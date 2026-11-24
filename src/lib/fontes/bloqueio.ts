// src/lib/fontes/bloqueio.ts
// Domínios que não entram no índice de Fontes. Módulo PURO: sem rede, sem Firebase, sem DOM.
//
// ───────────────────────── Por que a lista é separada das outras ─────────────────────────
// A rede já tem bloqueio de domínio, mas é de OUTRA coisa: é por pessoa, para o Fediverso, e quer dizer "não quero
// receber deste servidor". Aqui a pergunta é diferente — "esta página merece aparecer num resultado de busca?" —, e
// misturar as duas faria alguém que silenciou uma instância sumir com ela do índice de todo mundo.
//
// ───────────────────────── Por que o bloqueio vale nas DUAS pontas ─────────────────────────
// Na GRAVAÇÃO, para não encher o índice. E na LEITURA, porque bloquear um domínio depois precisa tirá-lo dos
// resultados na hora — não quando alguém lembrar de limpar a coleção. Se valesse só na gravação, bloquear seria uma
// decisão sem efeito sobre o que já está lá, que é justamente o que se quer remover.
//
// Hoje a lista mora no código. Quando o painel do admin existir, ela passa a vir do banco e esta constante vira o
// piso — o que estiver aqui continua bloqueado mesmo que alguém esvazie a lista do painel por engano.

/**
 * Domínios fora do índice, com o motivo de cada um. O motivo não é enfeite: uma lista de bloqueio sem motivo vira,
 * em um ano, um conjunto de nomes que ninguém sabe por que estão lá e ninguém tem coragem de tirar.
 */
export const DOMINIOS_BLOQUEADOS: ReadonlyArray<{ dominio: string; motivo: string }> = [
  {
    dominio: 'fllics.com',
    motivo:
      'Padrão de postagem automatizada: 463 citações para 463 páginas distintas (2026-11-19), ou seja, uma citação ' +
      'por página e nenhuma repetida — assinatura de despejo em massa, não de gente citando fonte.',
  },
];

/** Normaliza um host para comparação: minúsculas, sem `www.`, sem ponto final. */
export function normalizarHost(bruto: string): string {
  return (bruto || '')
    .toLowerCase()
    .trim()
    .replace(/\.$/, '')
    .replace(/^www\./, '');
}

/**
 * Este host está bloqueado?
 *
 * Bloquear `exemplo.com` bloqueia também `noticias.exemplo.com`: quem bloqueia um domínio não quer o conteúdo dele,
 * e deixar o subdomínio passar transformaria o bloqueio numa formalidade que se contorna com um prefixo.
 */
export function dominioBloqueado(
  host: string,
  lista: ReadonlyArray<{ dominio: string }> = DOMINIOS_BLOQUEADOS,
): boolean {
  const alvo = normalizarHost(host);
  if (!alvo) return false;
  return lista.some(({ dominio }) => {
    const d = normalizarHost(dominio);
    return d !== '' && (alvo === d || alvo.endsWith(`.${d}`));
  });
}

/** O motivo do bloqueio, para o painel do admin e para o log. `null` se não está bloqueado. */
export function motivoDoBloqueio(
  host: string,
  lista: ReadonlyArray<{ dominio: string; motivo: string }> = DOMINIOS_BLOQUEADOS,
): string | null {
  const alvo = normalizarHost(host);
  if (!alvo) return null;
  const achado = lista.find(({ dominio }) => {
    const d = normalizarHost(dominio);
    return d !== '' && (alvo === d || alvo.endsWith(`.${d}`));
  });
  return achado ? achado.motivo : null;
}
