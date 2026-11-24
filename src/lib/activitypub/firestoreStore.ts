// src/lib/activitypub/firestoreStore.ts
// O adaptador do Firestore para o contrato `FederationStore`. É uma camada FINA de propósito: a lógica de segurança
// vive nos serviços, que são testados em memória; aqui só se traduz o contrato para coleções e documentos. Esta camada
// é conferida por um teste de CONTRATO que roda a mesma bateria contra a implementação em memória e contra este
// adaptador no emulador (e2e/ap-firestore-store-check.mjs).
//
// DECISÕES QUE O CÓDIGO NÃO MOSTRA:
//
// - **Nenhuma consulta exige índice composto**, salvo uma, declarada (`ap_deliveries`: uid + createdAtMs). O emulador
//   NÃO valida índices — foi assim que faltaram três índices em produção em outubro. Tudo o mais usa igualdade em
//   campo único, ou um único campo de ordenação, ou ordena pelo ID do documento (que o índice de campo único já
//   carrega).
// - **A fila sai do índice quando termina.** `nextAttemptAt` é APAGADO (não zerado) ao concluir uma tarefa ou entrega:
//   a consulta "vencidas" é uma desigualdade num campo só e nunca precisa filtrar por estado.
// - **Posse temporária (lease) por transação.** Duas execuções do worker ao mesmo tempo disputam o mesmo documento; a
//   transação lê `leaseUntil` e só uma ganha. Se a execução cai, a posse vence sozinha e outra assume.
// - **Toda coleção `ap_*` que cresce tem `expireAt` e política de TTL** (`firestore.indexes.json`). A rede já teve
//   campo de expiração sem TTL; não repetir.
// - **Chave privada só cifrada**, em `ap_keys`, sem nenhuma regra que a libere ao cliente (acesso negado por padrão).
import { remoteFollowDocIdOf, remoteHashOf, remoteObjectKeyOf, remotePostIdOf, remoteUserIdOf } from './remoteIdentity.ts';
import { SUSPENDED_FEDIVERSE_DOMAINS } from '../federation/suspendedDomains.ts';
import { LRUCache } from 'lru-cache';
import type { DocumentData, Firestore, FieldPath as FieldPathType, FieldValue as FieldValueType, Timestamp as TimestampType } from 'firebase-admin/firestore';
import type { SealedSecret } from './keys.ts';
import type { InstancePolicy, PlatformFlags, UserBlock } from './gate.ts';
import type {
  AccountRecord, AuditEntry, DeliveryRecord, DomainHealth, FederatedObject, FederationStore, FollowerRecord, HandleRecord,
  HandleState, LocalComment, LocalPost, LocalProfile, OutboundJob, RemoteActorRecord, RemoteFlag,
} from './store.ts';

export type FirestoreStoreDeps = {
  db: Firestore;
  FieldValue: typeof FieldValueType;
  Timestamp: typeof TimestampType;
  FieldPath: typeof FieldPathType;
  now: () => number;
};

const DIA = 24 * 3600 * 1000;
const sha = remoteHashOf;
const HASHTAG_DO_TEXTO = /#([a-zA-Z0-9_áéíóúÁÉÍÓÚàèìòùÀÈÌÒÙâêîôûÂÊÎÔÛãõÃÕçÇ]+)/g;
/** O que sobra de um post remoto que o autor apagou na origem: sem texto nem mídia, fora de todos os feeds. */
export const TUMULO_DE_POST_REMOTO = { isDeleted: true, text: '[Post removido na origem]', media: null, hasMedia: false, hashtags: null } as const;
const jaExiste = (erro: unknown) => {
  const code = (erro as { code?: number | string })?.code;
  return code === 6 || code === 'already-exists';
};

/** Timestamp do Firestore, `Date`, número ou texto ISO → milissegundos. */
export function toMillis(valor: unknown): number {
  if (typeof valor === 'number') return valor;
  if (valor && typeof (valor as { toMillis?: unknown }).toMillis === 'function') return (valor as { toMillis(): number }).toMillis();
  if (valor instanceof Date) return valor.getTime();
  if (typeof valor === 'string') {
    const t = Date.parse(valor);
    return Number.isFinite(t) ? t : 0;
  }
  return 0;
}

const texto = (v: unknown): string => (typeof v === 'string' ? v : '');
const textoOuNulo = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

export function createFirestoreStore(deps: FirestoreStoreDeps): FederationStore & { invalidateCaches(): void } {
  const { db, FieldValue, Timestamp, FieldPath, now } = deps;
  const expira = (ms: number) => Timestamp.fromMillis(ms);

  // ── caches de configuração ──
  // Botão de emergência com atraso de até 10 s por instância: o preço de não ler o Firestore a cada requisição.
  let cachePlataforma: { em: number; valor: PlatformFlags } | null = null;
  let cachePolitica: { em: number; valor: InstancePolicy } | null = null;
  const TTL_PLATAFORMA = 10_000;
  const TTL_POLITICA = 30_000;
  const cacheAtoresRemotos = new LRUCache<string, RemoteActorRecord>({ max: 1000, ttl: 10 * 60 * 1000 });

  /** Posse temporária por transação. Devolve os dados do documento se esta execução ganhou a disputa. */
  async function reivindicar(colecao: string, id: string, agora: number, posseMs: number, estadoCampo: 'state' | 'status'): Promise<DocumentData | null> {
    const ref = db.collection(colecao).doc(id);
    return db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) return null;
      const d = snap.data() as DocumentData;
      if (d[estadoCampo] !== 'pending') return null;
      if (typeof d.nextAttemptAt !== 'number' || d.nextAttemptAt > agora) return null;
      if (typeof d.leaseUntil === 'number' && d.leaseUntil > agora) return null;
      tx.update(ref, { leaseUntil: agora + posseMs });
      return d;
    });
  }

  async function devidos(colecao: string, estadoCampo: 'state' | 'status', agora: number, limite: number, posseMs: number): Promise<DocumentData[]> {
    // Janela maior que o limite: parte dos primeiros pode estar com posse de outra execução.
    const snap = await db.collection(colecao).where('nextAttemptAt', '<=', agora).orderBy('nextAttemptAt').limit(limite * 3).get();
    const ganhos: DocumentData[] = [];
    for (const doc of snap.docs) {
      if (ganhos.length >= limite) break;
      const d = await reivindicar(colecao, doc.id, agora, posseMs, estadoCampo);
      if (d) ganhos.push(d);
    }
    return ganhos;
  }

  async function ensureRemoteUserDoc(actor: {
    actorId: string;
    handle: string;
    domain: string;
    name?: string | null;
    summary?: string | null;
    iconUrl?: string | null;
    inbox?: string | null;
    sharedInbox?: string | null;
    discoverable?: boolean;
    indexable?: boolean;
  }): Promise<string> {
    const remoteUid = remoteUserIdOf(actor.actorId);
    await db.collection('users').doc(remoteUid).set({
      id: remoteUid,
      name: actor.name || actor.handle,
      username: actor.handle,
      bio: actor.summary || '',
      avatarUrl: actor.iconUrl || '',
      profileVisibility: 'public',
      isRemoteFediverse: true,
      remoteActorId: actor.actorId,
      remoteDomain: actor.domain,
      remoteInbox: actor.inbox || actor.sharedInbox || null,
      // O que a pessoa disse no próprio ator sobre ser descoberta e indexada. Só grava quando o ator foi LIDO agora
      // (campo presente): registro sem a informação não pode apagar a escolha guardada antes.
      ...(typeof actor.discoverable === 'boolean' ? { remoteDiscoverable: actor.discoverable } : {}),
      ...(typeof actor.indexable === 'boolean' ? { remoteIndexable: actor.indexable } : {}),
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    return remoteUid;
  }

  /** Marca (curtida ou repost) de um ator remoto num COMENTÁRIO nosso. */
  async function marcarComentario(
    sub: 'likes' | 'reposts',
    postId: string,
    commentId: string,
    actor: RemoteActorRecord,
    activityId: string,
  ): Promise<'added' | 'duplicate' | 'missing-comment'> {
    const comentario = db.collection('posts').doc(postId).collection('comments').doc(commentId);
    const snap = await comentario.get();
    if (!snap.exists || snap.data()?.isDeleted === true) return 'missing-comment';
    const remoteUid = await ensureRemoteUserDoc(actor);
    try {
      await comentario.collection(sub).doc(remoteUid).create({
        userId: remoteUid,
        apActorId: actor.actorId,
        apHandle: actor.handle,
        apActivityId: activityId,
        isRemoteFediverse: true,
        createdAt: FieldValue.serverTimestamp(),
      });
      return 'added';
    } catch (e) {
      if (jaExiste(e)) return 'duplicate';
      throw e;
    }
  }
  async function desmarcarComentario(sub: 'likes' | 'reposts', postId: string, commentId: string, actorId: string): Promise<boolean> {
    const ref = db.collection('posts').doc(postId).collection('comments').doc(commentId).collection(sub).doc(remoteUserIdOf(actorId));
    if (!(await ref.get()).exists) return false;
    await ref.delete();
    return true;
  }
  /** O post remoto guardado para um id ActivityPub, SE foi criado por este mesmo ator (e ainda está no ar). */
  async function postRemotoDoAtor(apObjectId: string, actorId: string) {
    const candidatos = [db.collection('posts').doc(remotePostIdOf(apObjectId))];
    for (const ref of candidatos) {
      const snap = await ref.get();
      const d = snap.data();
      if (snap.exists && d?.remoteActorId === actorId && d?.isDeleted !== true) return ref;
    }
    // Posts antigos, sincronizados pelo perfil, guardam a URL da página como id do objeto: acha por ela.
    const porUrl = await db.collection('posts').where('remoteObjectId', '==', apObjectId).limit(3).get();
    const achado = porUrl.docs.find((x) => x.data().remoteActorId === actorId && x.data().isDeleted !== true);
    return achado ? achado.ref : null;
  }

  const comoHandle = (d: DocumentData): HandleRecord => ({
    handle: texto(d.handle), uid: texto(d.uid), state: d.state as HandleState, publicKeyPem: texto(d.publicKeyPem),
    createdAtMs: toMillis(d.createdAtMs), keyDeleteAfterMs: typeof d.keyDeleteAfterMs === 'number' ? d.keyDeleteAfterMs : null,
  });
  const comoSeguidor = (d: DocumentData): FollowerRecord => {
    let atividade: Record<string, unknown> = {};
    try { atividade = JSON.parse(texto(d.followActivityJson)) as Record<string, unknown>; } catch { atividade = {}; }
    return {
      uid: texto(d.uid), actorId: texto(d.actorId), inbox: texto(d.inbox), sharedInbox: textoOuNulo(d.sharedInbox),
      domain: texto(d.domain), followActivity: atividade, createdAtMs: toMillis(d.createdAtMs),
    };
  };
  const comoEntrega = (d: DocumentData): DeliveryRecord => ({
    id: texto(d.id), uid: texto(d.uid), op: d.op, objectId: texto(d.objectId), activityId: texto(d.activityId),
    targetInbox: texto(d.targetInbox), domain: texto(d.domain), body: texto(d.body), status: d.status,
    attempts: typeof d.attempts === 'number' ? d.attempts : 0, nextAttemptAt: typeof d.nextAttemptAt === 'number' ? d.nextAttemptAt : null,
    lastDetail: textoOuNulo(d.lastDetail), lastOutcome: d.lastOutcome ?? null, createdAtMs: toMillis(d.createdAtMs),
    sentAtMs: typeof d.sentAtMs === 'number' ? d.sentAtMs : null,
  });
  const comoTarefa = (d: DocumentData): OutboundJob => ({
    id: texto(d.id), op: d.op, uid: texto(d.uid), postId: textoOuNulo(d.postId), targets: Array.isArray(d.targets) ? d.targets : null,
    createdAtMs: toMillis(d.createdAtMs), nextAttemptAt: typeof d.nextAttemptAt === 'number' ? d.nextAttemptAt : null,
    attempts: typeof d.attempts === 'number' ? d.attempts : 0, state: d.state, note: textoOuNulo(d.note),
  });
  const comoObjeto = (d: DocumentData): FederatedObject => ({
    postId: texto(d.postId), uid: texto(d.uid), objectId: texto(d.objectId), scope: d.scope, createdAtMs: toMillis(d.createdAtMs),
    state: d.state, lastActivityAtMs: toMillis(d.lastActivityAtMs),
  });

  const store: FederationStore & { invalidateCaches(): void } = {
    invalidateCaches() { cachePlataforma = null; cachePolitica = null; cacheAtoresRemotos.clear(); },

    // ── configuração da casa ──
    async getPlatform() {
      const agora = now();
      if (cachePlataforma && agora - cachePlataforma.em < TTL_PLATAFORMA) return cachePlataforma.valor;
      const snap = await db.collection('config').doc('federation').get();
      const d = snap.data() ?? {};
      // Sem o documento a federação está DESLIGADA: o padrão é sempre o seguro.
      const valor: PlatformFlags = { enabled: d.enabled === true, killSwitch: d.killSwitch === true, mode: d.mode === 'allowlist' ? 'allowlist' : 'open' };
      cachePlataforma = { em: agora, valor };
      return valor;
    },
    async getInstancePolicy() {
      const agora = now();
      if (cachePolitica && agora - cachePolitica.em < TTL_POLITICA) return cachePolitica.valor;
      const plataforma = await store.getPlatform();
      const snap = await db.collection('ap_instance_policy').get();
      const rules: Record<string, { action: 'allow' | 'silence' | 'suspend' }> = {};
      for (const doc of snap.docs) {
        const a = doc.data().action;
        if (a === 'allow' || a === 'silence' || a === 'suspend') rules[doc.id] = { action: a };
      }
      // Corte explícito de comunicação com instâncias suspensas por política da casa.
      for (const suspended of SUSPENDED_FEDIVERSE_DOMAINS) {
        rules[suspended] = { action: 'suspend' };
      }
      const valor: InstancePolicy = { mode: plataforma.mode, rules };
      cachePolitica = { em: agora, valor };
      return valor;
    },

    async setPlatform(patch) {
      const dados: Record<string, unknown> = { updatedAtMs: now() };
      if (typeof patch.enabled === 'boolean') dados.enabled = patch.enabled;
      if (typeof patch.killSwitch === 'boolean') dados.killSwitch = patch.killSwitch;
      if (patch.mode === 'open' || patch.mode === 'allowlist') dados.mode = patch.mode;
      await db.collection('config').doc('federation').set(dados, { merge: true });
      cachePlataforma = null;
      cachePolitica = null;
    },
    async setInstanceRule(domain, action) {
      const ref = db.collection('ap_instance_policy').doc(domain);
      if (action === null) await ref.delete();
      else await ref.set({ action, updatedAtMs: now() });
      cachePolitica = null;
    },

    // ── contas e handles ──
    async getHandle(handle) {
      const snap = await db.collection('ap_handles').doc(handle).get();
      return snap.exists ? comoHandle(snap.data() as DocumentData) : null;
    },
    async getAccount(uid) {
      const snap = await db.collection('users').doc(uid).collection('private').doc('federation').get();
      if (!snap.exists) return null;
      const d = snap.data() as DocumentData;
      return {
        uid, enabled: d.enabled === true, paused: d.paused === true, handle: textoOuNulo(d.handle),
        eligibleSince: typeof d.eligibleSince === 'number' ? d.eligibleSince : Number.MAX_SAFE_INTEGER,
        enabledAtMs: typeof d.enabledAtMs === 'number' ? d.enabledAtMs : null, publicKeyPem: textoOuNulo(d.publicKeyPem),
        updatedAtMs: toMillis(d.updatedAtMs), alsoKnownAs: Array.isArray(d.alsoKnownAs) ? d.alsoKnownAs.filter((x: unknown) => typeof x === 'string') : [],
        movedTo: textoOuNulo(d.movedTo),
      } satisfies AccountRecord;
    },
    async createHandleIfAbsent(r) {
      try {
        await db.collection('ap_handles').doc(r.handle).create({ ...r });
        return true;
      } catch (erro) {
        if (jaExiste(erro)) return false;
        throw erro;
      }
    },
    async putHandle(r) { await db.collection('ap_handles').doc(r.handle).set({ ...r }); },
    async setHandleState(handle, state) { await db.collection('ap_handles').doc(handle).update({ state }); },
    async saveAccount(r) {
      const { uid, ...resto } = r;
      void uid;
      await db.collection('users').doc(r.uid).collection('private').doc('federation').set({ ...resto });
    },
    async findHandleByUid(uid) {
      const snap = await db.collection('ap_handles').where('uid', '==', uid).limit(1).get();
      return snap.empty ? null : comoHandle(snap.docs[0].data());
    },
    async listHandlesWithKeyDue(agora, limite) {
      const snap = await db.collection('ap_handles').where('keyDeleteAfterMs', '<=', agora).limit(limite).get();
      return snap.docs.map((d) => comoHandle(d.data()));
    },

    // ── chaves ──
    async saveSealedKey(uid, sealed) { await db.collection('ap_keys').doc(uid).set({ ...sealed }); },
    async saveSealedKeyIfAbsent(uid, sealed) {
      try {
        await db.collection('ap_keys').doc(uid).create({ ...sealed });
        return true;
      } catch (e) {
        if (jaExiste(e)) return false;
        throw e;
      }
    },
    async loadSealedKey(uid) {
      const snap = await db.collection('ap_keys').doc(uid).get();
      return snap.exists ? (snap.data() as SealedSecret) : null;
    },
    async deleteKey(uid) { await db.collection('ap_keys').doc(uid).delete(); },

    // ── conteúdo local ──
    async getProfile(uid) {
      const snap = await db.collection('users').doc(uid).get();
      if (!snap.exists) return null;
      const d = snap.data() as DocumentData;
      return {
        uid, name: texto(d.name), username: texto(d.username), bio: texto(d.bio), avatarUrl: textoOuNulo(d.avatarUrl),
        avatarAlt: textoOuNulo(d.avatarAlt),
        coverUrl: textoOuNulo(d.coverImageUrl), coverUrlAlt: textoOuNulo(d.coverImageAlt),
        website: textoOuNulo(d.website), location: textoOuNulo(d.location),
        createdAtMs: toMillis(d.createdAt), profileVisibility: d.profileVisibility === 'private' ? 'private' : 'public',
        isOfficial: d.isOfficial === true,
      } satisfies LocalProfile;
    },
    async getPost(postId) {
      const snap = await db.collection('posts').doc(postId).get();
      if (!snap.exists) return null;
      const d = snap.data() as DocumentData;
      const media = Array.isArray(d.media)
        ? d.media
            .filter((m: unknown): m is { url: string; type?: string; alt?: unknown } => typeof m === 'object' && m !== null && typeof (m as { url?: unknown }).url === 'string')
            .map((m: { url: string; type?: string; alt?: unknown }) => ({ url: m.url, type: (m.type === 'video' ? 'video' : 'image') as 'image' | 'video', alt: textoOuNulo(m.alt) }))
        : [];
      const quotedPostId = textoOuNulo(d.quotedPostId) ?? textoOuNulo((d.originalPostDetails as { id?: unknown } | undefined)?.id);
      let quotedPostUrl = textoOuNulo((d.originalPostDetails as { activityPubUrl?: unknown } | undefined)?.activityPubUrl);
      if (!quotedPostUrl && quotedPostId && quotedPostId.startsWith('ap_')) {
        const quotedSnap = await db.collection('posts').doc(quotedPostId).get();
        if (quotedSnap.exists) {
          const qd = quotedSnap.data() as DocumentData;
          quotedPostUrl = textoOuNulo(qd.activityPubUrl) ?? textoOuNulo(qd.sourceUrl);
        }
      }
      return {
        id: postId, userId: texto(d.userId), text: texto(d.text), hashtags: Array.isArray(d.hashtags) ? d.hashtags.filter((h: unknown) => typeof h === 'string') : [],
        media, createdAtMs: toMillis(d.createdAt), updatedAtMs: d.updatedAt ? toMillis(d.updatedAt) || null : null,
        visibility: d.visibility === 'followers' || d.visibility === 'private' ? d.visibility : 'public', federation: textoOuNulo(d.federation),
        type: texto(d.type) || 'original', category: texto(d.category) || 'echo', isDeleted: d.isDeleted === true,
        hasPoll: d.poll != null, sensitive: d.sensitive === true, youtubeVideoId: textoOuNulo(d.youtubeVideoId),
        quotedPostId,
        quotedPostUrl,
        headline: textoOuNulo(d.headline),
      } satisfies LocalPost;
    },
    async getObject(postId) {
      const snap = await db.collection('ap_objects').doc(postId).get();
      return snap.exists ? comoObjeto(snap.data() as DocumentData) : null;
    },
    async putObject(r) {
      const lote = db.batch();
      lote.set(db.collection('ap_objects').doc(r.postId), { ...r });
      // A outbox é uma subcoleção SÓ do alcance público, ordenada por um campo: a listagem usa o índice automático.
      const item = db.collection('ap_outbox').doc(r.uid).collection('items').doc(r.postId);
      if (r.scope === 'public' && r.state === 'federated') lote.set(item, { ...r });
      else lote.delete(item);
      await lote.commit();
    },
    async listPublicObjects(uid, before, limite) {
      let q = db.collection('ap_outbox').doc(uid).collection('items').orderBy('createdAtMs', 'desc');
      if (before !== null) q = q.startAfter(before);
      const snap = await q.limit(limite).get();
      return snap.docs.map((d) => comoObjeto(d.data()));
    },
    async countPublicObjects(uid) {
      const r = await db.collection('ap_outbox').doc(uid).collection('items').count().get();
      return r.data().count;
    },
    async federationCounts() {
      const [contas, objetos] = await Promise.all([
        db.collection('ap_handles').where('state', '==', 'active').count().get(),
        db.collection('ap_objects').where('scope', '==', 'public').where('state', '==', 'federated').count().get(),
      ]);
      return { accounts: contas.data().count, publicObjects: objetos.data().count };
    },

    // ── seguidores remotos ──
    async getFollower(uid, actorId) {
      const snap = await db.collection('ap_followers').doc(`${uid}__${sha(actorId)}`).get();
      return snap.exists ? comoSeguidor(snap.data() as DocumentData) : null;
    },
    async putFollower(r) {
      const { followActivity, ...resto } = r;
      await db.collection('ap_followers').doc(`${r.uid}__${sha(r.actorId)}`).set({ ...resto, followActivityJson: JSON.stringify(followActivity).slice(0, 20_000) });
      const actorSnap = await db.collection('ap_remote_actors').doc(sha(r.actorId)).get();
      const actorData = actorSnap.exists ? (actorSnap.data() as DocumentData) : null;
      const fallbackHandle = `${r.actorId.split('/').pop() || 'user'}@${r.domain}`;
      const remoteUid = await ensureRemoteUserDoc({
        actorId: r.actorId,
        handle: texto(actorData?.handle) || fallbackHandle,
        domain: r.domain,
        name: textoOuNulo(actorData?.name),
        summary: textoOuNulo(actorData?.summary),
        iconUrl: textoOuNulo(actorData?.iconUrl),
        inbox: r.inbox,
        sharedInbox: r.sharedInbox,
      });
      await db.collection('users').doc(r.uid).collection('followers').doc(remoteUid).set({
        createdAt: FieldValue.serverTimestamp(),
        isRemoteFediverse: true,
        remoteActorId: r.actorId,
      }, { merge: true });
    },
    async deleteFollower(uid, actorId) {
      const ref = db.collection('ap_followers').doc(`${uid}__${sha(actorId)}`);
      const snap = await ref.get();
      if (!snap.exists) return false;
      await ref.delete();
      const remoteUid = remoteUserIdOf(actorId);
      await db.collection('users').doc(uid).collection('followers').doc(remoteUid).delete().catch(() => {});
      return true;
    },
    async findFollowersByActor(actorId) {
      const snap = await db.collection('ap_followers').where('actorId', '==', actorId).limit(500).get();
      return snap.docs.map((d) => comoSeguidor(d.data()));
    },
    async listFollowers(uid, limite, depoisDe) {
      // Ordena pelo ID do documento: o índice de campo único de `uid` já guarda (uid, __name__), sem índice composto.
      let q = db.collection('ap_followers').where('uid', '==', uid).orderBy(FieldPath.documentId());
      if (depoisDe !== null) q = q.startAfter(`${uid}__${sha(depoisDe)}`);
      const snap = await q.limit(limite).get();
      return snap.docs.map((d) => comoSeguidor(d.data()));
    },
    async countFollowers(uid) {
      const r = await db.collection('ap_followers').where('uid', '==', uid).count().get();
      return r.data().count;
    },

    // ── atores remotos ──
    async getRemoteActor(actorId) {
      const cached = cacheAtoresRemotos.get(actorId);
      if (cached) return cached;
      const snap = await db.collection('ap_remote_actors').doc(sha(actorId)).get();
      if (!snap.exists) return null;
      const { expireAt, ...resto } = snap.data() as DocumentData;
      void expireAt;
      const actor = resto as RemoteActorRecord;
      cacheAtoresRemotos.set(actorId, actor);
      return actor;
    },
    async findRemoteActorByHandle(handle) {
      const alvo = handle.trim().toLowerCase().replace(/^@/, '');
      if (!alvo.includes('@')) return null;
      for (const atorEmCache of cacheAtoresRemotos.values()) {
        if (atorEmCache.handle.toLowerCase() === alvo) return atorEmCache;
      }
      const snap = await db.collection('ap_remote_actors').where('handle', '==', alvo).limit(1).get();
      if (snap.empty) return null;
      const { expireAt, ...resto } = snap.docs[0].data() as DocumentData;
      void expireAt;
      const ator = resto as RemoteActorRecord;
      cacheAtoresRemotos.set(ator.actorId, ator);
      return ator;
    },
    async putRemoteActor(r) {
      cacheAtoresRemotos.set(r.actorId, r);
      await db.collection('ap_remote_actors').doc(sha(r.actorId)).set({ ...r, expireAt: expira(now() + (r.state === 'gone' ? 2 : 14) * DIA) });
    },

    // ── idempotência ──
    async markSeen(activityId, ttlMs) {
      try {
        await db.collection('ap_seen').doc(sha(activityId)).create({ atMs: now(), expireAt: expira(now() + ttlMs) });
        return true;
      } catch (erro) {
        if (jaExiste(erro)) return false;
        throw erro;
      }
    },

    // ── saída da federação ──
    async purgeUserData(uid) {
      // recursiveDelete cobre a subcoleção `items` da outbox sem listar documento por documento.
      await db.recursiveDelete(db.collection('ap_outbox').doc(uid));
      for (const colecao of ['ap_objects', 'ap_user_blocks']) {
        for (let passo = 0; passo < 50; passo++) {
          const snap = await db.collection(colecao).where('uid', '==', uid).limit(400).get();
          if (snap.empty) break;
          const lote = db.batch();
          for (const d of snap.docs) lote.delete(d.ref);
          await lote.commit();
        }
      }
    },

    // ── bloqueios ──
    async listUserBlocks(uid) {
      const snap = await db.collection('ap_user_blocks').where('uid', '==', uid).limit(1000).get();
      return snap.docs.map((d) => ({ scope: d.data().scope, value: d.data().value }) as UserBlock);
    },
    async addUserBlock(uid, b) {
      await db.collection('ap_user_blocks').doc(`${uid}__${sha(`${b.scope}|${b.value}`)}`).set({ uid, scope: b.scope, value: b.value, atMs: now() });
    },
    async removeUserBlock(uid, b) {
      await db.collection('ap_user_blocks').doc(`${uid}__${sha(`${b.scope}|${b.value}`)}`).delete();
    },

    // ── fila ──
    async enqueueJob(job) { await db.collection('ap_outbound').doc(job.id).set({ ...job }); },
    async claimDueJobs(agora, limite, posse) {
      return (await devidos('ap_outbound', 'state', agora, limite, posse)).map(comoTarefa);
    },
    async finishJob(id, state, note) {
      await db.collection('ap_outbound').doc(id).update({
        state, note, nextAttemptAt: FieldValue.delete(), leaseUntil: FieldValue.delete(), expireAt: expira(now() + 7 * DIA),
      });
    },
    async putDeliveryIfAbsent(r) {
      try {
        await db.collection('ap_deliveries').doc(r.id).create({ ...r });
        return true;
      } catch (erro) {
        if (jaExiste(erro)) return false;
        throw erro;
      }
    },
    async claimDueDeliveries(agora, limite, posse) {
      return (await devidos('ap_deliveries', 'status', agora, limite, posse)).map(comoEntrega);
    },
    async updateDelivery(id, patch) {
      const dados: DocumentData = {};
      for (const [chave, valor] of Object.entries(patch)) {
        // Sair da fila = APAGAR o campo (e não gravar null): a consulta de "vencidas" é uma desigualdade num campo só.
        dados[chave] = chave === 'nextAttemptAt' && valor === null ? FieldValue.delete() : valor;
      }
      dados.leaseUntil = FieldValue.delete();
      if (patch.status === 'pending') dados.expireAt = FieldValue.delete();
      else if (patch.status) dados.expireAt = expira(now() + 30 * DIA);
      await db.collection('ap_deliveries').doc(id).update(dados);
    },
    async listDeliveries(uid, limite) {
      // ÚNICA consulta com índice composto (uid + createdAtMs desc): declarado em firestore.indexes.json.
      const snap = await db.collection('ap_deliveries').where('uid', '==', uid).orderBy('createdAtMs', 'desc').limit(limite).get();
      return snap.docs.map((d) => comoEntrega(d.data()));
    },
    async getDelivery(id) {
      const snap = await db.collection('ap_deliveries').doc(id).get();
      return snap.exists ? comoEntrega(snap.data() as DocumentData) : null;
    },
    async getDomainHealth(domain) {
      const snap = await db.collection('ap_domain_health').doc(domain).get();
      if (!snap.exists) return null;
      const d = snap.data() as DocumentData;
      // Sem o campo interno de expiração: ele existe para o TTL, não é parte do contrato.
      //
      // OS CAMPOS DE RECUSA TÊM DE VOLTAR. Esta leitura devolvia só os quatro campos do disjuntor de queda e descartava
      // `consecutiveRefusals`/`refusedUntilMs`: a cada 403 o worker partia de zero, o contador nunca passava de 1 e a
      // pausa de consentimento nunca disparou em produção (medido em 2026-11-24: 9 domínios presos em 1 recusa, 0 em
      // pausa). O armazenamento em memória dos testes devolvia tudo, então a suíte passava provando algo que a produção
      // não fazia. Campo ausente no documento continua ausente aqui, igual à memória.
      const saude: DomainHealth = {
        domain: texto(d.domain),
        consecutiveFailures: Number(d.consecutiveFailures) || 0,
        cooldownUntilMs: Number(d.cooldownUntilMs) || 0,
        lastFailureMs: Number(d.lastFailureMs) || 0,
      };
      if (d.consecutiveRefusals !== undefined) saude.consecutiveRefusals = Number(d.consecutiveRefusals) || 0;
      if (d.refusedUntilMs !== undefined) saude.refusedUntilMs = Number(d.refusedUntilMs) || 0;
      if (typeof d.lastFailureClass === 'string') saude.lastFailureClass = d.lastFailureClass;
      return saude;
    },
    async setDomainHealth(h) {
      // O registro vive pelo menos 7 dias e SEMPRE além do fim da pausa. Antes o TTL era fixo em 7 dias e o último degrau
      // da escada é 30: o documento sumia no meio da pausa e o domínio voltava a receber como se nada tivesse acontecido.
      const fimDaPausa = Number(h.refusedUntilMs) || 0;
      const expiraEm = Math.max(now() + 7 * DIA, fimDaPausa + 7 * DIA);
      await db.collection('ap_domain_health').doc(h.domain).set({ ...h, expireAt: expira(expiraEm) });
    },
    async queueDepth() {
      const [jobs, entregas, mortas] = await Promise.all([
        db.collection('ap_outbound').where('state', '==', 'pending').count().get(),
        db.collection('ap_deliveries').where('status', '==', 'pending').count().get(),
        db.collection('ap_deliveries').where('status', '==', 'dead').count().get(),
      ]);
      return { jobs: jobs.data().count, deliveries: entregas.data().count, dead: mortas.data().count };
    },

    // ── observabilidade ──
    async audit(e: AuditEntry) {
      await db.collection('ap_audit').add({ ...e, expireAt: expira(now() + 180 * DIA) });
    },
    async bump(nome, por = 1) {
      const d = new Date(now());
      const dia = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
      // Contadores num MAPA: com `set(..., { merge: true })` as chaves do mapa são literais (com pontos e tudo); com
      // `update()` os pontos virariam caminho aninhado.
      await db.collection('ap_stats').doc(dia).set({ c: { [nome]: FieldValue.increment(por) }, expireAt: expira(now() + 400 * DIA) }, { merge: true });
    },
    async readCounters(dia) {
      const snap = await db.collection('ap_stats').doc(dia).get();
      const c = snap.data()?.c;
      const saida: Record<string, number> = {};
      if (c && typeof c === 'object') for (const [k, v] of Object.entries(c)) if (typeof v === 'number') saida[k] = v;
      return saida;
    },
    async saveFlag(f: RemoteFlag) {
      await db.collection('ap_flags').add({ ...f, expireAt: expira(now() + 90 * DIA) });
    },

    // ── interações federadas ──
    async getComment(postId, commentId) {
      const snap = await db.collection('posts').doc(postId).collection('comments').doc(commentId).get();
      if (!snap.exists) return null;
      const d = snap.data() as DocumentData;
      const rawMedia = Array.isArray(d.media)
        ? d.media
            .filter((item): item is { url: string; type?: unknown; alt?: unknown } =>
              Boolean(item && typeof item === 'object' && typeof (item as { url?: unknown }).url === 'string'),
            )
            .map((item) => ({
              url: item.url,
              type: (item.type === 'video' ? 'video' : 'image') as 'image' | 'video',
              alt: typeof item.alt === 'string' ? item.alt : null,
            }))
        : undefined;
      return {
        id: commentId,
        postId,
        userId: texto(d.userId),
        text: texto(d.text),
        createdAtMs: toMillis(d.createdAt),
        parentCommentId: textoOuNulo(d.parentCommentId),
        isDeleted: d.isDeleted === true,
        sensitive: d.sensitive === true,
        ...(rawMedia && rawMedia.length > 0 ? { media: rawMedia } : {}),
        isRemoteFediverse: d.isRemoteFediverse === true,
      } satisfies LocalComment;
    },
    async recordRemoteLike(postId, actor, activityId) {
      const postSnap = await db.collection('posts').doc(postId).get();
      if (!postSnap.exists || postSnap.data()?.isDeleted === true) return 'missing-post';
      const remoteUid = await ensureRemoteUserDoc(actor);
      try {
        await db.collection('posts').doc(postId).collection('likes').doc(remoteUid).create({
          userId: remoteUid,
          apActorId: actor.actorId,
          apHandle: actor.handle,
          apActivityId: activityId,
          isRemoteFediverse: true,
          createdAt: FieldValue.serverTimestamp(),
        });
        return 'added';
      } catch (e) {
        if (jaExiste(e)) return 'duplicate';
        throw e;
      }
    },
    async removeRemoteLike(postId, actorId) {
      const remoteUid = remoteUserIdOf(actorId);
      const ref = db.collection('posts').doc(postId).collection('likes').doc(remoteUid);
      const snap = await ref.get();
      if (!snap.exists) return false;
      await ref.delete();
      return true;
    },
    async recordRemoteBoost(postId, actor, activityId) {
      const postSnap = await db.collection('posts').doc(postId).get();
      if (!postSnap.exists || postSnap.data()?.isDeleted === true) return 'missing-post';
      const remoteUid = await ensureRemoteUserDoc(actor);
      try {
        await db.collection('posts').doc(postId).collection('reposts').doc(remoteUid).create({
          userId: remoteUid,
          apActorId: actor.actorId,
          apHandle: actor.handle,
          apActivityId: activityId,
          isRemoteFediverse: true,
          createdAt: FieldValue.serverTimestamp(),
        });
        return 'added';
      } catch (e) {
        if (jaExiste(e)) return 'duplicate';
        throw e;
      }
    },
    async removeRemoteBoost(postId, actorId) {
      const remoteUid = remoteUserIdOf(actorId);
      const ref = db.collection('posts').doc(postId).collection('reposts').doc(remoteUid);
      const snap = await ref.get();
      if (!snap.exists) return false;
      await ref.delete();
      return true;
    },
    // ── curtir e repostar um COMENTÁRIO nosso: o marcador vai para o comentário (as Functions de comentário contam e
    // notificam o autor DELE). ──
    async recordRemoteCommentLike(postId, commentId, actor, activityId) {
      return marcarComentario('likes', postId, commentId, actor, activityId);
    },
    async removeRemoteCommentLike(postId, commentId, actorId) {
      return desmarcarComentario('likes', postId, commentId, actorId);
    },
    async recordRemoteCommentBoost(postId, commentId, actor, activityId) {
      return marcarComentario('reposts', postId, commentId, actor, activityId);
    },
    async removeRemoteCommentBoost(postId, commentId, actorId) {
      return desmarcarComentario('reposts', postId, commentId, actorId);
    },

    // ── resposta ao NOSSO Follow: o "Seguindo" é gravado por antecipação (follow/route.ts) e aqui vira definitivo ou é desfeito ──
    async acceptOutboundFollow(uid, remoteActorId) {
      const ref = db.collection('ap_following').doc(uid).collection('actors').doc(remoteFollowDocIdOf(remoteActorId));
      const snap = await ref.get();
      if (!snap.exists) return false;
      const eraPedido = (snap.data() as { status?: string } | undefined)?.status === 'pending';
      await ref.set({ status: 'accepted', acceptedAtMs: now() }, { merge: true });
      // Perfil FECHADO: o pedido ficou sem arestas até aqui. Aceito, o seguir passa a valer de verdade (feed e contadores andam pelas
      // arestas, e as Functions de seguir contam e notificam). Perfil aberto: as arestas já existem desde o clique, não se regravam.
      if (eraPedido) {
        const remoteUid = remoteUserIdOf(remoteActorId);
        await Promise.all([
          db.collection('users').doc(uid).collection('following').doc(remoteUid).set({ userId: remoteUid, isRemoteFediverse: true, createdAt: FieldValue.serverTimestamp() }),
          db.collection('users').doc(remoteUid).collection('followers').doc(uid).set({ userId: uid, createdAt: FieldValue.serverTimestamp() }),
        ]);
      }
      return true;
    },
    async rejectOutboundFollow(uid, remoteActorId) {
      const ref = db.collection('ap_following').doc(uid).collection('actors').doc(remoteFollowDocIdOf(remoteActorId));
      const snap = await ref.get();
      if (!snap.exists) return false;
      const remoteUid = remoteUserIdOf(remoteActorId);
      await Promise.all([
        ref.delete(),
        db.collection('users').doc(uid).collection('following').doc(remoteUid).delete(),
        db.collection('users').doc(remoteUid).collection('followers').doc(uid).delete(),
      ]);
      return true;
    },

    // ── o autor editou ou apagou na origem: só o MESMO ator que criou o que guardamos pode mexer nele ──
    async updateRemoteContent(apObjectId, actorId, novoTexto, sensitive, contentWarning) {
      const tags = Array.from(new Set(novoTexto.match(HASHTAG_DO_TEXTO) ?? []));
      const mapa = await db.collection('ap_remote_comments').doc(remoteObjectKeyOf(apObjectId)).get();
      if (mapa.exists) {
        const m = mapa.data() as DocumentData;
        if (m.actorId === actorId && typeof m.postId === 'string' && typeof m.commentId === 'string') {
          const ref = db.collection('posts').doc(m.postId).collection('comments').doc(m.commentId);
          const snap = await ref.get();
          if (snap.exists) {
            const existingMedia = Array.isArray(snap.data()?.media) ? snap.data()?.media : [];
            await ref.update({
              text: novoTexto,
              hashtags: tags.length > 0 ? tags : null,
              isEdited: true,
              ...(typeof sensitive === 'boolean' ? { sensitive } : {}),
              ...(contentWarning !== undefined ? { contentWarning } : {}),
            });
            return 'comment';
          }
        }
      }
      const post = await postRemotoDoAtor(apObjectId, actorId);
      if (!post) return 'unknown';
      const postSnap = await post.get();
      const postMedia = Array.isArray(postSnap.data()?.media) ? postSnap.data()?.media : [];
      await post.update({
        text: novoTexto,
        hashtags: tags.length > 0 ? tags : null,
        isEdited: true,
        ...(typeof sensitive === 'boolean' ? { sensitive } : {}),
        ...(contentWarning !== undefined ? { contentWarning } : {}),
      });
      return 'post';
    },
    async removeRemotePost(apObjectId, actorId) {
      const post = await postRemotoDoAtor(apObjectId, actorId);
      if (!post) return false;
      await post.update(TUMULO_DE_POST_REMOTO);
      return true;
    },
    async hasLocalLinkToActor(actorId) {
      // Direcao 1: ele segue alguem daqui. E a mesma consulta de `findFollowersByActor` (colecao `ap_followers`,
      // campo `actorId`), que ja tem indice -- por isto nao se inventa consulta nova aqui.
      const seguidores = await db.collection('ap_followers').where('actorId', '==', actorId).limit(1).get();
      if (!seguidores.empty) return true;
      // Direcao 2: alguem daqui segue ELE. O espelho `users/{remoteUid}` guarda quem daqui o segue.
      const locais = await db
        .collection('users').doc(remoteUserIdOf(actorId))
        .collection('followers').limit(1).get();
      return !locais.empty;
    },

    async removeRemoteActorContent(actorId) {
      const snap = await db.collection('posts').where('remoteActorId', '==', actorId).limit(500).get();
      let apagados = 0;
      for (let i = 0; i < snap.docs.length; i += 400) {
        const lote = db.batch();
        for (const d of snap.docs.slice(i, i + 400)) {
          if (d.data().isDeleted === true) continue;
          lote.update(d.ref, TUMULO_DE_POST_REMOTO);
          apagados++;
        }
        await lote.commit();
      }
      return apagados;
    },

    async recordRemoteComment(input) {
      const postSnap = await db.collection('posts').doc(input.postId).get();
      if (!postSnap.exists || postSnap.data()?.isDeleted === true) return 'missing-post';
      const postData = postSnap.data() as DocumentData;
      const objHash = remoteObjectKeyOf(input.apObjectId);
      const commentId = remotePostIdOf(input.apObjectId);
      const remoteUid = await ensureRemoteUserDoc(input.actor);
      const commentHashtags = Array.from(
        new Set(
          input.text.match(/#([a-zA-Z0-9_áéíóúÁÉÍÓÚàèìòùÀÈÌÒÙâêîôûÂÊÎÔÛãõÃÕçÇ]+)/g) ?? [],
        ),
      );
      const commentMediaList = Array.isArray(input.media) ? input.media : [];
      // O aviso do autor vale com ou sem anexo: quem escreveu "relato de violencia" num texto puro pediu o aviso do mesmo jeito.
      const commentSensitive = Boolean(input.sensitive);
      const commentAviso = input.contentWarning ?? null;
      try {
        await db.collection('posts').doc(input.postId).collection('comments').doc(commentId).create({
          userId: remoteUid,
          authorDetails: {
            userId: remoteUid,
            name: input.actor.name || input.actor.handle,
            username: input.actor.handle,
            avatarUrl: input.actor.iconUrl || null,
          },
          isRemoteFediverse: true,
          remoteActorUrl: input.actor.actorId,
          remoteHandle: input.actor.handle,
          apObjectId: input.apObjectId,
          parentPostId: input.postId,
          postAuthorId: texto(postData.userId),
          postVisibility: postData.visibility === 'followers' || postData.visibility === 'private' ? postData.visibility : 'public',
          parentCommentId: input.parentCommentId ?? null,
          text: input.text,
          hashtags: commentHashtags.length > 0 ? commentHashtags : null,
          media: commentMediaList.length > 0 ? commentMediaList : null,
          hasMedia: commentMediaList.length > 0,
          sensitive: commentSensitive,
          contentWarning: commentAviso,
          createdAt: Timestamp.fromMillis(input.createdAtMs),
          likes: 0,
          repostsCount: 0,
          repliesCount: 0,
          isDeleted: false,
        });
        await db.collection('ap_remote_comments').doc(objHash).set({
          postId: input.postId,
          commentId,
          actorId: input.actor.actorId,
          expireAt: expira(now() + 90 * DIA),
        });
        return 'added';
      } catch (e) {
        if (jaExiste(e)) return 'duplicate';
        throw e;
      }
    },
    async removeRemoteComment(apObjectId, actorId) {
      const objHash = remoteObjectKeyOf(apObjectId);
      const mapRef = db.collection('ap_remote_comments').doc(objHash);
      const mapSnap = await mapRef.get();
      if (!mapSnap.exists) return false;
      const d = mapSnap.data() as DocumentData;
      if (d.actorId !== actorId || typeof d.postId !== 'string' || typeof d.commentId !== 'string') return false;
      await db.collection('posts').doc(d.postId).collection('comments').doc(d.commentId).delete();
      await mapRef.delete();
      return true;
    },
    async hasRemoteFollowers(actorId) {
      const remoteUid = remoteUserIdOf(actorId);
      const followersSnap = await db.collection('users').doc(remoteUid).collection('followers').limit(1).get();
      return !followersSnap.empty;
    },
    async hasPost(postId) {
      const snap = await db.collection('posts').doc(postId).get();
      return snap.exists && snap.data()?.isDeleted !== true;
    },
    async ingestRemotePost(input) {
      const remoteUid = remoteUserIdOf(input.actor.actorId);
      const followersSnap = await db.collection('users').doc(remoteUid).collection('followers').limit(1).get();
      if (followersSnap.empty) return 'no-followers';

      const postId = remotePostIdOf(input.apObjectId);
      await ensureRemoteUserDoc(input.actor);
      const authorDetails = {
        userId: remoteUid,
        name: input.actor.name || input.actor.handle,
        username: input.actor.handle,
        avatarUrl: input.actor.iconUrl || '',
      };

      const mediaList = Array.isArray(input.media) ? input.media : [];
      const textWithQuote = input.quoteUrl && !input.text.includes(input.quoteUrl)
        ? `${input.text}\n\n${input.quoteUrl}`.trim()
        : input.text;

      const hashtags = Array.from(
        new Set(
          textWithQuote.match(/#([a-zA-Z0-9_áéíóúÁÉÍÓÚàèìòùÀÈÌÒÙâêîôûÂÊÎÔÛãõÃÕçÇ]+)/g) ?? [],
        ),
      );

      try {
        await db.collection('posts').doc(postId).create({
          id: postId,
          userId: remoteUid,
          authorDetails,
          text: textWithQuote,
          ...(input.customEmojis && Object.keys(input.customEmojis).length > 0 ? { customEmojis: input.customEmojis } : {}),
          hashtags: hashtags.length > 0 ? hashtags : null,
          media: mediaList,
          hasMedia: mediaList.length > 0,
          sensitive: Boolean(input.sensitive),
          contentWarning: input.contentWarning ?? null,
          language: input.language ?? null,
          visibility: 'public',
          federation: 'local',
          type: 'original',
          category: 'echo',
          allowReposts: true,
          replyPermission: 'everyone',
          likes: 0,
          reposts: 0,
          commentsCount: 0,
          quotesCount: 0,
          views: 0,
          isDeleted: false,
          isEdited: false,
          editCount: 0,
          postFormat: 'standard',
          createdAt: Timestamp.fromMillis(input.createdAtMs),
          isRemoteFediverse: true,
          remoteObjectId: input.apObjectId,
          remoteUrl: input.url,
          remoteActorId: input.actor.actorId,
          remoteInbox: input.actor.inbox || input.actor.sharedInbox || null,
        });
        return 'added';
      } catch (e) {
        if (jaExiste(e)) return 'duplicate';
        throw e;
      }
    },
    async ingestRemoteAnnounce(input) {
      const boosterUid = remoteUserIdOf(input.booster.actorId);
      const followersSnap = await db.collection('users').doc(boosterUid).collection('followers').limit(1).get();
      if (followersSnap.empty) return 'no-followers';

      const postId = remotePostIdOf(input.apObjectId);
      const postRef = db.collection('posts').doc(postId);
      const postSnap = await postRef.get();

      if (!postSnap.exists) {
        if (!input.author || !input.text) return 'missing-post';
        const authorUid = await ensureRemoteUserDoc(input.author);
        const mediaList = Array.isArray(input.media) ? input.media : [];
        const hashtags = Array.from(
          new Set(
            input.text.match(/#([a-zA-Z0-9_áéíóúÁÉÍÓÚàèìòùÀÈÌÒÙâêîôûÂÊÎÔÛãõÃÕçÇ]+)/g) ?? [],
          ),
        );
        try {
          await postRef.create({
            id: postId,
            userId: authorUid,
            authorDetails: {
              userId: authorUid,
              name: input.author.name || input.author.handle,
              username: input.author.handle,
              avatarUrl: input.author.iconUrl || '',
            },
            text: input.text,
            ...(input.customEmojis && Object.keys(input.customEmojis).length > 0 ? { customEmojis: input.customEmojis } : {}),
            hashtags: hashtags.length > 0 ? hashtags : null,
            media: mediaList,
            hasMedia: mediaList.length > 0,
            sensitive: Boolean(input.sensitive),
            contentWarning: input.contentWarning ?? null,
            language: input.language ?? null,
            visibility: 'public',
            federation: 'local',
            type: 'original',
            category: 'echo',
            allowReposts: true,
            replyPermission: 'everyone',
            likes: 0,
            reposts: 0,
            commentsCount: 0,
            quotesCount: 0,
            views: 0,
            isDeleted: false,
            isEdited: false,
            editCount: 0,
            postFormat: 'standard',
            createdAt: Timestamp.fromMillis(input.postCreatedAtMs ?? input.boostCreatedAtMs),
            isRemoteFediverse: true,
            remoteObjectId: input.apObjectId,
            remoteUrl: input.url || input.apObjectId,
            remoteActorId: input.author.actorId,
            remoteInbox: input.author.inbox || input.author.sharedInbox || null,
          });
        } catch (e) {
          if (!jaExiste(e)) throw e;
        }
      } else if (postSnap.data()?.isDeleted === true) {
        return 'missing-post';
      }

      await ensureRemoteUserDoc(input.booster);
      try {
        await postRef.collection('reposts').doc(boosterUid).create({
          userId: boosterUid,
          apActorId: input.booster.actorId,
          apHandle: input.booster.handle,
          apActivityId: input.activityId,
          isRemoteFediverse: true,
          createdAt: Timestamp.fromMillis(input.boostCreatedAtMs),
        });
        return 'added';
      } catch (e) {
        if (jaExiste(e)) return 'duplicate';
        throw e;
      }
    },
    async getRemotePostMeta(postId) {
      const snap = await db.collection('posts').doc(postId).get();
      if (!snap.exists) return null;
      const d = snap.data() as DocumentData;
      if (d.isRemoteFediverse !== true) return null;
      if (typeof d.remoteObjectId !== 'string' || typeof d.remoteInbox !== 'string') return null;
      return {
        remoteObjectId: d.remoteObjectId,
        remoteInbox: d.remoteInbox,
        remoteActorId: texto(d.remoteActorId),
      };
    },
    async ingestRemoteDm(input) {
      const targetSnap = await db.collection('users').doc(input.targetUid).get();
      if (!targetSnap.exists) return 'rejected';
      const targetData = targetSnap.data() as DocumentData;
      const dmPref = typeof targetData.dmPreference === 'string' ? targetData.dmPreference : 'all';
      if (dmPref === 'none') return 'rejected';

      const cleanHandle = (input.actor.handle || '').replace(/^@+/, '').trim();
      const fedMatchSnap = cleanHandle
        ? await db
            .collection('users')
            .where('federatedLoginHandle', '==', cleanHandle)
            .limit(1)
            .get()
            .catch(() => null)
        : null;
      const existingFedDoc = fedMatchSnap && !fedMatchSnap.empty ? fedMatchSnap.docs[0] : null;
      const remoteUid = existingFedDoc ? existingFedDoc.id : remoteUserIdOf(input.actor.actorId);

      if (dmPref === 'followed') {
        const followSnap = await db.collection('users').doc(input.targetUid).collection('following').doc(remoteUid).get();
        if (!followSnap.exists) return 'rejected';
      }

      const remoteName =
        (existingFedDoc ? (existingFedDoc.data()?.name as string) : '') ||
        input.actor.name ||
        input.actor.handle;
      const remoteUsername =
        (existingFedDoc ? (existingFedDoc.data()?.username as string) : '') ||
        input.actor.handle;

      if (existingFedDoc) {
        await db.collection('users').doc(remoteUid).set(
          {
            remoteActorId: input.actor.actorId,
            remoteDomain: input.actor.domain,
            remoteInbox: input.actor.inbox || input.actor.sharedInbox || null,
            updatedAt: FieldValue.serverTimestamp(),
          },
          { merge: true }
        );
      } else {
        await db.collection('users').doc(remoteUid).set({
          id: remoteUid,
          name: remoteName,
          name_lowercase: remoteName.toLowerCase(),
          username: input.actor.handle,
          bio: input.actor.summary || '',
          avatarUrl: input.actor.iconUrl || '',
          dmPreference: 'everyone',
          profileVisibility: 'public',
          isRemoteFediverse: true,
          remoteActorId: input.actor.actorId,
          remoteDomain: input.actor.domain,
          remoteInbox: input.actor.inbox || input.actor.sharedInbox || null,
          updatedAt: FieldValue.serverTimestamp(),
        }, { merge: true });
      }

      const sortedParticipants = [input.targetUid, remoteUid].sort();
      const convId = sortedParticipants.join('_');
      const convRef = db.collection('conversations').doc(convId);
      const participantsInfo = [
        {
          id: input.targetUid,
          name: typeof targetData.name === 'string' ? targetData.name : 'Usuário',
          username: typeof targetData.username === 'string' ? targetData.username : '',
          avatarUrl: typeof targetData.avatarUrl === 'string' ? targetData.avatarUrl : '',
        },
        {
          id: remoteUid,
          name: remoteName,
          username: remoteUsername,
          avatarUrl: input.actor.iconUrl || '',
        },
      ].sort((a, b) => a.id.localeCompare(b.id));

      const convSnap = await convRef.get();
      if (!convSnap.exists) {
        await convRef.set({
          participantIds: sortedParticipants,
          createdBy: remoteUid,
          participantsInfo,
          createdAt: Timestamp.fromMillis(input.createdAtMs),
          lastMessageAt: Timestamp.fromMillis(input.createdAtMs),
          lastMessageId: null,
          lastMessageText: null,
          lastMessageSenderId: null,
          unreadCounts: { [input.targetUid]: 0, [remoteUid]: 0 },
          userLeftAt: {},
          isRemoteFediverse: true,
        });
      }

      const msgId = remotePostIdOf(input.apObjectId);
      try {
        await convRef.collection('messages').doc(msgId).create({
          senderId: remoteUid,
          text: input.text,
          fileUrl: null,
          fileType: null,
          sharedPostId: null,
          createdAt: Timestamp.fromMillis(input.createdAtMs),
          readAt: null,
          parentMessageId: null,
          parentMessageText: null,
          parentMessageSenderName: null,
          apObjectId: input.apObjectId,
        });
        return 'added';
      } catch (e) {
        if (jaExiste(e)) return 'duplicate';
        throw e;
      }
    },
  };
  return store;
}
