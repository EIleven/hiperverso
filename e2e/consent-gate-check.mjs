#!/usr/bin/env node
/**
 * Testa o gate de consentimento de cookies (src/lib/consent/) sem app, navegador nem emuladores: importa os módulos
 * TypeScript direto (o Node 22 remove os tipos).
 *   node e2e/consent-gate-check.mjs
 *
 * Confere duas coisas diferentes:
 *
 * 1. A REGRA: sem decisão, com decisão corrompida, com decisão de uma versão antiga do aviso ou com o armazenamento
 *    bloqueado, nada opcional é liberado — e o Consent Mode nasce negando tudo. Aceitar, recusar e escolher categoria
 *    por categoria produzem exatamente os sinais esperados.
 *
 * 2. O CÓDIGO: que ninguém reintroduziu uma tag do Google fora do gate. Até 2026-11-11 o layout injetava o Google Tag
 *    Manager em TODA visita de produção, sem aviso e sem escolha; o único freio era o modo emulador. Esta parte do
 *    teste existe para isso não voltar por descuido — ela varre src/ e reprova qualquer referência ao
 *    googletagmanager.com fora do módulo de consentimento.
 *
 * Sai com código 1 se algo falhar.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, relative, sep } from 'node:path';

const {
  ACCEPT_ALL,
  CONSENT_NOTICE_VERSION,
  CONSENT_STORAGE_KEY,
  REJECT_ALL,
  analyticsAllowed,
  consentModeBootstrapScript,
  consentModeSignals,
  decisionFrom,
  grantedChoice,
  isCurrentDecision,
  needsDecision,
  parseStoredConsent,
  shouldLoadGtm,
} = await import('../src/lib/consent/consentState.ts');

const { GTM_CONTAINER_ID, gtmContainerScript, updateGoogleConsent } = await import(
  '../src/lib/consent/googleConsent.ts'
);

const RAIZ = fileURLToPath(new URL('..', import.meta.url));
let falhas = 0;

function ok(nome, detalhe) {
  console.log(`OK    ${nome}${detalhe ? ` — ${detalhe}` : ''}`);
}

function falha(nome, motivo) {
  falhas++;
  console.log(`FALHA ${nome} — ${motivo}`);
}

function confere(nome, condicao, motivo, detalhe) {
  if (condicao) ok(nome, detalhe);
  else falha(nome, motivo);
}

// ───────────────────────────── 1. A regra ─────────────────────────────

const decisaoGuardada = (valor) => JSON.stringify(valor);

// [nome, o que está no localStorage, espera decisão válida?, analytics]
//
// Publicidade saiu da tabela porque saiu do produto: em 2026-11-19 o código de anúncios foi removido e a categoria
// `marketing` deixou de existir. Um registro ANTIGO ainda traz esse campo, e o que se prova abaixo é que ele é
// ignorado em vez de invalidar a decisão -- quem já escolheu sobre MEDIÇÃO não perde a escolha por causa disso.
const casosGuardados = [
  ['nada guardado', null, false, false, false],
  ['texto vazio', '', false, false, false],
  ['JSON quebrado', '{analytics:true', false, false, false],
  ['não é objeto', '"aceito"', false, false, false],
  ['nulo', 'null', false, false, false],
  ['analytics como texto', decisaoGuardada({ version: CONSENT_NOTICE_VERSION, decidedAt: 'x', analytics: 'true' }), false, false],
  ['sem data', decisaoGuardada({ version: CONSENT_NOTICE_VERSION, decidedAt: '', analytics: true }), false, false],
  ['sem versão', decisaoGuardada({ decidedAt: 'x', analytics: true }), false, false],
  [
    'versão antiga do aviso',
    decisaoGuardada({ version: CONSENT_NOTICE_VERSION - 1, decidedAt: 'x', analytics: true }),
    false,
    false,
  ],
  [
    'aceitou a medição (versão atual)',
    decisaoGuardada({ version: CONSENT_NOTICE_VERSION, decidedAt: '2026-11-11T00:00:00.000Z', analytics: true }),
    true,
    true,
  ],
  [
    'recusou tudo (versão atual)',
    decisaoGuardada({ version: CONSENT_NOTICE_VERSION, decidedAt: '2026-11-11T00:00:00.000Z', analytics: false }),
    true,
    false,
  ],
  [
    'registro ANTIGO, com o campo marketing: o campo é ignorado e a escolha de medição continua valendo',
    decisaoGuardada({ version: CONSENT_NOTICE_VERSION, decidedAt: '2026-11-11T00:00:00.000Z', analytics: true, marketing: true }),
    true,
    true,
  ],
  [
    'registro ANTIGO que recusava tudo: continua recusando',
    decisaoGuardada({ version: CONSENT_NOTICE_VERSION, decidedAt: '2026-11-11T00:00:00.000Z', analytics: false, marketing: true }),
    true,
    false,
  ],
];

for (const [nome, guardado, valida, esperaAnalytics] of casosGuardados) {
  const decisao = parseStoredConsent(guardado);
  const concedido = grantedChoice(decisao);
  const sinais = consentModeSignals(decisao);
  const problemas = [];

  if (isCurrentDecision(decisao) !== valida) {
    problemas.push(`decisão ${valida ? 'deveria' : 'não deveria'} valer`);
  }
  if (needsDecision(decisao) !== !valida) {
    problemas.push(`o aviso ${valida ? 'não deveria' : 'deveria'} aparecer`);
  }
  if (concedido.analytics !== esperaAnalytics) {
    problemas.push(`medição veio ${concedido.analytics} (esperado ${esperaAnalytics})`);
  }
  if ('marketing' in concedido) {
    problemas.push('a categoria de publicidade voltou a existir na escolha concedida');
  }
  // Os quatro sinais de publicidade do Consent Mode sao NEGADOS sempre, decida-se o que se decidir. Antes, o botao
  // "Aceitar tudo" os concedia -- num aviso cujo proprio texto dizia "zero publicidade".
  for (const sinal of ['ad_storage', 'ad_user_data', 'ad_personalization', 'personalization_storage']) {
    if (sinais[sinal] !== 'denied') problemas.push(`${sinal} veio ${sinais[sinal]} (tem de ser sempre denied)`);
  }
  if (analyticsAllowed(decisao) !== esperaAnalytics) {
    problemas.push('analyticsAllowed discorda de grantedChoice');
  }
  if (shouldLoadGtm(decisao) !== esperaAnalytics) {
    problemas.push(`shouldLoadGtm veio ${shouldLoadGtm(decisao)}`);
  }
  // O que vai para o Google precisa bater, sinal por sinal.
  if (sinais.analytics_storage !== (esperaAnalytics ? 'granted' : 'denied')) {
    problemas.push(`analytics_storage veio ${sinais.analytics_storage}`);
  }
  // Estritamente necessários não dependem de aceite, nunca.
  if (sinais.functionality_storage !== 'granted' || sinais.security_storage !== 'granted') {
    problemas.push('os estritamente necessários não deveriam depender de aceite');
  }

  if (problemas.length) falha(nome, problemas.join('; '));
  else ok(nome, `medição ${esperaAnalytics ? 'sim' : 'não'}, publicidade sempre negada`);
}

// Sem decisão, o GTM não pode nem ser pedido.
confere(
  'sem decisão o container do GTM não é carregado',
  shouldLoadGtm(null) === false,
  'shouldLoadGtm(null) deveria ser false',
);

// Gravação da decisão: versão atual e data em ISO.
const agora = new Date('2026-11-11T12:34:56.000Z');
const gravada = decisionFrom({ analytics: true }, agora);
confere(
  'a decisão gravada registra a versão do aviso e a data',
  gravada.version === CONSENT_NOTICE_VERSION &&
    gravada.decidedAt === agora.toISOString() &&
    gravada.analytics === true &&
    !('marketing' in gravada),
  `veio ${JSON.stringify(gravada)}`,
  JSON.stringify(gravada),
);

// Entrada que não é booleano (um refactor passando 1/0, uma string vinda de formulário) NÃO concede. O normalizador
// puxa para o lado seguro de propósito: só `true` de verdade autoriza.
const gravadaTorta = decisionFrom({ analytics: 1, marketing: 'sim' }, agora);
confere(
  'valor que não é booleano não concede nada',
  gravadaTorta.analytics === false && !('marketing' in gravadaTorta),
  `veio ${JSON.stringify(gravadaTorta)}`,
);

// Ida e volta pelo armazenamento: o que é gravado precisa ser lido de volta igual.
const voltou = parseStoredConsent(JSON.stringify(decisionFrom(ACCEPT_ALL, agora)));
confere(
  'a decisão sobrevive à ida e volta pelo localStorage',
  voltou !== null && voltou.analytics === true && !('marketing' in voltou),
  `voltou ${JSON.stringify(voltou)}`,
);

confere(
  'recusar tudo é uma decisão (o aviso para de aparecer)',
  needsDecision(decisionFrom(REJECT_ALL, agora)) === false,
  'recusar deveria encerrar o aviso',
);

confere(
  'a chave do armazenamento segue o padrão do projeto',
  CONSENT_STORAGE_KEY === 'soberan_consent',
  `a chave é ${CONSENT_STORAGE_KEY}`,
);

// ─────────────────── 2. O script de partida nega tudo ───────────────────

const bootstrap = consentModeBootstrapScript();
const opcionaisNoBootstrap = ['ad_storage', 'ad_user_data', 'ad_personalization', 'analytics_storage'];

confere(
  'o script de partida nega todas as categorias opcionais',
  opcionaisNoBootstrap.every((chave) => bootstrap.includes(`"${chave}":"denied"`)),
  `o script de partida não nega tudo: ${bootstrap}`,
);
confere(
  'o script de partida não concede nada opcional',
  !opcionaisNoBootstrap.some((chave) => bootstrap.includes(`"${chave}":"granted"`)),
  'alguma categoria opcional nasce concedida',
);
confere(
  'o script de partida define dataLayer e gtag antes de qualquer tag',
  bootstrap.includes('window.dataLayer') && bootstrap.includes('window.gtag') && bootstrap.includes("'consent', 'default'"),
  'falta a fila ou o gtag no script de partida',
);
confere(
  'o gtag empurra o objeto arguments, como o snippet oficial',
  bootstrap.includes('window.dataLayer.push(arguments)'),
  'o gtag não empurra arguments — a API de consentimento do GTM não entende',
);
confere(
  'o script de partida espera a decisão guardada chegar na fila',
  bootstrap.includes('wait_for_update'),
  'falta wait_for_update',
);
confere(
  'o script de partida não baixa nada de terceiros',
  !bootstrap.includes('googletagmanager.com'),
  'o script de partida pede algo ao googletagmanager.com',
);

// `updateGoogleConsent` é chamado no servidor durante o build: não pode explodir sem window.
let erroNoServidor = null;
try {
  updateGoogleConsent(consentModeSignals(null));
} catch (erro) {
  erroNoServidor = erro;
}
confere(
  'avisar o Google não quebra onde não existe window',
  erroNoServidor === null,
  `estourou: ${erroNoServidor?.message}`,
);

confere(
  'o snippet do container aponta para o GTM da rede',
  gtmContainerScript(GTM_CONTAINER_ID).includes('googletagmanager.com/gtm.js') &&
    gtmContainerScript(GTM_CONTAINER_ID).includes(GTM_CONTAINER_ID),
  'o snippet do container não está montando o endereço certo',
  GTM_CONTAINER_ID,
);

// ──────────────── 3. Nenhuma tag do Google fora do gate ────────────────

/** Só o módulo de consentimento pode falar com os servidores do Google. */
const ehModuloDeConsentimento = (rel) =>
  rel.startsWith(join('lib', 'consent') + sep) || rel.startsWith(join('components', 'consent') + sep);

/**
 * Tira os comentários antes de procurar: uma MENÇÃO ao googletagmanager.com explicando a regra não é uma tag sendo
 * injetada. Saem só os comentários de bloco e as linhas que são puro comentário — um `//` no meio de uma string (o
 * próprio endereço `https://...`) continua no texto, senão o guarda deixaria passar justamente o que importa.
 */
function semComentarios(texto) {
  return texto.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
}

function varrer(dir, achados) {
  for (const nome of readdirSync(dir)) {
    const caminho = join(dir, nome);
    if (statSync(caminho).isDirectory()) {
      varrer(caminho, achados);
      continue;
    }
    if (!/\.(ts|tsx)$/.test(nome)) continue;
    const codigo = semComentarios(readFileSync(caminho, 'utf8'));
    if (codigo.includes('googletagmanager.com') || codigo.includes('googlesyndication.com')) {
      achados.push(relative(join(RAIZ, 'src'), caminho));
    }
  }
}

const achados = [];
varrer(join(RAIZ, 'src'), achados);
const foraDoGate = achados.filter((caminho) => !ehModuloDeConsentimento(caminho));
confere(
  'nenhuma tag do Google é injetada fora do gate de consentimento',
  foraDoGate.length === 0,
  `fora do gate: ${foraDoGate.join(', ')}`,
  `só em ${achados.join(', ')}`,
);

// [nome, arquivo, precisa conter, não pode conter]
const guardasDeArquivo = [
  [
    'o layout do idioma não injeta mais o GTM',
    join('app', '[locale]', 'layout.tsx'),
    [],
    ['googletagmanager.com', 'GTM-', 'adsbygoogle.js'],
  ],
  [
    'o layout raiz nega o consentimento antes de tudo',
    join('app', 'layout.tsx'),
    ['consentModeBootstrapScript', 'beforeInteractive'],
    [],
  ],
  [
    'o GTM só é montado atrás do consentimento',
    join('components', 'consent', 'GoogleTagManager.tsx'),
    ['shouldLoadGtm', 'useConsent'],
    [],
  ],
  [
    'o Analytics do Firebase não inicia sozinho na importação',
    join('lib', 'firebase.ts'),
    ['getAnalyticsIfConsented', 'analyticsAllowed'],
    ['const analytics: Analytics | null ='],
  ],
];

for (const [nome, relativo, precisa, proibido] of guardasDeArquivo) {
  const texto = readFileSync(join(RAIZ, 'src', relativo), 'utf8');
  const faltando = precisa.filter((trecho) => !texto.includes(trecho));
  const sobrando = proibido.filter((trecho) => texto.includes(trecho));
  const problemas = [];
  if (faltando.length) problemas.push(`falta ${faltando.join(', ')}`);
  if (sobrando.length) problemas.push(`não deveria ter ${sobrando.join(', ')}`);
  if (problemas.length) falha(nome, problemas.join('; '));
  else ok(nome, relativo);
}

// ── Publicidade: a melhor garantia não é "está atrás do consentimento", é "não existe" ──
//
// Até 2026-11-19 havia aqui uma guarda exigindo que o AdSense pedisse aceite. Ela protegia o vazamento, mas não
// protegia da contradição que existia ao lado: o aviso dizia "zero publicidade" e o botão "Aceitar tudo" mandava
// `ad_storage: granted` para o Google. O código de anúncios foi removido, e o que se prova agora é a AUSÊNCIA —
// arquivo que não existe não vaza, e não depende de ninguém lembrar de manter a guarda certa.
for (const sumido of [
  join('components', 'consent', 'AdSenseScript.tsx'),
  join('components', 'feed', 'AdPostCard.tsx'),
  join('components', 'shared', 'AdClientComponent.tsx'),
]) {
  if (existsSync(join(RAIZ, 'src', sumido))) falha('código de anúncio voltou a existir', sumido);
  else ok('sem código de anúncio', sumido);
}

// E nenhum arquivo da rede pode voltar a chamar o AdSense.
{
  const encontrados = [];
  const varrer = (dir) => {
    for (const entrada of readdirSync(dir, { withFileTypes: true })) {
      const caminho = join(dir, entrada.name);
      if (entrada.isDirectory()) varrer(caminho);
      else if (/\.(ts|tsx)$/.test(entrada.name)) {
        const t = readFileSync(caminho, 'utf8');
        // O bloqueio de domínios cita `googlesyndication` para BARRÁ-LO; só o uso real é proibido.
        if (/adsbygoogle|ca-pub-|pagead2\.googlesyndication/.test(t)) encontrados.push(caminho.slice(RAIZ.length));
      }
    }
  };
  varrer(join(RAIZ, 'src'));
  if (encontrados.length) falha('alguém voltou a chamar o AdSense', encontrados.join(', '));
  else ok('nenhum arquivo chama o AdSense', 'src/');
}

if (falhas) {
  console.log(`\n${falhas} falha(s) no gate de consentimento.`);
  process.exit(1);
}
console.log('\nGate de consentimento OK: nada opcional carrega antes do aceite.');
