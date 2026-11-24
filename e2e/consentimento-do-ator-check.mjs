#!/usr/bin/env node
/**
 * Consentimento do ator remoto: `discoverable` e `indexable` (src/lib/activitypub/consentimentoDoAtor.ts e onde vale):
 *   node e2e/consentimento-do-ator-check.mjs        (ou: npm run e2e:consentimento-do-ator)
 *
 * Nós emitíamos as duas flags no nosso ator e nunca líamos as dos outros. O acordo provado aqui:
 *   - só `true` é sim (ausente, `false`, "true" em texto: não consentiu);
 *   - pessoa remota na busca de pessoas, no explorar e nas sugestões: só com `discoverable` (endereço exato continua valendo);
 *   - texto de post remoto achado por palavra: só com `indexable`; busca EXPLÍCITA por #tag continua achando;
 *   - os posts (outbox) de um perfil remoto só são buscados se alguém daqui já o segue;
 *   - conteúdo local não passa por nenhuma dessas regras.
 *
 * Sai com código 1 se algo falhar.
 */
import { readFileSync } from 'node:fs';
import {
  enderecoNormalizado,
  lerConsentimentoDoAtor,
  podeCarregarOutbox,
  remotoPodeAparecerNaBusca,
  remotoPodeAparecerNaDescoberta,
} from '../src/lib/activitypub/consentimentoDoAtor.ts';
import { parseRemoteActor, resolveRemoteActor } from '../src/lib/activitypub/remote.ts';
import { contador, criarRemoto, montar, T0 } from './helpers/ap-fediverse.mjs';

const { confere, encerra } = contador();
const ler = (r) => readFileSync(new URL(`../${r}`, import.meta.url), 'utf8');

// ─────────────────────────── 1. Leitura estrita ───────────────────────────
const igual = (a, b) => JSON.stringify(a) === JSON.stringify(b);
confere('FLAGS · true/true', igual(lerConsentimentoDoAtor({ discoverable: true, indexable: true }), { discoverable: true, indexable: true }), 'não leu o sim');
confere('FLAGS · ausente = não consentiu', igual(lerConsentimentoDoAtor({}), { discoverable: false, indexable: false }), 'ausente virou sim');
confere('FLAGS · false = não', igual(lerConsentimentoDoAtor({ discoverable: false, indexable: false }), { discoverable: false, indexable: false }), 'false virou sim');
confere('FLAGS · "true" em texto ou 1 não é sim', igual(lerConsentimentoDoAtor({ discoverable: 'true', indexable: 1 }), { discoverable: false, indexable: false }), 'aceitou sim presumido');
confere('FLAGS · ator inválido = não', igual(lerConsentimentoDoAtor(null), { discoverable: false, indexable: false }), 'lixo virou sim');

// ─────────────────────────── 2. Busca ───────────────────────────
const busca = (o) => remotoPodeAparecerNaBusca(o);
confere('BUSCA · conteúdo LOCAL não passa por esta regra', busca({ tipo: 'post', remoto: false }) && busca({ tipo: 'pessoa', remoto: false }), 'regra vazou para o local');
confere('BUSCA · pessoa remota sem discoverable NÃO aparece', !busca({ tipo: 'pessoa', remoto: true, descobrivel: false }), 'quem não quis ser descoberto apareceu');
confere('BUSCA · pessoa remota com discoverable aparece', busca({ tipo: 'pessoa', remoto: true, descobrivel: true }), 'travou quem consentiu');
confere('BUSCA · pelo ENDEREÇO exato aparece mesmo sem discoverable (é o WebFinger)', busca({ tipo: 'pessoa', remoto: true, descobrivel: false, enderecoExato: true }), 'quebrou achar alguém pelo endereço');
confere('BUSCA · post remoto sem indexable NÃO é achado por palavra', !busca({ tipo: 'post', remoto: true, indexavel: false }), 'texto de quem não consentiu foi indexado');
confere('BUSCA · post remoto com indexable é achado', busca({ tipo: 'post', remoto: true, indexavel: true }), 'travou quem consentiu');
confere('BUSCA · busca EXPLÍCITA por #tag acha post remoto mesmo sem indexable', busca({ tipo: 'post', remoto: true, indexavel: false, casouPorTagExplicita: true }), 'hashtag deixou de ser achável');
confere('BUSCA · comentário remoto segue a mesma regra do post', !busca({ tipo: 'comentario', remoto: true }) && busca({ tipo: 'comentario', remoto: true, indexavel: true }), 'comentário escapou da regra');
confere('BUSCA · artigo remoto também', !busca({ tipo: 'artigo', remoto: true }), 'artigo escapou da regra');

// ─────────────────────────── 3. Descoberta e outbox ───────────────────────────
confere('DESCOBERTA · remoto sem discoverable fica fora', !remotoPodeAparecerNaDescoberta({ remoto: true }), 'apareceu no explorar sem consentir');
confere('DESCOBERTA · remoto com discoverable entra', remotoPodeAparecerNaDescoberta({ remoto: true, descobrivel: true }), 'travou quem consentiu');
confere('DESCOBERTA · local não passa por esta regra', remotoPodeAparecerNaDescoberta({ remoto: false }), 'regra vazou para o local');
confere('OUTBOX · ninguém daqui segue = não busca os posts', podeCarregarOutbox({ algumLocalSegue: false }) === false, 'baixaria o histórico de quem nunca pediu');
confere('OUTBOX · alguém daqui segue = pode buscar', podeCarregarOutbox({ algumLocalSegue: true }) === true, 'quem segue não veria os posts');
confere('ENDEREÇO · normaliza @ e maiúsculas', enderecoNormalizado('@Fulana@Masto.BR') === 'fulana@masto.br', enderecoNormalizado('@Fulana@Masto.BR'));

// ─────────────────────────── 4. As flags chegam ao registro do ator (código real) ───────────────────────────
{
  const ctx = montar();
  const { store, rede, relogio } = ctx;
  const quer = await criarRemoto(rede, 'consente.org', 'quer');
  const original = rede.atores.get(quer.id);
  rede.atores.set(quer.id, () => {
    const r = original();
    return { ...r, json: { ...r.json, discoverable: true, indexable: true } };
  });
  const naoQuer = await criarRemoto(rede, 'consente.org', 'naoquer');

  const p1 = parseRemoteActor({ ...rede.atores.get(quer.id)().json }, quer.id, T0);
  confere('ATOR · parseRemoteActor lê discoverable/indexable verdadeiros', p1.ok && p1.actor.discoverable === true && p1.actor.indexable === true, JSON.stringify(p1.ok ? p1.actor : p1));
  const p2 = parseRemoteActor({ ...rede.atores.get(naoQuer.id)().json }, naoQuer.id, T0);
  confere('ATOR · ator sem as flags fica com as duas em false', p2.ok && p2.actor.discoverable === false && p2.actor.indexable === false, JSON.stringify(p2.ok ? p2.actor : p2));

  const deps = { store, fetcher: rede.fetcher, now: () => relogio.t, ownHost: 'hiperverso.social' };
  await resolveRemoteActor(deps, quer.id);
  const guardado = await store.getRemoteActor(quer.id);
  confere('ATOR · resolveRemoteActor guarda o consentimento no cache do ator', guardado?.discoverable === true && guardado?.indexable === true, JSON.stringify(guardado));
}

// ─────────────────────────── 5. Onde a regra vale (guardas estáticas) ───────────────────────────
const buscaFonte = ler('src/app/api/search/route.ts');
confere(
  'APLICAÇÃO · a busca filtra pelo consentimento ANTES de ranquear',
  buscaFonte.indexOf('remotoPodeAparecerNaBusca({') > 0 && buscaFonte.indexOf('remotoPodeAparecerNaBusca({') < buscaFonte.indexOf('ordenarPorRelevancia(filtrados'),
  'o consentimento não é filtro, ou vem depois do ranking (vira só "empurrar para baixo")',
);
confere('APLICAÇÃO · a busca lê remoteIndexable do perfil do autor', buscaFonte.includes("remoteIndexable === true"), 'consentimento do autor não é lido');
confere('APLICAÇÃO · palavra solta é texto livre; só #tag explícita dispensa indexable', buscaFonte.includes("bruto.trim().startsWith('#')"), 'qualquer palavra igual a uma tag furaria o indexable');
confere('APLICAÇÃO · explorar filtra post remoto sem discoverable', ler('src/lib/services/postReadService.ts').includes("options.feedContext === 'explore' && !remotoNaDescoberta("), 'explorar mostra quem não consentiu');
confere('APLICAÇÃO · sugestões filtram perfil remoto sem discoverable', ler('src/lib/services/userService.ts').includes('.filter(sugestaoPermitida)'), 'sugestões mostram quem não consentiu');
confere('APLICAÇÃO · rota do perfil só carrega posts se alguém daqui segue', ler('src/app/api/ap/remote-profile/route.ts').includes('podeCarregarOutbox({ algumLocalSegue'), 'o outbox é baixado a cada clique');
confere('APLICAÇÃO · sem seguidor, o perfil marca postsSoComSeguidor (a tela explica)', ler('src/lib/server/remoteProfile.ts').includes('profile.postsSoComSeguidor = true'), 'a tela ficaria vazia sem explicação');
confere(
  'REGRESSÃO · abrir perfil remoto não zera contagens já guardadas',
  ler('src/lib/server/remoteMaterialize.ts').includes("typeof profile.followersCount === 'number' ? { followersCount: profile.followersCount }"),
  'followersCount ?? 0 voltou: cada abertura apagaria o número que sabíamos',
);
confere(
  'REGRESSÃO · listar conexões não zera contagens já guardadas',
  ler('src/lib/server/remoteConnections.ts').includes("typeof acc.followersCount === 'number' ? { followersCount: acc.followersCount }"),
  'a listagem grava 0 por cima dos números de cada conta',
);

encerra('Consentimento do ator OK: só true é sim, descoberta e texto livre respeitam a pessoa, #tag e endereço exato continuam, e o outbox só vem para quem é seguido.');
