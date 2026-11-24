// src/lib/activitypub/cicloDeVida.ts
// O que fazer com a CÓPIA LOCAL quando a origem diz que o conteúdo não existe mais. Módulo PURO: sem rede, sem Firebase.
//
// ───────────────────────── Por que existe ─────────────────────────
// O `Delete` que chega pelo inbox já apagava o que guardamos. Mas quem apaga um post nem sempre nos avisa (o servidor
// pode não ter nos entregue, pode ter caído, pode ter perdido a fila), e aí a nossa cópia ficava no ar para sempre: um
// post que a pessoa removeu, ainda legível aqui. Quando NÓS buscamos o objeto e a origem responde que ele sumiu, isso
// precisa ter consequência.
//
// ───────────────────────── As duas respostas ─────────────────────────
//   410 Gone, ou um `Tombstone`  -> a origem AFIRMA que foi apagado. Apaga a cópia na hora.
//   404 Not Found                -> pode ser apagado; pode ser algo que o servidor não mostra a quem pede (o Mastodon
//                                   responde 404 para o que não está visível a quem consulta); pode ser falha de
//                                   roteamento. Então: OCULTA na hora (respeita a exclusão, que é o mais provável) e só
//                                   apaga quando um segundo 404 confirmar, com pelo menos 6 h de distância. Se nesse meio
//                                   tempo o objeto voltar a responder, a cópia volta a aparecer.
//
// 401/403, limite e falha de rede não dizem nada sobre o conteúdo e não mudam nada.
import type { LeituraAp } from './colecoes.ts';

/** Distância mínima entre dois 404 para a remoção ser considerada confirmada. */
export const CONFIRMACAO_DE_404_MS = 6 * 3600 * 1000;

export type RegistroDoCiclo = {
  /** A cópia já está fora do ar (por nós, ou por um `Delete`). */
  isDeleted?: boolean;
  /** Quando ocultamos por um 404 ainda não confirmado. Ausente = não fomos nós que ocultamos. */
  remoteGoneAtMs?: number | null;
};

export type AcaoDoCiclo = 'manter' | 'ocultar' | 'apagar' | 'restaurar';

const instante = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null);

/**
 * A decisão para um post ou comentário remoto que guardamos, dada a resposta da origem.
 *
 * `restaurar` só desfaz o que NÓS ocultamos por 404 (marcado em `remoteGoneAtMs`). Um post apagado por `Delete` nunca
 * volta por aqui, mesmo que a origem passe a responder: quem apagou, apagou.
 */
export function decidirCiclo(leitura: LeituraAp, registro: RegistroDoCiclo | null | undefined, agora: number): AcaoDoCiclo {
  if (!registro) return 'manter';
  const ocultoPorNosDesde = instante(registro.remoteGoneAtMs);
  switch (leitura) {
    case 'apagado':
      // Já é túmulo por um `Delete`: nada a fazer. Oculto por 404 ou ainda no ar: apaga.
      return registro.isDeleted === true && ocultoPorNosDesde === null ? 'manter' : 'apagar';
    case 'sumiu':
      if (ocultoPorNosDesde === null) return registro.isDeleted === true ? 'manter' : 'ocultar';
      return agora - ocultoPorNosDesde >= CONFIRMACAO_DE_404_MS ? 'apagar' : 'manter';
    case 'ok':
      return ocultoPorNosDesde !== null ? 'restaurar' : 'manter';
    default:
      return 'manter';
  }
}

export type AcaoDoCicloDoAtor = 'manter' | 'marcar-removido' | 'apagar-conteudo';

/**
 * O mesmo raciocínio para um ATOR remoto. Aqui o "ocultar já" é marcar o ator como removido (o que já existia: sem
 * entregas, sem interações); o conteúdo dele só vira túmulo com 410 ou com o 404 confirmado. Um 404 de ator derrubar na
 * hora todos os posts dele seria pesado demais para uma resposta que pode ser passageira.
 */
export function decidirCicloDoAtor(leitura: LeituraAp, removidoDesdeMs: number | null | undefined, agora: number): AcaoDoCicloDoAtor {
  const desde = instante(removidoDesdeMs);
  if (leitura === 'apagado') return 'apagar-conteudo';
  if (leitura === 'sumiu') {
    if (desde === null) return 'marcar-removido';
    return agora - desde >= CONFIRMACAO_DE_404_MS ? 'apagar-conteudo' : 'manter';
  }
  return 'manter';
}
