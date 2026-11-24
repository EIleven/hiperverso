#!/usr/bin/env node
/**
 * GUARDA: nenhum fluxo público lê terceiros do Fediverso pela API de APLICATIVO (REST do Mastodon, API do Misskey).
 *   node e2e/sem-api-de-aplicativo-check.mjs        (ou: npm run e2e:sem-api-de-app)
 *
 * `/api/v1/...` é a API do aplicativo de quem tem conta naquele servidor, não o protocolo de federação. Usada sem
 * autenticação contra terceiros, ela contornava instâncias com "Authorized Fetch" (o próprio código dizia "funciona mesmo
 * com Authorized Fetch") e lia o que o ActivityPub não publica, como a lista de quem curtiu. Isso é raspagem.
 *
 * Esta suíte varre o código-fonte e falha se uma URL ABSOLUTA ou montada (`https://...` ou `${dominio}`) apontar para
 * `/api/v1/`, `/api/v2/`, `/api/users/`, `/api/notes/` ou `/api/i/` fora da lista permitida abaixo, onde cada exceção
 * tem o motivo escrito. Caminho relativo (`'/api/...'`) é rota NOSSA e não entra.
 *
 * Sai com código 1 se algo falhar.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const RAIZ = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const SRC = join(RAIZ, 'src');

/** Cada exceção com o motivo. Arquivo novo que precise disto tem de entrar aqui, à vista, com a justificativa. */
const PERMITIDOS = {
  'src/lib/server/federatedSync.ts': 'token OAuth da PRÓPRIA pessoa conectada, com consentimento por item',
  'src/app/api/auth/fediverse/start/route.ts': 'registro do app OAuth (/api/v1/apps): é o próprio fluxo de login autorizado',
  'src/app/api/auth/fediverse/callback/route.ts': 'verify_credentials com o token que a pessoa acabou de autorizar',
  'src/app/api/translate/route.ts': 'Lingva (tradução): não é servidor do Fediverso',
};

const PADRAO = /(https:\/\/[^'"`\s]*|\$\{[^}]+\})\/api\/(v1|v2|users|notes|i)\//;

function arquivos(dir) {
  const saida = [];
  for (const nome of readdirSync(dir)) {
    const caminho = join(dir, nome);
    const st = statSync(caminho);
    if (st.isDirectory()) saida.push(...arquivos(caminho));
    else if (/\.(ts|tsx|mjs|js)$/.test(nome)) saida.push(caminho);
  }
  return saida;
}

const rel = (p) => relative(RAIZ, p).split(sep).join('/');
const ehRotaNossaDeApi = (r) => /^src\/app\/api\/v[12]\//.test(r);

let falhas = 0;
let total = 0;
const confere = (nome, condicao, motivo) => {
  total++;
  if (condicao) console.log(`OK    ${nome}`);
  else {
    falhas++;
    console.log(`FALHA ${nome} — ${motivo}`);
  }
};

// ─────────────────────────── 1. Varredura ───────────────────────────
const violacoes = [];
const usadosNaLista = new Set();
for (const caminho of arquivos(SRC)) {
  const r = rel(caminho);
  if (ehRotaNossaDeApi(r)) continue;
  const linhas = readFileSync(caminho, 'utf8').split(/\r?\n/);
  linhas.forEach((linha, i) => {
    const t = linha.trim();
    if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return;
    if (!PADRAO.test(linha)) return;
    if (PERMITIDOS[r]) {
      usadosNaLista.add(r);
      return;
    }
    violacoes.push(`${r}:${i + 1}: ${t.slice(0, 140)}`);
  });
}
confere(
  'VARREDURA · nenhuma URL de API de aplicativo de terceiros fora da lista permitida',
  violacoes.length === 0,
  `\n      ${violacoes.join('\n      ')}`,
);

// ─────────────────────────── 2. Os quatro arquivos auditados ───────────────────────────
const AUDITADOS = [
  'src/lib/server/remoteProfile.ts',
  'src/lib/server/remotePostInteractions.ts',
  'src/lib/server/remoteConnections.ts',
  'src/lib/server/remoteMaterialize.ts',
];
for (const r of AUDITADOS) {
  const fonte = readFileSync(join(RAIZ, r), 'utf8');
  const codigo = fonte
    .split(/\r?\n/)
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n');
  confere(`AUDITADO · ${r} não monta URL de /api/ de terceiros`, !PADRAO.test(codigo), 'ainda monta URL de API de aplicativo');
  confere(
    `AUDITADO · ${r} não chama /favourited_by, /reblogged_by, /context nem accounts/lookup`,
    !/favourited_by|reblogged_by|\/context`|accounts\/lookup/.test(codigo),
    'ainda tem endpoint de REST',
  );
}
const perfil = readFileSync(join(RAIZ, 'src/lib/server/remoteProfile.ts'), 'utf8');
confere(
  'PERFIL · o "funciona mesmo com Authorized Fetch" acabou',
  !perfil.includes('funciona mesmo com Authorized Fetch'),
  'o contorno da escolha do servidor continua descrito (e provavelmente vivo)',
);
confere(
  "PERFIL · ator recusado (401/403) devolve 'origem-recusou' em vez de procurar outra porta",
  /leitura === 'recusada'\) return \{ ok: false, status: 403, error: 'origem-recusou' \}/.test(perfil),
  'não há resposta explícita para a recusa do ator',
);
confere(
  'PERFIL · outbox recusado vira aviso postsRestritos, não fallback',
  /classificarLeitura\(obRes\.status\) === 'recusada'\) profile\.postsRestritos = true/.test(perfil),
  'recusa do outbox não é sinalizada',
);
const sync = readFileSync(join(RAIZ, 'src/lib/server/federatedSync.ts'), 'utf8');
confere(
  'EXCEÇÃO · federatedSync só usa /api/v1 com o token OAuth da pessoa',
  /Authorization: `Bearer \$\{accessToken\}`/.test(sync),
  'a exceção permitida perdeu a autenticação que a justifica',
);

// ─────────────────────────── 3. A lista permitida não pode apodrecer ───────────────────────────
const sobrando = Object.keys(PERMITIDOS).filter((r) => !usadosNaLista.has(r));
confere(
  'LISTA · toda exceção permitida ainda é usada (exceção morta sai da lista)',
  sobrando.length === 0,
  `exceções sem uso: ${sobrando.join(', ')}`,
);

console.log('');
console.log(`${total} verificações.`);
if (falhas) {
  console.log(`${falhas} falha(s).`);
  process.exit(1);
}
console.log('Sem API de aplicativo: terceiros são lidos só pelo ActivityPub, e cada exceção tem motivo escrito.');
