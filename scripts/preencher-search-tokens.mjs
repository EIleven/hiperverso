#!/usr/bin/env node
/**
 * Preenche `searchTokens` nos posts que já existem, para a busca por palavra alcançar o histórico inteiro.
 *
 *   node scripts/preencher-search-tokens.mjs --producao                 inventário (SÓ LÊ, não grava nada)
 *   node scripts/preencher-search-tokens.mjs --producao --amostra=20    mostra o que seria gravado em 20 posts
 *   node scripts/preencher-search-tokens.mjs --producao --aplicar       grava (pede --aplicar de propósito)
 *   node scripts/preencher-search-tokens.mjs --producao --aplicar --limite=500
 *   node scripts/preencher-search-tokens.mjs --producao --reverter --aplicar   remove o campo
 *
 * Em produção o token de acesso vem de FIRESTORE_ACCESS_TOKEN (gcloud auth print-access-token) e NUNCA é impresso.
 * Segue o mesmo padrão dos outros scripts de migração deste repositório.
 *
 * ───────────────────────── POR QUE EXISTE ─────────────────────────
 * Medido em produção: a busca por palavra só enxergava a janela dos posts mais recentes, que nesta rede cobre
 * cerca de TRÊS HORAS. Procurar algo da semana passada não achava. Com `searchTokens` no documento, quem encontra
 * o post é o BANCO, pelo termo, em qualquer data.
 *
 * ───────────────────────── AS GARANTIAS ─────────────────────────
 * IDEMPOTENTE: recalcula os tokens de cada post e só grava se o que está lá for diferente. Rodar duas vezes não
 * grava nada na segunda. Interrompido no meio, é só rodar de novo — ele continua de onde parou, sem estado externo.
 *
 * NÃO DESTRUTIVO: grava UM campo novo (`searchTokens`) e não toca em nenhum outro. Nada no app depende dele além
 * da consulta nova da busca, que já funciona sem ele (cai na janela recente). Por isso a reversão é simplesmente
 * apagar o campo, e nenhum conteúdo se perde em nenhum dos dois sentidos.
 *
 * NÃO MEXE NA DATA: a gravação usa `updateMask` com o campo único, então `updatedAt` e `isEdited` ficam como estão.
 * Um post não vira "editado" por causa da migração.
 */

import { execFileSync } from 'node:child_process';

const { tokensDoDocumento } = await import('../src/lib/search/indiceDeTexto.ts');

const args = process.argv.slice(2);
const tem = (n) => args.includes(n);
const valor = (n, padrao) => {
  const a = args.find((x) => x.startsWith(`${n}=`));
  return a ? a.slice(n.length + 1) : padrao;
};

const PRODUCAO = tem('--producao');
const APLICAR = tem('--aplicar');
const REVERTER = tem('--reverter');
const LIMITE = Number(valor('--limite', '0')) || 0;
const AMOSTRA = Number(valor('--amostra', '0')) || 0;
/** Pausa entre lotes. A rede continua em uso enquanto isto roda; 250ms mantem a escrita longe do teto. */
const PAUSA_MS = Number(valor('--pausa', '250'));
const PROJETO = PRODUCAO ? 'echo-b5aw9' : 'demo-soberan';
const BANCO = PRODUCAO ? 'echo-db-124325' : '(default)';
const LOTE = 200;
/** Teto do `:commit` do Firestore e 500; 200 deixa folga e mantem o progresso visivel. */
const LOTE_DE_ESCRITA = 200;

/**
 * Preços usados na estimativa (Firestore, por 100 mil operações). NÃO são lidos de lugar nenhum: são uma conta de
 * ordem de grandeza para você decidir. Confira a tabela atual antes de tratar o número como orçamento.
 */
const PRECO_LEITURA_100K = 0.06;
const PRECO_ESCRITA_100K = 0.18;

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
    console.error(
      'Sem credencial. Rode:  $env:FIRESTORE_ACCESS_TOKEN = (gcloud auth print-access-token)  e tente de novo.',
    );
    process.exit(1);
  }
}

const TOKEN = tokenDeAcesso();

async function chamar(caminho, opcoes = {}) {
  const r = await fetch(`${base}${caminho}`, {
    ...opcoes,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
      ...(opcoes.headers || {}),
    },
  });
  if (!r.ok) {
    const corpo = await r.text();
    throw new Error(`${r.status} ${caminho.split('?')[0]} — ${corpo.slice(0, 300)}`);
  }
  return r.json();
}

/** Converte um documento da REST API para um objeto simples (só os campos que interessam). */
const valorSimples = (v) => {
  if (v == null) return null;
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('timestampValue' in v) return v.timestampValue;
  if ('nullValue' in v) return null;
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(valorSimples);
  if ('mapValue' in v) {
    const o = {};
    for (const [k, vv] of Object.entries(v.mapValue.fields || {})) o[k] = valorSimples(vv);
    return o;
  }
  return null;
};

const iguais = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => x === b[i]);

async function* percorrerPosts() {
  let pagina;
  let lidos = 0;
  for (;;) {
    const q = new URLSearchParams({ pageSize: String(LOTE) });
    if (pagina) q.set('pageToken', pagina);
    const r = await chamar(`/posts?${q}`);
    for (const doc of r.documents || []) {
      yield doc;
      lidos++;
      if (LIMITE && lidos >= LIMITE) return;
    }
    pagina = r.nextPageToken;
    if (!pagina) return;
  }
}

function tokensDoPost(campos) {
  const f = (n) => valorSimples(campos[n]);
  const autor = f('authorDetails') || {};
  return tokensDoDocumento({
    titulo: f('headline'),
    texto: f('text'),
    autorNome: autor.name,
    autorHandle: autor.username,
    hashtags: Array.isArray(f('hashtags')) ? f('hashtags') : [],
  });
}

/**
 * Grava um lote de uma vez (`:commit`). Uma chamada por lote em vez de uma por documento: com 37 mil posts a
 * diferenca e entre poucos minutos e meia hora de janela aberta. O custo em ESCRITAS e o mesmo -- o Firestore
 * cobra por documento, nao por chamada.
 *
 * `updateMask` com um campo so: nada mais do documento e tocado. `updatedAt` e `isEdited` ficam como estao, e
 * nenhum post vira "editado" por causa da migracao.
 */
async function gravarLote(itens) {
  if (itens.length === 0) return;
  const writes = itens.map(({ nome, tokens }) => ({
    update: {
      name: nome,
      fields: REVERTER
        ? {}
        : { searchTokens: { arrayValue: { values: tokens.map((t) => ({ stringValue: t })) } } },
    },
    updateMask: { fieldPaths: ['searchTokens'] },
    // So grava se o documento AINDA EXISTIR: post apagado entre a leitura e a escrita nao e ressuscitado.
    currentDocument: { exists: true },
  }));
  const raiz = base.slice(0, base.lastIndexOf('/documents'));
  const r = await fetch(`${raiz}/documents:commit`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ writes }),
  });
  if (!r.ok) throw new Error(`${r.status} commit — ${(await r.text()).slice(0, 300)}`);
}

// ───────────────────────── Execução ─────────────────────────

console.log(`Banco: ${PRODUCAO ? 'PRODUÇÃO' : 'emulador'} (${PROJETO}/${BANCO})`);
console.log(REVERTER ? 'Modo: REVERTER (apaga searchTokens)' : 'Modo: preencher searchTokens');
console.log(APLICAR ? 'GRAVANDO.' : 'Inventário: nada será gravado.\n');

let total = 0;
let jaCertos = 0;
let aGravar = 0;
let semConteudo = 0;
let gravados = 0;
let erros = 0;
const amostras = [];
/** O que ainda nao foi para o banco. Descarregado a cada LOTE_DE_ESCRITA. */
let pendentes = [];

async function descarregar() {
  if (pendentes.length === 0) return;
  const lote = pendentes;
  pendentes = [];
  try {
    await gravarLote(lote);
    gravados += lote.length;
    console.log(`  ${gravados} gravados...`);
    // A rede nao para enquanto isto roda. A pausa segura o ritmo bem abaixo do teto de escrita do Firestore,
    // para a migracao nao disputar banco com quem esta usando o app agora.
    if (PAUSA_MS > 0) await new Promise((r) => setTimeout(r, PAUSA_MS));
  } catch (e) {
    erros += lote.length;
    console.error('  falha no lote:', String(e).slice(0, 200));
  }
}

for await (const doc of percorrerPosts()) {
  total++;
  const campos = doc.fields || {};
  const atual = Array.isArray(valorSimples(campos.searchTokens)) ? valorSimples(campos.searchTokens) : null;

  if (REVERTER) {
    if (atual === null) {
      jaCertos++;
      continue;
    }
    aGravar++;
    if (APLICAR) {
      pendentes.push({ nome: doc.name, tokens: [] });
      if (pendentes.length >= LOTE_DE_ESCRITA) await descarregar();
    }
    continue;
  }

  const novos = tokensDoPost(campos);
  if (novos.length === 0) {
    semConteudo++;
    continue;
  }
  if (atual && iguais(atual, novos)) {
    jaCertos++;
    continue;
  }

  aGravar++;
  if (amostras.length < AMOSTRA) {
    amostras.push({ id: doc.name.split('/').pop(), tokens: novos.slice(0, 12) });
  }
  if (APLICAR) {
    pendentes.push({ nome: doc.name, tokens: novos });
    if (pendentes.length >= LOTE_DE_ESCRITA) await descarregar();
  }
}

if (APLICAR) await descarregar();

console.log('');
console.log('─'.repeat(64));
console.log(`posts examinados ............ ${total}`);
console.log(`já corretos (nada a fazer) .. ${jaCertos}`);
if (!REVERTER) console.log(`sem texto para indexar ...... ${semConteudo}`);
console.log(`${REVERTER ? 'a limpar' : 'a gravar'} .................... ${aGravar}`);
if (APLICAR) {
  console.log(`gravados .................... ${gravados}`);
  console.log(`erros ....................... ${erros}`);
}

if (!APLICAR) {
  const leituras = total;
  const escritas = aGravar;
  const custo = (leituras / 100_000) * PRECO_LEITURA_100K + (escritas / 100_000) * PRECO_ESCRITA_100K;
  console.log('');
  console.log(`leituras desta passada ...... ${leituras}`);
  console.log(`escritas se aplicar ......... ${escritas}`);
  console.log(
    `custo estimado .............. US$ ${custo.toFixed(4)}  ` +
      `(a US$ ${PRECO_LEITURA_100K}/100k leituras e US$ ${PRECO_ESCRITA_100K}/100k escritas — confira a tabela atual)`,
  );
  if (amostras.length > 0) {
    console.log('');
    console.log('Amostra do que seria gravado:');
    for (const a of amostras) console.log(`  ${a.id}: ${a.tokens.join(' ')}`);
  }
  console.log('');
  console.log('Nada foi gravado. Para gravar, repita com --aplicar.');
}
