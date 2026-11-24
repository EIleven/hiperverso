// src/lib/consent/consentState.ts
// Núcleo do consentimento de cookies: guarda, valida e traduz a escolha da pessoa em sinais. NÃO toca em navegador,
// React ou rede — é de propósito, para o `npm run e2e:consent` exercitar toda a regra sem app nem emuladores.
//
// A regra que manda aqui: nada opcional é liberado sem escolha explícita e informada (LGPD, art. 7º, I, e art. 8º).
// Na dúvida — sem decisão, decisão corrompida, armazenamento bloqueado ou aviso novo — o resultado é NEGADO.

/**
 * Categorias do aviso. `necessary` não é escolha: sem ela não há login, idioma, tema nem proteção contra fraude
 * (LGPD, art. 7º, V e IX — execução do serviço pedido pelo titular e legítimo interesse em segurança).
 */
export type ConsentCategory = 'necessary' | 'analytics';

/**
 * O que a pessoa escolheu para as categorias opcionais.
 *
 * Publicidade NÃO é uma delas, e não é por omissão: em 2026-11-19 o código de anúncios foi removido da rede. Antes
 * disso existia uma categoria `marketing` que ninguém conseguia ligar pela tela — mas o botão "Aceitar tudo" a
 * marcava, e ela virava `ad_storage: granted` no Consent Mode do Google. O aviso dizia "zero publicidade" enquanto
 * o sinal dizia o contrário. Sem categoria não há como a contradição voltar.
 */
export interface ConsentChoice {
  /** Medição de uso da rede (Google Analytics via Tag Manager). */
  analytics: boolean;
}

export interface ConsentDecision extends ConsentChoice {
  /** Versão do aviso que a pessoa leu ao decidir. */
  version: number;
  /** Quando decidiu (ISO 8601). Registro mínimo para demonstrar o consentimento (LGPD, art. 8º, § 1º). */
  decidedAt: string;
}

/**
 * Suba este número SEMPRE que o texto do aviso ou as categorias mudarem: toda decisão anterior deixa de valer e a
 * pergunta volta. Consentimento dado para outro texto não cobre um tratamento novo (LGPD, art. 8º, § 4º).
 */
export const CONSENT_NOTICE_VERSION = 2;

/** Chave no localStorage. Mesmo prefixo das outras preferências locais (`soberan_*`). */
export const CONSENT_STORAGE_KEY = 'soberan_consent';

export const ACCEPT_ALL: ConsentChoice = { analytics: true };
export const REJECT_ALL: ConsentChoice = { analytics: false };

/**
 * Lê o que estava guardado. Devolve `null` para qualquer coisa que não seja uma decisão íntegra — texto vazio, JSON
 * quebrado, campo faltando ou com tipo errado. Um registro pela metade não autoriza nada.
 */
export function parseStoredConsent(raw: string | null | undefined): ConsentDecision | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const candidate = parsed as Record<string, unknown>;
  if (typeof candidate.analytics !== 'boolean') return null;
  // Um registro antigo traz `marketing`. Ele não é lido nem recusado: é ignorado. Recusar invalidaria a decisão de
  // quem já respondeu, e o que ela escolheu para MEDIÇÃO continua valendo.
  if (typeof candidate.version !== 'number' || !Number.isFinite(candidate.version)) return null;
  if (typeof candidate.decidedAt !== 'string' || candidate.decidedAt.trim() === '') return null;
  return {
    version: candidate.version,
    decidedAt: candidate.decidedAt,
    analytics: candidate.analytics,
  };
}

/**
 * Só vale a decisão tomada sobre a versão atual do aviso. Versão antiga conta como "ainda não decidiu": o aviso
 * reaparece e, até lá, nada opcional carrega.
 */
export function isCurrentDecision(decision: ConsentDecision | null): decision is ConsentDecision {
  return decision !== null && decision.version === CONSENT_NOTICE_VERSION;
}

/** O aviso deve aparecer? Sim enquanto não houver decisão válida para a versão atual. */
export function needsDecision(decision: ConsentDecision | null): boolean {
  return !isCurrentDecision(decision);
}

/** O que foi de fato concedido. Sem decisão válida, nada opcional é concedido. */
export function grantedChoice(decision: ConsentDecision | null): ConsentChoice {
  return isCurrentDecision(decision) ? { analytics: decision.analytics } : REJECT_ALL;
}

export type ConsentSignal = 'granted' | 'denied';

/** Sinais do Google Consent Mode v2. Os nomes são os que o Google exige, por isso em inglês e snake_case. */
export interface ConsentModeSignals {
  ad_storage: ConsentSignal;
  ad_user_data: ConsentSignal;
  ad_personalization: ConsentSignal;
  analytics_storage: ConsentSignal;
  functionality_storage: ConsentSignal;
  personalization_storage: ConsentSignal;
  security_storage: ConsentSignal;
}

const signal = (granted: boolean): ConsentSignal => (granted ? 'granted' : 'denied');

/**
 * Traduz a decisão para os sinais do Consent Mode v2.
 *
 * Os quatro sinais de publicidade são NEGADOS SEMPRE, e não há caminho que os conceda: a rede não exibe anúncios e
 * não tem código para isso. Não dependem de escolha porque não há escolha a fazer -- conceder `ad_storage` numa rede
 * sem anúncio seria dar ao Google uma permissão que nada aqui usa.
 *
 * `functionality_storage` e `security_storage` ficam concedidos porque são os estritamente necessários (manter a
 * sessão, lembrar idioma e tema, barrar abuso) e não dependem de aceite.
 */
export function consentModeSignals(decision: ConsentDecision | null): ConsentModeSignals {
  const { analytics } = grantedChoice(decision);
  return {
    ad_storage: 'denied',
    ad_user_data: 'denied',
    ad_personalization: 'denied',
    analytics_storage: signal(analytics),
    functionality_storage: 'granted',
    personalization_storage: 'denied',
    security_storage: 'granted',
  };
}

/** Os sinais de partida, antes de qualquer escolha: tudo o que é opcional nasce negado. */
export function defaultConsentModeSignals(): ConsentModeSignals {
  return consentModeSignals(null);
}

/**
 * O container do Google Tag Manager só deve ser baixado se houver alguma categoria opcional concedida. Não basta
 * mandar sinais negados ao GTM: sem aceite, o script nem é pedido ao googletagmanager.com.
 */
export function shouldLoadGtm(decision: ConsentDecision | null): boolean {
  return grantedChoice(decision).analytics;
}

/** O Analytics do Firebase (Google Analytics) depende da categoria de medição. */
export function analyticsAllowed(decision: ConsentDecision | null): boolean {
  return grantedChoice(decision).analytics;
}

/**
 * Script de partida do Consent Mode v2, para rodar ANTES de qualquer tag (`beforeInteractive`, no layout raiz). Faz
 * três coisas: cria a `dataLayer`, define o `gtag` global e nega tudo que é opcional.
 *
 * O `gtag` precisa empurrar o objeto `arguments` cru (não um array): é assim que o snippet oficial do Google funciona
 * e é o que a API de consentimento do GTM espera encontrar na fila. Por isso ele nasce aqui, em texto, e o React
 * depois só chama `window.gtag(...)` em vez de montar a fila por conta própria.
 *
 * `wait_for_update` dá meio segundo para a decisão guardada chegar na fila antes de qualquer tag disparar.
 *
 * Mora neste módulo (e não junto do resto das tags) porque é lógica pura e precisa ficar ao alcance do teste.
 */
export function consentModeBootstrapScript(): string {
  const defaults = { ...defaultConsentModeSignals(), wait_for_update: 500 };
  return [
    'window.dataLayer = window.dataLayer || [];',
    'function gtag(){window.dataLayer.push(arguments);}',
    'window.gtag = gtag;',
    `gtag('consent', 'default', ${JSON.stringify(defaults)});`,
  ].join('\n');
}

/** Monta a decisão a gravar. Normaliza para booleano: nada entra no registro por descuido de tipo. */
export function decisionFrom(choice: ConsentChoice, now: Date = new Date()): ConsentDecision {
  return {
    version: CONSENT_NOTICE_VERSION,
    decidedAt: now.toISOString(),
    analytics: choice.analytics === true,
  };
}
