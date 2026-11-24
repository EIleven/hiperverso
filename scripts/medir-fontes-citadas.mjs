#!/usr/bin/env node
/**
 * Mede o corpus inicial do indexador: quantas URLs externas e quantos domínios a rede JÁ cita.
 *
 *   node scripts/medir-fontes-citadas.mjs --producao
 *   node scripts/medir-fontes-citadas.mjs --producao --dominios=40   (quantos domínios listar)
 *
 * SÓ LÊ. Não grava nada, em lugar nenhum.
 *
 * Em produção o token vem de FIRESTORE_ACCESS_TOKEN (gcloud auth print-access-token) e NUNCA é impresso.
 *
 * ───────────────────────── Por que medir antes de construir ─────────────────────────
 * A pergunta da Fase 3 não é "vamos fazer um buscador web?" — é "de que tamanho é o corpus?". Esse número decide a
 * arquitetura sozinho: até algumas centenas de milhares de páginas, a técnica que já existe serve (candidatos no
 * banco + BM25 nosso). Acima disso seria preciso possuir o índice invertido, que é outro projeto e outro custo.
 *
 * E decide também o NOME. Uma aba chamada "Web" com campo aberto promete o mundo; se o corpus real for de 800
 * domínios brasileiros citados pela rede, a coisa honesta a se chamar é "Fontes" — e aí ela entrega o que promete.
 */

import { execFileSync } from 'node:child_process';

const args = process.argv.slice(2);
const tem = (n) => args.includes(n);
const valor = (n, padrao) => {
  const a = args.find((x) => x.startsWith(`${n}=`));
  return a ? a.slice(n.length + 1) : padrao;
};

const PRODUCAO = tem('--producao');
const QUANTOS_DOMINIOS = Number(valor('--dominios', '30')) || 30;
const LIMITE = Number(valor('--limite', '0')) || 0;
const PROJETO = PRODUCAO ? 'echo-b5aw9' : 'demo-soberan';
const BANCO = PRODUCAO ? 'echo-db-124325' : '(default)';
const PAGINA = 300;

/** Hosts que são nossos: citá-los não é "fonte externa". */
const NOSSOS = [
  'hiperverso.app', 'hiperverso.social', 'media.hiperverso.app',
  'exercitodolula.app', 'media.exercitodolula.app', 'www.exercitodolula.app',
];

/** Encurtadores e agregadores: a URL não diz qual é a fonte, então contam à parte. */
const ENCURTADORES = new Set(['bit.ly', 't.co', 'tinyurl.com', 'ow.ly', 'buff.ly', 'is.gd', 'cutt.ly', 'l.facebook.com', 'lnkd.in']);

/**
 * CDN e host de mídia: a URL aponta para um arquivo, não para uma página com texto.
 * Isto NÃO é detalhe de contagem. Na primeira medição, `ichef.bbci.co.uk` -- o CDN de imagens da BBC -- apareceu em
 * SEGUNDO lugar, com 706 "páginas". Eram imagens vindas embutidas em post federado. Medir sem separar isso daria um
 * corpus inflado, e o tamanho do corpus é justamente o número que decide a arquitetura do indexador.
 */
const MIDIA_NO_HOST = /(^|\.)(ichef\.bbci|static|cdn|img|image|images|media|assets|i)\.|\.(cloudfront|akamaized|cloudinary|imgix|fbcdn|twimg|licdn|ytimg|gstatic|googleusercontent|wp|squarespace-cdn)\./i;
const EXTENSAO_DE_ARQUIVO = /\.(jpe?g|png|gif|webp|avif|svg|bmp|ico|mp4|webm|mov|m4v|mp3|m4a|ogg|wav|pdf|zip|rar|gz|docx?|xlsx?|pptx?|csv|json|xml|rss|atom)$/i;

/** Redes sociais: são citação, não fonte a indexar (e quase todas recusam indexação). */
const REDES = new Set([
  'twitter.com', 'x.com', 'facebook.com', 'www.facebook.com', 'instagram.com', 'www.instagram.com',
  'tiktok.com', 'www.tiktok.com', 'youtube.com', 'www.youtube.com', 'youtu.be', 'bsky.app',
  'threads.net', 'www.threads.net', 'telegram.me', 't.me', 'whatsapp.com', 'chat.whatsapp.com',
]);

const base = PRODUCAO
  ? `https://firestore.googleapis.com/v1/projects/${PROJETO}/databases/${BANCO}/documents`
  : `http://127.0.0.1:8080/v1/projects/${PROJETO}/databases/(default)/documents`;

function tokenDeAcesso() {
  if (!PRODUCAO) return 'owner';
  const doAmbiente = process.env.FIRESTORE_ACCESS_TOKEN;
  if (doAmbiente) return doAmbiente.trim();
  try {
    return execFileSync('gcloud', ['auth', 'print-access-token'], { encoding: 'utf8' }).trim();
  } catch {
    console.error('Sem credencial. Rode:  $env:FIRESTORE_ACCESS_TOKEN = (gcloud auth print-access-token --account=<a conta com acesso>)');
    process.exit(1);
  }
}
const TOKEN = tokenDeAcesso();

async function chamar(caminho) {
  const r = await fetch(`${base}${caminho}`, { headers: { Authorization: `Bearer ${TOKEN}` } });
  if (!r.ok) throw new Error(`${r.status} — ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

const texto = (f, nome) => {
  const v = f?.[nome];
  return v && typeof v.stringValue === 'string' ? v.stringValue : '';
};

/** Acha URLs no texto. Deliberadamente simples: o que não for http(s) não interessa ao indexador. */
const URL_RE = /https?:\/\/[^\s<>"')\]}]+/gi;

/** Tira o que não identifica a página: fragmento, barra final e os parâmetros de rastreamento. */
function canonica(bruta) {
  try {
    const u = new URL(bruta);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    u.hash = '';
    u.username = '';
    u.password = '';
    for (const p of [...u.searchParams.keys()]) {
      if (/^(utm_|fbclid|gclid|mc_|ref|ref_src|igshid|si$|s$)/i.test(p)) u.searchParams.delete(p);
    }
    if (u.pathname.endsWith('/') && u.pathname.length > 1) u.pathname = u.pathname.slice(0, -1);
    return u;
  } catch {
    return null;
  }
}

const ehNosso = (host) => NOSSOS.includes(host) || host.endsWith('.hiperverso.app') || host.endsWith('.hiperverso.social');

async function* percorrer(colecao) {
  let pagina;
  let lidos = 0;
  for (;;) {
    const q = new URLSearchParams({ pageSize: String(PAGINA) });
    if (pagina) q.set('pageToken', pagina);
    const r = await chamar(`/${colecao}?${q}`);
    for (const doc of r.documents || []) {
      yield doc;
      lidos++;
      if (LIMITE && lidos >= LIMITE) return;
    }
    pagina = r.nextPageToken;
    if (!pagina) return;
  }
}

console.log(`Lendo ${PRODUCAO ? 'PRODUÇÃO' : 'emulador'} (${PROJETO}/${BANCO}). Nada será gravado.\n`);

let posts = 0;
let comSourceUrl = 0;
const urlsPorDominio = new Map(); // host -> Set de urls
const citacoesPorDominio = new Map(); // host -> quantas vezes apareceu
let urlsTotais = 0;
let descartadasNossas = 0;
let invalidas = 0;

for await (const doc of percorrer('posts')) {
  posts++;
  const f = doc.fields || {};
  const fonte = texto(f, 'sourceUrl');
  if (fonte) comSourceUrl++;
  const alvo = `${fonte} ${texto(f, 'text')} ${texto(f, 'headline')}`;

  for (const bruta of alvo.match(URL_RE) || []) {
    const u = canonica(bruta);
    if (!u) {
      invalidas++;
      continue;
    }
    const host = u.hostname.toLowerCase();
    if (ehNosso(host)) {
      descartadasNossas++;
      continue;
    }
    urlsTotais++;
    citacoesPorDominio.set(host, (citacoesPorDominio.get(host) ?? 0) + 1);
    if (!urlsPorDominio.has(host)) urlsPorDominio.set(host, new Set());
    urlsPorDominio.get(host).add(u.href);
  }
  if (posts % 5000 === 0) console.log(`  ${posts} posts lidos...`);
}

const todos = [...urlsPorDominio.entries()];
const urlsDistintas = todos.reduce((s, [, set]) => s + set.size, 0);
const ehMidia = (host, exemplo) => MIDIA_NO_HOST.test(host) || EXTENSAO_DE_ARQUIVO.test(new URL(exemplo).pathname);
const classifica = (host, exemplo) =>
  ENCURTADORES.has(host) ? 'encurtador'
  : REDES.has(host) ? 'rede social'
  : ehMidia(host, exemplo) ? 'mídia/CDN'
  : 'indexável';
const porClasse = {
  'indexável': { dominios: 0, urls: 0 },
  'mídia/CDN': { dominios: 0, urls: 0 },
  'rede social': { dominios: 0, urls: 0 },
  encurtador: { dominios: 0, urls: 0 },
};
for (const [host, set] of todos) {
  const c = classifica(host, [...set][0]);
  porClasse[c].dominios++;
  porClasse[c].urls += set.size;
}

console.log('');
console.log('─'.repeat(68));
console.log(`posts lidos .................... ${posts}`);
console.log(`posts com fonte declarada ...... ${comSourceUrl}`);
console.log(`citações de URL externa ........ ${urlsTotais}`);
console.log(`URLs externas DISTINTAS ........ ${urlsDistintas}`);
console.log(`domínios externos DISTINTOS .... ${todos.length}`);
console.log(`(links nossos ignorados: ${descartadasNossas}; endereços inválidos: ${invalidas})`);
console.log('');
console.log('O corpus de verdade, separado por tipo:');
for (const [classe, v] of Object.entries(porClasse)) {
  console.log(`  ${classe.padEnd(12)} ${String(v.dominios).padStart(5)} domínios   ${String(v.urls).padStart(6)} páginas`);
}

console.log('');
console.log(`Os ${QUANTOS_DOMINIOS} domínios indexáveis mais citados:`);
todos
  .filter(([h, set]) => classifica(h, [...set][0]) === 'indexável')
  .sort((a, b) => (citacoesPorDominio.get(b[0]) ?? 0) - (citacoesPorDominio.get(a[0]) ?? 0))
  .slice(0, QUANTOS_DOMINIOS)
  .forEach(([host, set], i) => {
    console.log(`  ${String(i + 1).padStart(3)}. ${host.padEnd(38)} ${String(citacoesPorDominio.get(host)).padStart(5)} citações  ${String(set.size).padStart(5)} páginas`);
  });

console.log('');
console.log('Nada foi gravado.');
