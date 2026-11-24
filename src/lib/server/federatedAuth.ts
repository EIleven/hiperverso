// src/lib/server/federatedAuth.ts
// Provisionamento e autenticação de contas criadas/logadas via Fediverso (ActivityPub/Mastodon) ou Atmosfera (Bluesky).
import { createHash, randomBytes } from 'node:crypto';
import { FieldValue, Timestamp, type Firestore } from 'firebase-admin/firestore';
import { enableFederation } from '@/lib/activitypub/account';
import { pausaDeConsentimento } from '@/lib/activitypub/consentimentoDeDominio';
import { decideInstance } from '@/lib/activitypub/gate';
import { remoteUserIdOf } from '@/lib/activitypub/remoteIdentity';
import { isSuspendedFediverseHost } from '@/lib/federation/suspendedDomains';
import { federation } from '@/lib/server/federation';
import { adminAuth, adminFirestore } from '@/lib/server/firebaseAdmin';
import { mintClientAuthCredential, type ClientAuthCredential } from '@/lib/server/clientCredential';
import type { FederatedSyncConsent } from '@/lib/server/federatedSync';

export class FederatedSignupClosedError extends Error {
  constructor() {
    super('Os cadastros estão fechados no momento.');
    this.name = 'FederatedSignupClosedError';
  }
}

/** Bloqueia login OAuth de instâncias suspensas, rejeitadas pela política ou em pausa ativa por 403. */
export async function isFediverseDomainBlockedForLogin(domain: string): Promise<boolean> {
  if (isSuspendedFediverseHost(domain)) return true;
  const f = federation();
  const [politica, saude] = await Promise.all([
    f.store.getInstancePolicy(),
    f.store.getDomainHealth(domain),
  ]);
  if (decideInstance(domain, politica, f.ownHost).decision === 'reject') return true;
  if (pausaDeConsentimento(saude, Date.now()).pausado) return true;
  return false;
}

export interface FederatedProfileInput {
  provider: 'fediverse' | 'bluesky';
  externalId: string;
  handle: string;
  name: string;
  bio: string;
  avatarUrl: string;
  coverImageUrl: string;
  website: string;
  actorId?: string;
  did?: string;
  locale: string;
  consent?: FederatedSyncConsent;
}

const hashKey = (value: string) => createHash('sha256').update(value).digest('hex');

function sanitizeLocalUsername(rawHandle: string): string {
  const firstPart = rawHandle.replace(/^@/, '').split(/[@.]/)[0] || 'user';
  const cleaned = firstPart.replace(/[^a-zA-Z0-9_]/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '');
  if (cleaned.length >= 3) return cleaned.slice(0, 15);
  return `user_${cleaned || 'fed'}`.slice(0, 15);
}

async function allocateUniqueUsername(baseRaw: string): Promise<string> {
  const db = adminFirestore();
  const base = sanitizeLocalUsername(baseRaw);
  for (let i = 0; i < 20; i++) {
    const suffix = i === 0 ? '' : String(i === 1 ? Math.floor(10 + Math.random() * 89) : Math.floor(100 + Math.random() * 899));
    const candidate = `${base.slice(0, Math.max(3, 15 - suffix.length))}${suffix}`;
    const snap = await db.collection('usernames').doc(candidate.toLowerCase()).get();
    if (!snap.exists) return candidate;
  }
  return `u_${randomBytes(4).toString('hex')}`.slice(0, 15);
}

/**
 * Unifica automaticamente qualquer espelho remoto `ap_...` pré-existente (ex.: @vivian@organica.social)
 * na conta real autenticada (`uid`), migrando grupos (GENTE FINA E ELEGANTE, etc.) e conversas diretas
 * para que a pessoa nunca fique duplicada nem perca o acesso aos grupos para os quais foi convidada.
 */
async function unifyRemoteMirrorIntoFederatedAccount(
  db: Firestore,
  uid: string,
  handle: string,
  actorId?: string
): Promise<void> {
  try {
    const candidateApIds = new Set<string>();
    if (actorId && actorId.startsWith('https://')) {
      candidateApIds.add(remoteUserIdOf(actorId));
    }
    const cleanHandle = handle.replace(/^@+/, '').trim();
    if (cleanHandle.includes('@')) {
      const byHandleSnap = await db
        .collection('users')
        .where('username', '==', cleanHandle)
        .limit(5)
        .get();
      for (const doc of byHandleSnap.docs) {
        if (doc.id !== uid && doc.id.startsWith('ap_')) {
          candidateApIds.add(doc.id);
        }
      }
    }

    for (const apId of candidateApIds) {
      if (!apId || apId === uid) continue;

      const convSnap = await db
        .collection('conversations')
        .where('participantIds', 'array-contains', apId)
        .get();

      for (const convDoc of convSnap.docs) {
        const cData = convDoc.data();
        const pids: string[] = Array.isArray(cData.participantIds) ? cData.participantIds : [];

        if (cData.isGroup === true) {
          const nextPids = Array.from(new Set([...pids.filter((id) => id !== apId), uid]));
          await convDoc.ref.update({ participantIds: nextPids });
        } else if (pids.length === 2) {
          const otherUid = pids.find((id) => id !== apId);
          if (!otherUid || otherUid === uid) continue;
          const sortedPair = [uid, otherUid].sort();
          const targetConvId = `${sortedPair[0]}_${sortedPair[1]}`;
          const targetConvRef = db.collection('conversations').doc(targetConvId);

          const msgsSnap = await convDoc.ref.collection('messages').limit(200).get();
          const batch = db.batch();
          for (const mDoc of msgsSnap.docs) {
            const mData = mDoc.data();
            batch.set(
              targetConvRef.collection('messages').doc(mDoc.id),
              {
                ...mData,
                conversationId: targetConvId,
                senderId: mData.senderId === apId ? uid : mData.senderId,
              },
              { merge: true }
            );
            batch.delete(mDoc.ref);
          }
          batch.set(
            targetConvRef,
            {
              participantIds: sortedPair,
              isGroup: false,
              createdBy: cData.createdBy === apId ? uid : cData.createdBy || otherUid,
              createdAt: cData.createdAt || FieldValue.serverTimestamp(),
              lastMessageId: cData.lastMessageId || null,
              lastMessageText: cData.lastMessageText || '',
              lastMessageSenderId:
                cData.lastMessageSenderId === apId ? uid : cData.lastMessageSenderId || otherUid,
              lastMessageAt: cData.lastMessageAt || FieldValue.serverTimestamp(),
            },
            { merge: true }
          );
          batch.delete(convDoc.ref);
          await batch.commit();
        }
      }

      await db.collection('users').doc(apId).delete().catch(() => null);
    }
  } catch (err) {
    console.warn('unifyRemoteMirrorIntoFederatedAccount warning:', err);
  }
}

export async function provisionOrLoginFederatedUser(
  input: FederatedProfileInput,
): Promise<ClientAuthCredential & { uid: string; isNewUser: boolean }> {
  const db = adminFirestore();
  const auth = adminAuth();
  const identityDocId = `${input.provider}_${hashKey(input.externalId).slice(0, 32)}`;
  const identityRef = db.collection('federated_identities').doc(identityDocId);
  const identitySnap = await identityRef.get();

  let uid: string;
  let isNewUser = false;

  if (identitySnap.exists) {
    uid = String((identitySnap.data() as { uid?: string }).uid || '');
    const userSnap = uid ? await db.collection('users').doc(uid).get() : null;
    if (!uid || !userSnap?.exists) {
      uid = '';
    }
  } else {
    uid = '';
  }

  if (!uid) {
    const controlSnap = await db.collection('_signup').doc('control').get();
    const control = controlSnap.data() as { limit?: unknown; used?: unknown } | undefined;
    const limit = typeof control?.limit === 'number' ? control.limit : -1;
    const used = typeof control?.used === 'number' ? control.used : 0;
    if (!controlSnap.exists || limit <= 0 || used >= limit) {
      throw new FederatedSignupClosedError();
    }

    isNewUser = true;
    const username = await allocateUniqueUsername(input.handle);
    const displayName = (input.name || username).slice(0, 60);
    const created = await auth.createUser({
      displayName,
      emailVerified: true,
    });
    uid = created.uid;
    const syntheticEmail = `${uid.toLowerCase()}@federated.hiperverso.app`;
    await auth.updateUser(uid, { email: syntheticEmail, emailVerified: true }).catch(() => null);

    const nowIso = new Date().toISOString();
    const batch = db.batch();
    batch.set(db.collection('usernames').doc(username.toLowerCase()), {
      userId: uid,
      uid,
      createdAt: FieldValue.serverTimestamp(),
    });
    batch.set(db.collection('users').doc(uid), {
      id: uid,
      name: displayName,
      name_lowercase: displayName.toLowerCase(),
      username,
      email: '',
      bio: input.bio.slice(0, 500),
      avatarUrl: input.avatarUrl || '',
      coverImageUrl: input.coverImageUrl || '',
      website: input.website || '',
      followersCount: 0,
      followingCount: 0,
      postsCount: 0,
      dmPreference: 'everyone',
      isAdmin: false,
      isModerator: false,
      profileVisibility: 'public',
      createdAt: nowIso,
      updatedAt: FieldValue.serverTimestamp(),
      federatedLoginProvider: input.provider,
      federatedLoginHandle: input.handle,
      ...(input.consent ? { federatedConsent: input.consent } : {}),
    });
    batch.set(identityRef, {
      uid,
      provider: input.provider,
      externalId: input.externalId,
      handle: input.handle,
      createdAt: FieldValue.serverTimestamp(),
    });
    await batch.commit();
  } else {
    const authRecord = await auth.getUser(uid).catch(() => null);
    if (authRecord && !authRecord.emailVerified) {
      const syntheticEmail = authRecord.email || `${uid.toLowerCase()}@federated.hiperverso.app`;
      await auth.updateUser(uid, { email: syntheticEmail, emailVerified: true }).catch(() => null);
    }

    if (input.consent?.syncProfile !== false) {
      const refreshFields: Record<string, unknown> = {
        federatedLoginProvider: input.provider,
        federatedLoginHandle: input.handle,
        dmPreference: 'everyone',
        updatedAt: FieldValue.serverTimestamp(),
        ...(input.consent ? { federatedConsent: input.consent } : {}),
      };
      if (input.name) {
        refreshFields.name = input.name.slice(0, 60);
        refreshFields.name_lowercase = input.name.slice(0, 60).toLowerCase();
      }
      if (input.bio) refreshFields.bio = input.bio.slice(0, 500);
      if (input.avatarUrl) refreshFields.avatarUrl = input.avatarUrl;
      if (input.coverImageUrl) refreshFields.coverImageUrl = input.coverImageUrl;
      if (input.website) refreshFields.website = input.website;
      await db.collection('users').doc(uid).set(refreshFields, { merge: true });
    }
  }

  await auth.setCustomUserClaims(uid, { member: true, federatedVerified: true });

  // Unifica qualquer espelho ap_ anterior (grupos, DMs e perfil duplicado) na conta autenticada
  await unifyRemoteMirrorIntoFederatedAccount(db, uid, input.handle, input.actorId);

  // Ativa @handle@exercitodolula.app automaticamente para unificar a identidade dentro e fora da rede
  try {
    const accountDeps = federation().account();
    // Só liga o handle local. A conta de origem NÃO é gravada como `alsoKnownAs`: esse vínculo ia para o ator público e
    // entregava, sem autenticação, o mapa de identidades da pessoa em outros servidores.
    await enableFederation(accountDeps, uid, { emailVerified: true });
  } catch (err) {
    console.warn('Auto-enable federation warning:', err instanceof Error ? err.message : String(err));
  }

  const credential = await mintClientAuthCredential(uid, {
    member: true,
    federatedVerified: true,
  });
  return { uid, isNewUser, ...credential };
}

export async function createLoginTicket(payload: {
  customToken?: string;
  emailLink?: string;
  email?: string;
  uid: string;
  isNewUser: boolean;
}): Promise<string> {
  const ticket = randomBytes(24).toString('base64url');
  const db = adminFirestore();
  await db.collection('auth_login_tickets').doc(hashKey(ticket)).set({
    customToken: payload.customToken ?? null,
    emailLink: payload.emailLink ?? null,
    email: payload.email ?? null,
    uid: payload.uid,
    isNewUser: payload.isNewUser,
    expiresAt: Date.now() + 5 * 60 * 1000,
    expireAt: Timestamp.fromMillis(Date.now() + 5 * 60 * 1000),
    createdAt: FieldValue.serverTimestamp(),
  });
  return ticket;
}

export async function consumeLoginTicket(
  ticket: string,
): Promise<(ClientAuthCredential & { uid: string; isNewUser: boolean }) | null> {
  if (!ticket || ticket.length > 256) return null;
  const db = adminFirestore();
  const ref = db.collection('auth_login_tickets').doc(hashKey(ticket));
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return null;
    tx.delete(ref);
    const data = snap.data() as {
      customToken?: string | null;
      emailLink?: string | null;
      email?: string | null;
      uid?: string;
      isNewUser?: boolean;
      expiresAt?: number;
    };
    const hasCredential = Boolean(data.customToken || (data.emailLink && data.email));
    if (!hasCredential || !data.uid || (data.expiresAt ?? 0) < Date.now()) {
      return null;
    }
    return {
      ...(data.customToken ? { customToken: data.customToken } : {}),
      ...(data.emailLink && data.email ? { emailLink: data.emailLink, email: data.email } : {}),
      uid: data.uid,
      isNewUser: Boolean(data.isNewUser),
    };
  });
}
