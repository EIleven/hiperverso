#!/usr/bin/env node
/**
 * Reciprocidade com quem nos recusa (consentimentoDeDominio.ts, registroDeDominio.ts, inbox e worker):
 *   node e2e/reciprocidade-check.mjs        (ou: npm run e2e:reciprocidade)
 *
 * A pausa por 403 nasceu só para a ENTREGA. Um servidor que nos recusava continuava sendo lido por nós, e o conteúdo
 * dele entrava aqui por boost de terceiros. O acordo provado aqui:
 *   - durante a pausa, nada que BUSCAMOS ou que chega POR TERCEIROS daquele domínio entra;
 *   - o que ELE nos manda diretamente continua entrando (se ele escolheu mandar, a escolha é dele);
 *   - a pausa acaba sozinha no prazo;
 *   - o painel separa quem recusa de quem sumiu do DNS, e a purga mira UM domínio sem nunca cair na lista inteira.
 *
 * Sai com código 1 se algo falhar.
 */
import {
  FALHAS_PARA_MORTO,
  classeDaFalhaDeInfra,
  estadoDoDominio,
  podeLerDe,
} from '../src/lib/activitypub/consentimentoDeDominio.ts';
import { hostCasaComDominios, hostsDoRegistro, registroEhDosDominios } from '../src/lib/federation/registroDeDominio.ts';
import { processInbox } from '../src/lib/activitypub/inbox.ts';
import { runWorker } from '../src/lib/activitypub/worker.ts';
import { AS_PUBLIC } from '../src/lib/activitypub/gate.ts';
import { comSeguidores, contador, criarRemoto, ORIGEM, post, requisicao, T0, tarefa } from './helpers/ap-fediverse.mjs';

const { confere, encerra } = contador();
const CTX = 'https://www.w3.org/ns/activitystreams';
const DIA = 86_400_000;

// ─────────────────────────── 1. Decisão de leitura (pura) ───────────────────────────
const agora = T0;
confere('LEITURA · domínio comum pode ser lido', podeLerDe({ plataformaLigada: true, suspenso: false, saude: null, agora }).pode === true, 'travou o caminho comum');
confere(
  'LEITURA · em pausa de consentimento NÃO é lido (e diz até quando)',
  (() => { const d = podeLerDe({ plataformaLigada: true, suspenso: false, saude: { consecutiveRefusals: 3, refusedUntilMs: agora + DIA }, agora }); return d.pode === false && d.motivo === 'pausa-de-consentimento' && d.ate === agora + DIA; })(),
  'quem nos recusa continuaria sendo lido',
);
confere(
  'LEITURA · pausa vencida libera sozinha',
  podeLerDe({ plataformaLigada: true, suspenso: false, saude: { consecutiveRefusals: 3, refusedUntilMs: agora - 1 }, agora }).pode === true,
  'a pausa virou banimento permanente',
);
confere(
  'LEITURA · recusa abaixo do limite ainda não pausa',
  podeLerDe({ plataformaLigada: true, suspenso: false, saude: { consecutiveRefusals: 2, refusedUntilMs: 0 }, agora }).pode === true,
  'uma pessoa que bloqueou derrubou a instância',
);
confere(
  'LEITURA · suspensão vence a pausa (o motivo devolvido é o mais forte)',
  (() => { const d = podeLerDe({ plataformaLigada: true, suspenso: true, saude: { refusedUntilMs: agora + DIA }, agora }); return d.pode === false && d.motivo === 'suspenso'; })(),
  'motivo errado',
);
confere('LEITURA · plataforma desligada não lê nada', podeLerDe({ plataformaLigada: false, suspenso: false, saude: null, agora }).motivo === 'plataforma-desligada', 'leu com a federação desligada');

// ─────────────────────────── 2. Classe da falha e estado no painel (puro) ───────────────────────────
confere('FALHA · ENOTFOUND é DNS', classeDaFalhaDeInfra(null, 'ENOTFOUND') === 'dns', 'DNS não reconhecido');
confere('FALHA · EAI_AGAIN é DNS', classeDaFalhaDeInfra(null, 'EAI_AGAIN') === 'dns', 'EAI_AGAIN não reconhecido');
confere('FALHA · ECONNRESET é rede, não DNS', classeDaFalhaDeInfra(null, 'ECONNRESET') === 'rede', 'queda de conexão virou DNS');
confere('FALHA · 503 é servidor; 429 é limite', classeDaFalhaDeInfra(503) === 'servidor' && classeDaFalhaDeInfra(429) === 'limite', 'classe errada');

const recusando = estadoDoDominio({ consecutiveRefusals: 1, refusedUntilMs: 0 }, agora);
confere('PAINEL · uma recusa já aparece como "recusando", sem pausa', recusando.recusando && !recusando.emPausa && recusando.pausaAte === null, JSON.stringify(recusando));
const pausado = estadoDoDominio({ consecutiveRefusals: 3, refusedUntilMs: agora + DIA }, agora);
confere('PAINEL · em pausa mostra até quando', pausado.emPausa && pausado.pausaAte === agora + DIA, JSON.stringify(pausado));
const morto = estadoDoDominio({ consecutiveFailures: FALHAS_PARA_MORTO, lastFailureClass: 'dns' }, agora);
confere('PAINEL · falha repetida com DNS = morto e sem DNS', morto.morto && morto.semDns && !morto.recusando, JSON.stringify(morto));
const instavel = estadoDoDominio({ consecutiveFailures: FALHAS_PARA_MORTO - 1, lastFailureClass: 'dns' }, agora);
confere('PAINEL · abaixo do limite não é morto (servidor instável não é servidor fechado)', !instavel.morto && !instavel.semDns, JSON.stringify(instavel));

// ─────────────────────────── 3. Quem é de qual domínio (purga) ───────────────────────────
confere(
  'PURGA · lê host de domínio, handle, autor e URLs (inclusive a caixa de entrega)',
  (() => { const h = hostsDoRegistro({ remoteDomain: 'a.org', username: 'x@b.org', authorDetails: { username: 'y@c.org' }, targetInbox: 'https://d.org/inbox', apObjectId: 'https://e.org/n/1' }); return ['a.org', 'b.org', 'c.org', 'd.org', 'e.org'].every((d) => h.includes(d)); })(),
  JSON.stringify(hostsDoRegistro({ remoteDomain: 'a.org', username: 'x@b.org', targetInbox: 'https://d.org/inbox' })),
);
confere('PURGA · id do documento "usuario@host" conta', hostsDoRegistro({}, 'fulano@bolha.one').includes('bolha.one'), 'id ignorado');
confere('PURGA · subdomínio casa', hostCasaComDominios('media.bolha.one', ['bolha.one']), 'subdomínio escapou');
confere('PURGA · sufixo sem ponto NÃO casa (xbolha.one não é bolha.one)', !hostCasaComDominios('xbolha.one', ['bolha.one']), 'apagaria domínio de outra pessoa');
confere(
  'PURGA · entrega na fila para o domínio pedido é reconhecida (o corpo da atividade também sai)',
  registroEhDosDominios({ targetInbox: 'https://bolha.one/inbox', status: 'pending' }, ['bolha.one']),
  'a fila guardaria o que mandamos a quem pediu remoção',
);
confere('PURGA · lista vazia não casa nada', !registroEhDosDominios({ remoteDomain: 'bolha.one' }, []), 'lista vazia apagaria tudo');

// ─────────────────────────── 4. Inbox: boost de terceiro durante a pausa ───────────────────────────
{
  const ctx = await comSeguidores();
  const { teste, rede, store, deps } = ctx;
  let seq = 0;
  const idDe = (r, t) => `https://${r.host}/atividades/${t}-${++seq}`;
  const enviar = (remoto, atividade) => processInbox(deps, requisicao(remoto, { atividade, relogio: ctx.rel }));
  const booster = await criarRemoto(rede, 'mastodon.social', 'impulsionadora');
  const autora = await criarRemoto(rede, 'recusa.org', 'autora');
  teste.seedOutboundFollow('U_ANA', booster.id);
  const objeto = 'https://recusa.org/users/autora/statuses/1';
  rede.atores.set(objeto, () => ({ status: 200, json: { '@context': CTX, id: objeto, type: 'Note', attributedTo: autora.id, content: '<p>oi</p>', to: [AS_PUBLIC], cc: [], published: new Date(T0).toISOString() } }));
  const boost = () => ({ '@context': CTX, id: idDe(booster, 'announce'), type: 'Announce', actor: booster.id, object: objeto, to: [AS_PUBLIC], published: new Date(T0).toISOString() });

  await store.setDomainHealth({ domain: 'recusa.org', consecutiveFailures: 0, cooldownUntilMs: 0, lastFailureMs: deps.now(), consecutiveRefusals: 3, refusedUntilMs: deps.now() + DIA });
  const getsAntes = rede.gets.filter((u) => u.includes('recusa.org')).length;
  const r1 = await enviar(booster, boost());
  const getsDepois = rede.gets.filter((u) => u.includes('recusa.org')).length;
  confere('INBOX · boost de TERCEIRO de post de domínio em pausa é descartado', r1.reason === 'ignorada-dominio-pausado', JSON.stringify(r1));
  confere('INBOX · e o domínio em pausa nem é consultado (nenhum GET a ele)', getsDepois === getsAntes, `${getsDepois - getsAntes} GET(s) ao domínio que nos recusa`);
  confere('INBOX · nada foi ingerido', !teste.ingeridos.some((i) => i.apObjectId === objeto), JSON.stringify(teste.ingeridos));

  // Atividade DIRETA do domínio em pausa: ele escolheu mandar, então entra.
  teste.seedPost(post(ctx.relogio, { id: 'P1' }));
  teste.objects.set('P1', { postId: 'P1', uid: 'U_ANA', objectId: `${ORIGEM}/ap/notes/P1`, scope: 'public', state: 'federated', createdAtMs: T0, lastActivityAtMs: T0 });
  const curtida = await enviar(autora, { '@context': CTX, id: idDe(autora, 'like'), type: 'Like', actor: autora.id, object: `${ORIGEM}/ap/notes/P1` });
  confere('INBOX · o que o domínio em pausa nos manda DIRETAMENTE continua entrando', curtida.reason === 'aceita-like', JSON.stringify(curtida));

  // A pausa acaba sozinha.
  await store.setDomainHealth({ domain: 'recusa.org', consecutiveFailures: 0, cooldownUntilMs: 0, lastFailureMs: deps.now(), consecutiveRefusals: 3, refusedUntilMs: deps.now() - 1 });
  const r2 = await enviar(booster, boost());
  confere('INBOX · vencida a pausa, o boost volta a valer (sem banimento permanente)', r2.reason === 'aceita-announce-remoto', JSON.stringify(r2));
}

// ─────────────────────────── 5. Worker: DNS que não resolve vira classe gravada ───────────────────────────
{
  const ctx = await comSeguidores();
  const { deps, store, teste, rede, relogio } = ctx;
  relogio.t = deps.now() + 1000;
  deps.now = () => relogio.t;
  rede.respostaPost = () => ({ status: null, unsafe: false, errorDetail: 'ENOTFOUND' });
  teste.seedPost(post(relogio, { id: 'P9', createdAtMs: relogio.t }));
  await store.enqueueJob({ ...tarefa(relogio, 'create', 'P9'), id: 'j9' });
  await runWorker(deps, { budgetMs: 10_000, maxJobs: 25, deliveryBatch: 8 });
  const h = await store.getDomainHealth('pleroma.exemplo.com.br');
  confere('WORKER · falha de DNS fica gravada como classe "dns" (é o que o painel lista como morto)', h && h.lastFailureClass === 'dns' && h.consecutiveFailures >= 1, JSON.stringify(h));

  // E uma recusa depois disso não apaga a classe nem zera a contagem de recusas.
  rede.respostaPost = () => ({ status: 403, unsafe: false });
  relogio.t = (h?.cooldownUntilMs ?? relogio.t) + 1000;
  teste.seedPost(post(relogio, { id: 'P10', createdAtMs: relogio.t }));
  await store.enqueueJob({ ...tarefa(relogio, 'create', 'P10'), id: 'j10' });
  await runWorker(deps, { budgetMs: 10_000, maxJobs: 25, deliveryBatch: 8 });
  const h2 = await store.getDomainHealth('pleroma.exemplo.com.br');
  confere('WORKER · a recusa seguinte conta 1 recusa e preserva a classe da falha', h2 && h2.consecutiveRefusals >= 1 && h2.lastFailureClass === 'dns', JSON.stringify(h2));
}

encerra('Reciprocidade OK: quem nos recusa não é lido nem entra por terceiros, o que ele manda direto entra, a pausa vence sozinha e a purga mira só o domínio pedido.');
