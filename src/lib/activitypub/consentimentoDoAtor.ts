// src/lib/activitypub/consentimentoDoAtor.ts
// O que a PESSOA do outro servidor disse sobre ser descoberta e indexada. Módulo PURO: sem rede, sem Firebase.
//
// ───────────────────────── As duas flags ─────────────────────────
// `discoverable` (toot:discoverable): a pessoa aceita aparecer em diretório, explorar, sugestões e tendências.
// `indexable`    (toot:indexable):    a pessoa aceita que o TEXTO dos posts públicos dela entre em busca de texto livre.
//
// Nós já EMITÍAMOS as duas no nosso ator, mas nunca LÍAMOS as dos outros: perfil remoto aparecia na busca de pessoas e
// post remoto era achado por qualquer palavra, mesmo de quem disse que não queria.
//
// ───────────────────────── Ausente não é sim ─────────────────────────
// Só `true` conta. Campo ausente, `false`, texto, número: não consentiu. No Mastodon as duas são opt-in (a pessoa liga),
// e servidor que não publica a flag não disse "pode". Consentimento presumido não é consentimento.
//
// ───────────────────────── O que continua valendo sem as flags ─────────────────────────
// - Buscar pelo ENDEREÇO exato (`@pessoa@servidor`): é o WebFinger, o jeito padrão de achar alguém de quem já se sabe o
//   nome, e o próprio Mastodon permite independentemente de `discoverable`.
// - Busca EXPLÍCITA por hashtag (`#tema`): quem marca um post público com uma tag está pedindo que ele seja achado por
//   ela. É a semântica do Mastodon: `indexable` governa o texto livre, não as tags.
// - O feed de quem SEGUE a pessoa: seguir é o consentimento mais explícito que existe.

/** Lê as flags do documento do ator. Estrito: só `true` vale como sim. */
export function lerConsentimentoDoAtor(ator: unknown): { discoverable: boolean; indexable: boolean } {
  if (!ator || typeof ator !== 'object' || Array.isArray(ator)) return { discoverable: false, indexable: false };
  const o = ator as { discoverable?: unknown; indexable?: unknown };
  return { discoverable: o.discoverable === true, indexable: o.indexable === true };
}

export type ItemDaBusca = {
  tipo: 'post' | 'artigo' | 'comentario' | 'pessoa' | 'web';
  /** O item é de alguém de OUTRO servidor. Conteúdo local segue as escolhas da própria pessoa aqui, não estas. */
  remoto: boolean;
  descobrivel?: boolean;
  indexavel?: boolean;
  /** A consulta é o endereço exato desta pessoa (`pessoa@servidor`). */
  enderecoExato?: boolean;
  /** A consulta é uma busca EXPLÍCITA por tag e este item carrega a tag. */
  casouPorTagExplicita?: boolean;
};

/** Um item remoto pode aparecer nesta busca? */
export function remotoPodeAparecerNaBusca(item: ItemDaBusca): boolean {
  if (!item.remoto) return true;
  if (item.tipo === 'pessoa') return item.descobrivel === true || item.enderecoExato === true;
  if (item.tipo === 'post' || item.tipo === 'artigo' || item.tipo === 'comentario') {
    return item.indexavel === true || item.casouPorTagExplicita === true;
  }
  return true;
}

/** Perfil ou post remoto pode aparecer em explorar, sugestões e tendências? Só com `discoverable`. */
export function remotoPodeAparecerNaDescoberta(registro: { remoto: boolean; descobrivel?: boolean }): boolean {
  return !registro.remoto || registro.descobrivel === true;
}

/**
 * Podemos buscar o `outbox` (os posts) de um ator remoto para mostrar no perfil? Só se alguém daqui já o SEGUE. Abrir um
 * perfil não é motivo para baixarmos os posts de quem nunca pediu para estar aqui -- e é exatamente o comportamento que,
 * visto do outro lado, parece raspagem: um servidor desconhecido lendo o histórico de alguém a cada clique.
 */
export function podeCarregarOutbox(entrada: { algumLocalSegue: boolean }): boolean {
  return entrada.algumLocalSegue === true;
}

/** `pessoa@servidor` normalizado, para comparar com a consulta (sem `@` inicial, minúsculo). */
export function enderecoNormalizado(handle: string | null | undefined): string {
  return (handle ?? '').trim().replace(/^@+/, '').toLowerCase();
}
