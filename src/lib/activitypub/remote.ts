// src/lib/activitypub/remote.ts
// Como descobrimos e passamos a confiar num ator de outro servidor. Aqui se busca JSON de um servidor que não
// controlamos e se guarda uma chave pública que, daí em diante, valida assinaturas. Cada regra fecha um ataque:
//
// - **Id divergente**: o `id` do documento tem de ser EXATAMENTE a URL que pedimos. Sem isso, um servidor responde
//   por um ator de OUTRO servidor e nós gravamos a chave dele no cache do alvo (envenenamento de cache).
// - **Dono da chave**: `publicKey.owner` tem de ser o próprio ator. Uma chave que declara outro dono não vale.
// - **Inbox só do mesmo host**: um ator cujo `inbox` aponta para um terceiro nos faria entregar atividades a um
//   destino que o ator escolheu (amplificação, ameaça T5).
// - **Política antes da rede**: instância suspensa não recebe nem uma requisição nossa.
// - **Limite de renovação forçada**: falha de assinatura pode ser rotação de chave, e vale uma nova busca — mas uma
//   por ator a cada cinco minutos, para ninguém nos fazer buscar em loop mandando assinaturas ruins.
import { loadPublicKey } from './signature.ts';
import { decideInstance } from './gate.ts';
import { classificarLeitura } from './colecoes.ts';
import { decidirCicloDoAtor } from './cicloDeVida.ts';
import { lerConsentimentoDoAtor } from './consentimentoDoAtor.ts';
import { domainOfUrl, parseAcct } from './identity.ts';
import type { Acct } from './identity.ts';
import type { FederationStore, RemoteActorRecord } from './store.ts';

/** Meio de rede, injetável. A implementação real usa `safeFetchText`; os testes usam um mapa de URLs. */
export interface Fetcher {
  get(url: string, opts: { accept: string }): Promise<{ status: number; json: unknown | null; finalUrl: string }>;
  post(
    url: string,
    body: string,
    sign: { privateKeyPem: string; keyId: string },
  ): Promise<{ status: number | null; unsafe: boolean; errorDetail?: string; retryAfter?: string | string[] }>;
}

export type RemoteDeps = {
  store: FederationStore;
  fetcher: Fetcher;
  now: () => number;
  ownHost: string;
};

export const ACTOR_CACHE_TTL_MS = 24 * 3600 * 1000;
export const GONE_CACHE_TTL_MS = 3600 * 1000;
export const FORCED_REFRESH_MIN_INTERVAL_MS = 5 * 60 * 1000;

const ACTOR_TYPES = ['Person', 'Service', 'Application', 'Group', 'Organization'];
export const ACTIVITY_ACCEPT = 'application/activity+json, application/ld+json; profile="https://www.w3.org/ns/activitystreams"';

export type ResolveFailure =
  | 'dominio-recusado'
  | 'indisponivel'
  | 'removido'
  | 'id-divergente'
  | 'tipo-invalido'
  | 'sem-chave'
  | 'inbox-invalido'
  | 'inbox-de-outro-host';

export type ResolveResult = { ok: true; actor: RemoteActorRecord; fromCache: boolean } | { ok: false; reason: ResolveFailure };

const falha = (reason: ResolveFailure): ResolveResult => ({ ok: false, reason });
const ehObjeto = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Sem a âncora: `https://h/users/a#main-key` → `https://h/users/a`. */
export function stripFragment(url: string): string {
  const i = url.indexOf('#');
  return i < 0 ? url : url.slice(0, i);
}

/** Texto de exibição: sem marcação, sem caracteres de controle, com limite. Nunca HTML. */
export function plainText(valor: unknown, max: number): string {
  if (typeof valor !== 'string') return '';
  return valor
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
    .replace(/<br\s*\/?>|<\/(?:p|div|li|blockquote|h[1-6])>/gi, ' ')
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&#x27;/gi, "'").replace(/&nbsp;/gi, ' ')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f‪-‮⁦-⁩]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

/** URL https de imagem para exibir, ou `null`. Aceita `{ url }` ou lista. */
function imageUrl(valor: unknown): string | null {
  const primeiro = Array.isArray(valor) ? valor[0] : valor;
  const url = typeof primeiro === 'string' ? primeiro : ehObjeto(primeiro) && typeof primeiro.url === 'string' ? primeiro.url : null;
  return url && domainOfUrl(url) ? url : null;
}

/** Valida e normaliza o documento de um ator. Devolve o registro ou o motivo da recusa. */
export function parseRemoteActor(json: unknown, esperado: string, now: number): { ok: true; actor: RemoteActorRecord } | { ok: false; reason: ResolveFailure } {
  if (!ehObjeto(json)) return falha('tipo-invalido');
  // Id divergente: a defesa contra envenenamento de cache.
  if (json.id !== esperado) return falha('id-divergente');
  const tipo = json.type;
  if (typeof tipo !== 'string' || !ACTOR_TYPES.includes(tipo)) return falha('tipo-invalido');

  const domain = domainOfUrl(esperado);
  if (!domain) return falha('dominio-recusado');

  const inbox = json.inbox;
  if (typeof inbox !== 'string' || domainOfUrl(inbox) === null) return falha('inbox-invalido');
  if (domainOfUrl(inbox) !== domain) return falha('inbox-de-outro-host');
  let sharedInbox: string | null = null;
  if (ehObjeto(json.endpoints) && typeof json.endpoints.sharedInbox === 'string') {
    const candidato = json.endpoints.sharedInbox;
    if (domainOfUrl(candidato) !== domain) return falha('inbox-de-outro-host');
    sharedInbox = candidato;
  }

  const chave = json.publicKey;
  if (!ehObjeto(chave) || typeof chave.id !== 'string' || typeof chave.publicKeyPem !== 'string') return falha('sem-chave');
  // A chave tem de dizer que pertence a este ator.
  if (chave.owner !== esperado) return falha('sem-chave');
  if (stripFragment(chave.id) !== esperado) return falha('sem-chave');
  if (loadPublicKey(chave.publicKeyPem) === null) return falha('sem-chave');

  const usuario = plainText(json.preferredUsername, 64) || 'desconhecido';
  const movedTo = typeof json.movedTo === 'string' && domainOfUrl(json.movedTo) ? json.movedTo : null;

  return {
    ok: true,
    actor: {
      actorId: esperado,
      handle: `${usuario}@${domain}`,
      domain,
      type: tipo,
      inbox,
      sharedInbox,
      keyId: chave.id,
      publicKeyPem: chave.publicKeyPem,
      name: plainText(json.name, 100) || usuario,
      iconUrl: imageUrl(json.icon),
      summary: plainText(json.summary, 2000),
      movedTo,
      state: 'ok',
      fetchedAtMs: now,
      lastForcedRefreshAtMs: 0,
      // O que a pessoa disse sobre ser descoberta e ter o texto buscado. Só `true` vale (ver consentimentoDoAtor.ts).
      ...lerConsentimentoDoAtor(json),
    },
  };
}

/**
 * Descobre (ou lê do cache) um ator remoto. `forceRefresh` serve à falha de assinatura: pode ser rotação de chave.
 */
export async function resolveRemoteActor(
  deps: RemoteDeps,
  actorOuChave: string,
  opcoes: { forceRefresh?: boolean } = {},
): Promise<ResolveResult> {
  const actorId = stripFragment(actorOuChave);
  const domain = domainOfUrl(actorId);
  if (!domain) return falha('dominio-recusado');

  // Política ANTES da rede: instância suspensa não recebe uma requisição nossa.
  const politica = await deps.store.getInstancePolicy();
  if (decideInstance(domain, politica, deps.ownHost).decision === 'reject') return falha('dominio-recusado');

  const agora = deps.now();
  const emCache = await deps.store.getRemoteActor(actorId);

  if (emCache) {
    const idade = agora - emCache.fetchedAtMs;
    if (emCache.state === 'gone' && idade < GONE_CACHE_TTL_MS) return falha('removido');
    if (emCache.state === 'ok') {
      const fresco = idade < ACTOR_CACHE_TTL_MS;
      const podeForcar = agora - emCache.lastForcedRefreshAtMs >= FORCED_REFRESH_MIN_INTERVAL_MS;
      if (fresco && !(opcoes.forceRefresh && podeForcar)) return { ok: true, actor: emCache, fromCache: true };
      // Forçar mais de uma vez em cinco minutos: devolve o que temos. A segunda tentativa de verificação falhará
      // sozinha, e é o resultado certo para quem manda assinatura ruim em laço.
      if (fresco && opcoes.forceRefresh && !podeForcar) return { ok: true, actor: emCache, fromCache: true };
    }
  }

  let resposta: Awaited<ReturnType<Fetcher['get']>>;
  try {
    resposta = await deps.fetcher.get(actorId, { accept: ACTIVITY_ACCEPT });
  } catch {
    // Rede fora ou destino recusado pela guarda de SSRF: serve o cache vencido em vez de derrubar a verificação.
    return emCache?.state === 'ok' ? { ok: true, actor: emCache, fromCache: true } : falha('indisponivel');
  }

  if (resposta.status === 410 || resposta.status === 404) {
    // O próprio servidor diz que o ator não existe mais. Lembramos disso para não insistir -- e, com 410 ou com o 404
    // CONFIRMADO (segundo 404 a 6 h ou mais do primeiro), o que guardamos dele vira túmulo. Antes o ator virava "removido"
    // e os posts dele continuavam no ar aqui para sempre, mesmo com a conta apagada na origem.
    const acao = decidirCicloDoAtor(
      classificarLeitura(resposta.status),
      emCache?.state === 'gone' ? (emCache.goneSinceMs ?? null) : null,
      agora,
    );
    if (emCache) {
      const goneSinceMs = acao === 'marcar-removido' ? agora : (emCache.goneSinceMs ?? agora);
      await deps.store.putRemoteActor({ ...emCache, state: 'gone', fetchedAtMs: agora, goneSinceMs });
      if (acao === 'apagar-conteudo') await deps.store.removeRemoteActorContent?.(actorId);
    }
    return falha('removido');
  }
  if (resposta.status < 200 || resposta.status >= 300 || resposta.json === null) {
    return emCache?.state === 'ok' ? { ok: true, actor: emCache, fromCache: true } : falha('indisponivel');
  }

  const analisado = parseRemoteActor(resposta.json, actorId, agora);
  if (!analisado.ok) return analisado;

  const registro: RemoteActorRecord = {
    ...analisado.actor,
    lastForcedRefreshAtMs: opcoes.forceRefresh ? agora : (emCache?.lastForcedRefreshAtMs ?? 0),
  };
  await deps.store.putRemoteActor(registro);
  return { ok: true, actor: registro, fromCache: false };
}

// ───────────────────────── WebFinger de saída ─────────────────────────

export type LookupResult = { ok: true; actor: RemoteActorRecord } | { ok: false; reason: ResolveFailure | 'acct-invalido' | 'sem-link' };

/**
 * `usuario@servidor` → ator. Usado quando uma pessoa daqui procura alguém do Fediverso. Só consulta o servidor que
 * o próprio `acct` nomeia, e só segue o link `self` que ele devolve — o ator pode morar noutro host (delegação), mas
 * passa pela mesma validação e pela mesma política.
 */
export async function lookupAcct(deps: RemoteDeps, bruto: string): Promise<LookupResult> {
  const acct: Acct | null = parseAcct(bruto);
  if (!acct) return { ok: false, reason: 'acct-invalido' };

  const politica = await deps.store.getInstancePolicy();
  if (decideInstance(acct.host, politica, deps.ownHost).decision === 'reject') return { ok: false, reason: 'dominio-recusado' };

  let resposta: Awaited<ReturnType<Fetcher['get']>>;
  try {
    resposta = await deps.fetcher.get(
      `https://${acct.host}/.well-known/webfinger?resource=${encodeURIComponent(`acct:${acct.user}@${acct.host}`)}`,
      { accept: 'application/jrd+json, application/json' },
    );
  } catch {
    return { ok: false, reason: 'indisponivel' };
  }
  if (resposta.status !== 200 || !ehObjeto(resposta.json) || !Array.isArray(resposta.json.links)) {
    return { ok: false, reason: 'sem-link' };
  }
  const link = resposta.json.links.find(
    (l): l is Record<string, unknown> =>
      ehObjeto(l) && l.rel === 'self' && typeof l.href === 'string' &&
      /application\/(activity|ld)\+json/i.test(String(l.type ?? '')),
  );
  if (!link || typeof link.href !== 'string') return { ok: false, reason: 'sem-link' };

  const resolvido = await resolveRemoteActor(deps, link.href);
  return resolvido.ok ? { ok: true, actor: resolvido.actor } : resolvido;
}
