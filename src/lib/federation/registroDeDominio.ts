// src/lib/federation/registroDeDominio.ts
// "Este documento é de tal domínio?" -- a pergunta que toda purga faz. Módulo PURO: sem Firebase.
//
// Existia em dois lugares com listas de campos diferentes (o script da purga olhava `targetInbox`/`sharedInbox`; a purga
// do painel não), e por isso a do painel deixava na fila de entrega o corpo das atividades destinadas ao domínio que
// pediu remoção. Agora é uma só, e a purga do painel pode mirar um domínio qualquer, não só a lista fixa do código.

/** Campos que guardam o domínio em si. */
const CAMPOS_DE_DOMINIO = ['remoteDomain', 'domain', 'host'] as const;
/** Campos que guardam um handle `usuario@dominio`. */
const CAMPOS_DE_HANDLE = ['handle', 'username'] as const;
/** Campos que guardam uma URL de onde se tira o host. */
const CAMPOS_DE_URL = [
  'remoteUrl',
  'remoteActorId',
  'remoteActorUrl',
  'apActorUri',
  'website',
  'apObjectId',
  'actorId',
  'url',
  'canonicalUrl',
  'targetInbox',
  'sharedInbox',
] as const;

const limparHost = (h: string): string | null => {
  const t = h.trim().toLowerCase().replace(/\.$/, '');
  return t && !/[\s/]/.test(t) ? t : null;
};

const hostDeUrl = (v: string): string | null => {
  if (!/^https?:\/\//i.test(v)) return null;
  try {
    return limparHost(new URL(v).hostname);
  } catch {
    return null;
  }
};

const hostDeHandle = (v: string): string | null => (v.includes('@') ? limparHost(v.split('@').pop() || '') : null);

/** Todos os hosts que um documento declara, por qualquer um dos campos conhecidos. `idDoDoc` cobre ids `usuario@host`. */
export function hostsDoRegistro(dados: Record<string, unknown> | null | undefined, idDoDoc?: string): string[] {
  const hosts = new Set<string>();
  const add = (h: string | null) => {
    if (h) hosts.add(h);
  };
  if (idDoDoc) add(hostDeHandle(idDoDoc));
  if (!dados) return [...hosts];
  for (const c of CAMPOS_DE_DOMINIO) if (typeof dados[c] === 'string') add(limparHost(dados[c] as string));
  for (const c of CAMPOS_DE_HANDLE) if (typeof dados[c] === 'string') add(hostDeHandle(dados[c] as string));
  const autor = dados.authorDetails;
  if (autor && typeof autor === 'object' && typeof (autor as { username?: unknown }).username === 'string') {
    add(hostDeHandle((autor as { username: string }).username));
  }
  for (const c of CAMPOS_DE_URL) if (typeof dados[c] === 'string') add(hostDeUrl(dados[c] as string));
  return [...hosts];
}

/** O host é um dos domínios, ou subdomínio de um deles? (`a.bolha.one` casa com `bolha.one`; `xbolha.one` não.) */
export function hostCasaComDominios(host: string, dominios: readonly string[]): boolean {
  const h = limparHost(host);
  if (!h) return false;
  return dominios.some((d) => {
    const alvo = limparHost(d);
    return Boolean(alvo) && (h === alvo || h.endsWith(`.${alvo}`));
  });
}

/** O documento pertence a algum dos domínios? */
export function registroEhDosDominios(
  dados: Record<string, unknown> | null | undefined,
  dominios: readonly string[],
  idDoDoc?: string,
): boolean {
  if (dominios.length === 0) return false;
  return hostsDoRegistro(dados, idDoDoc).some((h) => hostCasaComDominios(h, dominios));
}
