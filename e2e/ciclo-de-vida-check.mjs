#!/usr/bin/env node
/**
 * Ciclo de vida do conteúdo remoto: 410 / Tombstone / 404 (src/lib/activitypub/cicloDeVida.ts e resolveRemoteActor):
 *   node e2e/ciclo-de-vida-check.mjs        (ou: npm run e2e:ciclo-de-vida)
 *
 * Quem apaga um post nem sempre nos avisa. Quando NÓS buscamos o objeto e a origem responde que ele sumiu, a cópia local
 * tem de acompanhar -- senão um post removido pela pessoa continua legível aqui para sempre. O acordo:
 *   - 410 ou Tombstone: a origem afirma que foi apagado -> apaga já;
 *   - 404: oculta já (o mais provável é exclusão) e só apaga com um segundo 404 a 6 h ou mais; se voltar, restaura;
 *   - o que um `Delete` apagou nunca volta por aqui; 401/403/limite/rede não mudam nada.
 *
 * Sai com código 1 se algo falhar.
 */
import { CONFIRMACAO_DE_404_MS, decidirCiclo, decidirCicloDoAtor } from '../src/lib/activitypub/cicloDeVida.ts';
import { resolveRemoteActor } from '../src/lib/activitypub/remote.ts';
import { contador, criarRemoto, montar, T0 } from './helpers/ap-fediverse.mjs';

const { confere, encerra } = contador();
const agora = T0;
const HORA = 3_600_000;

const vivo = { isDeleted: false };
const ocultoAgora = { isDeleted: true, remoteGoneAtMs: agora - HORA };
const ocultoHaMuito = { isDeleted: true, remoteGoneAtMs: agora - CONFIRMACAO_DE_404_MS };
const tumuloDeDelete = { isDeleted: true };

// ─────────────────────────── 1. 410 / Tombstone ───────────────────────────
confere('410 · cópia no ar é apagada na hora', decidirCiclo('apagado', vivo, agora) === 'apagar', 'cópia apagada na origem continuaria no ar');
confere('410 · cópia que ocultamos por 404 também é apagada (o 410 confirma)', decidirCiclo('apagado', ocultoAgora, agora) === 'apagar', 'não confirmou');
confere('410 · túmulo de Delete fica como está (nada a refazer)', decidirCiclo('apagado', tumuloDeDelete, agora) === 'manter', 'regravou túmulo');

// ─────────────────────────── 2. 404 em duas etapas ───────────────────────────
confere('404 · primeira vez: OCULTA na hora (não apaga)', decidirCiclo('sumiu', vivo, agora) === 'ocultar', 'ou deixou no ar, ou apagou sem confirmar');
confere('404 · segundo 404 antes de 6 h: continua só oculto', decidirCiclo('sumiu', ocultoAgora, agora) === 'manter', 'apagou sem a distância mínima');
confere('404 · segundo 404 a 6 h ou mais: APAGA (confirmado)', decidirCiclo('sumiu', ocultoHaMuito, agora) === 'apagar', 'o 404 em duas etapas nunca fecha');
confere('404 · túmulo de Delete fica como está', decidirCiclo('sumiu', tumuloDeDelete, agora) === 'manter', 'mexeu no que o Delete apagou');

// ─────────────────────────── 3. Voltou a responder ───────────────────────────
confere('200 · o que ocultamos por 404 volta (era passageiro)', decidirCiclo('ok', ocultoAgora, agora) === 'restaurar', 'um 404 passageiro sumiria com o post para sempre');
confere(
  '200 · o que um Delete apagou NUNCA volta por aqui (quem apagou, apagou)',
  decidirCiclo('ok', tumuloDeDelete, agora) === 'manter',
  'ressuscitaria um post que a pessoa apagou',
);
confere('200 · cópia no ar segue no ar', decidirCiclo('ok', vivo, agora) === 'manter', 'mexeu em cópia viva');

// ─────────────────────────── 4. Respostas que não dizem nada sobre o conteúdo ───────────────────────────
for (const leitura of ['recusada', 'limitada', 'falha']) {
  confere(
    `${leitura.toUpperCase()} · não oculta, não apaga, não restaura`,
    [vivo, ocultoAgora, ocultoHaMuito, tumuloDeDelete].every((r) => decidirCiclo(leitura, r, agora) === 'manter'),
    `${leitura} mudou o estado da cópia`,
  );
}
confere('SEM CÓPIA · nada a fazer', decidirCiclo('apagado', null, agora) === 'manter', 'agiu sobre o vazio');

// ─────────────────────────── 5. Ator ───────────────────────────
confere('ATOR · 410 apaga o conteúdo dele', decidirCicloDoAtor('apagado', null, agora) === 'apagar-conteudo', 'conta apagada continuaria com posts no ar');
confere('ATOR · primeiro 404 só marca como removido (não derruba todos os posts)', decidirCicloDoAtor('sumiu', null, agora) === 'marcar-removido', 'derrubou tudo por um 404');
confere('ATOR · 404 confirmado a 6 h ou mais apaga o conteúdo', decidirCicloDoAtor('sumiu', agora - CONFIRMACAO_DE_404_MS, agora) === 'apagar-conteudo', 'não confirmou');
confere('ATOR · 404 antes de 6 h segue só marcado', decidirCicloDoAtor('sumiu', agora - HORA, agora) === 'manter', 'confirmou cedo demais');
confere('ATOR · 403 não muda nada', decidirCicloDoAtor('recusada', agora - CONFIRMACAO_DE_404_MS, agora) === 'manter', 'recusa virou remoção');

// ─────────────────────────── 6. resolveRemoteActor de verdade (armazenamento em memória) ───────────────────────────
{
  const ctx = montar();
  const { store, teste, rede, relogio } = ctx;
  const deps = { store, fetcher: rede.fetcher, now: () => relogio.t, ownHost: 'hiperverso.social' };
  const fulano = await criarRemoto(rede, 'apagou.org', 'fulano');
  // Primeiro resolve normalmente (vai para o cache) e guarda dois posts dele.
  const ok = await resolveRemoteActor(deps, fulano.id);
  confere('RESOLVE · ator vivo é resolvido e guardado', ok.ok === true, JSON.stringify(ok));
  teste.seedRemotePost({ apObjectId: 'https://apagou.org/users/fulano/statuses/1', actorId: fulano.id, text: 'um' });
  teste.seedRemotePost({ apObjectId: 'https://apagou.org/users/fulano/statuses/2', actorId: fulano.id, text: 'dois' });
  const postsDele = () => [...teste.remotePosts.values()].filter((p) => p.actorId === fulano.id);

  // 404 pela primeira vez (cache vencido): marca removido, posts continuam.
  rede.atores.set(fulano.id, () => ({ status: 404, json: null }));
  relogio.t += 2 * 24 * HORA;
  const r1 = await resolveRemoteActor(deps, fulano.id);
  const a1 = await store.getRemoteActor(fulano.id);
  confere('RESOLVE · primeiro 404: ator marcado como removido, com a hora em que sumiu', r1.ok === false && a1?.state === 'gone' && a1?.goneSinceMs === relogio.t, JSON.stringify(a1));
  confere('RESOLVE · primeiro 404: os posts dele NÃO caem', postsDele().every((p) => !p.isDeleted), JSON.stringify(postsDele()));

  // Segundo 404, depois de 7 h (passado o cache de "removido" de 1 h): confirmado, posts viram túmulo.
  relogio.t += 7 * HORA;
  await resolveRemoteActor(deps, fulano.id);
  const a2 = await store.getRemoteActor(fulano.id);
  confere('RESOLVE · segundo 404 a 7 h: posts dele viram túmulo', postsDele().length === 2 && postsDele().every((p) => p.isDeleted), JSON.stringify(postsDele()));
  confere('RESOLVE · e a hora em que sumiu é a do PRIMEIRO 404 (não recomeça a contagem)', a2?.goneSinceMs === a1?.goneSinceMs, JSON.stringify([a1?.goneSinceMs, a2?.goneSinceMs]));

  // 410 apaga na hora, sem confirmação.
  const ciclana = await criarRemoto(rede, 'fechou.org', 'ciclana');
  await resolveRemoteActor(deps, ciclana.id);
  teste.seedRemotePost({ apObjectId: 'https://fechou.org/users/ciclana/statuses/1', actorId: ciclana.id, text: 'oi' });
  rede.atores.set(ciclana.id, () => ({ status: 410, json: null }));
  relogio.t += 2 * 24 * HORA;
  await resolveRemoteActor(deps, ciclana.id);
  const dela = [...teste.remotePosts.values()].filter((p) => p.actorId === ciclana.id);
  confere('RESOLVE · 410 de ator: o conteúdo vira túmulo na hora', dela.length === 1 && dela[0].isDeleted === true, JSON.stringify(dela));
}

// ─────────────────────────── 7. Guardas do lado do servidor (estáticas) ───────────────────────────
{
  const { readFileSync } = await import('node:fs');
  const fonte = readFileSync(new URL('../src/lib/server/cicloDeVidaRemoto.ts', import.meta.url), 'utf8');
  confere(
    'SERVIDOR · documento sem isRemoteFediverse NUNCA é tocado (conteúdo local fora do alcance de uma URL)',
    fonte.includes("if (d.isRemoteFediverse !== true) return 'manter';"),
    'a guarda de conteúdo local sumiu',
  );
  confere(
    'SERVIDOR · ocultar mantém o texto (restaurável); apagar usa o mesmo túmulo do Delete',
    fonte.includes("ref.update({ isDeleted: true, remoteGoneAtMs: agora })") && fonte.includes('...TUMULO_DE_POST_REMOTO'),
    'ocultar e apagar se confundiram',
  );
  confere(
    'SERVIDOR · a reconferência das pendentes é limitada (uma rodada por minuto) e respeita suspensão/pausa',
    fonte.includes('agora - ultimaConfirmacaoMs < 60_000') && fonte.includes('podeLerDoDominio(dominio)'),
    'a confirmação virou varredura',
  );
}

encerra('Ciclo de vida OK: 410 apaga, 404 oculta e só apaga confirmado, o que volta é restaurado e o que um Delete apagou não ressuscita.');
