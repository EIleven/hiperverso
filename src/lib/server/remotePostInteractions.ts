// src/lib/server/remotePostInteractions.ts
// Importa comentários, curtidas e repostagens de posts remotos do Fediverso sob demanda.
import { isOwnHostUrl, remotePostIdOf, sameHost } from '@/lib/activitypub/remoteIdentity';
import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import type { User } from '@/lib/types';
import { decideInstance } from '@/lib/activitypub/gate';
import { pausaDeConsentimento } from '@/lib/activitypub/consentimentoDeDominio';
import { isFromSuspendedFediverseDomain, isSuspendedFediverseHost } from '@/lib/federation/suspendedDomains';
import { ACTIVITY_ACCEPT, resolveRemoteActor } from '@/lib/activitypub/remote';
import { classificarLeitura, contagensDoNote, idDe, itensDe, primeiraPagina, type LeituraAp } from '@/lib/activitypub/colecoes';
import type { RemoteActorRecord } from '@/lib/activitypub/store';
import { federation } from '@/lib/server/federation';
import { podeLerDoDominio } from '@/lib/server/leituraRemota';
import { aplicarCicloAoDocumento, aplicarCicloAoPost } from '@/lib/server/cicloDeVidaRemoto';
import { adminFirestore } from '@/lib/server/firebaseAdmin';
import { createDomainGate, createSyncMemo } from '@/lib/federation/countSyncPolicy';
import { createCountSyncer, type CountSyncOutcome, type FetchedStatus } from '@/lib/federation/countSyncer';
import { applyRemoteCounts } from '@/lib/server/remoteCounts';
import { remoteUserIdOf } from '@/lib/server/remoteMaterialize';
import { stripHtml } from '@/lib/server/remoteProfile';

interface MastodonAccount {
  id?: string;
  /** `toot:discoverable` / `toot:indexable` do ator. Só `true` é sim. */
  discoverable?: boolean;
  indexable?: boolean;
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
}

interface MastodonStatus {
  id?: string;
  uri?: string;
  url?: string;
  content?: string;
  created_at?: string;
  in_reply_to_id?: string | null;
  favourites_count?: number;
  reblogs_count?: number;
  replies_count?: number;
  account?: MastodonAccount;
}

const AS_PUBLIC = 'https://www.w3.org/ns/activitystreams#Public';

function hostDe(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Podemos LER deste domínio agora? Plataforma ligada, domínio não suspenso (nem na lista fixa, nem na política do banco)
 * e sem pausa de consentimento ativa -- quem recusa receber de nós também não é lido por nós.
 */
async function podeLer(dominio: string): Promise<boolean> {
  return (await podeLerDoDominio(dominio)).pode;
}

/**
 * Onde o objeto ActivityPub do post mora, se podemos ler de lá. `statusId` carrega o ID AP (URI) do objeto: o
 * orquestrador de contadores só repassa o valor, não o interpreta.
 *
 * Antes isto extraía um id NUMÉRICO da URL para chamar a REST do Mastodon e, se não achasse, perguntava ao servidor por
 * `/api/v2/search?resolve=true` sem autenticação. Agora o objeto é lido pelo próprio ID, como o protocolo prevê.
 */
async function localizarObjeto(postData: {
  remoteUrl?: string;
  remoteObjectId?: string;
  remoteActorId?: string;
}): Promise<{ domain: string; statusId: string } | null> {
  const objectUri = [postData.remoteObjectId, postData.remoteUrl].find(
    (u): u is string => typeof u === 'string' && u.startsWith('https://'),
  );
  if (!objectUri) return null;
  const domain = hostDe(objectUri);
  if (!domain) return null;
  if (isOwnHostUrl(objectUri, federation().ownHost)) return null;
  if (!(await podeLer(domain))) return null;
  return { domain, statusId: objectUri };
}

/**
 * GET ActivityPub de um objeto, com a classificação da resposta. O `fetcher` da federação tenta sem assinatura e, se o
 * servidor exigir (401/403), repete ASSINADO -- e para aí. Recusa assinada é resposta final: não existe caminho B.
 *
 * `exigirId`: o objeto devolvido tem de ser o que pedimos (mesmo host, `id` igual ao pedido ou ao destino final do
 * redirecionamento). Páginas de coleção têm `id` com parâmetros próprios, então lá basta o mesmo host.
 */
async function lerObjetoRemoto(
  url: string,
  opcoes: { exigirId?: boolean } = {},
): Promise<{ leitura: LeituraAp; json: Record<string, unknown> | null; status: number | null }> {
  const exigirId = opcoes.exigirId !== false;
  try {
    const r = await federation().inbox.fetcher.get(url, { accept: ACTIVITY_ACCEPT });
    const leitura = classificarLeitura(r.status, r.json);
    if (leitura !== 'ok') return { leitura, json: null, status: r.status };
    const o = r.json as Record<string, unknown>;
    const id = typeof o.id === 'string' ? o.id : '';
    if (!sameHost(r.finalUrl || url, url)) return { leitura: 'falha', json: null, status: r.status };
    if (exigirId && id !== url && id !== r.finalUrl && o.url !== url) return { leitura: 'falha', json: null, status: r.status };
    if (exigirId && !sameHost(id, url)) return { leitura: 'falha', json: null, status: r.status };
    return { leitura, json: o, status: r.status };
  } catch {
    return { leitura: 'falha', json: null, status: null };
  }
}

/** O ator AP no formato que `resolveAccountToUser` entende. Sem contagens: o ator não as publica, e ausente != zero. */
function contaDoAtor(ator: RemoteActorRecord): MastodonAccount {
  return {
    uri: ator.actorId,
    url: ator.actorId,
    acct: ator.handle,
    username: ator.handle.split('@')[0],
    display_name: ator.name,
    note: ator.summary,
    avatar: ator.iconUrl ?? undefined,
    discoverable: ator.discoverable === true,
    indexable: ator.indexable === true,
  };
}

async function resolveAccountToUser(
  m: MastodonAccount,
  fallbackDomain: string,
  ownHostLower: string,
): Promise<{ uid: string; name: string; username: string; avatarUrl: string; actorId: string; isLocal: boolean; userObj: User } | null> {
  const actorId =
    (typeof m.uri === 'string' && m.uri.startsWith('https://') ? m.uri : null) ||
    (typeof m.url === 'string' && m.url.startsWith('https://') ? m.url : null);
  if (!actorId) return null;

  const acct = typeof m.acct === 'string' && m.acct ? m.acct : m.username || '';
  if (!acct) return null;
  const handle = acct.includes('@') ? acct : `${acct}@${fallbackDomain}`;
  const itemDomain = handle.split('@').pop()?.toLowerCase() || fallbackDomain;

  if (
    isSuspendedFediverseHost(itemDomain) ||
    isFromSuspendedFediverseDomain({ username: handle, remoteUrl: actorId })
  ) {
    return null;
  }

  const f = federation();
  const politica = await f.store.getInstancePolicy();
  if (itemDomain !== ownHostLower && decideInstance(itemDomain, politica, f.ownHost).decision === 'reject') {
    return null;
  }
  const saude = await f.store.getDomainHealth(itemDomain).catch(() => null);
  if (pausaDeConsentimento(saude, Date.now()).pausado) {
    return null;
  }

  const db = adminFirestore();
  if (itemDomain === ownHostLower) {
    const localHandle = handle.split('@')[0].toLowerCase();
    const hSnap = await db.collection('ap_handles').doc(localHandle).get();
    const localUid = (hSnap.data() as { uid?: string } | undefined)?.uid;
    if (localUid) {
      const uSnap = await db.collection('users').doc(localUid).get();
      if (uSnap.exists) {
        const d = uSnap.data() as Record<string, unknown>;
        const userObj: User = {
          id: localUid,
          name: typeof d.name === 'string' ? d.name : 'Usuário',
          username: typeof d.username === 'string' ? d.username : handle.split('@')[0],
          email: '',
          bio: typeof d.bio === 'string' ? d.bio : '',
          avatarUrl: typeof d.avatarUrl === 'string' ? d.avatarUrl : '',
          coverImageUrl: typeof d.coverImageUrl === 'string' ? d.coverImageUrl : '',
          website: typeof d.website === 'string' ? d.website : '',
          followersCount: typeof d.followersCount === 'number' ? d.followersCount : 0,
          followingCount: typeof d.followingCount === 'number' ? d.followingCount : 0,
          postsCount: typeof d.postsCount === 'number' ? d.postsCount : 0,
          dmPreference: (d.dmPreference as User['dmPreference']) || 'everyone',
          isAdmin: Boolean(d.isAdmin),
          isModerator: Boolean(d.isModerator),
          profileVisibility: (d.profileVisibility as User['profileVisibility']) || 'public',
          createdAt: typeof d.createdAt === 'string' ? d.createdAt : new Date().toISOString(),
        };
        return {
          uid: localUid,
          name: userObj.name,
          username: userObj.username,
          avatarUrl: userObj.avatarUrl || '',
          actorId,
          isLocal: true,
          userObj,
        };
      }
    }
  }

  const uid = remoteUserIdOf(actorId);
  const name = (typeof m.display_name === 'string' && m.display_name.trim()) || m.username || handle.split('@')[0];
  const bio = typeof m.note === 'string' ? stripHtml(m.note).slice(0, 500) : '';
  const avatarUrl =
    typeof m.avatar === 'string' && m.avatar.startsWith('https://') && !m.avatar.includes('missing.png')
      ? m.avatar
      : '';
  const coverImageUrl =
    typeof m.header === 'string' && m.header.startsWith('https://') && !m.header.includes('missing.png')
      ? m.header
      : '';
  const url = typeof m.url === 'string' && m.url.startsWith('https://') ? m.url : actorId;
  const followersCount = typeof m.followers_count === 'number' ? m.followers_count : 0;
  const followingCount = typeof m.following_count === 'number' ? m.following_count : 0;
  const postsCount = typeof m.statuses_count === 'number' ? m.statuses_count : 0;

  await db.collection('users').doc(uid).set(
    {
      id: uid,
      name,
      name_lowercase: (name || handle || '').toLowerCase(),
      username: handle,
      bio,
      avatarUrl,
      coverImageUrl,
      website: url,
      // Só grava contagem que a origem INFORMOU. Autor vindo do ator ActivityPub não traz número, e gravar 0 por cima
      // apagaria o que já sabíamos dele.
      ...(typeof m.followers_count === 'number' ? { followersCount } : {}),
      ...(typeof m.following_count === 'number' ? { followingCount } : {}),
      ...(typeof m.statuses_count === 'number' ? { postsCount } : {}),
      dmPreference: 'everyone',
      profileVisibility: 'public',
      isRemoteFediverse: true,
      // O que a pessoa disse sobre ser descoberta e indexada; só grava quando veio do ator (campo presente).
      ...(typeof m.discoverable === 'boolean' ? { remoteDiscoverable: m.discoverable } : {}),
      ...(typeof m.indexable === 'boolean' ? { remoteIndexable: m.indexable } : {}),
      remoteActorId: actorId,
      remoteDomain: itemDomain,
      remoteUrl: url,
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );

  return {
    uid,
    name,
    username: handle,
    avatarUrl,
    actorId,
    isLocal: false,
    userObj: {
      id: uid,
      name,
      username: handle,
      email: '',
      bio,
      avatarUrl,
      coverImageUrl,
      website: url,
      followersCount,
      followingCount,
      postsCount,
      dmPreference: 'everyone',
      isAdmin: false,
      isModerator: false,
      profileVisibility: 'public',
      createdAt: new Date().toISOString(),
    },
  };
}

// ───────────────────────── revalidação dos contadores em segundo plano ─────────────────────────
// Chamada pelo feed (`/api/ap/sync-counts`) para os posts remotos que acabaram de chegar perto da tela, para que o número
// já apareça sem abrir o post. Custa uma busca a SERVIDOR ALHEIO por post, então tudo aqui existe para limitar essa
// busca (a regra pura está em src/lib/federation/countSyncPolicy.ts e é testada em e2e/count-sync-check.mjs):
//  - validade: um post revalidado (por qualquer pessoa, em qualquer aba) não é buscado de novo por 3 min; falha passageira
//    espera 1 min e "não existe lá / não deixa ler" espera 30 min;
//  - por servidor: no máximo 2 buscas ao mesmo tempo e 20 por minuto, e quem responde 429/503 não recebe nada até o prazo
//    do `Retry-After` (o IP é compartilhado com a sincronização de comentários e de quem reagiu);
//  - a gravação passa pela regra de counterPolicy.ts DENTRO de transação (applyRemoteCounts): sobe, DESCE quando alguém
//    descurtiu na origem, e não perde a curtida daqui somada no meio do caminho.
const syncMemo = createSyncMemo();
const domainGate = createDomainGate();

type RemotePostFields = {
  remoteUrl?: string;
  remoteObjectId?: string;
  remoteActorId?: string;
  remoteCountsAtMs?: number;
};

/** Servidor de origem do post, lido do próprio documento (sem rede), ou `null`. */
function remoteHostOf(post: RemotePostFields): string | null {
  const raw = post.remoteUrl || post.remoteObjectId || '';
  if (!raw.startsWith('https://')) return null;
  try {
    return new URL(raw).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Lê o objeto na origem e traduz para o que o orquestrador entende (sem decidir nada). Os números vêm do que o próprio
 * `Note` publica (`likes`/`shares`/`replies` com `totalItems`); o que não vier fica como está.
 */
async function fetchRemoteStatus(location: { domain: string; statusId: string }): Promise<FetchedStatus> {
  const r = await lerObjetoRemoto(location.statusId);
  // A origem disse que o objeto não existe mais (410/Tombstone) ou não achou (404): a cópia local segue o ciclo de vida
  // (apaga já, ou oculta e só apaga confirmado). Antes ela ficava no ar para sempre.
  if (r.leitura === 'apagado' || r.leitura === 'sumiu') await aplicarCicloAoPost(location.statusId, r.leitura).catch(() => null);
  if (r.leitura === 'ok' && r.json) return { kind: 'ok', origin: contagensDoNote(r.json) };
  if (r.leitura === 'limitada') return { kind: 'rate-limited', status: r.status ?? 429 };
  if (r.leitura === 'recusada' || r.leitura === 'apagado' || r.leitura === 'sumiu') return { kind: 'gone', status: r.status ?? 404 };
  return { kind: 'error', ...(r.status !== null ? { status: r.status } : {}) };
}

const syncOnePost = createCountSyncer<RemotePostFields>({
  now: () => Date.now(),
  readPost: async (id) => {
    const snap = await adminFirestore().collection('posts').doc(id).get();
    return snap.exists ? (snap.data() as RemotePostFields) : null;
  },
  hostOf: remoteHostOf,
  checkedAtMsOf: (post) => post.remoteCountsAtMs,
  locate: (post) => localizarObjeto(post),
  fetchStatus: fetchRemoteStatus,
  apply: async (id, origin, fetchedAtMs) => {
    const decisions = await applyRemoteCounts(id, { origin, fetchedAtMs });
    if (!decisions) return 'missing';
    return Object.values(decisions).some((d) => d && d.action !== 'keep') ? 'updated' : 'unchanged';
  },
  gate: domainGate,
  memo: syncMemo,
  warn: (message) => console.warn(message),
});

/** Revalida os contadores de UM post remoto na origem (com todos os freios). Nunca lança. */
export function syncRemotePostCounts(postId: string, now?: number): Promise<CountSyncOutcome> {
  return syncOnePost(postId, now);
}

export async function syncRemotePostComments(postId: string): Promise<number> {
  const db = adminFirestore();
  const postSnap = await db.collection('posts').doc(postId).get();
  if (!postSnap.exists) return 0;
  const postData = postSnap.data() as {
    userId?: string;
    visibility?: string;
    commentsCount?: number;
    remoteUrl?: string;
    remoteObjectId?: string;
    remoteActorId?: string;
    isRemoteFediverse?: boolean;
  };
  if (!postData.isRemoteFediverse && !postId.startsWith('ap_')) return 0;

  const f = federation();
  const loc = await localizarObjeto(postData);
  if (!loc) return 0;
  const paiUri = loc.statusId;
  const objeto = await lerObjetoRemoto(paiUri);
  // Abrir o post também é o momento de conferir se ele ainda existe na origem -- e de restaurar o que ocultamos por um
  // 404 que não se confirmou.
  await aplicarCicloAoPost(paiUri, objeto.leitura).catch(() => null);
  if (objeto.leitura !== 'ok' || !objeto.json) return 0;

  // A origem é a fonte do número PÚBLICO; a regra (counterPolicy.ts) decide quando subir, quando descer e quando
  // desconfiar. Dentro de transação, para não desfazer uma curtida daqui somada no meio do caminho.
  const origem = contagensDoNote(objeto.json);
  if (Object.keys(origem).length > 0) await applyRemoteCounts(postId, { origin: origem }).catch(() => null);

  // Antes: `/api/v1/statuses/{id}/context` sem autenticação, que devolve a conversa inteira montada pelo servidor --
  // inclusive respostas que ele nunca federou. Agora: a coleção `replies` que o próprio objeto publica.
  const ids = await idsDasRespostas(objeto.json.replies, paiUri, MAX_RESPOSTAS);
  await reconferirRespostasAusentes(postId, new Set(ids));
  if (ids.length === 0) return 0;

  const ownHostLower = f.ownHost.toLowerCase();
  let added = 0;
  let conferidas = 0;
  for (const id of ids) {
    if (isFromSuspendedFediverseDomain({ remoteUrl: id })) continue;
    const resposta = await respostaConferida(id, paiUri);
    if (!resposta) continue;
    conferidas++;
    const { note, autorId } = resposta;
    const text = typeof note.content === 'string' ? stripHtml(note.content).slice(0, 2000) : '';
    if (!text) continue;

    const ator = await resolveRemoteActor(f.inbox, autorId).catch(() => null);
    if (!ator || !ator.ok) continue;
    const resolvedAuthor = await resolveAccountToUser(contaDoAtor(ator.actor), ator.actor.domain, ownHostLower);
    if (!resolvedAuthor) continue;

    const commentId = remotePostIdOf(id);
    const publicado = typeof note.published === 'string' ? Date.parse(note.published) : NaN;
    const createdMs = Number.isFinite(publicado) ? publicado : Date.now();
    const contagens = contagensDoNote(note);

    const cRef = db.collection('posts').doc(postId).collection('comments').doc(commentId);
    const existing = await cRef.get();
    if (!existing.exists) {
      await cRef.set({
        userId: resolvedAuthor.uid,
        authorDetails: {
          userId: resolvedAuthor.uid,
          name: resolvedAuthor.name,
          username: resolvedAuthor.username,
          avatarUrl: resolvedAuthor.avatarUrl || null,
        },
        isRemoteFediverse: !resolvedAuthor.isLocal,
        remoteActorUrl: resolvedAuthor.actorId,
        remoteHandle: resolvedAuthor.username,
        apObjectId: id,
        parentPostId: postId,
        postAuthorId: postData.userId || '',
        postVisibility: postData.visibility || 'public',
        parentCommentId: null,
        text,
        hasMedia: false,
        createdAt: Timestamp.fromMillis(createdMs),
        likes: contagens.likes ?? 0,
        repostsCount: contagens.reposts ?? 0,
        repliesCount: contagens.commentsCount ?? 0,
        isDeleted: false,
      });
      added++;
    } else if (!existing.data()?.apObjectId) {
      await cRef.update({ apObjectId: id }).catch(() => null);
    }
  }

  // Piso, não valor: só sobe, e só com o que foi CONFERIDO.
  if (conferidas > 0) await applyRemoteCounts(postId, { lowerBound: { commentsCount: conferidas } }).catch(() => null);
  return added;
}

/** No máximo tantas respostas conferidas por sincronização: cada uma é um GET num servidor alheio. */
const MAX_RESPOSTAS = 20;

/** No máximo tantas cópias de resposta rechecadas por abertura do post. */
const MAX_RECONFERENCIAS = 5;

/**
 * Resposta apagada SOME da coleção `replies` -- e por isso nunca mais seria buscada, e a nossa cópia ficaria no ar. Aqui
 * as cópias remotas que guardamos e que não apareceram na coleção são conferidas no servidor de quem as escreveu (poucas
 * por vez) e seguem o mesmo ciclo do post. Ausência na página não é prova de nada (pode ser paginação); a resposta da
 * origem é.
 */
async function reconferirRespostasAusentes(postId: string, listadas: Set<string>): Promise<void> {
  const snap = await adminFirestore()
    .collection('posts').doc(postId).collection('comments')
    .where('isRemoteFediverse', '==', true)
    .limit(40)
    .get()
    .catch(() => null);
  if (!snap) return;
  let conferidas = 0;
  for (const c of snap.docs) {
    if (conferidas >= MAX_RECONFERENCIAS) break;
    const apObjectId = c.data().apObjectId;
    if (typeof apObjectId !== 'string' || !apObjectId.startsWith('https://') || listadas.has(apObjectId)) continue;
    const dominio = hostDe(apObjectId);
    if (!dominio || !(await podeLer(dominio))) continue;
    conferidas++;
    const r = await lerObjetoRemoto(apObjectId);
    await aplicarCicloAoDocumento(c.ref, r.leitura).catch(() => null);
  }
}

/**
 * Os ids das respostas publicadas na coleção `replies` do objeto: a primeira página e, no máximo, a seguinte (o Mastodon
 * põe as respostas do próprio autor na primeira e as de outras contas na `next`). Toda página tem de morar no mesmo
 * servidor do post: uma coleção que aponta para outro host não nos leva a ele.
 */
async function idsDasRespostas(colecao: unknown, paiUri: string, maxIds: number): Promise<string[]> {
  const ids: string[] = [];
  const juntar = (pagina: unknown) => {
    for (const item of itensDe(pagina)) {
      const id = idDe(item);
      if (id && !ids.includes(id)) ids.push(id);
    }
  };
  const buscarPagina = async (url: string): Promise<Record<string, unknown> | null> => {
    if (!sameHost(url, paiUri)) return null;
    const r = await lerObjetoRemoto(url, { exigirId: false });
    return r.leitura === 'ok' ? r.json : null;
  };

  let alvo: unknown = colecao;
  if (typeof colecao === 'string') {
    if (!colecao.startsWith('https://')) return [];
    alvo = await buscarPagina(colecao);
    if (!alvo) return [];
  }
  juntar(alvo);

  const primeira = primeiraPagina(alvo);
  let pagina: Record<string, unknown> | null = null;
  if (primeira && 'embutida' in primeira) pagina = primeira.embutida;
  else if (primeira && 'url' in primeira) pagina = await buscarPagina(primeira.url);
  if (pagina) {
    juntar(pagina);
    const proxima = pagina.next;
    if (typeof proxima === 'string' && proxima.startsWith('https://') && ids.length < maxIds) {
      const seguinte = await buscarPagina(proxima);
      if (seguinte) juntar(seguinte);
    }
  }
  return ids.slice(0, maxIds);
}

/**
 * Uma resposta só entra conferida NO SERVIDOR DE QUEM A ESCREVEU: o objeto é o que pedimos, é público, responde a ESTE
 * post e o autor mora no mesmo host do objeto. Domínio suspenso ou em pausa de consentimento nem é consultado.
 */
async function respostaConferida(
  id: string,
  paiUri: string,
): Promise<{ note: Record<string, unknown>; autorId: string } | null> {
  const dominio = hostDe(id);
  if (!dominio || isOwnHostUrl(id, federation().ownHost)) return null;
  if (!(await podeLer(dominio))) return null;
  const r = await lerObjetoRemoto(id);
  if (r.leitura !== 'ok' || !r.json) return null;
  const o = r.json;
  if (o.type !== 'Note' && o.type !== 'Article') return null;
  const brutoPai = o.inReplyTo;
  const inReplyTo = typeof brutoPai === 'string'
    ? brutoPai
    : brutoPai && typeof brutoPai === 'object' && typeof (brutoPai as { id?: unknown }).id === 'string'
      ? (brutoPai as { id: string }).id
      : null;
  if (inReplyTo !== paiUri) return null;
  const enderecos = [...(Array.isArray(o.to) ? o.to : []), ...(Array.isArray(o.cc) ? o.cc : [])];
  if (!enderecos.includes(AS_PUBLIC)) return null;
  const brutoAutor = Array.isArray(o.attributedTo) ? o.attributedTo[0] : o.attributedTo;
  const autorId = typeof brutoAutor === 'string'
    ? brutoAutor
    : brutoAutor && typeof brutoAutor === 'object' && typeof (brutoAutor as { id?: unknown }).id === 'string'
      ? (brutoAutor as { id: string }).id
      : null;
  if (!autorId || !autorId.startsWith('https://') || !sameHost(autorId, id)) return null;
  return { note: o, autorId };
}

// ───────────────────────── quem curtiu / quem repostou ─────────────────────────
// O ActivityPub NÃO publica a lista de quem curtiu ou repostou: o Mastodon expõe só o `totalItems` de `likes`/`shares`.
// Antes estas duas funções montavam a lista pela REST (`/favourited_by`, `/reblogged_by`) sem autenticação -- pegar do
// outro servidor algo que ele não federou. Agora não buscam nada fora. Quem reagiu e chegou até nós pelo inbox (Like,
// Announce) já está nas subcoleções locais, que a tela lê direto; o resto da lista fica onde mora, no servidor de origem.
// `restricted` diz à tela que existe contagem sem lista, para ela oferecer o link para a origem em vez de "ninguém".

export async function fetchAndMaterializeRemotePostReactors(
  postId: string,
  mode: 'likes' | 'reposts',
  _callerUid?: string | null,
): Promise<{ users: User[]; restricted: boolean }> {
  const snap = await adminFirestore().collection('posts').doc(postId).get();
  if (!snap.exists) return { users: [], restricted: false };
  const d = snap.data() as { isRemoteFediverse?: boolean; likes?: number; reposts?: number };
  if (!d.isRemoteFediverse && !postId.startsWith('ap_')) return { users: [], restricted: false };
  const esperado = mode === 'likes' ? Number(d.likes ?? 0) : Number(d.reposts ?? 0);
  return { users: [], restricted: esperado > 0 };
}

export async function fetchAndMaterializeRemoteCommentReactors(
  postId: string,
  commentId: string,
  mode: 'likes' | 'reposts',
  _callerUid?: string | null,
): Promise<{ users: User[]; restricted: boolean }> {
  const snap = await adminFirestore().collection('posts').doc(postId).collection('comments').doc(commentId).get();
  if (!snap.exists) return { users: [], restricted: false };
  const d = snap.data() as { isRemoteFediverse?: boolean; likes?: number; repostsCount?: number };
  if (!d.isRemoteFediverse && !commentId.startsWith('ap_')) return { users: [], restricted: false };
  const esperado = mode === 'likes' ? Number(d.likes ?? 0) : Number(d.repostsCount ?? 0);
  return { users: [], restricted: esperado > 0 };
}
