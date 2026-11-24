// src/lib/server/remoteMaterialize.ts
// Materializa perfis e posts remotos do Fediverso no Firestore com a mesma estrutura nativa de User e Post do HiperVerso.
//
// O que este módulo garante (e antes não garantia):
//  - **O que é do nosso domínio nunca vira `ap_`.** Resposta ou repost de um post/conta DAQUI, visto pelo perfil de quem
//    respondeu ou repostou, criava um "Breno" fantasma e uma cópia do post dele. Agora o item é ignorado: quem trata a
//    interação com conteúdo nosso é o inbox (portão de consentimento, bloqueios e idempotência).
//  - **Um post só é de um terceiro se o servidor DELE disser.** Repost e resposta trazem posts de outros atores, e o servidor de
//    quem reposta é só o mensageiro: o post de terceiro só entra depois de buscado no servidor do autor (id igual à URL,
//    `attributedTo` igual ao autor, mesmo host) e o autor passa por `resolveRemoteActor`, que valida o ator.
//  - **Nada de outro ator é sobrescrito**: um post só é atualizado pelo mesmo ator que o criou, e um usuário de terceiro só é
//    criado se ainda não existir (nunca regravado com dados que o mensageiro afirmou).
//  - **Um post, um id.** O id sai do id ActivityPub (`uri`), como no inbox; antes saía da URL da página e o mesmo post aparecia
//    duas vezes. Documentos antigos, gravados pela URL, continuam sendo reconhecidos.
import type { CollectionReference } from 'firebase-admin/firestore';
import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { domainOfUrl } from '@/lib/activitypub/identity';
import { resolveRemoteActor } from '@/lib/activitypub/remote';
import {
  canonicalObjectId,
  isOwnHostUrl,
  remotePostIdOf,
  remoteUserIdOf,
} from '@/lib/activitypub/remoteIdentity';
import type { Post, User } from '@/lib/types';
import { adminFirestore } from '@/lib/server/firebaseAdmin';
import { federation } from '@/lib/server/federation';
import { applyRemoteCounts } from '@/lib/server/remoteCounts';
import {
  fetchVerifiedNote,
  stripHtml,
  type RemotePostItem,
  type RemoteProfileData,
  type VerifiedNote,
} from '@/lib/server/remoteProfile';

// Os ids vivem em remoteIdentity (uma fonte só); reexportados para quem já importava daqui.
export { remotePostIdOf, remoteUserIdOf };

/** Quantos posts de TERCEIROS (reposts e pais de respostas) se confere por sincronização: cada um custa uma busca de rede. */
const MAX_TERCEIROS_POR_SINCRONIZACAO = 12;
const MAX_ITENS = 15;
const HASHTAG = /#([a-zA-Z0-9_áéíóúÁÉÍÓÚàèìòùÀÈÌÒÙâêîôûÂÊÎÔÛãõÃÕçÇ]+)/g;

type Midia = { url: string; type: 'image' | 'video'; alt: string | null };
type Autor = { userId: string; name: string; username: string; avatarUrl: string };

const hashtagsDe = (texto: string): string[] => Array.from(new Set(texto.match(HASHTAG) ?? []));

/** O documento de um post remoto, com a estrutura de um post nativo. */
function documentoDoPost(p: {
  id: string;
  autor: Autor;
  texto: string;
  midia: Midia[];
  criadoEmMs: number;
  curtidas: number;
  reposts: number;
  respostas: number;
  objectId: string;
  url: string;
  actorId: string;
  inbox: string | null;
}) {
  const tags = hashtagsDe(p.texto);
  return {
    id: p.id,
    userId: p.autor.userId,
    authorDetails: p.autor,
    text: p.texto,
    hashtags: tags.length > 0 ? tags : null,
    media: p.midia,
    hasMedia: p.midia.length > 0,
    visibility: 'public',
    federation: 'local',
    type: 'original',
    category: 'echo',
    allowReposts: true,
    replyPermission: 'everyone',
    likes: p.curtidas,
    reposts: p.reposts,
    commentsCount: p.respostas,
    quotesCount: 0,
    views: 0,
    isDeleted: false,
    isEdited: false,
    editCount: 0,
    postFormat: 'standard',
    createdAt: Timestamp.fromMillis(p.criadoEmMs),
    isRemoteFediverse: true,
    remoteObjectId: p.objectId,
    remoteUrl: p.url,
    remoteActorId: p.actorId,
    remoteInbox: p.inbox,
  };
}

/** Primeiro documento que existe entre os ids candidatos (o novo, pelo `uri`, e o antigo, pela URL da página). */
async function primeiroExistente(
  colecao: CollectionReference,
  ids: string[],
): Promise<{ id: string; dados: Record<string, unknown> } | null> {
  for (const id of ids) {
    const snap = await colecao.doc(id).get();
    if (snap.exists) return { id, dados: snap.data() as Record<string, unknown> };
  }
  return null;
}

export async function materializeRemoteProfile(
  profile: RemoteProfileData,
): Promise<{ user: User; posts: Post[] }> {
  const f = federation();
  const db = adminFirestore();
  // Defesa em profundidade: resolveRemoteProfile já recusa, mas nada daqui pode criar um ap_ para o nosso domínio.
  if (isOwnHostUrl(profile.actorId, f.ownHost)) {
    throw new Error('ator-proprio: um perfil do nosso domínio nunca é materializado como remoto');
  }
  const uid = remoteUserIdOf(profile.actorId);
  const targetInbox = profile.inbox || profile.sharedInbox || null;
  const nowIso = new Date().toISOString();

  const userRef = db.collection('users').doc(uid);
  const existingUserSnap = await userRef.get();
  await userRef.set(
    {
      id: uid,
      name: profile.name,
      name_lowercase: (profile.name || profile.handle || '').toLowerCase(),
      username: profile.handle,
      bio: profile.summary || '',
      avatarUrl: profile.iconUrl || '',
      coverImageUrl: profile.headerUrl || '',
      website: profile.url,
      // Só grava contagem que a origem INFORMOU. O ator ActivityPub não publica número de seguidores; com a REST fora,
      // `?? 0` aqui zeraria o que já sabíamos a cada abertura de perfil. Ausente não é zero.
      ...(typeof profile.followersCount === 'number' ? { followersCount: profile.followersCount } : {}),
      ...(typeof profile.followingCount === 'number' ? { followingCount: profile.followingCount } : {}),
      ...(typeof profile.postsCount === 'number' ? { postsCount: profile.postsCount } : {}),
      ...(existingUserSnap.exists ? {} : { followersCount: profile.followersCount ?? 0, followingCount: profile.followingCount ?? 0, postsCount: profile.postsCount ?? (profile.posts?.length ?? 0) }),
      dmPreference: 'everyone' as const,
      profileVisibility: 'public' as const,
      isRemoteFediverse: true,
      remoteActorId: profile.actorId,
      remoteDomain: profile.domain,
      remoteUrl: profile.url,
      remoteInbox: targetInbox,
      // Verdade do ator no momento da leitura: é o que decide, nas listas e nos balões, entre "Seguir" e "Pedir para seguir".
      remoteManuallyApprovesFollowers: profile.manuallyApprovesFollowers === true,
      // O que a pessoa disse sobre ser descoberta e ter o texto buscado (só `true` é sim). Decide busca e explorar.
      ...(typeof profile.discoverable === 'boolean' ? { remoteDiscoverable: profile.discoverable } : {}),
      ...(typeof profile.indexable === 'boolean' ? { remoteIndexable: profile.indexable } : {}),
      updatedAt: FieldValue.serverTimestamp(),
      ...(existingUserSnap.exists ? {} : { createdAt: FieldValue.serverTimestamp() }),
    },
    { merge: true },
  );

  const nativeUser: User = {
    id: uid,
    name: profile.name,
    username: profile.handle,
    email: '',
    bio: profile.summary || '',
    avatarUrl: profile.iconUrl || '',
    coverImageUrl: profile.headerUrl || '',
    website: profile.url,
    followersCount: profile.followersCount ?? 0,
    followingCount: profile.followingCount ?? 0,
    postsCount: profile.postsCount ?? (profile.posts?.length ?? 0),
    dmPreference: 'everyone',
    isAdmin: false,
    isModerator: false,
    profileVisibility: 'public',
    createdAt: nowIso,
    remoteManuallyApprovesFollowers: profile.manuallyApprovesFollowers === true,
  };
  const autorDoPerfil: Autor = { userId: uid, name: profile.name, username: profile.handle, avatarUrl: profile.iconUrl || '' };
  const hostDoAtor = domainOfUrl(profile.actorId);
  /** O objeto é servido pelo host do ator (ou pelo domínio do handle e subdomínios)? Senão o ator não fala por ele. */
  const doHostDoAtor = (url: string): boolean => {
    const host = domainOfUrl(url);
    return host !== null && (host === hostDoAtor || host === profile.domain || host.endsWith(`.${profile.domain}`));
  };

  const rawPosts: RemotePostItem[] = profile.posts ?? [];
  const nativePosts: Post[] = [];
  const batch = db.batch();
  let escritas = 0;
  let terceirosConferidos = 0;
  const conferencias = new Map<string, Promise<VerifiedNote | null>>();
  const usuariosJaMarcados = new Set<string>();
  const contadoresParaAplicar: Array<{ postId: string; curtidas: number; reposts: number; respostas: number }> = [];
  const postsRef = db.collection('posts');

  /**
   * Garante o usuário de um ATOR DE TERCEIRO com os dados que `resolveRemoteActor` VALIDOU (id, host, caixa de entrada). Se o
   * usuário já existe, não é regravado: dado afirmado pelo mensageiro nunca sobrescreve o que já temos.
   */
  async function garantirUsuarioDeTerceiro(actorId: string): Promise<{ uid: string; autor: Autor; inbox: string | null } | null> {
    const r = await resolveRemoteActor(f.inbox, actorId);
    if (!r.ok) return null;
    const a = r.actor;
    const thirdUid = remoteUserIdOf(a.actorId);
    if (!usuariosJaMarcados.has(thirdUid)) {
      usuariosJaMarcados.add(thirdUid);
      const ref = db.collection('users').doc(thirdUid);
      if (!(await ref.get()).exists) {
        batch.set(ref, {
          id: thirdUid,
          name: a.name || a.handle,
          name_lowercase: (a.name || a.handle || '').toLowerCase(),
          username: a.handle,
          bio: a.summary || '',
          avatarUrl: a.iconUrl || '',
          coverImageUrl: '',
          website: a.actorId,
          dmPreference: 'everyone',
          profileVisibility: 'public',
          isRemoteFediverse: true,
          remoteActorId: a.actorId,
          remoteDomain: a.domain,
          remoteUrl: a.actorId,
          remoteInbox: a.inbox || a.sharedInbox || null,
          createdAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        });
        escritas++;
      }
    }
    return {
      uid: thirdUid,
      autor: { userId: thirdUid, name: a.name || a.handle, username: a.handle, avatarUrl: a.iconUrl || '' },
      inbox: a.inbox || a.sharedInbox || null,
    };
  }

  /** Post de TERCEIRO já conferido no servidor do autor: devolve o id local (cria o documento só se ainda não existe). */
  async function garantirPostDeTerceiro(
    objectUri: string,
    pagina: string,
    actorId: string,
    contagens: { curtidas: number; reposts: number; respostas: number },
    candidatos: string[],
  ): Promise<{ id: string; autor: Autor; verificado: VerifiedNote | null } | null> {
    const existente = await primeiroExistente(postsRef, candidatos);
    if (existente) {
      const dono = String(existente.dados.userId ?? '');
      if (dono !== remoteUserIdOf(actorId)) return null; // o id pertence a outro autor: não se mistura
      const a = existente.dados.authorDetails as Autor | undefined;
      return { id: existente.id, autor: a ?? { userId: dono, name: dono, username: dono, avatarUrl: '' }, verificado: null };
    }
    // A conferência de um repost já começou antes do laço (todas em paralelo); a de um pai de resposta começa aqui.
    let conferencia = conferencias.get(objectUri);
    if (!conferencia) {
      if (terceirosConferidos >= MAX_TERCEIROS_POR_SINCRONIZACAO) return null;
      terceirosConferidos++;
      conferencia = fetchVerifiedNote(objectUri, actorId).catch(() => null);
      conferencias.set(objectUri, conferencia);
    }
    const nota = await conferencia;
    if (!nota) return null;
    const autor = await garantirUsuarioDeTerceiro(actorId);
    if (!autor) return null;
    const id = candidatos[0];
    batch.set(
      postsRef.doc(id),
      documentoDoPost({
        id,
        autor: autor.autor,
        texto: nota.text,
        midia: nota.media,
        criadoEmMs: Number.isFinite(Date.parse(nota.createdAt)) ? Date.parse(nota.createdAt) : Date.now(),
        curtidas: contagens.curtidas,
        reposts: contagens.reposts,
        respostas: contagens.respostas,
        objectId: objectUri,
        url: nota.url || pagina,
        actorId,
        inbox: autor.inbox,
      }),
    );
    escritas++;
    return { id, autor: autor.autor, verificado: nota };
  }

  const idsDoPost = (objectUri: string, pagina: string): string[] => {
    const novo = remotePostIdOf(objectUri);
    const antigo = pagina && pagina !== objectUri ? remotePostIdOf(pagina) : null;
    return antigo ? [novo, antigo] : [novo];
  };

  // Reposts cujo original ainda não temos: as conferências no servidor do autor começam TODAS agora, em paralelo, em vez de
  // uma por vez (o perfil de quem só reposta levaria a soma das esperas).
  const lote = rawPosts.slice(0, MAX_ITENS);
  for (const item of lote) {
    if (!item.isRepost || !item.repostedAuthorActorId || isOwnHostUrl(item.repostedAuthorActorId, f.ownHost)) continue;
    const objectUri = canonicalObjectId({ uri: item.uri, url: item.url });
    if (!objectUri || isOwnHostUrl(objectUri, f.ownHost) || conferencias.has(objectUri)) continue;
    if (terceirosConferidos >= MAX_TERCEIROS_POR_SINCRONIZACAO) break;
    if (await primeiroExistente(postsRef, idsDoPost(objectUri, item.url))) continue;
    terceirosConferidos++;
    conferencias.set(objectUri, fetchVerifiedNote(objectUri, item.repostedAuthorActorId).catch(() => null));
  }

  for (const item of lote) {
    const objectUri = canonicalObjectId({ uri: item.uri, url: item.url }) ?? `${profile.actorId}#${item.id}`;
    // Objeto do NOSSO domínio (resposta ou repost de algo daqui, visto pelo servidor remoto): nunca vira ap_. O inbox trata.
    if (isOwnHostUrl(objectUri, f.ownHost) || isOwnHostUrl(item.url, f.ownHost)) continue;
    const createdMs = Number.isFinite(Date.parse(item.createdAt)) ? Date.parse(item.createdAt) : Date.now();
    const contagens = { curtidas: item.favouritesCount, reposts: item.reblogsCount, respostas: item.repliesCount };

    // ── Resposta: nunca vira post de topo; vai para os comentários do post-pai (que precisa existir e ser conferido) ──
    if (item.inReplyToId && !item.isRepost) {
      if (!doHostDoAtor(objectUri)) continue;
      let parentPostId: string | null = null;
      let parentAuthorId = uid;

      if (item.inReplyToId.startsWith('https://')) {
        if (isOwnHostUrl(item.inReplyToId, f.ownHost)) continue; // resposta a um post nosso: o inbox é quem trata
        const pai = await primeiroExistente(postsRef, [remotePostIdOf(item.inReplyToId)]);
        if (pai) {
          parentPostId = pai.id;
          parentAuthorId = String(pai.dados.userId || uid);
        }
      }
      // Pai identificado só por id NUMÉRICO (formato da REST do Mastodon) não é mais buscado: aqui havia um
      // `/api/v1/statuses/{id}` sem autenticação. O outbox ActivityPub sempre traz `inReplyTo` como URI.

      if (parentPostId) {
        const comentarioId = remotePostIdOf(objectUri);
        const tags = hashtagsDe(item.text);
        batch.set(
          postsRef.doc(parentPostId).collection('comments').doc(comentarioId),
          {
            userId: uid,
            authorDetails: autorDoPerfil,
            isRemoteFediverse: true,
            remoteActorUrl: profile.actorId,
            remoteHandle: profile.handle,
            apObjectId: objectUri,
            parentPostId,
            postAuthorId: parentAuthorId,
            postVisibility: 'public',
            parentCommentId: null,
            text: item.text,
            hashtags: tags.length > 0 ? tags : null,
            hasMedia: item.media.length > 0,
            createdAt: Timestamp.fromMillis(createdMs),
            likes: item.favouritesCount,
            repostsCount: item.reblogsCount,
            repliesCount: item.repliesCount,
            isDeleted: false,
          },
          { merge: true },
        );
        escritas++;
      }
      continue;
    }

    // ── Repost: o post original é de OUTRO ator; só entra depois de conferido no servidor do autor ──
    if (item.isRepost) {
      const origActorId = item.repostedAuthorActorId;
      if (!origActorId || isOwnHostUrl(origActorId, f.ownHost)) continue; // repost de algo nosso: o inbox (Announce) é quem trata
      const original = await garantirPostDeTerceiro(
        objectUri,
        item.url,
        origActorId,
        contagens,
        idsDoPost(objectUri, item.url),
      );
      if (!original) continue;
      batch.set(
        postsRef.doc(original.id).collection('reposts').doc(uid),
        { userId: uid, apActorId: profile.actorId, apHandle: profile.handle, isRemoteFediverse: true, createdAt: Timestamp.fromMillis(createdMs) },
        { merge: true },
      );
      escritas++;
      const origUser: User = { ...nativeUser, id: original.autor.userId, name: original.autor.name, username: original.autor.username, avatarUrl: original.autor.avatarUrl, website: origActorId };
      nativePosts.push(
        nativoDoPost({
          id: original.id,
          autor: original.autor,
          user: origUser,
          texto: original.verificado?.text ?? item.text,
          midia: original.verificado?.media ?? item.media,
          criadoEmMs: original.verificado ? Date.parse(original.verificado.createdAt) || createdMs : createdMs,
          contagens,
          existentes: undefined,
          repostedBy: autorDoPerfil,
          repostedAtMs: createdMs,
        }),
      );
      continue;
    }

    // ── Post do próprio ator do perfil ──
    if (!doHostDoAtor(objectUri)) continue; // o ator só fala por objetos do próprio servidor
    const ids = idsDoPost(objectUri, item.url);
    const existente = await primeiroExistente(postsRef, ids);
    const postId = existente?.id ?? ids[0];
    if (!existente) {
      batch.set(
        postsRef.doc(postId),
        documentoDoPost({
          id: postId,
          autor: autorDoPerfil,
          texto: item.text,
          midia: item.media,
          criadoEmMs: createdMs,
          ...contagens,
          objectId: objectUri,
          url: item.url,
          actorId: profile.actorId,
          inbox: targetInbox,
        }),
      );
      escritas++;
    } else if (existente.dados.remoteActorId === profile.actorId) {
      // Só o MESMO ator atualiza o que publicou. Antes qualquer perfil sincronizado reescrevia o texto e o autor de um post
      // remoto que já estava guardado, mesmo que fosse de outra pessoa.
      const tags = hashtagsDe(item.text);
      batch.update(postsRef.doc(postId), {
        authorDetails: autorDoPerfil,
        text: item.text,
        hashtags: tags.length > 0 ? tags : null,
        remoteInbox: targetInbox,
      });
      escritas++;
      // O lote NÃO grava contador: ele leria o número, calcularia e gravaria por cima de uma curtida somada no meio do caminho
      // pela Function (escrita perdida). Os contadores vão depois do lote, em transação (remoteCounts.ts).
      contadoresParaAplicar.push({ postId, ...contagens });
    }
    nativePosts.push(
      nativoDoPost({
        id: postId,
        autor: autorDoPerfil,
        user: nativeUser,
        texto: item.text,
        midia: item.media,
        criadoEmMs: createdMs,
        contagens,
        existentes: existente?.dados,
      }),
    );
  }

  if (escritas > 0) {
    await batch.commit();
  }

  // Contadores dos posts que já existiam. O perfil não distingue "a instância não informa" de "zero" (o número ausente vira 0),
  // então estes valores só podem fazer o contador SUBIR (piso), nunca descer; quem pode descer é o `/statuses/{id}` da origem
  // (syncRemotePostComments), que traz o número de fato. Em grupos pequenos, para não abrir centenas de transações juntas.
  for (let i = 0; i < contadoresParaAplicar.length; i += 6) {
    await Promise.all(
      contadoresParaAplicar.slice(i, i + 6).map((c) =>
        applyRemoteCounts(c.postId, { lowerBound: { likes: c.curtidas, reposts: c.reposts, commentsCount: c.respostas } }).catch(() => null),
      ),
    );
  }

  return { user: nativeUser, posts: nativePosts };
}

/** O post como o cliente o recebe. Os contadores do documento existente prevalecem (o app os mantém por conta própria). */
function nativoDoPost(p: {
  id: string;
  autor: Autor;
  user: User;
  texto: string;
  midia: Midia[];
  criadoEmMs: number;
  contagens: { curtidas: number; reposts: number; respostas: number };
  existentes: Record<string, unknown> | undefined;
  repostedBy?: Autor;
  repostedAtMs?: number;
}): Post {
  const numero = (valor: unknown, padrao: number) => (typeof valor === 'number' ? valor : padrao);
  const tags = hashtagsDe(p.texto);
  return {
    id: p.id,
    userId: p.autor.userId,
    user: p.user,
    authorDetails: p.autor,
    text: p.texto,
    hashtags: tags.length > 0 ? tags : null,
    media: p.midia.map((m) => ({ url: m.url, type: m.type, ...(m.alt ? { alt: m.alt } : {}) })) as Post['media'],
    hasMedia: p.midia.length > 0,
    visibility: 'public',
    federation: 'local',
    type: 'original',
    category: 'echo',
    allowReposts: true,
    replyPermission: 'everyone',
    likes: Math.max(numero(p.existentes?.likes, 0), p.contagens.curtidas),
    reposts: Math.max(numero(p.existentes?.reposts, 0), p.contagens.reposts),
    commentsCount: Math.max(numero(p.existentes?.commentsCount, 0), p.contagens.respostas),
    quotesCount: numero(p.existentes?.quotesCount, 0),
    views: numero(p.existentes?.views, 0),
    isEdited: false,
    editCount: 0,
    postFormat: 'standard',
    createdAt: new Date(p.criadoEmMs).toISOString(),
    ...(p.repostedBy ? { repostedBy: p.repostedBy, repostedAt: new Date(p.repostedAtMs ?? p.criadoEmMs).toISOString() } : {}),
    comments: [],
    isLiked: false,
    isReposted: false,
    isBookmarked: false,
  };
}
