// src/lib/server/remoteConnections.ts
// Importa e materializa seguidores e seguindo de perfis remotos do Fediverso sob demanda.
import { remoteFollowDocIdOf } from '@/lib/activitypub/remoteIdentity';
import { FieldValue } from 'firebase-admin/firestore';
import type { User } from '@/lib/types';
import { decideInstance } from '@/lib/activitypub/gate';
import { safeFetchText } from '@/lib/security/safe-fetch';
import { federation } from '@/lib/server/federation';
import { podeLerDoDominio } from '@/lib/server/leituraRemota';
import { lerConsentimentoDoAtor } from '@/lib/activitypub/consentimentoDoAtor';
import { adminFirestore } from '@/lib/server/firebaseAdmin';
import { remoteUserIdOf } from '@/lib/server/remoteMaterialize';
import { getAnySigningHeaders, stripHtml } from '@/lib/server/remoteProfile';

interface MastodonAccount {
  id?: string;
  username?: string;
  acct?: string;
  display_name?: string;
  note?: string;
  avatar?: string;
  header?: string;
  url?: string;
  uri?: string;
  followers_count?: number;
  following_count?: number;
  statuses_count?: number;
  /** Perfil que aprova seguidores manualmente. */
  locked?: boolean;
}

function remoteDomainFromUrl(rawUrl: string, fallback: string): string {
  try {
    return new URL(rawUrl).hostname.toLowerCase();
  } catch {
    return fallback;
  }
}

export interface RemoteConnectionsResult {
  users: User[];
  restricted?: boolean;
}

export async function fetchAndMaterializeRemoteConnections(
  profileUserId: string,
  type: 'followers' | 'following',
  callerUid?: string | null,
): Promise<RemoteConnectionsResult> {
  const db = adminFirestore();
  const profileSnap = await db.collection('users').doc(profileUserId).get();
  if (!profileSnap.exists) return { users: [] };

  const profileData = profileSnap.data() as {
    username?: string;
    remoteDomain?: string;
    remoteActorId?: string;
    isRemoteFediverse?: boolean;
  };
  if (!profileData.isRemoteFediverse && !profileUserId.startsWith('ap_')) {
    return { users: [] };
  }

  const domain =
    profileData.remoteDomain ||
    (profileData.username?.includes('@') ? profileData.username.split('@').pop() : '') ||
    '';
  if (!domain) return { users: [] };

  const f = federation();
  const plataforma = await f.store.getPlatform();
  if (!plataforma.enabled || plataforma.killSwitch) return { users: [] };

  const politica = await f.store.getInstancePolicy();
  if (decideInstance(domain, politica, f.ownHost).decision === 'reject') return { users: [] };
  if (!(await podeLerDoDominio(domain)).pode) return { users: [] };

  const userAgent = `HiperVerso/1.0 (+${f.origin})`;
  let sawRestricted = false;

  const fetchApWithOptionalSigning = async (
    targetUrl: string,
    acceptHeader: string,
    timeoutMs: number,
    maxBytes: number,
  ) => {
    const firstTry = await safeFetchText(targetUrl, {
      timeoutMs,
      maxBytes,
      headers: { Accept: acceptHeader, 'User-Agent': userAgent },
      allowedContentTypes: /^application\/(activity\+json|ld\+json|json)/i,
    }).catch(() => null);
    if (firstTry?.ok) return firstTry;
    if (firstTry && (firstTry.status === 401 || firstTry.status === 403)) {
      const sigHeaders = await getAnySigningHeaders(f.origin, targetUrl);
      if (Object.keys(sigHeaders).length > 0) {
        const signedTry = await safeFetchText(targetUrl, {
          timeoutMs,
          maxBytes,
          headers: { Accept: acceptHeader, 'User-Agent': userAgent, ...sigHeaders },
          allowedContentTypes: /^application\/(activity\+json|ld\+json|json)/i,
        }).catch(() => null);
        if (signedTry?.ok) return signedTry;
        if (signedTry && (signedTry.status === 401 || signedTry.status === 403)) {
          sawRestricted = true;
        }
        return signedTry;
      }
      sawRestricted = true;
    }
    return firstTry;
  };

  const accounts: {
    actorId: string;
    handle: string;
    domain: string;
    name: string;
    bio: string;
    avatarUrl: string;
    coverImageUrl: string;
    url: string;
    /** Contagens só quando a origem informa. O ator ActivityPub não publica número: ausente não vira zero. */
    followersCount?: number;
    followingCount?: number;
    postsCount?: number;
    /** `toot:discoverable` / `toot:indexable` lidos do ator. Só `true` é sim. */
    discoverable?: boolean;
    indexable?: boolean;
    /** Só quando a origem diz (API Mastodon: `locked`); ausente = não se sabe. */
    locked?: boolean;
  }[] = [];

  // Só a coleção ActivityPub do ator (`followers`/`following`). Aqui havia, ANTES dela, uma leitura pela API REST do
  // Mastodon (`/api/v1/accounts/lookup` + `/api/v1/accounts/:id/followers|following`), sem autenticação. É a API do
  // aplicativo de quem tem conta lá, não o protocolo de federação, e servia justamente quando a coleção AP não mostrava a
  // lista. Coleção que traz só o `totalItems` é a pessoa escolhendo esconder a rede: isso se respeita, não se contorna.
  if (accounts.length === 0 && profileData.remoteActorId) {
    const actorRes = await fetchApWithOptionalSigning(
      profileData.remoteActorId,
      'application/activity+json, application/ld+json; profile="https://www.w3.org/ns/activitystreams", application/json',
      5000,
      128_000,
    );

    let collectionUrl: string | null = null;
    if (actorRes?.ok) {
      try {
        const actorJson = JSON.parse(actorRes.text) as { followers?: string; following?: string };
        const candidate = type === 'followers' ? actorJson.followers : actorJson.following;
        if (typeof candidate === 'string' && candidate.startsWith('https://')) {
          collectionUrl = candidate;
        }
      } catch {
        // ignora
      }
    }

    if (collectionUrl) {
      const colRes = await fetchApWithOptionalSigning(
        collectionUrl,
        'application/activity+json, application/ld+json, application/json',
        5000,
        256_000,
      );

      let itemUrls: string[] = [];
      if (colRes?.ok) {
        try {
          const colJson = JSON.parse(colRes.text) as {
            orderedItems?: unknown[];
            items?: unknown[];
            first?: string | { orderedItems?: unknown[]; items?: unknown[] };
          };
          const extractUrls = (arr?: unknown[]) =>
            (arr || [])
              .map((x) => (typeof x === 'string' ? x : (x as { id?: string })?.id))
              .filter((x): x is string => typeof x === 'string' && x.startsWith('https://'));

          itemUrls = extractUrls(colJson.orderedItems ?? colJson.items);
          if (itemUrls.length === 0 && typeof colJson.first === 'string' && colJson.first.startsWith('https://')) {
            const firstRes = await fetchApWithOptionalSigning(
              colJson.first,
              'application/activity+json, application/ld+json, application/json',
              5000,
              256_000,
            );
            if (firstRes?.ok) {
              const firstJson = JSON.parse(firstRes.text) as { orderedItems?: unknown[]; items?: unknown[] };
              itemUrls = extractUrls(firstJson.orderedItems ?? firstJson.items);
            }
          } else if (itemUrls.length === 0 && colJson.first && typeof colJson.first === 'object') {
            itemUrls = extractUrls(colJson.first.orderedItems ?? colJson.first.items);
          }
        } catch {
          // ignora
        }
      }

      // Cada conta da lista mora num servidor; buscar o ator dela é LER daquele servidor. Domínio suspenso ou em pausa de
      // consentimento fica de fora antes da busca, não depois. Uma decisão por domínio, reaproveitada na lista toda.
      const decisaoPorDominio = new Map<string, boolean>();
      const liberados: string[] = [];
      for (const url of itemUrls.slice(0, 60)) {
        if (liberados.length >= 30) break;
        let dominioDoItem = '';
        try {
          dominioDoItem = new URL(url).hostname.toLowerCase();
        } catch {
          continue;
        }
        if (!decisaoPorDominio.has(dominioDoItem)) {
          decisaoPorDominio.set(dominioDoItem, (await podeLerDoDominio(dominioDoItem)).pode);
        }
        if (decisaoPorDominio.get(dominioDoItem)) liberados.push(url);
      }

      const settled = await Promise.all(
        liberados.map(async (actorUrl) => {
          const res = await fetchApWithOptionalSigning(
            actorUrl,
            'application/activity+json, application/ld+json, application/json',
            4000,
            96_000,
          );
          if (!res?.ok) return null;
          try {
            const a = JSON.parse(res.text) as {
              id?: string;
              preferredUsername?: string;
              name?: string;
              summary?: string;
              url?: string;
              icon?: { url?: string } | { url?: string }[];
              image?: { url?: string } | { url?: string }[];
              discoverable?: unknown;
              indexable?: unknown;
            };
            const id = typeof a.id === 'string' && a.id.startsWith('https://') ? a.id : actorUrl;
            const d = remoteDomainFromUrl(id, domain);
            const pref = typeof a.preferredUsername === 'string' && a.preferredUsername ? a.preferredUsername : 'user';
            const iconRaw = Array.isArray(a.icon) ? a.icon[0]?.url : a.icon?.url;
            const imgRaw = Array.isArray(a.image) ? a.image[0]?.url : a.image?.url;
            return {
              actorId: id,
              handle: `${pref}@${d}`,
              domain: d,
              name: (typeof a.name === 'string' && a.name.trim()) || pref,
              bio: typeof a.summary === 'string' ? stripHtml(a.summary).slice(0, 500) : '',
              avatarUrl: typeof iconRaw === 'string' && iconRaw.startsWith('https://') ? iconRaw : '',
              coverImageUrl: typeof imgRaw === 'string' && imgRaw.startsWith('https://') ? imgRaw : '',
              url: typeof a.url === 'string' && a.url.startsWith('https://') ? a.url : id,
              ...lerConsentimentoDoAtor(a),
            };
          } catch {
            return null;
          }
        }),
      );
      for (const acc of settled) {
        if (acc) accounts.push(acc);
      }
    }
  }

  // Também saiu daqui a leitura pela API de APLICATIVO do Misskey/Sharkey/Firefish (`/api/users/show` +
  // `/api/users/followers|following`): mesmo problema da REST do Mastodon -- não é federação, é a API do app de lá.

  if (accounts.length === 0) return { users: [], restricted: sawRestricted };

  const ownHostLower = f.ownHost.toLowerCase();
  const ownDomainsSet = new Set([
    ownHostLower,
    'exercitodolula.app',
    'hiperverso.app',
    'hiperverso.social',
  ]);

  // Separa contas locais (do próprio HiperVerso / HiperVerso) das contas remotas do Fediverso
  const localResolutionMap = new Map<string, { user: User }>();
  const localCandidates = accounts.filter((a) => ownDomainsSet.has(a.domain.toLowerCase()));
  if (localCandidates.length > 0) {
    const localHandles = Array.from(
      new Set(localCandidates.map((a) => a.handle.split('@')[0].toLowerCase()).filter(Boolean)),
    );
    const [handleSnaps, usernameSnaps] = await Promise.all([
      Promise.all(localHandles.map((h) => db.collection('ap_handles').doc(h).get())),
      Promise.all(localHandles.map((h) => db.collection('usernames').doc(h).get())),
    ]);
    const handleToUid = new Map<string, string>();
    localHandles.forEach((h, idx) => {
      const apSnap = handleSnaps[idx];
      const unSnap = usernameSnaps[idx];
      const uid =
        (apSnap?.exists ? (apSnap.data() as { uid?: string })?.uid : undefined) ||
        (unSnap?.exists
          ? ((unSnap.data() as { userId?: string; uid?: string })?.userId ||
            (unSnap.data() as { userId?: string; uid?: string })?.uid)
          : undefined);
      if (typeof uid === 'string' && uid) {
        handleToUid.set(h, uid);
      }
    });

    const uniqueUids = Array.from(new Set(handleToUid.values()));
    const [userSnaps, followingSnaps] = await Promise.all([
      Promise.all(uniqueUids.map((uid) => db.collection('users').doc(uid).get())),
      callerUid
        ? Promise.all(
            uniqueUids.map((uid) =>
              db.collection('users').doc(callerUid).collection('following').doc(uid).get(),
            ),
          )
        : Promise.resolve([]),
    ]);

    const uidToUser = new Map<string, User>();
    userSnaps.forEach((snap, idx) => {
      if (!snap.exists) return;
      const d = snap.data() as Record<string, unknown>;
      const uid = uniqueUids[idx];
      const isFollowing = Boolean(followingSnaps[idx]?.exists);
      uidToUser.set(uid, {
        id: uid,
        name: typeof d.name === 'string' ? d.name : 'Usuário',
        username: typeof d.username === 'string' ? d.username : '',
        email: typeof d.email === 'string' ? d.email : '',
        bio: typeof d.bio === 'string' ? d.bio : '',
        avatarUrl: typeof d.avatarUrl === 'string' ? d.avatarUrl : '',
        coverImageUrl: typeof d.coverImageUrl === 'string' ? d.coverImageUrl : '',
        website: typeof d.website === 'string' ? d.website : '',
        followersCount: typeof d.followersCount === 'number' ? d.followersCount : 0,
        followingCount: typeof d.followingCount === 'number' ? d.followingCount : 0,
        postsCount: typeof d.postsCount === 'number' ? d.postsCount : 0,
        dmPreference: (d.dmPreference as User['dmPreference']) || 'all',
        isAdmin: Boolean(d.isAdmin),
        isModerator: Boolean(d.isModerator),
        profileVisibility: (d.profileVisibility as User['profileVisibility']) || 'public',
        createdAt: typeof d.createdAt === 'string' ? d.createdAt : new Date().toISOString(),
        isFollowing,
      });
    });

    for (const [h, uid] of handleToUid.entries()) {
      const localUser = uidToUser.get(uid);
      if (localUser) {
        localResolutionMap.set(h, { user: localUser });
      }
    }
  }

  // Verifica quais contas remotas o usuário logado já segue no Fediverso
  const remoteAccounts = accounts.filter(
    (a) => !ownDomainsSet.has(a.domain.toLowerCase()),
  );
  // "Seguindo" (aceito, ou registro antigo) e "Solicitação enviada" (pedido pendente a perfil fechado) são estados diferentes.
  const followedSet = new Set<string>();
  const requestedSet = new Set<string>();
  if (callerUid && remoteAccounts.length > 0) {
    const actorHashes = remoteAccounts.map((a) => remoteFollowDocIdOf(a.actorId));
    const snaps = await Promise.all(
      actorHashes.map((h) => db.collection('ap_following').doc(callerUid).collection('actors').doc(h).get()),
    );
    snaps.forEach((s, idx) => {
      if (!s.exists) return;
      if ((s.data() as { status?: string } | undefined)?.status === 'pending') requestedSet.add(remoteAccounts[idx].actorId);
      else followedSet.add(remoteAccounts[idx].actorId);
    });
  }

  // Materializa perfis e vínculos no Firestore em lote
  const batch = db.batch();
  const nowIso = new Date().toISOString();
  const resultUsers: User[] = [];

  for (const acc of accounts) {
    const isOwnDomain = ownDomainsSet.has(acc.domain.toLowerCase());
    const localKey = isOwnDomain ? acc.handle.split('@')[0].toLowerCase() : '';
    const resolvedLocal = localKey ? localResolutionMap.get(localKey) : undefined;
    if (isOwnDomain) {
      if (resolvedLocal) {
        const linkRef = db.collection('users').doc(profileUserId).collection(type).doc(resolvedLocal.user.id);
        batch.set(
          linkRef,
          {
            userId: resolvedLocal.user.id,
            createdAt: FieldValue.serverTimestamp(),
          },
          { merge: true },
        );
        resultUsers.push(resolvedLocal.user);
      }
      continue;
    }

    const uid = remoteUserIdOf(acc.actorId);
    const userRef = db.collection('users').doc(uid);
    batch.set(
      userRef,
      {
        id: uid,
        name: acc.name,
        name_lowercase: (acc.name || acc.handle || '').toLowerCase(),
        username: acc.handle,
        bio: acc.bio,
        avatarUrl: acc.avatarUrl,
        coverImageUrl: acc.coverImageUrl,
        website: acc.url,
        // Só o que a origem informou: gravar 0 aqui zerava, a cada listagem, os números já guardados de cada conta.
        ...(typeof acc.followersCount === 'number' ? { followersCount: acc.followersCount } : {}),
        ...(typeof acc.followingCount === 'number' ? { followingCount: acc.followingCount } : {}),
        ...(typeof acc.postsCount === 'number' ? { postsCount: acc.postsCount } : {}),
        ...(typeof acc.discoverable === 'boolean' ? { remoteDiscoverable: acc.discoverable } : {}),
        ...(typeof acc.indexable === 'boolean' ? { remoteIndexable: acc.indexable } : {}),
        dmPreference: 'everyone',
        profileVisibility: 'public',
        isRemoteFediverse: true,
        remoteActorId: acc.actorId,
        remoteDomain: acc.domain,
        remoteUrl: acc.url,
        ...(typeof acc.locked === 'boolean' ? { remoteManuallyApprovesFollowers: acc.locked } : {}),
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );

    const linkRef = db.collection('users').doc(profileUserId).collection(type).doc(uid);
    batch.set(
      linkRef,
      {
        userId: uid,
        isRemoteFediverse: true,
        createdAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );

    resultUsers.push({
      id: uid,
      name: acc.name,
      username: acc.handle,
      email: '',
      bio: acc.bio,
      avatarUrl: acc.avatarUrl,
      coverImageUrl: acc.coverImageUrl,
      website: acc.url,
      followersCount: acc.followersCount ?? 0,
      followingCount: acc.followingCount ?? 0,
      postsCount: acc.postsCount ?? 0,
      dmPreference: 'none',
      isAdmin: false,
      isModerator: false,
      profileVisibility: 'public',
      createdAt: nowIso,
      isFollowing: followedSet.has(acc.actorId),
      followRequested: requestedSet.has(acc.actorId),
      ...(typeof acc.locked === 'boolean' ? { remoteManuallyApprovesFollowers: acc.locked } : {}),
    });
  }

  await batch.commit();
  return { users: resultUsers, restricted: false };
}

