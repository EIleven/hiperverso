// Deployed at [timestamp] to ensure fresh deployment
/**
 * @fileOverview Cloud Functions for Firebase for the Echo project.
 * This file contains Cloud Functions triggers (mostly v2) to handle Firestore
 * events and create notifications (mentions, replies, likes, follows, etc.).
 */
import {
  onDocumentCreated,
  onDocumentDeleted,
  onDocumentUpdated,
  onDocumentWritten,
  type QueryDocumentSnapshot,
} from "firebase-functions/v2/firestore";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import {
  getFirestore,
  Timestamp,
  FieldValue,
} from "firebase-admin/firestore";
import * as logger from "firebase-functions/logger";
import {
  aoBoostPostLocal,
  aoEscreverComentario,
  aoEscreverPost,
  aoExcluirConta,
  aoInteragirPostRemoto,
} from "./federation";
import {
  applyMediaVisibilityByOwnerPosts,
  mediaIdsFromContent,
  purgeMedia,
  tombstoneMediaByOwner,
} from "./mediaAccess";
import { setGlobalOptions } from "firebase-functions/v2";
import { defineSecret } from "firebase-functions/params";
import { type UserRecord } from "firebase-admin/auth";
import { initializeApp, applicationDefault, getApps } from "firebase-admin/app";
import { getMessaging } from "firebase-admin/messaging";
import { getDatabaseWithUrl } from "firebase-admin/database";
import { onSchedule } from "firebase-functions/v2/scheduler";
import {onObjectFinalized} from "firebase-functions/v2/storage";
import * as functions from "firebase-functions/v1";
// eslint-disable-next-line @typescript-eslint/no-require-imports
import Parser = require("rss-parser");
import {createHash} from "crypto";
import {
  assertHuman,
  claimGoogleProfile as claimGoogleProfileFor,
  createEmailAccount,
  readSignupStatus,
  refreshMemberClaim as refreshMemberClaimFor,
  updateBirthDate as updateBirthDateFor,
} from "./signup";
import {
  buildPushMessages,
  normalizeLocale,
  normalizePlatform,
  shouldPushOnUpdate,
  wantsPush,
  type PushNotification,
  type PushToken,
} from "./push";
import {dispatchVideoTranscode} from "./videoTranscode";

// Região e banco configuráveis por ambiente (functions/.env*); os padrões
// são os valores do projeto antigo.
const REGION = process.env.FUNCTIONS_REGION || "southamerica-east1";
const DATABASE_ID = process.env.FIRESTORE_DATABASE_ID || "echo-db-124325";
const VIDEO_DISPATCHER_SERVICE_ACCOUNT =
  "video-dispatcher@echo-b5aw9.iam.gserviceaccount.com";
// Nome distinto da variável legada evita sobreposição durante a migração;
// o site continua recebendo o valor como REVALIDATE_SECRET via App Hosting.
const revalidateSecret = defineSecret("REVALIDATE_TOKEN");

// Bucket padrao do Storage. O app abaixo e criado com opcoes explicitas e,
// nesse caso, o firebase-admin NAO le o bucket do ambiente: sem isto todo
// getStorage().bucket() falhava com "Bucket name not specified"
// (em producao tambem), e a revogacao de token e a remocao de midia nunca
// funcionaram. No emulador, functions/.env.demo-soberan define o bucket.
const STORAGE_BUCKET =
  process.env.STORAGE_BUCKET || "echo-b5aw9.firebasestorage.app";

// Initialize Firebase Admin SDK if not already initialized
const adminApp =
  getApps().length === 0
    ? initializeApp({
        credential: applicationDefault(),
        databaseURL: `https://${process.env.GCLOUD_PROJECT}.firebaseio.com`,
        storageBucket: STORAGE_BUCKET,
      })
    : getApps()[0];

// Firestore Admin client bound to the target database id
const db = getFirestore(adminApp, DATABASE_ID);

// Região de todas as Functions v2. CPU fracionada (como a 1ª geração: 0,167
// vCPU para 256 MB) e no máximo 10 instâncias por Function: os gatilhos são
// leves, e com 1 vCPU por instância uma implantação das ~30 Functions já
// estourava a cota da região (20 vCPU simultâneas), assim como um pico de uso.
setGlobalOptions({region: REGION, cpu: "gcf_gen1", maxInstances: 10});

// URL pública do site (revalidação on-demand e links de push), configurável
// por ambiente (functions/.env*). O padrão é o domínio oficial; no emulador
// use SITE_URL=http://localhost:9002.
const SITE_URL = (process.env.SITE_URL || "https://exercitodolula.app")
  .replace(/\/+$/, "");

/**
 * Build a Next.js on-demand revalidate URL.
 * @param {string} path Path to revalidate.
 * @param {string} secret Revalidate secret.
 * @return {string} URL to call.
 */
const buildRevalidateUrl = (path: string, secret: string) => {
  const base = `${SITE_URL}/api/revalidate`;
  const query = `secret=${encodeURIComponent(secret)}&path=${encodeURIComponent(
    path
  )}`;
  return `${base}?${query}`;
};

/**
 * Sleep helper.
 * @param {number} ms Milliseconds.
 * @return {Promise<void>} Promise that resolves after delay.
 */
const sleep = async (ms: number) => {
  await new Promise((resolve) => setTimeout(resolve, ms));
};

// --- TYPE DEFINITIONS ---
export type NotificationType =
  | "like_post"
  | "like_repost"
  | "repost"
  | "repost_repost"
  | "quote"
  | "comment_on_post"
  | "reply_to_comment"
  | "new_follower"
  | "follow_back"
  | "like_comment"
  | "mention_in_post"
  | "mention_in_comment"
  | "new_post_from_user"
  | "new_message"
  | "alt_text_request"
  | "welcome";

export type NotificationActor = {
  userId: string;
  name: string;
  username: string;
  avatarUrl?: string;
  "data-ai-hint"?: string | null;
};

interface User {
  name: string;
  username: string;
  avatarUrl?: string;
  "data-ai-hint"?: string | null;
}

interface EmbeddedUserDetailsForFunction {
  userId: string;
  name: string;
  username: string;
  avatarUrl?: string;
  "data-ai-hint"?: string | null;
}

interface OriginalPostDetailsForFunction {
  id: string;
  authorDetails: EmbeddedUserDetailsForFunction;
  type: "post" | "news" | "comment";
  parentPostId?: string;
}

interface PostData {
  userId: string;
  type: "original" | "repost" | "quote";
  text?: string;
  headline?: string;
  category: "echo" | "news";
  newsCategory?: string;
  isLikedBy?: { [key: string]: boolean };
  originalPostDetails?: OriginalPostDetailsForFunction;
  quotedCommentId?: string;
  isDeleted?: boolean;
}

interface CommentData {
  userId: string;
  text: string;
  parentPostId?: string;
  parentCommentId?: string;
  isLikedBy?: { [key: string]: boolean };
}

interface ConversationData {
  participantIds: string[];
  lastMessageSenderId?: string;
  createdBy?: string;
}

interface MessageData {
  senderId: string;
  text?: string;
  createdAt?: Timestamp;
}

/**
 * Utility to write Firestore operations with automatic batching to avoid
 * limits. Commits automatically when approaching the Firestore batch limit.
 */
class FirestoreBatchWriter {
  private batch: FirebaseFirestore.WriteBatch;
  private count: number;

  /**
   * Create a batch writer.
   * @param {FirebaseFirestore.Firestore} firestore Firestore instance.
   * @param {number} maxOps Max operations per commit (default 450).
   */
  constructor(
    private firestore: FirebaseFirestore.Firestore,
    private maxOps = 450
  ) {
    this.batch = firestore.batch();
    this.count = 0;
  }

  /**
   * Queue an update in the current batch and auto-flush if needed.
   * @param {FirebaseFirestore.DocumentReference} ref Document reference.
   * @param {FirebaseFirestore.UpdateData<FirebaseFirestore.DocumentData>} data
   * Update payload.
   * @return {Promise<void>} Resolves when the operation is queued/flushed.
   */
  async update(
    ref: FirebaseFirestore.DocumentReference,
    data: FirebaseFirestore.UpdateData<FirebaseFirestore.DocumentData>
  ): Promise<void> {
    this.batch.update(ref, data);
    this.count += 1;
    await this.flushIfNeeded();
  }

  /**
   * Queue a delete in the current batch and auto-flush if needed.
   * @param {FirebaseFirestore.DocumentReference} ref Document reference.
   * @return {Promise<void>} Resolves when the operation is queued/flushed.
   */
  async delete(ref: FirebaseFirestore.DocumentReference): Promise<void> {
    this.batch.delete(ref);
    this.count += 1;
    await this.flushIfNeeded();
  }

  /**
   * Commit the batch when the operation count reaches the threshold.
   * @return {Promise<void>} Resolves after committing when threshold
   * is reached.
   */
  async flushIfNeeded(): Promise<void> {
    if (this.count >= this.maxOps) {
      await this.batch.commit();
      this.batch = this.firestore.batch();
      this.count = 0;
    }
  }

  /**
   * Commit any queued operations that haven't been committed yet.
   * @return {Promise<void>} Resolves after committing remaining operations.
   */
  async flush(): Promise<void> {
    if (this.count > 0) {
      await this.batch.commit();
      this.batch = this.firestore.batch();
      this.count = 0;
    }
  }
}

// --- HELPER FUNCTIONS ---
/**
 * Fetch embedded actor details used for notifications.
 * @param {string} userId User ID.
 * @return {Promise<EmbeddedUserDetailsForFunction|null>} Embedded details
 * or null.
 */
const getActorDetails = async (
  userId: string
): Promise<EmbeddedUserDetailsForFunction | null> => {
  const userSnap = await db.collection("users").doc(userId).get();
  if (!userSnap.exists) {
    logger.warn(`getActorDetails: User ${userId} not found.`);
    return null;
  }
  const u = userSnap.data() as User;
  const details: EmbeddedUserDetailsForFunction = {
    userId,
    name: u.name,
    username: u.username,
    avatarUrl: u.avatarUrl,
  };
  details["data-ai-hint"] = u["data-ai-hint"] || null;
  return details;
};

// Chave de users/{id}.notificationPreferences que liga ou desliga cada tipo
// de notificação (o valor false desliga).
const NOTIFICATION_PREFERENCE_BY_TYPE: Record<string, string> = {
  like_post: "likes",
  like_repost: "likes",
  like_comment: "likes",
  comment_on_post: "comments",
  reply_to_comment: "comments",
  repost: "reposts",
  repost_repost: "reposts",
  quote: "reposts",
  new_follower: "newFollowers",
  follow_back: "newFollowers",
  mention_in_post: "mentions",
  mention_in_comment: "mentions",
  new_message: "directMessages",
  new_conversation: "directMessages",
};

/**
 * O destinatário quer esta notificação? Respeita as preferências dele, o
 * bloqueio (nos dois sentidos) e as contas silenciadas. Antes as telas de
 * configuração gravavam isso, mas nenhuma Function lia.
 * @param {string} recipientId Quem receberia a notificação.
 * @param {string} actorId Quem fez a ação.
 * @param {string} type Tipo da notificação.
 * @return {Promise<boolean>} true se a notificação deve ser criada.
 */
const shouldNotify = async (
  recipientId: string,
  actorId: string,
  type: string
): Promise<boolean> => {
  const recipientRef = db.collection("users").doc(recipientId);
  const actorRef = db.collection("users").doc(actorId);
  const [recipientSnap, privateSnap, blockedActor, blockedByActor, mutedActor] =
    await Promise.all([
      recipientRef.get(),
      privateAccountRefOf(recipientId).get(),
      recipientRef.collection("blockedUsers").doc(actorId).get(),
      actorRef.collection("blockedUsers").doc(recipientId).get(),
      recipientRef.collection("mutedUsers").doc(actorId).get(),
    ]);
  if (!recipientSnap.exists) return false;
  if (blockedActor.exists || blockedByActor.exists || mutedActor.exists) {
    return false;
  }
  const key = NOTIFICATION_PREFERENCE_BY_TYPE[type];
  type Prefs = {notificationPreferences?: Record<string, boolean>};
  // Preferências ficam no documento privado; perfis antigos (antes da
  // migração) ainda as têm no documento público.
  const preferences =
    (privateSnap.data() as Prefs | undefined)?.notificationPreferences ??
    (recipientSnap.data() as Prefs).notificationPreferences;
  return !(key && preferences?.[key] === false);
};

/**
 * Create or aggregate a notification for a recipient.
 * @param {string} recipientId Recipient user id.
 * @param {string} type Notification type string.
 * @param {string} entityId Entity id related to the notification.
 * @param {EmbeddedUserDetailsForFunction} actor Actor details (who caused it).
 * @param {NotificationOptions} options Extra fields and aggregation config.
 * @return {Promise<void>} Resolves when the notification write is done.
 */
const createOrUpdateNotification = async (
  recipientId: string,
  type: string,
  entityId: string,
  actor: EmbeddedUserDetailsForFunction,
  options: {
    entityParentId?: string;
    entityType?: "post" | "comment" | "user" | "conversation";
    previewText?: string | null;
    newPostId?: string;
    aggregationWindowSeconds?: number;
  }
) => {
  const logInfo = [
    `type=${type}`,
    `entityId=${entityId}`,
    `recipient=${recipientId}`,
  ].join(", ");
  logger.info(`[LOG] createOrUpdateNotification called: ${logInfo}`);

  if (recipientId === actor.userId) {
    logger.info(`[LOG] Skipping self-notification for ${actor.userId}.`);
    return;
  }

  if (!(await shouldNotify(recipientId, actor.userId, type))) {
    logger.info(
      `[LOG] Skipping ${type} for ${recipientId}: ` +
      "preference off, blocked or muted."
    );
    return;
  }

  const {
    entityParentId,
    entityType,
    previewText,
    newPostId,
    aggregationWindowSeconds,
  } = options;

  let toUpdate: FirebaseFirestore.DocumentReference | null = null;

  try {
    if (aggregationWindowSeconds) {
      const since = new Date(Date.now() - aggregationWindowSeconds * 1000);
      logger.info(`[LOG] Aggregation window since: ${since.toISOString()}`);
      const recentQuery = db
        .collection("notifications")
        .where("recipientId", "==", recipientId)
        .where("type", "==", type)
        .where("entityId", "==", entityId)
        .where("readAt", "==", null)
        .where("createdAt", ">=", since);
      const recent = await recentQuery.limit(1).get();

      if (!recent.empty) {
        toUpdate = recent.docs[0].ref;
        logger.info(`[LOG] Found recent notification: ${toUpdate.path}`);
      } else {
        logger.info("[LOG] No recent notification found for aggregation.");
      }
    }

    const now = Timestamp.now();

    if (toUpdate) {
      logger.info(`[LOG] Updating existing notification: ${toUpdate.path}`);
      const batch = db.batch();
      batch.update(toUpdate, {
        actors: FieldValue.arrayUnion(actor),
        count: FieldValue.increment(1),
        createdAt: now,
      });
      await batch.commit();
      logger.info("[LOG] Successfully updated notification.");
      return;
    }

    logger.info(`[LOG] Creating new notification for ${recipientId}`);
    const data = {
      recipientId: recipientId,
      type: type,
      entityId: entityId,
      entityParentId: entityParentId || null,
      entityType: entityType || "post",
      actors: [actor],
      count: 1,
      previewText: previewText || null,
      newPostId: newPostId || null,
      createdAt: now,
      readAt: null,
    };
    await db.collection("notifications").add(data);
    logger.info("[LOG] Successfully created new notification.");
  } catch (error) {
    logger.error("[ERROR] Failed to create/update notification:", error);
  }
};

/**
 * Extract @mentions from a text.
 * @param {string} text Input text.
 * @return {string[]} Unique usernames without the @.
 */
const extractMentions = (text: string): string[] => {
  if (!text) {
    return [];
  }
  const regex = /@([a-zA-Z0-9_]+)/g;
  const matches = text.match(regex);
  return matches ? [...new Set(matches)].map((m) => m.substring(1)) : [];
};

/**
 * Create mention notifications for every user mentioned in a text.
 * @param {string} text Content text.
 * @param {"post"|"comment"} entityType Where the mention happened.
 * @param {string} entityId Related entity id.
 * @param {string} authorId Author/actor user id.
 * @param {string=} entityParentId Optional parent id (e.g. post id for
 * comment).
 * @return {Promise<void>} Resolves after processing mentions.
 */
const handleMentions = async (
  text: string,
  entityType: "post" | "comment",
  entityId: string,
  authorId: string,
  entityParentId?: string,
  excludeUserId?: string | null
) => {
  const mentions = extractMentions(text);
  if (mentions.length === 0) {
    return;
  }

  const author = await getActorDetails(authorId);
  if (!author) {
    return;
  }

  const CHUNK = 30;
  for (let i = 0; i < mentions.length; i += CHUNK) {
    const batchUsernames = mentions.slice(i, i + CHUNK);
    if (batchUsernames.length === 0) {
      continue;
    }

    const snap = await db
      .collection("users")
      .where("username", "in", batchUsernames)
      .get();

    if (snap.empty) {
      continue;
    }
    for (const d of snap.docs) {
      const mentionedUserId = d.id;
      if (mentionedUserId === authorId || mentionedUserId === excludeUserId) {
        continue;
      }
      await createOrUpdateNotification(
        mentionedUserId,
        `mention_in_${entityType}`,
        entityId,
        author,
        {
          entityParentId,
          entityType,
          previewText: text.substring(0, 50),
        }
      );
    }
  }
};

// --- CONTADORES ---
// Os números públicos (curtidas, comentários, reposts, citações, seguidores,
// posts, visualizações) são gravados SÓ por estas Functions, a partir dos
// documentos "marcadores" que o app cria (likes/{uid}, reposts/{uid},
// followers/{uid}, views/{uid}...). As regras não deixam o cliente mexer nos
// números: antes qualquer usuário logado somava +1 no post ou no perfil de
// outra pessoa quantas vezes quisesse.

/**
 * Aplica as gravações de um evento UMA única vez. O Eventarc entrega cada
 * evento "pelo menos uma vez" (pode repetir): o id do evento fica em
 * _functionEvents na mesma transação das gravações, e uma repetição é
 * ignorada.
 * @param {string} eventId Id do evento (e.id).
 * @param {Function} apply Recebe a transação. Faz TODAS as leituras antes de
 * gravar (exigência das transações do Firestore).
 * @return {Promise<boolean>} true se aplicou; false se já tinha aplicado.
 */
const applyOnce = async (
  eventId: string,
  apply: (tx: FirebaseFirestore.Transaction) => Promise<void>
): Promise<boolean> => {
  const marker = db.collection("_functionEvents").doc(eventId);
  return db.runTransaction(async (tx) => {
    const seen = await tx.get(marker);
    if (seen.exists) {
      return false;
    }
    await apply(tx);
    tx.set(marker, {
      at: FieldValue.serverTimestamp(),
      // Para uma política de TTL do Firestore apagar os marcadores antigos.
      expireAt: Timestamp.fromMillis(Date.now() + 7 * 24 * 3600 * 1000),
    });
    return true;
  });
};

type CounterTarget = {
  ref: FirebaseFirestore.DocumentReference;
  fields: Record<string, number>;
};

/**
 * Soma os deltas em cada documento que AINDA existir (post ou comentário já
 * apagado é ignorado, em vez de falhar ou ser recriado como esqueleto).
 * @param {string} eventId Id do evento (idempotência).
 * @param {CounterTarget[]} targets Documentos e deltas por campo.
 * @return {Promise<void>} Resolve depois de gravar (ou de ignorar repetição).
 */
const bumpCounters = async (
  eventId: string,
  targets: CounterTarget[]
): Promise<void> => {
  if (targets.length === 0) {
    return;
  }
  await applyOnce(eventId, async (tx) => {
    const snaps = await Promise.all(targets.map((t) => tx.get(t.ref)));
    targets.forEach((t, i) => {
      if (!snaps[i].exists) {
        return;
      }
      const data: Record<string, FieldValue> = {};
      for (const [field, delta] of Object.entries(t.fields)) {
        data[field] = FieldValue.increment(delta);
      }
      tx.update(t.ref, data);
    });
  });
};

const postRefOf = (postId: string) => db.collection("posts").doc(postId);
// Dados pessoais do usuário (e-mail, nascimento, preferências, não lidas):
// fora do perfil público, que qualquer pessoa lê.
const privateAccountRefOf = (userId: string) =>
  db.collection("users").doc(userId).collection("private").doc("account");
const commentRefOf = (postId: string, commentId: string) =>
  postRefOf(postId).collection("comments").doc(commentId);
const userRefOf = (userId: string) => db.collection("users").doc(userId);

/** Post ou citação que conta em postsCount (reposts antigos não contam). */
const countsAsAuthorPost = (post: {type?: string}) =>
  post.type === "original" || post.type === "quote" || !post.type;

/**
 * Contadores que um post (original ou citação) soma ao nascer e devolve ao
 * sumir: postsCount do autor e, nas citações, quotesCount do post citado ou
 * repostsCount do comentário citado.
 * @param {Record<string, unknown>} post Dados do post.
 * @param {number} sign +1 ao criar, -1 ao apagar ou "tombar".
 * @return {CounterTarget[]} Documentos e deltas.
 */
const postLifecycleTargets = (
  post: Record<string, unknown>,
  sign: 1 | -1
): CounterTarget[] => {
  const targets: CounterTarget[] = [];
  const userId = typeof post.userId === "string" ? post.userId : "";
  if (userId && countsAsAuthorPost(post as {type?: string})) {
    targets.push({ref: userRefOf(userId), fields: {postsCount: sign}});
  }
  if (post.type === "quote") {
    const original = post.originalPostDetails as {id?: string} | null;
    const quotedComment = typeof post.quotedCommentId === "string" ?
      post.quotedCommentId : "";
    if (original?.id && !original.id.startsWith("http")) {
      targets.push({
        ref: postRefOf(original.id),
        fields: {quotesCount: sign},
      });
    } else if (quotedComment.includes("/")) {
      const [parentPostId, commentId] = quotedComment.split("/");
      if (parentPostId && commentId) {
        targets.push({
          ref: commentRefOf(parentPostId, commentId),
          fields: {repostsCount: sign},
        });
      }
    }
  }
  return targets;
};

// --- CLOUD FUNCTION TRIGGERS ---
export const onPostCreated = onDocumentCreated(
  {
    document: "posts/{postId}",
    database: DATABASE_ID,
    secrets: [revalidateSecret],
  },
  async (e) => {
    const snap = e.data;
    if (!snap) {
      logger.warn(`onPostCreated: missing data for ${e.params.postId}`);
      return;
    }
    const post = snap.data() as PostData | undefined;
    const pid = e.params.postId;
    // Evento sem documento (visto nos emuladores ao limpar o banco): sem isto a
    // Function caía e derrubava o processo, atrasando os outros gatilhos.
    if (!post) {
      logger.warn(`onPostCreated: ${pid} sem dados, ignorado.`);
      return;
    }
    const authorId = post.userId;

    // Contadores: postsCount do autor e, nas citações, o contador do post ou
    // do comentário citado (antes o navegador gravava esses números).
    try {
      await bumpCounters(
        e.id,
        postLifecycleTargets(snap.data() as Record<string, unknown>, 1)
      );
    } catch (error) {
      logger.error(`onPostCreated: contadores de ${pid}:`, error);
    }

    const actor = await getActorDetails(authorId);
    if (!actor) {
      return;
    }

    // Citação de COMENTÁRIO: avisa o autor do comentário (antes não avisava).
    if (post.type === "quote" && post.quotedCommentId?.includes("/")) {
      const [parentPostId, commentId] = post.quotedCommentId.split("/");
      const quoted = await commentRefOf(parentPostId, commentId).get();
      const commentAuthor = quoted.exists ?
        (quoted.data() as CommentData).userId : null;
      if (commentAuthor) {
        await createOrUpdateNotification(commentAuthor, "quote", commentId,
          actor, {
            entityParentId: parentPostId,
            entityType: "comment",
            previewText: post.text ? post.text.substring(0, 50) : null,
            newPostId: pid,
          });
      }
    }

    // Notify original author about repost/quote
    if (
      (post.type === "repost" || post.type === "quote") &&
      post.originalPostDetails
    ) {
      const orig = post.originalPostDetails;
      if (orig.id && orig.authorDetails?.userId) {
        let prev = null;
        if (post.type === "quote" && post.text) {
          prev = post.text.substring(0, 50);
        }

        if (orig.type === "comment" && orig.parentPostId) {
          await createOrUpdateNotification(
            orig.authorDetails.userId,
            post.type,
            orig.id,
            actor,
            {
              entityParentId: orig.parentPostId,
              entityType: "comment",
              previewText: prev,
              newPostId: pid,
            }
          );
        } else {
          await createOrUpdateNotification(
            orig.authorDetails.userId,
            post.type,
            orig.id,
            actor,
            {
              previewText: prev,
              newPostId: pid,
            }
          );
        }
      }
    }

    // Mentions in original/quote post
    if ((post.type === "original" || post.type === "quote") && post.text) {
      await handleMentions(post.text, "post", pid, authorId);
    }

    // Notify subscribers
    if (post.type === "original" || post.type === "quote") {
      const subs = await db
        .collection("users")
        .doc(authorId)
        .collection("subscribers")
        .get();

      if (!subs.empty) {
        const prev = post.headline || post.text?.substring(0, 50) || null;
        for (const s of subs.docs) {
          const sid = s.id;
          const pref = String(s.data().preference || "all");
          if (sid === authorId) {
            continue;
          }
          const ok =
            pref === "all" ||
            (pref === "news_only" && post.category === "news");
          if (!ok) {
            continue;
          }
          await createOrUpdateNotification(
            sid,
            "new_post_from_user",
            pid,
            actor,
            {
              previewText: prev,
              entityType: "post",
            }
          );
        }
      }
    }

    // O ping de sitemap ao Google/Bing foi removido: esses endpoints foram
    // descontinuados (404/410). O sitemap é descoberto via robots.txt.

    // Next.js on-demand revalidation
    const secret = revalidateSecret.value();
    if (!secret) {
      logger.warn("REVALIDATE_SECRET is not set. Skipping revalidation.");
      return;
    }

    try {
      const sitemapUrl = buildRevalidateUrl("/sitemap.xml", secret);
      const resp = await fetch(sitemapUrl);
      if (!resp.ok) {
        throw new Error(`Invalid response: ${resp.status}`);
      }
      logger.info("Revalidate sitemap response:", await resp.json());
    } catch (err) {
      logger.error("Error revalidating sitemap:", err);
    }

    try {
      await sleep(500);
      const postPath = `/post/${pid}`;
      const postUrl = buildRevalidateUrl(postPath, secret);
      const resp2 = await fetch(postUrl);
      if (!resp2.ok) {
        throw new Error(`Invalid response: ${resp2.status}`);
      }
      logger.info("Revalidate post page response:", await resp2.json());
    } catch (err) {
      logger.error("Error revalidating post page:", err);
    }
  }
);

export const onPostLiked = onDocumentCreated(
  {
    document: "posts/{postId}/likes/{userId}",
    database: DATABASE_ID,
  },
  async (e) => {
    const { postId, userId } = e.params;
    const logPrefix = `onPostLiked(postId=${postId}, userId=${userId}):`;
    logger.info(`[LOG] ${logPrefix} Triggered.`);

    const postRef = db.collection("posts").doc(postId);

    try {
      await bumpCounters(e.id, [{ref: postRef, fields: {likes: 1}}]);
      logger.info(`[LOG] ${logPrefix} Incremented likes count.`);

      if (postId.startsWith("ap_") && !userId.startsWith("ap_")) {
        await aoInteragirPostRemoto(db, {
          idDoEvento: e.id,
          op: "remote-like",
          uid: userId,
          postId,
          agora: Date.now(),
        });
      }

      const postSnap = await postRef.get();
      if (!postSnap.exists) {
        logger.warn(`[WARN] ${logPrefix} Post document not found.`);
        return;
      }
      const post = postSnap.data() as PostData;
      logger.info(
        `[LOG] ${logPrefix} Fetched post data for ${post.userId}.`
      );

      const actor = await getActorDetails(userId);
      if (!actor) {
        logger.warn(`[WARN] ${logPrefix} Actor details not found.`);
        return;
      }

      const recipientId = post.userId;
      const isRepost = post.type === "repost";
      const orig = (
        post as {originalPostDetails?: PostData}
      ).originalPostDetails;
      const prev =
        (isRepost ? orig?.headline || orig?.text?.substring(0, 50) : null) ||
        post.headline ||
        post.text?.substring(0, 50) ||
        null;

      await createOrUpdateNotification(
        recipientId,
        isRepost ? "like_repost" : "like_post",
        postId,
        actor,
        {
          previewText: prev,
          aggregationWindowSeconds: 3600,
        }
      );

      logger.info(`[LOG] ${logPrefix} Completed successfully.`);
    } catch (error) {
      logger.error(`[ERROR] ${logPrefix}`, error);
    }
  }
);

export const onPostUnliked = onDocumentDeleted(
  {
    document: "posts/{postId}/likes/{userId}",
    database: DATABASE_ID,
  },
  async (e) => {
    const { postId, userId } = e.params;
    await bumpCounters(e.id, [{ref: postRefOf(postId), fields: {likes: -1}}]);
    if (postId.startsWith("ap_") && !userId.startsWith("ap_")) {
      await aoInteragirPostRemoto(db, {
        idDoEvento: e.id,
        op: "remote-unlike",
        uid: userId,
        postId,
        agora: Date.now(),
      });
    }
  }
);

export const onCommentCreated = onDocumentCreated(
  {
    document: "posts/{postId}/comments/{commentId}",
    database: DATABASE_ID,
  },
  async (e) => {
    const snap = e.data;
    if (!snap) {
      return;
    }
    const c = snap.data() as CommentData | undefined;
    const { postId, commentId } = e.params;
    if (!c) {
      logger.warn(`onCommentCreated: ${postId}/${commentId} sem dados.`);
      return;
    }

    // commentsCount do post (conta respostas também) e repliesCount do
    // comentário-pai.
    const counters: CounterTarget[] = [
      {ref: postRefOf(postId), fields: {commentsCount: 1}},
    ];
    if (c.parentCommentId) {
      counters.push({
        ref: commentRefOf(postId, c.parentCommentId),
        fields: {repliesCount: 1},
      });
    }
    try {
      await bumpCounters(e.id, counters);
    } catch (error) {
      logger.error(`onCommentCreated: contadores de ${commentId}:`, error);
    }

    const actor = await getActorDetails(c.userId);
    if (!actor) {
      return;
    }

    let notifiedRecipientId: string | null = null;
    if (c.parentCommentId) {
      const parentRef = db
        .collection("posts")
        .doc(postId)
        .collection("comments")
        .doc(c.parentCommentId);
      const parent = await parentRef.get();
      if (parent.exists) {
        const pc = parent.data() as CommentData;
        notifiedRecipientId = pc.userId;
        await createOrUpdateNotification(
          pc.userId,
          "reply_to_comment",
          c.parentCommentId,
          actor,
          {
            entityParentId: postId,
            entityType: "comment",
            previewText: c.text.substring(0, 50),
          }
        );
      }
    } else {
      const postSnap = await db.collection("posts").doc(postId).get();
      if (postSnap.exists) {
        const pd = postSnap.data() as PostData;
        notifiedRecipientId = pd.userId;
        await createOrUpdateNotification(
          pd.userId,
          "comment_on_post",
          postId,
          actor,
          {
            entityType: "post",
            previewText: c.text.substring(0, 50),
          }
        );
      }
    }
    if (c.text) {
      await handleMentions(
        c.text,
        "comment",
        commentId,
        c.userId,
        postId,
        notifiedRecipientId
      );
    }
  }
);

export const onCommentDeleted = onDocumentDeleted(
  {
    document: "posts/{postId}/comments/{commentId}",
    database: DATABASE_ID,
  },
  async (e) => {
    const { postId } = e.params;
    const c = e.data?.data() as CommentData | undefined;
    const counters: CounterTarget[] = [
      {ref: postRefOf(postId), fields: {commentsCount: -1}},
    ];
    if (c?.parentCommentId) {
      counters.push({
        ref: commentRefOf(postId, c.parentCommentId),
        fields: {repliesCount: -1},
      });
    }
    await bumpCounters(e.id, counters);
    await purgarMidiaDe(
      c as unknown as Record<string, unknown> | undefined,
      c?.userId,
      `onCommentDeleted ${e.params.commentId}`
    );
  }
);

// Reposts são marcadores posts/{postId}/reposts/{userId} (e o mesmo dentro de
// um comentário). O número e a notificação ficam aqui: antes o navegador
// somava o contador e ninguém avisava o autor do repost.
export const onPostReposted = onDocumentCreated(
  {
    document: "posts/{postId}/reposts/{userId}",
    database: DATABASE_ID,
  },
  async (e) => {
    const { postId, userId } = e.params;
    await bumpCounters(e.id, [{ref: postRefOf(postId), fields: {reposts: 1}}]);
    if (postId.startsWith("ap_") && !userId.startsWith("ap_")) {
      await aoInteragirPostRemoto(db, {
        idDoEvento: e.id,
        op: "remote-boost",
        uid: userId,
        postId,
        agora: Date.now(),
      });
    } else if (!postId.startsWith("ap_") && !userId.startsWith("ap_")) {
      await aoBoostPostLocal(db, {
        idDoEvento: e.id,
        op: "local-boost",
        uid: userId,
        postId,
        agora: Date.now(),
      });
    }
    const postSnap = await postRefOf(postId).get();
    const actor = await getActorDetails(userId);
    if (!postSnap.exists || !actor) {
      return;
    }
    const post = postSnap.data() as PostData;
    const isRepost = post.type === "repost";
    const orig = (post as {originalPostDetails?: PostData}).originalPostDetails;
    const previewText =
      (isRepost ? orig?.headline || orig?.text?.substring(0, 50) : null) ||
      post.headline ||
      post.text?.substring(0, 50) ||
      null;
    await createOrUpdateNotification(
      post.userId,
      isRepost ? "repost_repost" : "repost",
      postId,
      actor,
      {
        entityType: "post",
        previewText,
        aggregationWindowSeconds: 3600,
      }
    );
  }
);

export const onPostUnreposted = onDocumentDeleted(
  {
    document: "posts/{postId}/reposts/{userId}",
    database: DATABASE_ID,
  },
  async (e) => {
    const { postId, userId } = e.params;
    await bumpCounters(e.id, [
      {ref: postRefOf(postId), fields: {reposts: -1}},
    ]);
    if (postId.startsWith("ap_") && !userId.startsWith("ap_")) {
      await aoInteragirPostRemoto(db, {
        idDoEvento: e.id,
        op: "remote-unboost",
        uid: userId,
        postId,
        agora: Date.now(),
      });
    } else if (!postId.startsWith("ap_") && !userId.startsWith("ap_")) {
      await aoBoostPostLocal(db, {
        idDoEvento: e.id,
        op: "local-unboost",
        uid: userId,
        postId,
        agora: Date.now(),
      });
    }
  }
);

export const onCommentReposted = onDocumentCreated(
  {
    document: "posts/{postId}/comments/{commentId}/reposts/{userId}",
    database: DATABASE_ID,
  },
  async (e) => {
    const { postId, commentId, userId } = e.params;
    const ref = commentRefOf(postId, commentId);
    await bumpCounters(e.id, [{ref, fields: {repostsCount: 1}}]);
    const commentSnap = await ref.get();
    const actor = await getActorDetails(userId);
    if (!commentSnap.exists || !actor) {
      return;
    }
    const comment = commentSnap.data() as CommentData;
    await createOrUpdateNotification(comment.userId, "repost", commentId,
      actor, {
        entityParentId: postId,
        entityType: "comment",
        previewText: comment.text ? comment.text.substring(0, 50) : null,
        aggregationWindowSeconds: 3600,
      });
  }
);

export const onCommentUnreposted = onDocumentDeleted(
  {
    document: "posts/{postId}/comments/{commentId}/reposts/{userId}",
    database: DATABASE_ID,
  },
  async (e) => {
    const { postId, commentId } = e.params;
    await bumpCounters(e.id, [
      {ref: commentRefOf(postId, commentId), fields: {repostsCount: -1}},
    ]);
  }
);

// Visualizações e cliques no perfil a partir de um post: um marcador por
// usuário logado (views/{uid}, profileClicks/{uid}). Contam pessoas únicas e
// ninguém infla o número de outra pessoa (antes era +1 livre no post).
export const onPostViewed = onDocumentCreated(
  {
    document: "posts/{postId}/views/{userId}",
    database: DATABASE_ID,
  },
  async (e) => {
    const { postId } = e.params;
    const postRef = postRefOf(postId);
    const analyticsRef = postRef.collection("analytics").doc("summary");
    const today = new Date().toISOString().slice(0, 10);
    await applyOnce(e.id, async (tx) => {
      const post = await tx.get(postRef);
      if (!post.exists) {
        return;
      }
      tx.update(postRef, {views: FieldValue.increment(1)});
      tx.set(analyticsRef, {
        dailyViews: {[today]: FieldValue.increment(1)},
        lastUpdated: FieldValue.serverTimestamp(),
      }, {merge: true});
    });
  }
);

export const onProfileClickedFromPost = onDocumentCreated(
  {
    document: "posts/{postId}/profileClicks/{userId}",
    database: DATABASE_ID,
  },
  async (e) => {
    const { postId } = e.params;
    const postRef = postRefOf(postId);
    const analyticsRef = postRef.collection("analytics").doc("summary");
    await applyOnce(e.id, async (tx) => {
      const post = await tx.get(postRef);
      if (!post.exists) {
        return;
      }
      tx.set(analyticsRef, {
        profileClicks: FieldValue.increment(1),
        lastUpdated: FieldValue.serverTimestamp(),
      }, {merge: true});
    });
  }
);

/**
 * Apaga a midia (registro em tombstone E objeto no bucket) de um conteudo que
 * foi apagado. Nunca derruba a Function que a chamou: falha aqui fica no log.
 * `autor` e quem escreveu o conteudo: so a midia dele e removida.
 */
async function purgarMidiaDe(
  conteudo: Record<string, unknown> | undefined,
  autor: unknown,
  origem: string
): Promise<void> {
  try {
    if (typeof autor !== "string" || !autor) return;
    const ids = mediaIdsFromContent(conteudo);
    if (ids.length === 0) return;
    const r = await purgeMedia(db, ids, autor);
    logger.info(
      `${origem}: ${r.registros} registros, ` +
      `${r.objetosApagados} objetos apagados, ${r.ignorados} ignorados`
    );
  } catch (error) {
    logger.error(`${origem}: falha ao remover a midia:`, error);
  }
}


// Post apagado de vez ou "tombado" (isDeleted, quando já tinha interações):
// devolve postsCount do autor e o contador da citação. O que foi tombado não
// devolve de novo se depois for apagado.
export const onPostDeleted = onDocumentDeleted(
  {
    document: "posts/{postId}",
    database: DATABASE_ID,
  },
  async (e) => {
    const { postId } = e.params;
    const post = e.data?.data() as Record<string, unknown> | undefined;
    if (post && post.isDeleted !== true) {
      await bumpCounters(e.id, postLifecycleTargets(post, -1));
    }
    // A midia do post apagado sai do ar (tombstone) E do bucket (objeto
    // apagado). Antes so o token era revogado e o arquivo ficava guardado.
    await purgarMidiaDe(post, post?.userId, `onPostDeleted ${postId}`);

    // Curtidas, marcadores de repost, visualizações e análises do post apagado
    // não servem a mais nada (e apontariam para um post inexistente).
    try {
      await db.recursiveDelete(postRefOf(postId));
    } catch (error) {
      logger.error(`onPostDeleted: limpeza de ${postId}:`, error);
    }
  }
);

export const onPostUpdated = onDocumentUpdated(
  {
    document: "posts/{postId}",
    database: DATABASE_ID,
  },
  async (e) => {
    const before = e.data?.before.data();
    const after = e.data?.after.data();
    if (!before || !after) {
      return;
    }
    if (before.isDeleted !== true && after.isDeleted === true) {
      await bumpCounters(e.id, postLifecycleTargets(before, -1));
      // Post "tombado" (tinha interacoes): o texto e a lista de midia saem do
      // documento, e a midia sai do ar e do bucket junto.
      await purgarMidiaDe(
        before,
        before.userId,
        `onPostUpdated ${e.params.postId}`
      );
    }
  }
);

export const onCommentLiked = onDocumentCreated(
  {
    document: "posts/{postId}/comments/{commentId}/likes/{userId}",
    database: DATABASE_ID,
  },
  async (e) => {
    const { postId, commentId, userId } = e.params;
    const logPrefix = [
      `onCommentLiked(postId=${postId}`,
      `commentId=${commentId}`,
      `userId=${userId})`,
    ].join(", ");
    logger.info(`[LOG] ${logPrefix} Triggered.`);

    const commentRef = db
      .collection("posts")
      .doc(postId)
      .collection("comments")
      .doc(commentId);

    try {
      await bumpCounters(e.id, [{ref: commentRef, fields: {likes: 1}}]);
      logger.info(`[LOG] ${logPrefix} Incremented likes count.`);

      const commentSnap = await commentRef.get();
      if (!commentSnap.exists) {
        logger.warn(`[WARN] ${logPrefix} Comment document not found.`);
        return;
      }
      const comment = commentSnap.data() as CommentData;
      logger.info(
        `[LOG] ${logPrefix} Fetched comment data for ${comment.userId}.`
      );

      const actor = await getActorDetails(userId);
      if (!actor) {
        logger.warn(`[WARN] ${logPrefix} Actor details not found.`);
        return;
      }

      const recipientId = comment.userId;
      const prev = comment.text ? comment.text.substring(0, 50) : null;
      await createOrUpdateNotification(
        recipientId,
        "like_comment",
        commentId,
        actor,
        {
          entityParentId: postId,
          entityType: "comment",
          previewText: prev,
          aggregationWindowSeconds: 3600,
        }
      );
      logger.info(`[LOG] ${logPrefix} Completed successfully.`);
    } catch (error) {
      logger.error(`[ERROR] ${logPrefix}`, error);
    }
  }
);

export const onCommentUnliked = onDocumentDeleted(
  {
    document: "posts/{postId}/comments/{commentId}/likes/{userId}",
    database: DATABASE_ID,
  },
  async (e) => {
    const { postId, commentId } = e.params;
    await bumpCounters(e.id, [
      {ref: commentRefOf(postId, commentId), fields: {likes: -1}},
    ]);
  }
);

/**
 * Faz os contadores de seguir refletirem os documentos que realmente existem.
 *
 * Ciclos rápidos de seguir/deixar de seguir podem entregar os gatilhos fora de
 * ordem. Somar deltas deixa o perfil permanentemente divergente quando também
 * há uma importação, limpeza administrativa ou repetição antiga para reparar.
 * A agregação é barata (não transfere os documentos) e torna cada evento
 * autocorretivo.
 * @param {string} followedId Pessoa seguida.
 * @param {string} followerId Pessoa que segue.
 * @return {Promise<void>} Resolve após sincronizar os perfis existentes.
 */
const syncFollowCounters = async (
  followedId: string,
  followerId: string
): Promise<void> => {
  const followedRef = userRefOf(followedId);
  const followerRef = userRefOf(followerId);
  const [followers, following, followedUser, followerUser] = await Promise.all([
    followedRef.collection("followers").count().get(),
    followerRef.collection("following").count().get(),
    followedRef.get(),
    followerRef.get(),
  ]);
  const batch = db.batch();
  let hasWrites = false;
  if (followedUser.exists) {
    batch.update(followedRef, {followersCount: followers.data().count});
    hasWrites = true;
  }
  if (followerUser.exists) {
    batch.update(followerRef, {followingCount: following.data().count});
    hasWrites = true;
  }
  if (hasWrites) {
    await batch.commit();
  }
};

export const onUserFollowed = onDocumentCreated(
  {
    document: "users/{followedId}/followers/{followerId}",
    database: DATABASE_ID,
  },
  async (e) => {
    const { followedId, followerId } = e.params;
    if (followedId === followerId) {
      return;
    }
    // O navegador só grava os marcadores. A Function deriva os dois números da
    // fonte de verdade e também corrige eventual divergência anterior.
    try {
      await syncFollowCounters(followedId, followerId);
    } catch (error) {
      logger.error(`onUserFollowed: contadores ${followerId}->${followedId}:`,
        error);
    }
    const actor = await getActorDetails(followerId);
    if (!actor) {
      return;
    }
    const followBackSnap = await db
      .collection("users")
      .doc(followedId)
      .collection("following")
      .doc(followerId)
      .get();
    await createOrUpdateNotification(
      followedId,
      followBackSnap.exists ? "follow_back" : "new_follower",
      followerId,
      actor,
      {
        entityType: "user",
      }
    );
  }
);

export const onUserUnfollowed = onDocumentDeleted(
  {
    document: "users/{followedId}/followers/{followerId}",
    database: DATABASE_ID,
  },
  async (e) => {
    const { followedId, followerId } = e.params;
    if (followedId === followerId) {
      return;
    }
    await syncFollowCounters(followedId, followerId);
  }
);

export const onConversationCreated = onDocumentCreated(
  {
    document: "conversations/{conversationId}",
    database: DATABASE_ID,
  },
  async (e) => {
    const snap = e.data;
    if (!snap) {
      return;
    }

    const conversation = snap.data() as ConversationData | undefined;
    if (!conversation?.participantIds) {
      return;
    }
    const { conversationId } = e.params;
    // Quem iniciou a conversa: "createdBy" (gravado pelo app e conferido pelas
    // regras). Sem ele (documentos antigos) sobra participantIds[0], que é o
    // MENOR id e não quem iniciou: errava a pessoa notificada em metade dos
    // casos.
    const creatorId =
      conversation.createdBy ||
      conversation.lastMessageSenderId ||
      conversation.participantIds[0];
    const recipients = conversation.participantIds.filter((id) => {
      return id !== creatorId;
    });

    if (recipients.length === 0) {
      logger.info(
        `No recipient found for new conversation ${conversationId}.`
      );
      return;
    }

    const actor = await getActorDetails(creatorId);
    if (!actor) {
      return;
    }
    const isGroup = Boolean((conversation as { isGroup?: boolean }).isGroup);
    const groupName = (conversation as { groupName?: string }).groupName;
    const previewText = isGroup && groupName
      ? `Adicionou você ao grupo "${groupName}".`
      : "Started a new conversation with you.";

    for (let i = 0; i < recipients.length; i += 50) {
      const chunk = recipients.slice(i, i + 50);
      await Promise.all(
        chunk.map((recipientId) =>
          createOrUpdateNotification(
            recipientId,
            "new_conversation",
            conversationId,
            actor,
            {
              entityType: "conversation",
              previewText,
            }
          )
        )
      );
    }
  }
);

export const onDirectMessageCreated = onDocumentCreated(
  {
    document: "conversations/{conversationId}/messages/{messageId}",
    database: DATABASE_ID,
  },
  async (e) => {
    const snap = e.data;
    if (!snap) {
      return;
    }
    const { conversationId } = e.params;
    const message = snap.data() as MessageData | undefined;
    if (!message?.senderId) {
      return;
    }
    const senderId = message.senderId;
    const conversationSnap = await db
      .collection("conversations")
      .doc(conversationId)
      .get();

    if (!conversationSnap.exists) {
      logger.error(`Conversation ${conversationId} not found for message.`);
      return;
    }
    const conversation = conversationSnap.data() as ConversationData;
    if (!conversation.participantIds?.includes(senderId)) {
      logger.warn(`Sender ${senderId} is not in ${conversationId}.`);
      return;
    }
    const recipients = conversation.participantIds.filter((id) => {
      return id !== senderId;
    });

    const hasE2ee = Boolean((message as { e2ee?: unknown }).e2ee);
    const preview = hasE2ee
      ? "🔒 Mensagem criptografada"
      : (message.text ? message.text.substring(0, 50) : "Sent a file.");

    const unreadIncrements: Record<string, FieldValue> = {};
    for (const rid of recipients) {
      unreadIncrements[`unreadCounts.${rid}`] = FieldValue.increment(1);
    }

    // Mantém o documento da conversa em dia: prévia da última mensagem e
    // não lidas dos destinatários (a lista de conversas e o contador do menu
    // dependem disto).
    await conversationSnap.ref.update({
      lastMessageAt: message.createdAt ?? Timestamp.now(),
      lastMessageId: snap.id,
      lastMessageSenderId: senderId,
      lastMessageText: preview,
      ...unreadIncrements,
    });

    if (recipients.length === 0) {
      return;
    }

    // Envia push direto para DMs/grupos sem criar documento na aba de
    // Notificações da timeline (mantém o sino limpo, mas acorda o aparelho).
    const actor = await getActorDetails(senderId);
    if (!actor) {
      return;
    }
    const isGroup = Boolean((conversation as { isGroup?: boolean }).isGroup);
    const localRecipients = recipients.filter((rid) => !rid.startsWith("ap_"));
    for (let i = 0; i < localRecipients.length; i += 25) {
      const chunk = localRecipients.slice(i, i + 25);
      await Promise.all(
        chunk.map(async (recipientId) => {
          try {
            const privSnap = await privateAccountRefOf(recipientId).get();
            const prefs = privSnap.get("notificationPreferences") as
              | { directMessages?: boolean }
              | undefined;
            if (prefs?.directMessages === false) {
              return;
            }
            await sendPushForNotification(
              `dm-${conversationId}-${snap.id}-${recipientId}`,
              `dm-${conversationId}`,
              {
                recipientId,
                type: "new_message",
                entityId: conversationId,
                entityType: isGroup ? "group" : "conversation",
                actors: [actor],
                count: 1,
              }
            );
          } catch (err) {
            logger.warn(
              `[PUSH] Falha ao enviar push de DM para ${recipientId}:`,
              err
            );
          }
        })
      );
    }
  }
);

export const onConversationUpdated = onDocumentUpdated(
  {
    document: "conversations/{conversationId}",
    database: DATABASE_ID,
  },
  async (e) => {
    if (!e.data) {
      return;
    }

    const before = e.data.before.data();
    const after = e.data.after.data();

    const beforeUnread = JSON.stringify(before.unreadCounts);
    const afterUnread = JSON.stringify(after.unreadCounts);

    if (beforeUnread === afterUnread) {
      return;
    }

    const unreadCountsBefore = before.unreadCounts || {};
    const unreadCountsAfter = after.unreadCounts || {};

    try {
      const batch = db.batch();
      const allParticipantIds = new Set([
        ...Object.keys(unreadCountsBefore),
        ...Object.keys(unreadCountsAfter),
      ]);

      for (const userId of allParticipantIds) {
        const countBefore = unreadCountsBefore[userId] || 0;
        const countAfter = unreadCountsAfter[userId] || 0;
        const diff = countAfter - countBefore;

        if (diff !== 0) {
          // Contador pessoal: fica no documento privado do usuário.
          batch.set(privateAccountRefOf(userId), {
            totalUnreadMessages: FieldValue.increment(diff),
          }, {merge: true});
        }
      }
      await batch.commit();
    } catch (error) {
      const { conversationId } = e.params;
      const msg = `Error in onConversationUpdated for ${conversationId}:`;
      logger.error(msg, error);
    }
  }
);

// Realtime Database da presença. A instância padrão de projetos novos é
// "{projeto}-default-rtdb" (o initializeApp acima usa a URL antiga).
const RTDB_URL = process.env.RTDB_URL ||
  `https://${process.env.GCLOUD_PROJECT}-default-rtdb.firebaseio.com`;

/**
 * Quantos usuários (com ao menos uma conexão em /status/{uid}/connections) e
 * visitantes (/guests) estão online. Só administradores: o cliente não pode
 * listar a presença de todos (privacidade), então a contagem sai daqui, com
 * credencial de servidor.
 */
export const getPresenceStats = onCall(async (request) => {
  const uid = request.auth?.uid;
  if (!uid) {
    throw new HttpsError("unauthenticated", "Login necessário.");
  }
  const caller = await userRefOf(uid).get();
  if (caller.get("isAdmin") !== true) {
    throw new HttpsError("permission-denied", "Somente administradores.");
  }
  const rtdb = getDatabaseWithUrl(RTDB_URL, adminApp);
  const [status, guests] = await Promise.all([
    rtdb.ref("status").get(),
    rtdb.ref("guests").get(),
  ]);
  let onlineUsers = 0;
  status.forEach((child) => {
    if (child.child("connections").exists()) {
      onlineUsers++;
    }
  });
  return {onlineUsers, onlineGuests: guests.numChildren()};
});

export const checkAvailability = onCall(async (request) => {
  const { type, value } = request.data;
  if (!type || !value) {
    throw new HttpsError(
      "invalid-argument",
      "The function must be called with a 'type' and 'value'."
    );
  }
  // Anti-robô: com a verificação ligada, só quem traz o token do App Check
  // consulta se um e-mail ou @ existe (sem isso um script enumera contas).
  await assertHuman(db, Boolean(request.app));

  try {
    if (type === "username") {
      if (typeof value !== "string" || value.length < 3) {
        return { available: false };
      }
      const usernameDoc = await db
        .collection("usernames")
        .doc(value.toLowerCase())
        .get();
      return { available: !usernameDoc.exists };
    }

    throw new HttpsError(
      "invalid-argument",
      "Invalid availability check type specified."
    );
  } catch (error) {
    logger.error("Error in checkAvailability function:", error);
    if (error instanceof HttpsError) {
      throw error;
    }
    throw new HttpsError("internal", "An unexpected error occurred.");
  }
});

/**
 * Cadastro por e-mail e senha. Confere o limite dos primeiros usuários, cria a
 * conta no Auth e o perfil numa transação que também reserva a vaga (veja
 * signup.ts). Lotado: resource-exhausted, sem criar nada.
 */
export const createUserProfile = onCall(async (request) => {
  const data = request.data && typeof request.data === "object" ?
    request.data : {};
  return createEmailAccount(db, data, {appCheck: Boolean(request.app)});
});

/**
 * Primeiro acesso com o Google: cria o perfil pela mesma transação do cadastro
 * por e-mail (limite, vaga, @ e dados pessoais). Exige login com o Google e
 * não recebe dado nenhum do cliente. Lotado: resource-exhausted, e a conta
 * que o Google acabou de criar é removida.
 */
export const claimGoogleProfile = onCall(async (request) => {
  const uid = request.auth?.uid;
  if (!uid) {
    throw new HttpsError("unauthenticated", "Login necessário.");
  }
  return claimGoogleProfileFor(
    db,
    uid,
    request.auth?.token.firebase?.sign_in_provider,
    {appCheck: Boolean(request.app)}
  );
});

/**
 * Situação pública do cadastro (aberto ou lotado) para a tela de cadastro.
 * Não devolve o contador de vagas usadas.
 */
export const getSignupStatus = onCall(async () => readSignupStatus(db));

/**
 * Renova a claim usada pelas regras depois de confirmar o e-mail ou ao entrar
 * em uma conta antiga. O servidor so a concede a quem tem perfil e vaga.
 */
export const refreshMembershipClaim = onCall(async (request) => {
  const uid = request.auth?.uid;
  if (!uid) {
    throw new HttpsError("unauthenticated", "Login necessario.");
  }
  await refreshMemberClaimFor(db, uid);
  return {status: "ok"};
});

/** Atualiza a data declarada de nascimento sem expor esse dado no perfil. */
export const updateUserBirthDate = onCall(async (request) => {
  const uid = request.auth?.uid;
  if (!uid) {
    throw new HttpsError("unauthenticated", "Login necessario.");
  }
  await updateBirthDateFor(db, uid, request.data?.dateOfBirth);
  return {status: "ok"};
});

/**
 * Registra um único voto por UID, numa transação. O navegador nunca altera os
 * contadores do post: isso impede voto duplicado, opção inventada e inflação
 * de resultados por escrita direta no Firestore.
 */
export const voteOnPoll = onCall(async (request) => {
  const voterId = request.auth?.uid;
  if (!voterId) {
    throw new HttpsError("unauthenticated", "Entre na sua conta para votar.");
  }
  if (
    request.auth?.token.email_verified !== true ||
    request.auth?.token.member !== true
  ) {
    throw new HttpsError(
      "failed-precondition",
      "Confirme seu e-mail antes de votar."
    );
  }
  const postId = String(request.data?.postId ?? "").trim();
  const optionId = String(request.data?.optionId ?? "").trim();
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(postId) || !/^[a-d]$/.test(optionId)) {
    throw new HttpsError("invalid-argument", "Post ou opção inválidos.");
  }

  return db.runTransaction(async (transaction) => {
    const postRef = db.collection("posts").doc(postId);
    const voteRef = postRef.collection("pollVotes").doc(voterId);
    const postSnapshot = await transaction.get(postRef);
    if (!postSnapshot.exists) {
      throw new HttpsError("not-found", "Enquete não encontrada.");
    }

    const post = postSnapshot.data() ?? {};
    if (post.isDeleted === true) {
      throw new HttpsError("not-found", "Enquete não encontrada.");
    }
    const visibility = String(post.visibility ?? "public");
    if (visibility === "private" && post.userId !== voterId) {
      throw new HttpsError(
        "permission-denied",
        "Você não pode ver esta enquete."
      );
    }
    if (visibility === "followers" && post.userId !== voterId) {
      const follower = await transaction.get(
        db.collection("users").doc(String(post.userId))
          .collection("followers").doc(voterId)
      );
      if (!follower.exists) {
        throw new HttpsError(
          "permission-denied",
          "Você não pode ver esta enquete."
        );
      }
    }

    if (post.userId !== voterId) {
      const blocked = await transaction.get(
        db.collection("users").doc(String(post.userId))
          .collection("blockedUsers").doc(voterId)
      );
      if (blocked.exists) {
        throw new HttpsError(
          "permission-denied",
          "Você não pode votar nesta enquete."
        );
      }
    }

    const voteSnapshot = await transaction.get(voteRef);
    if (voteSnapshot.exists) {
      throw new HttpsError("already-exists", "Seu voto já foi registrado.");
    }

    const poll = post.poll as {
      options?: Array<{id?: unknown}>;
      endsAt?: Timestamp;
    } | undefined;
    const optionIds = Array.isArray(poll?.options)
      ? poll.options.map((option) => String(option?.id ?? ""))
      : [];
    if (!optionIds.includes(optionId)) {
      throw new HttpsError("invalid-argument", "Esta opção não existe.");
    }
    if (
      !(poll?.endsAt instanceof Timestamp) ||
      poll.endsAt.toMillis() <= Date.now()
    ) {
      throw new HttpsError("failed-precondition", "Esta enquete já terminou.");
    }

    const counts = (post.pollCounts && typeof post.pollCounts === "object")
      ? {...post.pollCounts} as Record<string, number>
      : {};
    const current = Number(counts[optionId] ?? 0);
    const total = Number(post.pollTotal ?? 0);
    counts[optionId] = Math.max(0, current) + 1;
    const nextTotal = Math.max(0, total) + 1;

    transaction.create(voteRef, {
      userId: voterId,
      optionId,
      createdAt: FieldValue.serverTimestamp(),
    });
    transaction.update(postRef, {
      [`pollCounts.${optionId}`]: counts[optionId],
      pollTotal: nextTotal,
    });

    return {optionId, pollCounts: counts, pollTotal: nextTotal};
  });
});

export const updateUserUsername = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError(
      "unauthenticated",
      "The function must be called while authenticated."
    );
  }
  const uid = request.auth.uid;
  if (
    request.auth.token.email_verified !== true ||
    request.auth.token.member !== true
  ) {
    throw new HttpsError(
      "failed-precondition",
      "Confirme seu e-mail antes de alterar o nome de usuario."
    );
  }
  const { newUsername } = request.data;

  if (
    !newUsername ||
    typeof newUsername !== "string" ||
    newUsername.length < 3 ||
    newUsername.length > 15 ||
    !/^[a-zA-Z0-9_]+$/.test(newUsername)
  ) {
    throw new HttpsError(
      "invalid-argument",
      "Invalid username format or length."
    );
  }

  const newUsernameLower = newUsername.toLowerCase();

  try {
    await db.runTransaction(async (transaction) => {
      const userRef = db.collection("users").doc(uid);
      const userDoc = await transaction.get(userRef);

      if (!userDoc.exists) {
        throw new HttpsError("not-found", "User not found.");
      }

      const oldUsername = userDoc.data()?.username;
      if (!oldUsername) {
        throw new HttpsError(
          "failed-precondition",
          "Current user does not have a username."
        );
      }

      const oldUsernameLower = String(oldUsername).toLowerCase();
      if (oldUsernameLower === newUsernameLower) {
        // No change needed, but not an error. Silently succeed.
        return;
      }

      const oldUsernameRef = db.collection("usernames").doc(oldUsernameLower);
      const newUsernameRef = db.collection("usernames").doc(newUsernameLower);

      const newUsernameDoc = await transaction.get(newUsernameRef);
      if (newUsernameDoc.exists) {
        throw new HttpsError("already-exists", "Username is already taken.");
      }

      // All checks passed, perform the atomic write
      transaction.delete(oldUsernameRef);
      transaction.set(newUsernameRef, { userId: uid });
      transaction.update(userRef, {
        username: newUsername,
        updatedAt: FieldValue.serverTimestamp(),
      });
    });

    return { status: "success", message: "Username updated successfully." };
  } catch (error) {
    if (error instanceof HttpsError) {
      throw error;
    }
    logger.error("Error in updateUserUsername transaction:", error);
    throw new HttpsError(
      "internal",
      "An unexpected error occurred while updating the username.",
      error
    );
  }
});

const profileVisibilityOf = (user: FirebaseFirestore.DocumentData) =>
  user.profileVisibility === "private" ? "private" : "public";

/**
 * Leva os posts do autor e as respostas a eles para a visibilidade do perfil
 * ATUAL (privado -> "followers"; público -> "public"); posts "private" (só o
 * autor) ficam como estão. Ao ficar privado, as citações de posts dele por
 * outras pessoas deixam de carregar a cópia do conteúdo (o app mostra o
 * original atualizado a quem puder vê-lo). Relê o perfil no fim e repete se
 * ele mudou de novo no meio do caminho.
 * @param {string} userId Autor.
 * @return {Promise<void>} Resolve depois de gravar tudo.
 */
const syncAuthorVisibility = async (userId: string): Promise<void> => {
  for (let attempt = 0; attempt < 3; attempt++) {
    const profile = await userRefOf(userId).get();
    if (!profile.exists) {
      return;
    }
    const target = profileVisibilityOf(profile.data() ?? {}) === "private" ?
      "followers" : "public";
    const writer = new FirestoreBatchWriter(db);
    let postsChanged = 0;
    let commentsChanged = 0;
    let quotesScrubbed = 0;

    const posts = await db.collection("posts")
      .where("userId", "==", userId).get();
    for (const post of posts.docs) {
      const current = post.get("visibility") ?? "public";
      if (current === "private" || current === target) {
        continue;
      }
      await writer.update(post.ref, {visibility: target});
      postsChanged++;
      const comments = await post.ref.collection("comments").get();
      for (const comment of comments.docs) {
        if (comment.get("postVisibility") !== target) {
          await writer.update(comment.ref, {postVisibility: target});
          commentsChanged++;
        }
      }
    }

    if (target === "followers") {
      const scrub = {
        "originalPostDetails.text": null,
        "originalPostDetails.media": null,
        "originalPostDetails.youtubeVideoId": null,
        "originalPostDetails.headline": null,
        "originalPostDetails.hasMedia": false,
        "originalPostDetails.originalPostDetails": null,
        "originalPostDetails.visibility": "followers",
      };
      const quotes = await db.collection("posts")
        .where("originalPostDetails.authorDetails.userId", "==", userId)
        .get();
      for (const quote of quotes.docs) {
        if (quote.get("userId") !== userId) {
          await writer.update(quote.ref, scrub);
          quotesScrubbed++;
        }
      }
      // Citação de uma citação: a cópia de dentro também é do autor privado.
      const nested = await db.collection("posts")
        .where(
          "originalPostDetails.originalPostDetails.authorDetails.userId",
          "==",
          userId
        )
        .get();
      for (const quote of nested.docs) {
        if (quote.get("userId") !== userId) {
          await writer.update(quote.ref, {
            "originalPostDetails.originalPostDetails": null,
          });
          quotesScrubbed++;
        }
      }
    }

    await writer.flush();
    logger.info(
      `Visibilidade de ${userId} -> ${target}: ${postsChanged} posts, ` +
        `${commentsChanged} respostas, ${quotesScrubbed} citações limpas.`
    );

    const again = await userRefOf(userId).get();
    const latest = profileVisibilityOf(again.data() ?? {}) === "private" ?
      "followers" : "public";
    if (latest === target) {
      return;
    }
  }
};

export const onUserUpdated = onDocumentUpdated(
  {
    document: "users/{userId}",
    database: DATABASE_ID,
  },
  async (event) => {
    const before = event.data?.before.data();
    const after = event.data?.after.data();

    if (!before || !after) {
      logger.info("User data is missing, exiting function.");
      return;
    }

    const userId = event.params.userId;
    const nameChanged = before.name !== after.name;
    const avatarChanged = before.avatarUrl !== after.avatarUrl;
    const usernameChanged = before.username !== after.username;

    // Perfil passou de público para privado (ou o contrário): os posts e as
    // respostas a eles acompanham.
    if (profileVisibilityOf(before) !== profileVisibilityOf(after)) {
      try {
        await syncAuthorVisibility(userId);
      } catch (error) {
        logger.error(`Failed to sync post visibility for ${userId}:`, error);
      }
      // A midia acompanha: perfil que vira privado precisa fechar a rota
      // publica E revogar o token, senao a imagem do post continua abrindo
      // para quem tem o link antigo.
      try {
        const vis =
          profileVisibilityOf(after) === "private" ? "private" : "public";
        const r = await applyMediaVisibilityByOwnerPosts(db, userId, vis);
        logger.info(
          `onUserUpdated ${userId}: midia -> ${vis}, ` +
          `${r.registros} registros, ${r.tokensRevogados} tokens`
        );
      } catch (error) {
        logger.error(`Failed to sync media for ${userId}:`, error);
      }
    }

    if (!nameChanged && !avatarChanged && !usernameChanged) {
      logger.info(`No relevant user fields changed for ${userId}.`);
      return;
    }

    // Só os campos que mudaram, por caminho ("authorDetails.name"...). Antes o
    // objeto authorDetails inteiro era trocado pelo parcial: trocar só a foto
    // apagava nome e @usuário de todos os posts e comentários da pessoa.
    const changes: Record<string, unknown> = {};
    if (nameChanged) {
      changes["authorDetails.name"] = after.name;
    }
    if (avatarChanged) {
      changes["authorDetails.avatarUrl"] = after.avatarUrl ?? null;
      changes["authorDetails.data-ai-hint"] = after["data-ai-hint"] || null;
    }
    if (usernameChanged) {
      changes["authorDetails.username"] = after.username;
    }
    const update =
      changes as FirebaseFirestore.UpdateData<FirebaseFirestore.DocumentData>;

    try {
      const writer = new FirestoreBatchWriter(db);
      const postsSnapshot = await db
        .collection("posts")
        .where("userId", "==", userId)
        .get();
      for (const doc of postsSnapshot.docs) {
        await writer.update(doc.ref, update);
      }
      const commentsSnapshot = await db
        .collectionGroup("comments")
        .where("userId", "==", userId)
        .get();
      for (const doc of commentsSnapshot.docs) {
        // Comentários novos não embutem o autor: só atualiza quem tem o cartão.
        if (doc.get("authorDetails")) {
          await writer.update(doc.ref, update);
        }
      }

      await writer.flush();
      logger.info(
        `Propagated user updates for ${userId} to ` +
          `${postsSnapshot.size} posts and ${commentsSnapshot.size} comments.`
      );
    } catch (error) {
      logger.error(`Failed to propagate user updates for ${userId}:`, error);
    }
  }
);

type CleanupOperation = {
  type: "delete" | "update";
  ref: FirebaseFirestore.DocumentReference;
  data?: FirebaseFirestore.UpdateData<FirebaseFirestore.DocumentData>;
};

export const onUserDeletedCleanup = functions
  .region(REGION)
  .auth.user()
  .onDelete(async (user: UserRecord) => {
    const uid = user.uid;
    logger.info(`[CLEANUP] Starting data cleanup for deleted user: ${uid}`);

    // --- Firestore Cleanup ---
    const MAX_WRITES_PER_BATCH = 499;
    const ops: CleanupOperation[] = [];

    try {
      // 1. Delete User Profile and Username documents
      const userDocRef = db.collection("users").doc(uid);
      const userDoc = await userDocRef.get();
      if (userDoc.exists) {
        const username = String(userDoc.data()?.username || "");
        if (username) {
          const unameLower = username.toLowerCase();
          const usernameDocRef = db.collection("usernames").doc(unameLower);
          ops.push({ type: "delete", ref: usernameDocRef });
        }
        ops.push({ type: "delete", ref: userDocRef });
      }
      ops.push({ type: "delete", ref: privateAccountRefOf(uid) });

      // Toda a midia da conta: tombstone no registro e token revogado no
      // Storage. Sem isto, excluir a conta deixava avatar, capa, anexos e
      // midia de post acessiveis para sempre por quem tivesse a URL antiga.
      try {
        const r = await tombstoneMediaByOwner(db, uid);
        logger.info(
          `[CLEANUP] ${uid}: ${r.registros} midias, ` +
          `${r.tokensRevogados} tokens revogados`
        );
      } catch (error) {
        logger.error(`[CLEANUP] falha na midia de ${uid}:`, error);
      }

      // Federação: marca o handle como removido, dá prazo para destruir a
      // chave e enfileira o Delete do ator. Sem isto a conta apagada seguiria
      // "viva" para os servidores que a seguiam, e o estado de federação
      // sobreviveria à exclusão.
      try {
        const r = await aoExcluirConta(db, uid, Date.now());
        logger.info(`[CLEANUP] ${uid}: federação ${r}`);
      } catch (error) {
        logger.error(`[CLEANUP] falha na federação de ${uid}:`, error);
      }

      // 2. Tombstone user's posts
      const postsSnapshot = await db
        .collection("posts")
        .where("userId", "==", uid)
        .get();
      const tombstoneData = {
        isDeleted: true,
        text: "[Post deleted by user]",
        headline: "[Post deleted]",
        media: null,
        youtubeVideoId: null,
        hasMedia: false,
        authorDetails: {
          userId: "deleted_user",
          name: "Deleted User",
          username: "deleted",
          avatarUrl: null,
        },
      };
      postsSnapshot.forEach((doc: QueryDocumentSnapshot) =>
        ops.push({ type: "update", ref: doc.ref, data: tombstoneData })
      );

      // 3. Tombstone user's comments
      const commentsSnapshot = await db
        .collectionGroup("comments")
        .where("userId", "==", uid)
        .get();
      const tombstoneCommentData = {
        isDeleted: true,
        text: "[Comment deleted by user]",
        media: null,
        youtubeVideoId: null,
        hasMedia: false,
        authorDetails: {
          userId: "deleted_user",
          name: "Deleted User",
          username: "deleted",
          avatarUrl: null,
        },
      };
      commentsSnapshot.forEach((doc: QueryDocumentSnapshot) =>
        ops.push({ type: "update", ref: doc.ref, data: tombstoneCommentData })
      );

      // 4. Delete ephemeral data & user associations
      const likesSnapshot = await db
        .collectionGroup("likes")
        .where("userId", "==", uid)
        .get();
      likesSnapshot.forEach((doc: QueryDocumentSnapshot) =>
        ops.push({ type: "delete", ref: doc.ref })
      );

      const repostsSnapshot = await db
        .collectionGroup("reposts")
        .where("userId", "==", uid)
        .get();
      repostsSnapshot.forEach((doc: QueryDocumentSnapshot) =>
        ops.push({ type: "delete", ref: doc.ref })
      );

      const pollVotesSnapshot = await db
        .collectionGroup("pollVotes")
        .where("userId", "==", uid)
        .get();
      pollVotesSnapshot.forEach((doc: QueryDocumentSnapshot) =>
        ops.push({type: "delete", ref: doc.ref})
      );

      const bookmarksSnapshot = await db
        .collection("users")
        .doc(uid)
        .collection("bookmarks")
        .get();
      bookmarksSnapshot.forEach((doc: QueryDocumentSnapshot) =>
        ops.push({ type: "delete", ref: doc.ref })
      );

      const notificationsSnapshot = await db
        .collection("notifications")
        .where("recipientId", "==", uid)
        .get();
      notificationsSnapshot.forEach((doc: QueryDocumentSnapshot) =>
        ops.push({ type: "delete", ref: doc.ref })
      );

      const fcmTokensSnapshot = await db
        .collection("users")
        .doc(uid)
        .collection("fcmTokens")
        .get();
      fcmTokensSnapshot.forEach((doc: QueryDocumentSnapshot) =>
        ops.push({ type: "delete", ref: doc.ref })
      );

      // Credenciais e historico tecnico das integracoes sociais. A rota de
      // exclusao tenta revogar nos provedores antes; este gatilho e a rede de
      // seguranca local caso a conta seja apagada por outro caminho.
      const [socialConnections, socialLinks, socialPublications] =
        await Promise.all([
          db.collection("social_connections").where("uid", "==", uid).get(),
          db.collection("social_oauth_links").where("uid", "==", uid).get(),
          db.collection("social_publications").where("uid", "==", uid).get(),
        ]);
      for (const doc of socialConnections.docs) {
        const did = doc.get("did");
        if (typeof did === "string" && did) {
          const sessionId = createHash("sha256").update(did).digest("hex");
          ops.push({
            type: "delete",
            ref: db.collection("social_atproto_sessions").doc(sessionId),
          });
        }
        ops.push({type: "delete", ref: doc.ref});
      }
      socialLinks.forEach((doc) =>
        ops.push({type: "delete", ref: doc.ref})
      );
      socialPublications.forEach((doc) =>
        ops.push({type: "delete", ref: doc.ref})
      );

      // Desfaz as relações de seguir nos dois sentidos. Os contadores dos
      // outros perfis são devolvidos pela Function onUserUnfollowed, que roda
      // quando cada followers/{id} é apagado (aqui só se apagam documentos).
      const followingSnapshot = await db
        .collection("users")
        .doc(uid)
        .collection("following")
        .get();
      for (const doc of followingSnapshot.docs) {
        const followedUserId = doc.id;
        ops.push({
          type: "delete",
          ref: userRefOf(followedUserId).collection("followers").doc(uid),
        });
        ops.push({ type: "delete", ref: doc.ref });
      }

      const followersSnapshot = await db
        .collection("users")
        .doc(uid)
        .collection("followers")
        .get();
      for (const doc of followersSnapshot.docs) {
        const followerUserId = doc.id;
        ops.push({
          type: "delete",
          ref: userRefOf(followerUserId).collection("following").doc(uid),
        });
        ops.push({ type: "delete", ref: doc.ref });
      }

      // Execute all operations in batches
      for (let i = 0; i < ops.length; i += MAX_WRITES_PER_BATCH) {
        const batch = db.batch();
        const chunk = ops.slice(i, i + MAX_WRITES_PER_BATCH);
        for (const op of chunk) {
          if (op.type === "delete") {
            batch.delete(op.ref);
          } else if (op.type === "update" && op.data) {
            batch.update(op.ref, op.data);
          }
        }
        const batchCommitMsg =
          `[CLEANUP] Committing batch of ${chunk.length} ops for ${uid}.`;
        logger.info(batchCommitMsg);
        await batch.commit();
      }

      const finalMsg =
        `[CLEANUP] Cleanup for ${uid} done. Total ops: ${ops.length}.`;
      logger.info(finalMsg);
    } catch (error) {
      logger.error(`[CLEANUP] Error during cleanup for user ${uid}:`, error);
    }
  });

type StoredNotification = PushNotification & {
  recipientId?: string;
  readAt?: unknown;
};

/**
 * Envia o push de uma notificação para todos os aparelhos de quem recebe
 * (nos emuladores, onde não existe FCM, guarda o que SERIA enviado).
 * @param {string} deliveryId Id desta entrega: o da notificação quando ela
 * nasce; "id-contador" a cada reenvio por agregação.
 * @param {string} notificationId Id do documento da notificação.
 * @param {StoredNotification} data Dados da notificação.
 * @return {Promise<void>} Resolve depois de enviar.
 */
const sendPushForNotification = async (
  deliveryId: string,
  notificationId: string,
  data: StoredNotification
): Promise<void> => {
  const recipientId = data.recipientId;
  if (!recipientId || !data.actors || data.actors.length === 0) {
    logger.info(`[PUSH] ${notificationId} sem destinatário ou autor.`);
    return;
  }

  const tokensSnap = await db
    .collection(`users/${recipientId}/fcmTokens`)
    .get();
  if (tokensSnap.empty) {
    logger.info(`[PUSH] No FCM tokens found for user ${recipientId}.`);
    return;
  }
  const devices: PushToken[] = tokensSnap.docs.map((doc) => ({
    token: doc.id,
    locale: normalizeLocale(doc.get("locale")),
    platform: normalizePlatform(doc.get("platform")),
  }));

  // Mensagem direta: o contador da notificação soma desde que ela nasceu,
  // mesmo que a conversa já tenha sido aberta. O que vale é quantas a pessoa
  // ainda não leu (a conversa guarda isso por pessoa).
  let notification: PushNotification = data;
  if (data.type === "new_message" && data.entityId) {
    const conversation = await db
      .collection("conversations")
      .doc(data.entityId)
      .get();
    const unread = Number(conversation.get(`unreadCounts.${recipientId}`));
    if (unread >= 1) {
      notification = {...data, count: unread};
    }
  }

  // Uma mensagem por idioma dos aparelhos: texto, destino do toque, tag de
  // agrupamento e ajustes de Android e navegador (veja push.ts).
  const messages = buildPushMessages(
    notification,
    notificationId,
    devices,
    SITE_URL
  );

  // Nos emuladores não existe FCM: a mensagem montada fica em _pushOutbox
  // (só as Functions leem) para os testes conferirem o que SERIA enviado.
  if (process.env.FUNCTIONS_EMULATOR === "true") {
    await db.collection("_pushOutbox").doc(deliveryId).set({
      recipientId,
      type: data.type,
      notificationId,
      count: Number(notification.count) || 1,
      createdAt: FieldValue.serverTimestamp(),
      messages: messages.map((m) => JSON.parse(JSON.stringify(m))),
    });
    return;
  }

  for (const message of messages) {
    // API HTTP v1 do FCM (sendEachForMulticast). A antiga sendToDevice
    // usava a API legada, que o Google desligou: todo envio falhava.
    const response = await getMessaging().sendEachForMulticast(message);

    const tokensToRemove: Promise<FirebaseFirestore.WriteResult>[] = [];
    response.responses.forEach((result, index) => {
      const error = result.error;
      if (error) {
        const logMessage =
          "[PUSH] Failure sending notification to " +
          `${message.tokens[index]}`;
        logger.error(logMessage, error);
        if (
          [
            "messaging/invalid-registration-token",
            "messaging/registration-token-not-registered",
          ].includes(error.code)
        ) {
          const docRef = db.doc(
            `users/${recipientId}/fcmTokens/${message.tokens[index]}`
          );
          tokensToRemove.push(docRef.delete());
        }
      }
    });

    if (tokensToRemove.length > 0) {
      await Promise.all(tokensToRemove);
      const msg =
        `[PUSH] Cleaned up ${tokensToRemove.length} invalid ` +
        `tokens for ${recipientId}.`;
      logger.info(msg);
    }
  }
};

export const onNotificationCreatedSendPush = onDocumentCreated(
  { document: "notifications/{notificationId}", database: DATABASE_ID },
  async (e) => {
    const snap = e.data;
    if (!snap) {
      logger.warn("[PUSH] Notification data missing on create, skipping push.");
      return;
    }
    const notification = snap.data() as StoredNotification | undefined;
    if (!notification) {
      logger.warn(`[PUSH] Notification ${snap.id} sem dados, ignorada.`);
      return;
    }
    if (!wantsPush(notification.type)) {
      return;
    }
    await sendPushForNotification(snap.id, snap.id, notification);
  }
);

// Notificações agregadas (várias curtidas no mesmo post, várias mensagens da
// mesma conversa) NÃO criam um documento novo: só somam no existente. Sem este
// gatilho a 2ª mensagem de uma conversa, dentro de 5 minutos, não avisava
// ninguém. Mensagem direta avisa sempre; curtidas e afins, só nas marcas
// (5, 10, 25...) para não virar spam (veja shouldPushOnUpdate).
export const onNotificationUpdatedSendPush = onDocumentUpdated(
  { document: "notifications/{notificationId}", database: DATABASE_ID },
  async (e) => {
    const before = e.data?.before.data() as StoredNotification | undefined;
    const after = e.data?.after.data() as StoredNotification | undefined;
    if (!before || !after || after.readAt) {
      return;
    }
    const countBefore = Number(before.count) || 1;
    const countAfter = Number(after.count) || 1;
    if (!shouldPushOnUpdate(after.type, countBefore, countAfter)) {
      return;
    }
    const id = e.params.notificationId;
    await sendPushForNotification(`${id}-${countAfter}`, id, after);
  }
);

/**
 * Aggregates access events into daily summaries.
 * This function is scheduled to run daily at 2 AM UTC.
 * It processes events from the previous day, aggregates them,
 * and deletes the raw events.
 */
export const aggregateAccessEvents = onSchedule(
  "every day 02:00",
  async () => {
    logger.info("Starting daily aggregation of access events.");

    const now = new Date();
    const yesterday = new Date();
    yesterday.setDate(now.getDate() - 1);

    const startOfYesterday = new Date(yesterday);
    startOfYesterday.setUTCHours(0, 0, 0, 0);

    const endOfYesterday = new Date(yesterday);
    endOfYesterday.setUTCHours(23, 59, 59, 999);

    const dateString = startOfYesterday.toISOString().split("T")[0];

    const startISO = startOfYesterday.toISOString();
    const endISO = endOfYesterday.toISOString();
    logger.info(`Aggregating events from ${startISO} to ${endISO}`);

    const eventsQuery = db
      .collection("access_events")
      .where("serverTimestamp", ">=", startOfYesterday)
      .where("serverTimestamp", "<=", endOfYesterday);

    try {
      const snapshot = await eventsQuery.get();
      if (snapshot.empty) {
        logger.info("No access events to aggregate for yesterday.");
        return;
      }

      type AggregationValue = {
        count: number;
        date: string;
        audienceType: string;
        path: string;
        countryCode: string | null;
        countryName: string | null;
        stateCode: string | null;
        stateName: string | null;
        city: string | null;
      };

      const aggregations = new Map<string, AggregationValue>();

      snapshot.forEach((doc: QueryDocumentSnapshot) => {
        const eventData = doc.data();
        const path = eventData.path || "/";
        const audienceType = eventData.audienceType || "unknown";

        // Use the geo data passed from the client-side API
        const countryCode = eventData.geo?.countryCode || "XX";
        const countryName = eventData.geo?.countryName || "Unknown";
        const stateCode = eventData.geo?.stateCode || null;
        const stateName = eventData.geo?.stateName || null;
        const city = eventData.geo?.city || null;

        const key = `${audienceType}|${path}|${countryCode}|${
          stateCode || "none"
        }|${city || "none"}`;

        const current = aggregations.get(key) || {
          count: 0,
          date: dateString,
          audienceType: audienceType,
          path: path,
          countryCode: countryCode,
          countryName: countryName,
          stateCode: stateCode,
          stateName: stateName,
          city: city,
        };
        current.count += 1;
        aggregations.set(key, current);
      });

      const logMsg =
        `Found ${snapshot.size} events, resulting in ` +
        `${aggregations.size} aggregation docs to update.`;
      logger.info(logMsg);

      const batch = db.batch();
      const aggCollectionRef = db.collection("access_agg_daily");

      aggregations.forEach((data) => {
        const safePath = Buffer.from(data.path)
          .toString("base64")
          .replace(/=/g, "")
          .substring(0, 70);
        const safeCity = data.city
          ? Buffer.from(data.city).toString("base64").replace(/=/g, "")
          : "none";

        const docId = [
          data.date,
          data.audienceType,
          data.countryCode,
          data.stateCode || "none",
          safeCity,
          safePath,
        ].join("_");

        const docRef = db.doc(`${aggCollectionRef.path}/${docId}`);

        batch.set(
          docRef,
          {
            ...data,
            count: FieldValue.increment(data.count),
          },
          {
            merge: true,
          }
        );
      });

      snapshot.docs.forEach((doc: QueryDocumentSnapshot) => {
        batch.delete(doc.ref);
      });

      await batch.commit();
      const successMsg =
        "Successfully aggregated and cleaned up " +
        `${snapshot.size} raw access events.`;
      logger.info(successMsg);
    } catch (error) {
      logger.error("Error during access event aggregation:", error);
    }
  }
);

export const fetchTrendingNews = onSchedule("every 2 hours", async () => {
  logger.info("Fetching trending news from RSS feeds...");
  
  const parser = new Parser({
    customFields: {
      item: [
        ["media:content", "mediaContent"],
        ["media:thumbnail", "mediaThumbnail"],
      ],
    },
  });
  const trendingTopicsCol = db.collection("trending_topics");

  const RSS_FEEDS = [
    { name: "BBC Brasil", url: "https://feeds.bbci.co.uk/portuguese/rss.xml" },
    { name: "Reuters", url: "https://www.reuters.com/tools/rss" },
  ];

  const fetchPromises = RSS_FEEDS.map(async (feedSource) => {
    try {
      const feed = await parser.parseURL(feedSource.url);
      logger.info(
        `Fetched ${feed.items.length} items from ${feedSource.name}`
      );

      const batch = db.batch();
      for (const item of feed.items) {
        if (!item.link || !item.title) continue;

        const docId = Buffer.from(item.link).toString("hex");
        const docRef = trendingTopicsCol.doc(docId);

        const docSnap = await docRef.get();
        if (!docSnap.exists) {
          
          let imgUrl = item.enclosure?.url || null;
          if (!imgUrl && item.mediaContent && item.mediaContent["$"]) {
            imgUrl = item.mediaContent["$"].url;
          }
          if (!imgUrl && item.mediaThumbnail && item.mediaThumbnail["$"]) {
            imgUrl = item.mediaThumbnail["$"].url;
          }

          const newItem = {
            title: item.title,
            link: item.link,
            pubDate: item.pubDate
              ? Timestamp.fromDate(new Date(item.pubDate))
              : Timestamp.now(),
            snippet: item.contentSnippet?.substring(0, 200) || null,
            source: feedSource.name,
            imageUrl: imgUrl, 
            fetchedAt: Timestamp.now(),
            processed: false, 
          };
          batch.set(docRef, newItem);
        }
      }
      await batch.commit();
    } catch (error) {
      logger.error(
        `Failed to process feed from ${feedSource.name}:`,
        error
      );
    }
  });

  await Promise.all(fetchPromises);
  logger.info("Finished fetching all RSS feeds.");

  const fortyEightHoursAgo = Timestamp.fromMillis(
    Date.now() - 48 * 60 * 60 * 1000
  );
  const oldDocsQuery = trendingTopicsCol.where(
    "fetchedAt",
    "<",
    fortyEightHoursAgo
  );

  try {
    const oldDocsSnapshot = await oldDocsQuery.get();
    if (!oldDocsSnapshot.empty) {
      const deleteBatch = db.batch();
      oldDocsSnapshot.forEach((doc) => deleteBatch.delete(doc.ref));
      await deleteBatch.commit();
      logger.info(`Cleaned up ${oldDocsSnapshot.size} old trending topics.`);
    }
  } catch (error) {
    logger.error("Failed to clean up old trending topics:", error);
  }
});

/**
 * Federação (ActivityPub): enfileira o que mudou num post para o worker do
 * site entregar. NÃO assina nem fala com servidor remoto. A maioria das
 * escritas em `posts` são contadores gravados por outras Functions; elas saem
 * daqui em uma comparação, sem tocar no banco.
 */
export const apPostFederation = onDocumentWritten(
  {
    document: "posts/{postId}",
    database: DATABASE_ID,
  },
  async (e) => {
    const resultado = await aoEscreverPost(db, {
      idDoEvento: e.id,
      postId: e.params.postId,
      antes: e.data?.before?.data(),
      depois: e.data?.after?.data(),
      agora: Date.now(),
    });
    if (resultado !== "ignorado") {
      logger.info(`[federacao] post ${e.params.postId}: ${resultado}`);
    }
  }
);

export const apCommentFederation = onDocumentWritten(
  {
    document: "posts/{postId}/comments/{commentId}",
    database: DATABASE_ID,
  },
  async (e) => {
    const resultado = await aoEscreverComentario(db, {
      idDoEvento: e.id,
      postId: e.params.postId,
      commentId: e.params.commentId,
      antes: e.data?.before?.data(),
      depois: e.data?.after?.data(),
      agora: Date.now(),
    });
    if (resultado !== "ignorado") {
      logger.info(
        `[federacao] comment ${e.params.postId}/${e.params.commentId}: ` +
        resultado
      );
    }
  }
);

/**
 * Aciona o worker de entrega do Fediverso (/api/ap/worker) periodicamente com
 * token OIDC da conta de serviço do projeto, sem segredo compartilhado.
 */
export const apWorkerTick = onSchedule(
  {
    schedule: "every 2 minutes",
    region: REGION,
    maxInstances: 1,
    timeoutSeconds: 65,
  },
  async () => {
    const platSnap = await db.collection("config").doc("federation").get();
    const plat = platSnap.data();
    if (!plat?.enabled || plat?.killSwitch) return;

    const targetUrl = "https://exercitodolula.app/api/ap/worker";
    const {GoogleAuth} = await import("google-auth-library");
    const auth = new GoogleAuth();
    const client = await auth.getIdTokenClient(targetUrl);
    const res = await client.request({url: targetUrl, method: "POST"});
    logger.info("[federacao] apWorkerTick", res.data);
  }
);

/**
 * O navegador envia o original para a área transitória do Storage. Este
 * gatilho confere objeto, registro e dono antes de iniciar o worker.
 */
export const onVideoSourceUploaded = onObjectFinalized(
  {
    bucket: STORAGE_BUCKET,
    serviceAccount: VIDEO_DISPATCHER_SERVICE_ACCOUNT,
  },
  async (event) => {
    const object = event.data;
    const match = /^video_staging\/([^/]+)\/([A-Za-z0-9_-]{22})\/source$/.exec(
      object.name || ""
    );
    if (!match) return;
    const [, ownerUid, mediaId] = match;
    const uploadRef = db.collection("videoUploads").doc(mediaId);
    const snapshot = await uploadRef.get();
    if (!snapshot.exists) {
      logger.error(
        `[video] fonte ${mediaId} sem registro; worker não iniciado`
      );
      return;
    }
    const data = snapshot.data() || {};
    const metadataMediaId = object.metadata?.mediaId;
    if (
      data.ownerUid !== ownerUid ||
      data.sourcePath !== object.name ||
      metadataMediaId !== mediaId ||
      !String(object.contentType || "").startsWith("video/")
    ) {
      logger.error(
        `[video] metadados divergentes para ${mediaId}; worker não iniciado`
      );
      await uploadRef.update({
        status: "failed",
        errorCode: "source-metadata-mismatch",
        updatedAt: FieldValue.serverTimestamp(),
      });
      await db.collection("media").doc(mediaId).update({
        processingStatus: "failed",
        processingError: "source-metadata-mismatch",
        updatedAt: FieldValue.serverTimestamp(),
      });
      return;
    }

    await uploadRef.update({
      status: "queued",
      uploadedSize: Number(object.size || 0),
      sourceGeneration: object.generation || null,
      uploadCompletedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
    await db.collection("media").doc(mediaId).update({
      processingStatus: "queued",
      updatedAt: FieldValue.serverTimestamp(),
    });
    await dispatchVideoTranscode(db, mediaId);
  }
);

/** Recolhe lançamentos que falharam antes de chegar ao worker. */
export const dispatchQueuedVideoTranscodes = onSchedule(
  {
    schedule: "every 5 minutes",
    timeZone: "America/Sao_Paulo",
    serviceAccount: VIDEO_DISPATCHER_SERVICE_ACCOUNT,
  },
  async () => {
    const queued = await db.collection("videoUploads")
      .where("status", "==", "queued")
      .orderBy("createdAt", "asc")
      .limit(10)
      .get();
    for (const document of queued.docs) {
      await dispatchVideoTranscode(db, document.id);
    }
  }
);


// Comentario "tombado" (tinha respostas): o conteudo sai do documento e a
// midia dele sai do ar e do bucket, como no post.
export const onCommentUpdated = onDocumentUpdated(
  {
    document: "posts/{postId}/comments/{commentId}",
    database: DATABASE_ID,
  },
  async (e) => {
    const before = e.data?.before.data();
    const after = e.data?.after.data();
    if (!before || !after) return;
    if (before.isDeleted !== true && after.isDeleted === true) {
      await purgarMidiaDe(
        before,
        before.userId,
        `onCommentUpdated ${e.params.commentId}`
      );
    }
  }
);

// Mensagem apagada: o anexo (privado, servido por /mp) sai do ar e do bucket.
// Antes so o documento da mensagem era apagado e o arquivo seguia acessivel
// ao dono e ao participante.
export const onDirectMessageDeleted = onDocumentDeleted(
  {
    document: "conversations/{conversationId}/messages/{messageId}",
    database: DATABASE_ID,
  },
  async (e) => {
    const message = e.data?.data();
    await purgarMidiaDe(
      message,
      message?.senderId,
      `onDirectMessageDeleted ${e.params.messageId}`
    );
  }
);