// src/lib/activitypub/consentimentoDeDominio.ts
// Quando um servidor do Fediverso nos RECUSA, parar de insistir. Módulo PURO: sem Firebase, sem rede, sem DOM.
//
// ───────────────────────── Por que existe ─────────────────────────
// Já havia um disjuntor por domínio, mas ele media uma coisa só: se o servidor está DE PÉ. A regra era explícita —
// "só falha de infraestrutura conta; um 403 é recusa dele, não fora do ar". Correto para disponibilidade, e errado
// para consentimento: o 403 é justamente o servidor dizendo que não quer o que estamos mandando.
//
// O efeito disso aparecia de fora: uma instância nos desfedera e a nossa fila continua batendo na porta dela a cada
// post novo. Do lado de lá, isso não parece engenharia — parece desrespeito. E é.
//
// Aqui o 403 passa a ter consequência própria: recusas seguidas pausam a entrega para aquele domínio.
//
// ───────────────────────── Os dois cuidados ─────────────────────────
// 1. UMA PESSOA QUE BLOQUEIA NÃO PODE DERRUBAR O SERVIDOR INTEIRO. A entrega pode ir para a caixa pessoal de alguém,
//    e aí o 403 é daquela conta, não da instância. Por isso a contagem é de recusas CONSECUTIVAS: qualquer entrega
//    aceita naquele domínio zera o contador. Um único contato que nos bloqueia só derruba o domínio se for o único
//    contato que temos lá — que é exatamente o caso em que parar está certo.
//
// 2. PAUSA TEM PRAZO, E CRESCE. Nunca é definitiva: se foi engano nosso, ou se do outro lado mudaram de ideia, a
//    entrega volta sozinha. Banimento permanente decidido por heurística é o tipo de coisa que ninguém consegue
//    desfazer depois.

/** Recusas seguidas antes de pausar. Três é o bastante para não ser acidente e pouco para não ser insistência. */
export const LIMITE_DE_RECUSAS = 3;

/** A escada da pausa, em horas: 1 dia, 3 dias, 1 semana, 30 dias. Daí para a frente fica em 30 dias. */
export const ESCADA_DE_PAUSA_HORAS = [24, 72, 168, 720] as const;

export interface SaudeDoDominio {
  consecutiveRefusals?: number;
  refusedUntilMs?: number;
}

/** O 403 é a recusa: "eu sei quem você é e não quero". 401 é assinatura, 404 é rota, 5xx é queda — nenhum é recusa. */
export function ehRecusaDeConsentimento(status: number | null | undefined): boolean {
  return status === 403;
}

/** Quanto dura a pausa depois de `n` recusas seguidas (n ≥ LIMITE_DE_RECUSAS). */
export function horasDePausa(recusas: number): number {
  const degrau = Math.max(0, recusas - LIMITE_DE_RECUSAS);
  const i = Math.min(degrau, ESCADA_DE_PAUSA_HORAS.length - 1);
  return ESCADA_DE_PAUSA_HORAS[i];
}

/**
 * Uma entrega foi recusada (403). Devolve como fica a saúde do domínio.
 * Abaixo do limite não pausa nada: só conta.
 */
export function aposRecusa(saude: SaudeDoDominio | null | undefined, agora: number): Required<SaudeDoDominio> {
  const anteriores = Number.isFinite(saude?.consecutiveRefusals) ? Math.max(0, saude!.consecutiveRefusals!) : 0;
  const recusas = anteriores + 1;
  if (recusas < LIMITE_DE_RECUSAS) {
    return { consecutiveRefusals: recusas, refusedUntilMs: 0 };
  }
  return { consecutiveRefusals: recusas, refusedUntilMs: agora + horasDePausa(recusas) * 3_600_000 };
}

/** Uma entrega foi ACEITA naquele domínio: o que havia de recusa não vale mais. */
export function aposEntregaAceita(): Required<SaudeDoDominio> {
  return { consecutiveRefusals: 0, refusedUntilMs: 0 };
}

export type DecisaoDeConsentimento =
  | { pausado: false }
  | { pausado: true; ate: number; recusas: number };

/** Podemos entregar a este domínio agora? */
export function pausaDeConsentimento(
  saude: SaudeDoDominio | null | undefined,
  agora: number,
): DecisaoDeConsentimento {
  const ate = Number.isFinite(saude?.refusedUntilMs) ? saude!.refusedUntilMs! : 0;
  if (!ate || !Number.isFinite(agora) || ate <= agora) return { pausado: false };
  return { pausado: true, ate, recusas: Math.max(0, saude?.consecutiveRefusals ?? 0) };
}

// ───────────────────────── Reciprocidade: quem nos recusa também não é LIDO ─────────────────────────
//
// A pausa nasceu para a ENTREGA: parar de mandar para quem recusa. Mas um servidor que nos recusa continuava sendo lido
// por nós -- buscávamos o perfil, as conexões, os posts e as respostas dele, e o conteúdo dele entrava aqui por boost de
// terceiros. "Não mando para você, mas continuo pegando o que é seu" não é respeito; é só a metade conveniente dele.
//
// A regra: durante a pausa, nada de leitura nossa naquele domínio. O que ELE nos mandar diretamente continua entrando
// -- se ele escolheu mandar, a escolha é dele. O que é bloqueado é o que buscamos ou o que chega por terceiros.

export type MotivoSemLeitura = 'plataforma-desligada' | 'suspenso' | 'pausa-de-consentimento';

export type DecisaoDeLeitura = { pode: true } | { pode: false; motivo: MotivoSemLeitura; ate?: number };

/**
 * Podemos LER deste domínio agora? `suspenso` junta a lista fixa e a política do banco (quem chama resolve as duas).
 * A suspensão vem antes da pausa porque é definitiva: o motivo devolvido deve ser o mais forte.
 */
export function podeLerDe(entrada: {
  plataformaLigada: boolean;
  suspenso: boolean;
  saude: SaudeDoDominio | null | undefined;
  agora: number;
}): DecisaoDeLeitura {
  if (!entrada.plataformaLigada) return { pode: false, motivo: 'plataforma-desligada' };
  if (entrada.suspenso) return { pode: false, motivo: 'suspenso' };
  const pausa = pausaDeConsentimento(entrada.saude, entrada.agora);
  if (pausa.pausado) return { pode: false, motivo: 'pausa-de-consentimento', ate: pausa.ate };
  return { pode: true };
}

// ───────────────────────── Domínios mortos: o nome nem resolve ─────────────────────────

/** Códigos de erro de rede que querem dizer "esse nome não existe (mais) no DNS". */
const CODIGOS_DE_DNS = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ESERVFAIL', 'ENODATA', 'EAI_NONAME']);

/**
 * A classe de uma falha de INFRAESTRUTURA, para o painel. 'dns' separa o servidor que sumiu do mapa (o domínio
 * expirou, a instância fechou) do que está só fora do ar por um tempo.
 */
export function classeDaFalhaDeInfra(status: number | null | undefined, errorDetail?: string | null): string {
  if (status === null || status === undefined) {
    return errorDetail && CODIGOS_DE_DNS.has(errorDetail) ? 'dns' : 'rede';
  }
  if (status === 429 || status === 408) return 'limite';
  if (status >= 500) return 'servidor';
  return 'outra';
}

/** Falhas seguidas a partir das quais o domínio aparece como "morto" no painel (ninguém é suspenso por isto sozinho). */
export const FALHAS_PARA_MORTO = 10;

export type EstadoDoDominio = {
  /** Recebemos 403 dele (nem que uma vez seguida). */
  recusando: boolean;
  /** A pausa está valendo agora. */
  emPausa: boolean;
  pausaAte: number | null;
  /** Falhou de infraestrutura FALHAS_PARA_MORTO vezes seguidas. */
  morto: boolean;
  /** Morto E a última falha foi de DNS: o nome não resolve. */
  semDns: boolean;
};

/** Como o painel deve mostrar este domínio. Puro: só lê o registro de saúde. */
export function estadoDoDominio(
  saude: (SaudeDoDominio & { consecutiveFailures?: number; lastFailureClass?: string }) | null | undefined,
  agora: number,
): EstadoDoDominio {
  const recusas = Number.isFinite(saude?.consecutiveRefusals) ? saude!.consecutiveRefusals! : 0;
  const pausa = pausaDeConsentimento(saude, agora);
  const falhas = Number.isFinite(saude?.consecutiveFailures) ? saude!.consecutiveFailures! : 0;
  const morto = falhas >= FALHAS_PARA_MORTO;
  return {
    recusando: recusas > 0,
    emPausa: pausa.pausado,
    pausaAte: pausa.pausado ? pausa.ate : null,
    morto,
    semDns: morto && saude?.lastFailureClass === 'dns',
  };
}
