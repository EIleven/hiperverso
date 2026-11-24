#!/usr/bin/env node
/**
 * Leitura do que o Fediverso PUBLICA por ActivityPub (src/lib/activitypub/colecoes.ts):
 *   node e2e/ap-colecoes-check.mjs        (ou: npm run e2e:ap-colecoes)
 *
 * Duas regras sustentam a troca da REST do Mastodon pelo protocolo, e são as que este arquivo prova:
 *   1. RECUSA É RESPOSTA. 401/403 viram "recusada" e ponto: não existe classificação que convide a tentar por outra porta.
 *   2. AUSENTE NÃO É ZERO. Servidor que não publica a contagem não pode zerar o número que já sabíamos.
 *
 * Sai com código 1 se algo falhar.
 */
import {
  classificarLeitura,
  contagensDoNote,
  idDe,
  itensDe,
  listaOculta,
  primeiraPagina,
  totalDe,
} from '../src/lib/activitypub/colecoes.ts';

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
const igual = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ─────────────────────────── 1. Classificação da resposta ───────────────────────────
confere('LEITURA · 200 com objeto = ok', classificarLeitura(200, { type: 'Note' }) === 'ok', 'objeto válido não foi aceito');
confere('LEITURA · 401 = recusada (sem fallback)', classificarLeitura(401) === 'recusada', 'assinatura recusada virou outra coisa');
confere('LEITURA · 403 = recusada (sem fallback)', classificarLeitura(403) === 'recusada', 'recusa virou outra coisa');
confere('LEITURA · 410 = apagado (autoritativo)', classificarLeitura(410) === 'apagado', '410 não foi tratado como apagado');
confere(
  'LEITURA · 200 com Tombstone = apagado (servidor que responde 200 com lápide)',
  classificarLeitura(200, { type: 'Tombstone', id: 'https://x.org/n/1' }) === 'apagado',
  'lápide passaria como objeto vivo',
);
confere('LEITURA · 404 = sumiu (não é o mesmo que apagado)', classificarLeitura(404) === 'sumiu', '404 confundido com 410');
confere('LEITURA · 429 e 503 = limitada', classificarLeitura(429) === 'limitada' && classificarLeitura(503) === 'limitada', 'pedido de espera ignorado');
confere('LEITURA · 500 = falha', classificarLeitura(500) === 'falha', '5xx virou conteúdo');
confere('LEITURA · sem status (rede) = falha', classificarLeitura(null) === 'falha' && classificarLeitura(undefined) === 'falha', 'rede caída virou conteúdo');
confere('LEITURA · 200 sem corpo de objeto = falha', classificarLeitura(200, null) === 'falha' && classificarLeitura(200, []) === 'falha', 'corpo inválido virou ok');

// ─────────────────────────── 2. Contagens: ausente não é zero ───────────────────────────
confere('TOTAL · coleção embutida com totalItems', totalDe({ type: 'Collection', totalItems: 12 }) === 12, 'não leu o total');
confere('TOTAL · zero informado é zero', totalDe({ totalItems: 0 }) === 0, 'zero informado sumiu');
confere('TOTAL · referência (só URL) = não informado', totalDe('https://x.org/n/1/likes') === null, 'URL virou número');
confere('TOTAL · campo ausente = não informado', totalDe({ type: 'Collection' }) === null, 'ausente virou zero');
confere('TOTAL · negativo ou NaN = não informado', totalDe({ totalItems: -3 }) === null && totalDe({ totalItems: NaN }) === null, 'lixo virou número');
confere('TOTAL · fracionado é arredondado para baixo', totalDe({ totalItems: 4.9 }) === 4, 'aceitou fração');

confere(
  'NOTE · lê likes/shares/replies nas chaves que applyRemoteCounts entende',
  igual(contagensDoNote({ likes: { totalItems: 5 }, shares: { totalItems: 2 }, replies: { totalItems: 7 } }), { likes: 5, reposts: 2, commentsCount: 7 }),
  JSON.stringify(contagensDoNote({ likes: { totalItems: 5 }, shares: { totalItems: 2 }, replies: { totalItems: 7 } })),
);
confere(
  'NOTE · contagem não publicada fica FORA (não vira 0 e não apaga o que havia)',
  igual(contagensDoNote({ replies: { totalItems: 3 }, likes: 'https://x.org/n/1/likes' }), { commentsCount: 3 }),
  JSON.stringify(contagensDoNote({ replies: { totalItems: 3 }, likes: 'https://x.org/n/1/likes' })),
);
confere('NOTE · objeto inválido = nada', igual(contagensDoNote(null), {}) && igual(contagensDoNote([]), {}), 'objeto inválido gerou contagem');

// ─────────────────────────── 3. Itens e páginas ───────────────────────────
confere('ITENS · orderedItems', itensDe({ orderedItems: [1, 2] }).length === 2, 'não leu orderedItems');
confere('ITENS · items', itensDe({ items: ['a'] }).length === 1, 'não leu items');
confere('ITENS · forma estranha = vazio', itensDe({ items: 'x' }).length === 0 && itensDe(null).length === 0, 'aceitou forma inválida');
confere('ID · URL https', idDe('https://x.org/u/1') === 'https://x.org/u/1', 'não leu a URL');
confere('ID · objeto embutido', idDe({ id: 'https://x.org/u/2', type: 'Note' }) === 'https://x.org/u/2', 'não leu o id embutido');
confere('ID · http puro ou lixo = nulo', idDe('http://x.org/u/1') === null && idDe({ id: 3 }) === null && idDe(null) === null, 'aceitou id inseguro');
confere('PÁGINA · first como URL', igual(primeiraPagina({ first: 'https://x.org/c?page=1' }), { url: 'https://x.org/c?page=1' }), 'não leu first');
confere('PÁGINA · first embutida', 'embutida' in (primeiraPagina({ first: { items: [] } }) || {}), 'não reconheceu página embutida');
confere('PÁGINA · first http puro é recusado', primeiraPagina({ first: 'http://x.org/c' }) === null, 'seguiria página insegura');

// ─────────────────────────── 4. Lista oculta pela pessoa ───────────────────────────
confere(
  'OCULTA · só totalItems, sem itens nem página = a pessoa escondeu a rede (respeitar)',
  listaOculta({ type: 'OrderedCollection', totalItems: 120 }) === true,
  'lista oculta não foi reconhecida',
);
confere('OCULTA · com página não é oculta', listaOculta({ totalItems: 3, first: 'https://x.org/c?page=1' }) === false, 'confundiu lista paginada com oculta');
confere('OCULTA · sem total não é afirmação de nada', listaOculta({ type: 'OrderedCollection' }) === false, 'inventou ocultação');

console.log('');
console.log(`${total} verificações.`);
if (falhas) {
  console.log(`${falhas} falha(s).`);
  process.exit(1);
}
console.log('Coleções OK: recusa é resposta final, ausente nunca vira zero e lista oculta é respeitada.');
