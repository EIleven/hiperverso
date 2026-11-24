// src/lib/server/remoteProfile.ts
// Resolução segura (SSRF-safe) de perfis e posts públicos remotos do Fediverso.
import { decideInstance } from '@/lib/activitypub/gate';
import { extractAttachments } from '@/lib/activitypub/inbox';
import { ACTIVITY_ACCEPT } from '@/lib/activitypub/remote';
import { classificarLeitura, contagensDoNote, totalDe } from '@/lib/activitypub/colecoes';
import { lerConsentimentoDoAtor } from '@/lib/activitypub/consentimentoDoAtor';
import { domainOfUrl, normalizeHandle, normalizeHostname } from '@/lib/activitypub/identity';
import { isOwnHostUrl, sameHost, validateFetchedActor } from '@/lib/activitypub/remoteIdentity';
import { safeFetchText } from '@/lib/security/safe-fetch';
import { classifySearchQuery } from '@/lib/search/searchQueryParser';
import { federation } from '@/lib/server/federation';
import { podeLerDoDominio } from '@/lib/server/leituraRemota';
import { aplicarCicloAoPost } from '@/lib/server/cicloDeVidaRemoto';

const HANDLE_RE = /^@?([A-Za-z0-9_.-]{1,64})@([A-Za-z0-9.-]+\.[A-Za-z]{2,})$/;

export type RemotePostItem = {
  id: string;
  /** Página do post, para humanos. */
  url: string;
  /** Id ActivityPub do objeto (o mesmo que o inbox recebe). É dele que sai o id local do post. */
  uri?: string | null;
  text: string;
  createdAt: string;
  repliesCount: number;
  reblogsCount: number;
  favouritesCount: number;
  media: { url: string; type: 'image' | 'video'; alt: string | null }[];
  isRepost: boolean;
  repostedAuthor?: string | null;
  repostedAuthorHandle?: string | null;
  repostedAuthorAvatar?: string | null;
  repostedAuthorActorId?: string | null;
  repostedAuthorUrl?: string | null;
  inReplyToId?: string | null;
};

export type RemoteProfileData = {
  actorId: string;
  handle: string;
  domain: string;
  name: string;
  summary: string;
  iconUrl: string | null;
  headerUrl: string | null;
  url: string;
  inbox: string | null;
  sharedInbox: string | null;
  followersCount: number | null;
  followingCount: number | null;
  postsCount: number | null;
  /** O perfil aprova seguidores manualmente (`manuallyApprovesFollowers` no ator; `locked` na API Mastodon): seguir vira PEDIR para seguir. */
  manuallyApprovesFollowers?: boolean;
  posts?: RemotePostItem[];
  /**
   * O servidor de origem recusou (401/403) a leitura do `outbox`. Os posts nao aparecem, e NAO buscamos por outra porta:
   * a tela diz que a origem restringe a leitura e oferece o link para la.
   */
  postsRestritos?: boolean;
  /**
   * Ninguém daqui segue esta pessoa, então o `outbox` não foi buscado: abrir um perfil não é motivo para baixarmos o
   * histórico de quem nunca pediu para estar aqui. A tela oferece "siga para ver aqui, ou abra na origem".
   */
  postsSoComSeguidor?: boolean;
  /** `toot:discoverable` do ator. Só `true` é sim. */
  discoverable?: boolean;
  /** `toot:indexable` do ator. Só `true` é sim. */
  indexable?: boolean;
};

export function stripHtml(html: string): string {
  return html
    .replace(
      /<a\b[^>]*\bhref=["'](https?:\/\/([^/"'\s]+)\/(?:@|users\/)([^"'/\s<>?#]+))["'][^>]*>([\s\S]*?)<\/a>/gi,
      (_m, _url, domain, pathUser, inner) => {
        const innerText = inner.replace(/<[^>]+>/g, '').trim();
        if (innerText.startsWith('@')) {
          const bare = innerText.slice(1);
          if (bare.includes('@')) return innerText;
          return `@${bare || pathUser}@${domain}`;
        }
        return innerText;
      },
    )
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;/gi, "'")
    .replace(/&nbsp;/gi, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Cabeçalhos assinados para um GET, com a chave do ator da INSTÂNCIA (`{}` se a chave-mestra não está configurada: a busca segue
 * sem assinar, e só falha em quem exige Authorized Fetch). O `origin` é mantido por compatibilidade com quem já chamava.
 */
export async function getAnySigningHeaders(_origin: string, targetUrl: string): Promise<Record<string, string>> {
  return (await federation().signGet(targetUrl)) ?? {};
}

export type ResolveRemoteResult =
  | { ok: true; profile: RemoteProfileData }
  | { ok: false; status: number; error: string; localHandle?: string };

/** O servidor do ator pode ser o domínio do handle ou um subdomínio dele (o caso comum de `WEB_DOMAIN`). */
const hostPertenceAoDominio = (url: string, dominio: string): boolean => {
  const host = domainOfUrl(url);
  return host !== null && (host === dominio || host.endsWith(`.${dominio}`));
};

export async function resolveRemoteProfile(
  rawHandle: string,
  opts: {
    withPosts?: boolean;
    /**
     * Decide, já com o ator conferido, se o `outbox` pode ser buscado. Sem isto, `withPosts` vale sozinho (é o caso de
     * quem acabou de SEGUIR: o seguir é o consentimento explícito). A rota do perfil passa "alguém daqui já segue?".
     */
    podeCarregarPosts?: (actorId: string) => Promise<boolean>;
  } = {},
): Promise<ResolveRemoteResult> {
  const classified = classifySearchQuery(rawHandle);
  const candidateHandle =
    classified.kind === 'fediverse-profile-url' || classified.kind === 'fediverse-handle'
      ? classified.handle
      : rawHandle.trim();

  const match = candidateHandle.match(HANDLE_RE);
  if (!match) return { ok: false, status: 400, error: 'formato-invalido' };

  const user = match[1];
  // Mesma normalização do restante da federação: recusa IP literal, localhost e sufixos que nunca são Internet pública.
  const domain = normalizeHostname(match[2]);
  if (!domain) return { ok: false, status: 400, error: 'formato-invalido' };
  const f = federation();

  const plataforma = await f.store.getPlatform();
  if (!plataforma.enabled || plataforma.killSwitch) {
    return { ok: false, status: 404, error: 'plataforma-desligada' };
  }
  // O @Breno@exercitodolula.app é o @Breno: alguém do NOSSO domínio nunca é buscado nem materializado como remoto (virava um
  // "Breno" fantasma, com UID ap_...). Quem chama usa o handle devolvido para abrir o perfil local.
  if (domain === f.ownHost.toLowerCase()) {
    return { ok: false, status: 409, error: 'perfil-local', localHandle: normalizeHandle(user) ?? undefined };
  }

  const politica = await f.store.getInstancePolicy();
  const decisao = decideInstance(domain, politica, f.ownHost);
  if (decisao.decision === 'reject') {
    return { ok: false, status: 403, error: 'instancia-bloqueada' };
  }
  // RECIPROCIDADE: domínio que vem recusando o que mandamos (pausa de consentimento ativa) também não é lido por nós
  // enquanto a pausa durar. Antes a pausa só parava a entrega, e a busca de perfil continuava batendo lá.
  const leitura = await podeLerDoDominio(domain);
  if (!leitura.pode) {
    return { ok: false, status: 403, error: leitura.motivo === 'pausa-de-consentimento' ? 'dominio-em-pausa' : 'instancia-bloqueada' };
  }

  const userAgent = `HiperVerso/1.0 (+${f.origin})`;
  const wfUrl = `https://${domain}/.well-known/webfinger?resource=${encodeURIComponent(`acct:${user}@${domain}`)}`;
  const wfRes = await safeFetchText(wfUrl, {
    timeoutMs: 6000,
    maxBytes: 64_000,
    headers: { Accept: 'application/jrd+json, application/json', 'User-Agent': userAgent },
    allowedContentTypes: /^application\/(jrd\+json|json)/i,
  });
  if (!wfRes.ok) {
    return { ok: false, status: 404, error: 'perfil-nao-encontrado' };
  }

  let actorUrl: string | null = null;
  let profilePageUrl: string | null = null;
  try {
    const wfJson = JSON.parse(wfRes.text) as { links?: { rel?: string; type?: string; href?: string }[] };
    actorUrl =
      wfJson.links?.find(
        (l) =>
          l.rel === 'self' &&
          typeof l.href === 'string' &&
          l.href.startsWith('https://') &&
          (!l.type || /activity\+json|ld\+json/i.test(l.type)),
      )?.href ?? null;
    profilePageUrl =
      wfJson.links?.find(
        (l) =>
          l.rel === 'http://webfinger.net/rel/profile-page' &&
          typeof l.href === 'string' &&
          l.href.startsWith('https://'),
      )?.href ?? null;
  } catch {
    actorUrl = null;
  }

  if (!actorUrl) {
    return { ok: false, status: 404, error: 'perfil-nao-encontrado' };
  }
  // O WebFinger de `user@domain` só pode apontar para um ator que more em `domain` (ou num subdomínio) e NUNCA para um do nosso
  // domínio. Sem isto, um servidor qualquer "tem" uma conta cujo ator é o de outro servidor, ou o nosso.
  if (isOwnHostUrl(actorUrl, f.ownHost) || !hostPertenceAoDominio(actorUrl, domain)) {
    return { ok: false, status: 404, error: 'perfil-nao-encontrado' };
  }

  const profile: RemoteProfileData = {
    actorId: actorUrl,
    handle: `${user}@${domain}`,
    domain,
    name: user,
    summary: '',
    iconUrl: null,
    headerUrl: null,
    url: profilePageUrl ?? actorUrl,
    inbox: null,
    sharedInbox: null,
    followersCount: null,
    followingCount: null,
    postsCount: null,
  };

  let outboxUrl: string | null = null;
  const signedHeaders = await getAnySigningHeaders(f.origin, actorUrl);
  const actorRes = await safeFetchText(actorUrl, {
    timeoutMs: 6000,
    maxBytes: 128_000,
    headers: {
      ...signedHeaders,
      Accept: 'application/activity+json, application/ld+json; profile="https://www.w3.org/ns/activitystreams", application/json',
      'User-Agent': userAgent,
    },
    allowedContentTypes: /^application\/(activity\+json|ld\+json|json)/i,
  });

  if (actorRes.ok) {
    let actorJson: unknown = null;
    try {
      actorJson = JSON.parse(actorRes.text);
    } catch {
      actorJson = null;
    }
    // O documento do ator só vale se for de quem dissemos (id = URL pedida, usuário, host, caixas de entrada no mesmo host).
    // Antes o `id` declarado pelo servidor virava o id do perfil e o `inbox` dele ia para onde DMs e respostas são entregues.
    const validado = validateFetchedActor({
      requestedUrl: actorUrl,
      finalUrl: actorRes.finalUrl,
      handleUser: user,
      handleDomain: domain,
      json: actorJson,
      ownHost: f.ownHost,
    });
    if (!validado.ok) {
      if (validado.reason === 'ator-proprio') return { ok: false, status: 404, error: 'perfil-nao-encontrado' };
      return { ok: false, status: 422, error: 'ator-invalido' };
    }
    const actor = actorJson as {
      name?: string;
      summary?: string;
      url?: string;
      icon?: { url?: string } | { url?: string }[];
      image?: { url?: string } | { url?: string }[];
      manuallyApprovesFollowers?: unknown;
    };
    profile.actorId = validado.actor.actorId;
    profile.handle = validado.actor.handle;
    profile.inbox = validado.actor.inbox;
    profile.sharedInbox = validado.actor.sharedInbox;
    outboxUrl = validado.actor.outbox;
    const preferred = validado.actor.handle.split('@')[0];
    profile.name = typeof actor.name === 'string' && actor.name.trim() ? actor.name.trim() : preferred;
    profile.summary = typeof actor.summary === 'string' ? stripHtml(actor.summary).slice(0, 500) : '';
    const iconRaw = Array.isArray(actor.icon) ? actor.icon[0]?.url : actor.icon?.url;
    if (typeof iconRaw === 'string' && iconRaw.startsWith('https://')) profile.iconUrl = iconRaw;
    const imgRaw = Array.isArray(actor.image) ? actor.image[0]?.url : actor.image?.url;
    if (typeof imgRaw === 'string' && imgRaw.startsWith('https://')) profile.headerUrl = imgRaw;
    if (typeof actor.url === 'string' && actor.url.startsWith('https://')) profile.url = actor.url;
    if (actor.manuallyApprovesFollowers === true) profile.manuallyApprovesFollowers = true;
    const consentimento = lerConsentimentoDoAtor(actorJson);
    profile.discoverable = consentimento.discoverable;
    profile.indexable = consentimento.indexable;
  }

  // SEM FALLBACK. Aqui havia um "enriquecimento" pela API REST do Mastodon, apresentado no proprio comentario como algo que
  // continuava valendo com Authorized Fetch ligado: quando o servidor recusava a leitura assinada, a REST publica
  // contornava. Isso e raspagem -- funcionar contra a escolha de quem administra. O perfil agora e so o que o protocolo publica: WebFinger,
  // ator e outbox. Ator recusado (401/403) e resposta, nao obstaculo.
  if (!actorRes.ok) {
    const leitura = classificarLeitura(actorRes.status);
    if (leitura === 'recusada') return { ok: false, status: 403, error: 'origem-recusou' };
    if (leitura === 'apagado' || leitura === 'sumiu') return { ok: false, status: 404, error: 'perfil-nao-encontrado' };
    return { ok: false, status: 502, error: 'origem-indisponivel' };
  }

  let carregarPosts = opts.withPosts === true;
  if (carregarPosts && opts.podeCarregarPosts) {
    carregarPosts = await opts.podeCarregarPosts(profile.actorId).catch(() => false);
    if (!carregarPosts) {
      profile.posts = [];
      profile.postsSoComSeguidor = true;
    }
  }

  if (carregarPosts) {
    profile.posts = [];
    if (outboxUrl) {
      const obHeaders = await getAnySigningHeaders(f.origin, outboxUrl);
      const obRes = await safeFetchText(outboxUrl, {
        timeoutMs: 6000,
        maxBytes: 128_000,
        headers: { ...obHeaders, Accept: 'application/activity+json, application/json', 'User-Agent': userAgent },
        allowedContentTypes: /^application\/(activity\+json|ld\+json|json)/i,
      }).catch(() => null);
      if (obRes && classificarLeitura(obRes.status) === 'recusada') profile.postsRestritos = true;
      if (obRes?.ok) {
        try {
          const ob = JSON.parse(obRes.text) as { first?: string | { orderedItems?: unknown[] }; orderedItems?: unknown[] };
          const totalDePosts = totalDe(ob);
          if (totalDePosts !== null) profile.postsCount = totalDePosts;
          let items = Array.isArray(ob.orderedItems) ? ob.orderedItems : [];
          if (items.length === 0 && typeof ob.first === 'string' && ob.first.startsWith('https://')) {
            const pHeaders = await getAnySigningHeaders(f.origin, ob.first);
            const pRes = await safeFetchText(ob.first, {
              timeoutMs: 6000,
              maxBytes: 256_000,
              headers: { ...pHeaders, Accept: 'application/activity+json, application/json', 'User-Agent': userAgent },
              allowedContentTypes: /^application\/(activity\+json|ld\+json|json)/i,
            }).catch(() => null);
            if (pRes && classificarLeitura(pRes.status) === 'recusada') profile.postsRestritos = true;
            if (pRes?.ok) {
              const page = JSON.parse(pRes.text) as { orderedItems?: unknown[] };
              if (Array.isArray(page.orderedItems)) items = page.orderedItems;
            }
          }
          profile.posts = items
            .slice(0, 15)
            .map((rawItem: unknown): RemotePostItem | null => {
              const item = rawItem as {
                id?: string;
                type?: string;
                published?: string;
                object?: { id?: string; type?: string; content?: string; url?: string; published?: string; inReplyTo?: string | { id?: string } | null };
              };
              const note = item.type === 'Create' && item.object ? item.object : (item as unknown as { id?: string; content?: string; url?: string; published?: string; inReplyTo?: string | { id?: string } | null });
              if (!note || typeof note.content !== 'string') return null;
              const rawReply = note.inReplyTo;
              const inReplyToVal = typeof rawReply === 'string'
                ? rawReply
                : (rawReply && typeof rawReply === 'object' && typeof rawReply.id === 'string' ? rawReply.id : null);
              // Contadores e anexos vêm do PRÓPRIO objeto publicado (antes vinham da REST): o que a origem não publica
              // fica zero aqui e se corrige na revalidação, que só sobe com número informado.
              const contagens = contagensDoNote(note);
              return {
                id: String(note.id ?? item.id ?? ''),
                url: typeof note.url === 'string' ? note.url : profile.url,
                uri: typeof note.id === 'string' && note.id.startsWith('https://') ? note.id : null,
                text: stripHtml(note.content),
                createdAt: note.published ?? item.published ?? new Date().toISOString(),
                repliesCount: contagens.commentsCount ?? 0,
                reblogsCount: contagens.reposts ?? 0,
                favouritesCount: contagens.likes ?? 0,
                media: extractAttachments(note as unknown as Record<string, unknown>)
                  .slice(0, 4)
                  .map((a) => ({ url: a.url, type: a.type, alt: a.alt ?? null })),
                isRepost: item.type === 'Announce',
                repostedAuthor: null,
                inReplyToId: item.type !== 'Announce' ? inReplyToVal : null,
              };
            })
            .filter((x): x is RemotePostItem => x !== null);
        } catch {
          // ignora
        }
      }
    }
  }

  return { ok: true, profile };
}

export type VerifiedNote = {
  /** O `id` ActivityPub do objeto, já conferido contra a URL pedida. */
  uri: string;
  /** Página do post, para humanos (cai no `id` se o objeto não declarar `url`). */
  url: string;
  actorId: string;
  text: string;
  createdAt: string;
  media: { url: string; type: 'image' | 'video'; alt: string | null }[];
};

const AS_PUBLIC = 'https://www.w3.org/ns/activitystreams#Public';

/**
 * Busca um post de OUTRO ator no servidor dele e confere que é dele. É o que separa "o servidor de quem reposta disse que
 * este post é de @fulano" de "o servidor de @fulano disse que este post é dele": só o segundo vira um post de terceiro.
 *
 * Confere que o `id` do objeto é a URL pedida (ou a final de um redirecionamento), que o autor declarado
 * (`attributedTo`) é o ator esperado, que o objeto mora no mesmo host do autor, que não é do nosso domínio e que o
 * endereçamento é público. Qualquer falha devolve `null` e o item simplesmente não é materializado.
 */
export async function fetchVerifiedNote(objectUri: string, expectedActorId: string): Promise<VerifiedNote | null> {
  const f = federation();
  if (!objectUri.startsWith('https://') || !sameHost(objectUri, expectedActorId)) return null;
  if (isOwnHostUrl(objectUri, f.ownHost) || isOwnHostUrl(expectedActorId, f.ownHost)) return null;
  const dominio = domainOfUrl(objectUri);
  if (!dominio) return null;
  // Suspensão (lista fixa e política do banco) e pausa de consentimento: quem nos recusa não tem post conferido por nós.
  if (!(await podeLerDoDominio(dominio)).pode) return null;

  let r: Awaited<ReturnType<typeof f.inbox.fetcher.get>>;
  try {
    r = await f.inbox.fetcher.get(objectUri, { accept: ACTIVITY_ACCEPT });
  } catch {
    return null;
  }
  const leitura = classificarLeitura(r.status, r.json);
  // Objeto apagado (410/Tombstone) ou não encontrado (404) na origem: se guardamos uma cópia, ela segue o ciclo de vida.
  if (leitura === 'apagado' || leitura === 'sumiu') {
    await aplicarCicloAoPost(objectUri, leitura).catch(() => null);
    return null;
  }
  if (r.status < 200 || r.status >= 300 || !r.json || typeof r.json !== 'object' || Array.isArray(r.json)) return null;
  const o = r.json as Record<string, unknown>;
  if (o.type !== 'Note' && o.type !== 'Article') return null;
  if (o.id !== objectUri && o.id !== r.finalUrl) return null;

  const bruto = Array.isArray(o.attributedTo) ? o.attributedTo[0] : o.attributedTo;
  const autor = typeof bruto === 'string' ? bruto : bruto && typeof bruto === 'object' ? (bruto as { id?: unknown }).id : null;
  if (autor !== expectedActorId) return null;

  const enderecos = [...(Array.isArray(o.to) ? o.to : []), ...(Array.isArray(o.cc) ? o.cc : [])];
  if (!enderecos.includes(AS_PUBLIC)) return null;

  const texto = typeof o.content === 'string' ? stripHtml(o.content).slice(0, 5000) : '';
  const anexos = extractAttachments(o).map((a) => ({ url: a.url, type: a.type, alt: a.alt ?? null }));
  if (!texto && anexos.length === 0) return null;
  const publicado = typeof o.published === 'string' && Number.isFinite(Date.parse(o.published)) ? o.published : new Date().toISOString();
  return {
    uri: objectUri,
    url: typeof o.url === 'string' && o.url.startsWith('https://') ? o.url : objectUri,
    actorId: expectedActorId,
    text: texto,
    createdAt: publicado,
    media: anexos,
  };
}
