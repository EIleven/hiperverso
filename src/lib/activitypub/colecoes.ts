// src/lib/activitypub/colecoes.ts
// Como ler o que um servidor do Fediverso PUBLICA por ActivityPub -- e só isso. Módulo PURO: sem rede, sem Firebase.
//
// ───────────────────────── Por que existe ─────────────────────────
// Perfil, conexões, contadores e comentários remotos eram lidos pela API REST do Mastodon (`/api/v1/...`), sem
// autenticação. Essa API é a do APLICATIVO de quem tem conta lá: não é o protocolo de federação. Usá-la contra
// terceiros tem dois problemas que não se resolvem com cuidado:
//
//   1. Contorna a escolha do servidor. Instância com "Authorized Fetch" recusa leitura de quem não assina; a REST
//      pública muitas vezes continua aberta. Um comentário no código dizia isso com todas as letras: "funciona mesmo
//      com Authorized Fetch". Funcionar contra a vontade de quem administra é exatamente o que define raspagem.
//   2. Lê o que o protocolo NÃO publica. "Quem curtiu" e "quem repostou" não fazem parte do ActivityPub: o Mastodon
//      publica só o total. Montar a lista pela REST é pegar do outro servidor algo que ele não federou.
//
// Aqui fica a leitura do que É federado: coleções (`totalItems`, `orderedItems`/`items`, `first`) e o desfecho de uma
// busca, com uma regra central -- RECUSA É RESPOSTA. 401/403 não abre caminho alternativo.

/** O que a resposta de uma busca AP significa para nós. */
export type LeituraAp =
  /** Veio o objeto. */
  | 'ok'
  /** 401/403: o servidor sabe quem somos e não quer. Sem fallback, sem tentar por outra porta. */
  | 'recusada'
  /** 410, ou um `Tombstone`: a origem diz que foi apagado. É autoritativo. */
  | 'apagado'
  /** 404: não achou. Pode ser apagado, pode ser algo que o servidor não mostra a quem pede, pode ser falha passageira. */
  | 'sumiu'
  /** 429/503: está pedindo para esperar. */
  | 'limitada'
  /** Rede, 5xx, corpo inválido. Não diz nada sobre o conteúdo. */
  | 'falha';

/** Classifica a resposta de um GET ActivityPub. `json` é o corpo já interpretado, quando houver. */
export function classificarLeitura(status: number | null | undefined, json?: unknown): LeituraAp {
  if (typeof status !== 'number' || !Number.isFinite(status)) return 'falha';
  if (status >= 200 && status < 300) {
    if (json && typeof json === 'object' && !Array.isArray(json) && (json as { type?: unknown }).type === 'Tombstone') {
      return 'apagado';
    }
    return json && typeof json === 'object' && !Array.isArray(json) ? 'ok' : 'falha';
  }
  if (status === 410) return 'apagado';
  if (status === 404) return 'sumiu';
  if (status === 401 || status === 403) return 'recusada';
  if (status === 429 || status === 503) return 'limitada';
  return 'falha';
}

/**
 * O `totalItems` de uma coleção EMBUTIDA (`{ type: 'Collection', totalItems: 12 }`). Uma referência (só a URL) ou um
 * número inválido devolve `null` -- "não informado", que é diferente de zero. Tratar ausência como zero apagaria o
 * contador de quem simplesmente não publica a contagem.
 */
export function totalDe(colecao: unknown): number | null {
  if (!colecao || typeof colecao !== 'object' || Array.isArray(colecao)) return null;
  const t = (colecao as { totalItems?: unknown }).totalItems;
  if (typeof t !== 'number' || !Number.isFinite(t) || t < 0) return null;
  return Math.floor(t);
}

/**
 * Os três contadores que um `Note` publica sobre si: `replies`, `likes` e `shares` (o Mastodon publica `likes` e
 * `shares` com `totalItems` desde a 4.3). Campo ausente = a origem não informou, e o valor guardado fica como está.
 * As chaves são as que `applyRemoteCounts` entende.
 */
export function contagensDoNote(note: unknown): { likes?: number; reposts?: number; commentsCount?: number } {
  if (!note || typeof note !== 'object' || Array.isArray(note)) return {};
  const o = note as Record<string, unknown>;
  const saida: { likes?: number; reposts?: number; commentsCount?: number } = {};
  const curtidas = totalDe(o.likes);
  const reposts = totalDe(o.shares);
  const respostas = totalDe(o.replies);
  if (curtidas !== null) saida.likes = curtidas;
  if (reposts !== null) saida.reposts = reposts;
  if (respostas !== null) saida.commentsCount = respostas;
  return saida;
}

/** Os itens de uma coleção ou página (`orderedItems` ou `items`). Qualquer outra forma = lista vazia. */
export function itensDe(colecaoOuPagina: unknown): unknown[] {
  if (!colecaoOuPagina || typeof colecaoOuPagina !== 'object' || Array.isArray(colecaoOuPagina)) return [];
  const o = colecaoOuPagina as { orderedItems?: unknown; items?: unknown };
  if (Array.isArray(o.orderedItems)) return o.orderedItems;
  if (Array.isArray(o.items)) return o.items;
  return [];
}

/** O id (https) de um item que pode vir como URL ou como objeto embutido. */
export function idDe(item: unknown): string | null {
  if (typeof item === 'string') return item.startsWith('https://') ? item : null;
  if (item && typeof item === 'object' && !Array.isArray(item)) {
    const id = (item as { id?: unknown }).id;
    return typeof id === 'string' && id.startsWith('https://') ? id : null;
  }
  return null;
}

/**
 * A primeira página de uma coleção: embutida (já veio no corpo) ou só a URL (precisa de outra busca). Uma coleção que
 * traz `totalItems` e nenhum `first`/itens é a pessoa (ou o servidor) mostrando o número e escondendo a lista --
 * escolha que se respeita, não um obstáculo a contornar.
 */
export function primeiraPagina(colecao: unknown): { embutida: Record<string, unknown> } | { url: string } | null {
  if (!colecao || typeof colecao !== 'object' || Array.isArray(colecao)) return null;
  const first = (colecao as { first?: unknown }).first;
  if (typeof first === 'string') return first.startsWith('https://') ? { url: first } : null;
  if (first && typeof first === 'object' && !Array.isArray(first)) return { embutida: first as Record<string, unknown> };
  return null;
}

/** A coleção expõe só o número, sem lista nem página? (É assim que o Mastodon publica quem oculta a rede.) */
export function listaOculta(colecao: unknown): boolean {
  return totalDe(colecao) !== null && itensDe(colecao).length === 0 && primeiraPagina(colecao) === null;
}
