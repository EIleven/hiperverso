// src/lib/fontes/registrarFonte.ts
// Guarda no índice de Fontes a página cuja prévia acabou de ser lida. Lado SERVIDOR (Admin SDK).
//
// ───────────────────────── Como o índice enche sem rastrear ninguém ─────────────────────────
// Nada aqui sai procurando página. O que entra é o que a própria rede já foi buscar porque ALGUÉM colou o link —
// a busca já aconteceu, o servidor já respondeu, e o custo já foi pago. Em vez de jogar fora o que foi lido (hoje
// vive numa `LRUCache` que morre a cada reinício), guarda-se o resumo.
//
// Isso tem uma consequência boa e uma limitação honesta:
//   - Bom: zero requisição a mais, zero rastreamento, e o índice cresce exatamente na direção do que a rede discute.
//   - Limitado: só entra o que alguém citou. Não é um varredor da web, e nunca vai ser por este caminho.
//
// A decisão de SE pode entrar não é tomada aqui: ela mora em politicaDeIndexacao.ts, que é puro e testado. Este
// arquivo só executa a decisão e grava.

import { FieldValue } from 'firebase-admin/firestore';
import { adminFirestore } from '@/lib/server/firebaseAdmin';
import { tokensDoDocumento } from '@/lib/search/indiceDeTexto';
import { avaliarParaIndice, chaveDaPagina, type SinaisDaPagina } from './politicaDeIndexacao';
import { dominioBloqueado } from './bloqueio';

/** A coleção do índice. Só o servidor escreve e só o servidor lê: as regras do banco negam o cliente. */
export const COLECAO_FONTES = 'fontes';

export interface EntradaDeFonte {
  urlOriginal: string;
  titulo?: string | null;
  descricao?: string | null;
  imagem?: string | null;
  idioma?: string | null;
  publicadoEm?: string | null;
  sinais?: SinaisDaPagina;
}

export type ResultadoDoRegistro = 'gravada' | 'atualizada' | 'recusada' | 'falhou';

/**
 * Grava (ou atualiza) uma página no índice.
 *
 * Nunca lança: quem chama está no meio de responder uma prévia para alguém, e uma falha de índice não pode
 * estragar a tela de quem só queria ver o link. Devolve o que aconteceu, para o log.
 */
export async function registrarFonte(entrada: EntradaDeFonte, agora: number = Date.now()): Promise<ResultadoDoRegistro> {
  const veredito = avaliarParaIndice(
    entrada.urlOriginal,
    {
      titulo: entrada.titulo,
      descricao: entrada.descricao,
      imagem: entrada.imagem,
      idioma: entrada.idioma,
      publicadoEm: entrada.publicadoEm,
      sinais: entrada.sinais,
    },
    agora,
  );
  if (!veredito.ok) return 'recusada';

  const p = veredito.pagina;
  // Sem título E sem descrição não há o que buscar: guardar seria encher o índice de registro cego.
  if (!p.titulo && !p.descricao) return 'recusada';
  // Domínio bloqueado não entra. (Vale também na LEITURA, em /api/search: bloquear depois tem de tirar dos
  // resultados na hora, e não só impedir registros novos.)
  if (dominioBloqueado(p.host)) return 'recusada';

  try {
    const db = adminFirestore();
    const ref = db.collection(COLECAO_FONTES).doc(chaveDaPagina(p.url));
    const existente = await ref.get();

    const comum = {
      url: p.url,
      host: p.host,
      titulo: p.titulo,
      descricao: p.descricao,
      imagem: p.imagem,
      idioma: p.idioma,
      publicadoEm: p.publicadoEm,
      // Os mesmos tokens do índice interno: a busca de Fontes usa o mesmo motor da busca da rede.
      searchTokens: tokensDoDocumento({ titulo: p.titulo, texto: p.descricao, autorNome: p.host }),
      vistaEm: FieldValue.serverTimestamp(),
    };

    if (existente.exists) {
      // `citacoes` conta quantas vezes a rede voltou a esta página. É sinal de relevância ORGÂNICO, e o único que
      // este índice terá: não há, e não vai haver, como pagar para subir.
      await ref.update({ ...comum, citacoes: FieldValue.increment(1) });
      return 'atualizada';
    }
    await ref.create({ ...comum, citacoes: 1, primeiraVezEm: FieldValue.serverTimestamp() });
    return 'gravada';
  } catch (error) {
    console.error('[fontes] falha ao registrar:', error);
    return 'falhou';
  }
}

/** Lê os sinais de indexação de um documento HTML já interpretado. */
export function sinaisDoDocumento(
  doc: { querySelector(seletor: string): { getAttribute(nome: string): string | null } | null },
  cabecalhos: Record<string, string | string[] | undefined>,
): SinaisDaPagina {
  const meta = (nome: string) => doc.querySelector(`meta[name="${nome}"]`)?.getAttribute('content') ?? null;
  const bruto = cabecalhos['x-robots-tag'];
  return {
    xRobotsTag: Array.isArray(bruto) ? bruto.join(', ') : bruto ?? null,
    metaRobots: meta('robots'),
    // O opt-out dedicado: recusar SÓ esta rede, sem precisar sair do resto da web.
    metaHiperverso: meta('hiperverso-index'),
  };
}
