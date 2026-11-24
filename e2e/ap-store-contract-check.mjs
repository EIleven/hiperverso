#!/usr/bin/env node
/**
 * Teste de CONTRATO do FederationStore: a MESMA bateria roda contra o armazenamento em memória e contra o adaptador do
 * Firestore (no emulador). Existe por um motivo: os serviços da federação são provados contra o armazenamento em
 * memória; se o adaptador do Firestore se comportasse de outro jeito, aqueles testes provariam algo que a produção não
 * faz.
 *
 *   npm run emulators            (noutro terminal; basta o Firestore)
 *   node e2e/ap-store-contract-check.mjs
 *
 * O que o emulador NÃO valida, e portanto este teste não prova: ÍNDICES. A única consulta que exige índice composto é
 * `ap_deliveries` (uid + createdAtMs) e está declarada em firestore.indexes.json; conferi-la em produção é um portão
 * da publicação.
 *
 * Sai com código 1 se algo falhar.
 */
import { createMemoryStore } from './helpers/ap-memory-store.mjs';
import { createFirestoreStore } from '../src/lib/activitypub/firestoreStore.ts';
import { buildActor } from '../src/lib/activitypub/activity.ts';

const FS_HOST = process.env.FIRESTORE_EMULATOR_HOST ?? '127.0.0.1:8080';
const PROJETO = 'demo-soberan';
// Banco NOMEADO e próprio do teste. O banco da aplicação (echo-db-124325) tem o gatilho da Function de federação: ao
// semear posts aqui, o emulador enfileiraria tarefas de verdade e embaralharia as contagens da fila.
const BANCO = 'contrato-federacao';

let falhas = 0;
let total = 0;
const confere = (nome, condicao, motivo, detalhe) => {
  total++;
  if (condicao) console.log(`OK    ${nome}${detalhe ? ` — ${detalhe}` : ''}`);
  else { falhas++; console.log(`FALHA ${nome} — ${motivo}`); }
};
// Comparação CANÔNICA (chaves ordenadas): o Firestore devolve os campos de um mapa em ordem alfabética, e a ordem em
// que um objeto foi escrito não é parte do contrato.
const canon = (v) => (Array.isArray(v) ? v.map(canon) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])) : v);
const igual = (a, b) => JSON.stringify(canon(a)) === JSON.stringify(canon(b));
const ordenado = (xs) => [...xs].sort();

const T0 = Date.UTC(2026, 10, 12, 15, 0, 0);

// ───────────── fábricas ─────────────

function fabricaMemoria() {
  const relogio = { t: T0 };
  const { store, teste } = createMemoryStore({ now: () => relogio.t });
  return {
    store, relogio, nome: 'memória',
    setPlatform(p) { Object.assign(teste.platform, p); },
    setPolicy(p) { teste.setPolicy(p); },
    seedProfile(p) { teste.seedProfile(p); },
    seedPost(p) { teste.seedPost(p); },
    async inspecionarExpira() { return null; },
    async limpar() {},
  };
}

async function fabricaFirestore() {
  process.env.FIRESTORE_EMULATOR_HOST = FS_HOST;
  const { initializeApp } = await import('firebase-admin/app');
  const { getFirestore, FieldValue, Timestamp, FieldPath } = await import('firebase-admin/firestore');
  const app = initializeApp({ projectId: PROJETO }, `contrato-${Date.now()}`);
  const db = getFirestore(app, BANCO);
  const relogio = { t: T0 };
  const store = createFirestoreStore({ db, FieldValue, Timestamp, FieldPath, now: () => relogio.t });
  return {
    store, relogio, nome: 'firestore (emulador)', db,
    async setPlatform(p) {
      await db.collection('config').doc('federation').set({ enabled: true, killSwitch: false, mode: 'open', ...p });
      store.invalidateCaches();
    },
    async setPolicy(p) {
      const antigos = await db.collection('ap_instance_policy').get();
      await Promise.all(antigos.docs.map((d) => d.ref.delete()));
      for (const [dominio, r] of Object.entries(p.rules ?? {})) await db.collection('ap_instance_policy').doc(dominio).set({ action: r.action });
      await db.collection('config').doc('federation').set({ enabled: true, killSwitch: false, mode: p.mode ?? 'open' }, { merge: true });
      store.invalidateCaches();
    },
    // O app grava perfis e posts com Timestamp e estes nomes de campo: semeia no formato REAL.
    async seedProfile(p) {
      await db.collection('users').doc(p.uid).set({
        name: p.name, username: p.username, bio: p.bio, avatarUrl: p.avatarUrl, coverImageUrl: p.coverUrl, website: p.website,
        location: p.location, createdAt: Timestamp.fromMillis(p.createdAtMs), profileVisibility: p.profileVisibility,
        email: 'NAO-PODE-APARECER@exemplo.com',
      });
    },
    async seedPost(p) {
      await db.collection('posts').doc(p.id).set({
        userId: p.userId, text: p.text, hashtags: p.hashtags.length ? p.hashtags : null, media: p.media.length ? p.media : null,
        createdAt: Timestamp.fromMillis(p.createdAtMs), updatedAt: p.updatedAtMs ? new Date(p.updatedAtMs).toISOString() : null,
        visibility: p.visibility, federation: p.federation, type: p.type, category: p.category, isDeleted: p.isDeleted,
        poll: p.hasPoll ? { options: [], endsAt: Timestamp.fromMillis(p.createdAtMs) } : null, sensitive: p.sensitive,
        youtubeVideoId: p.youtubeVideoId, likes: 0, reposts: 0,
      });
    },
    async inspecionarExpira(colecao, id) {
      const snap = await db.collection(colecao).doc(id).get();
      return snap.exists ? snap.data().expireAt ?? null : undefined;
    },
    async limpar() {
      await fetch(`http://${FS_HOST}/emulator/v1/projects/${PROJETO}/databases/${BANCO}/documents`, { method: 'DELETE' });
    },
  };
}

// ───────────── a bateria ─────────────

async function bateria(F) {
  const S = F.store;
  const rot = (s) => `[${F.nome}] ${s}`;
  const { relogio } = F;

  // configuração
  await F.setPlatform({ enabled: true, killSwitch: false, mode: 'allowlist' });
  let p = await S.getPlatform();
  confere(rot('plataforma: lê os três campos'), p.enabled === true && p.killSwitch === false && p.mode === 'allowlist', JSON.stringify(p));
  await F.setPolicy({ mode: 'allowlist', rules: { 'boa.org': { action: 'allow' }, 'ruim.org': { action: 'suspend' }, 'chata.org': { action: 'silence' } } });
  const pol = await S.getInstancePolicy();
  confere(rot('política: modo e regras'), pol.mode === 'allowlist' && pol.rules['boa.org']?.action === 'allow' && pol.rules['ruim.org']?.action === 'suspend' && pol.rules['chata.org']?.action === 'silence', JSON.stringify(pol));

  // gravação da configuração pelo painel (setPlatform / setInstanceRule)
  await S.setPlatform({ killSwitch: true });
  p = await S.getPlatform();
  confere(rot('setPlatform: muda só o que foi pedido, e VALE NA HORA (sem esperar o cache)'), p.killSwitch === true && p.enabled === true && p.mode === 'allowlist', JSON.stringify(p));
  await S.setPlatform({ killSwitch: false, enabled: false, mode: 'open' });
  p = await S.getPlatform();
  confere(rot('setPlatform: vários campos de uma vez'), p.killSwitch === false && p.enabled === false && p.mode === 'open', JSON.stringify(p));
  confere(rot('setPlatform: o modo da plataforma passa a ser o modo da política'), (await S.getInstancePolicy()).mode === 'open', JSON.stringify(await S.getInstancePolicy()));
  await S.setPlatform({ mode: 'banana', enabled: 'sim', killSwitch: 1 });
  p = await S.getPlatform();
  confere(rot('setPlatform: valores inválidos são ignorados'), p.killSwitch === false && p.enabled === false && p.mode === 'open', JSON.stringify(p));
  await S.setPlatform({ enabled: true, killSwitch: false, mode: 'allowlist' });

  await S.setInstanceRule('nova.org', 'suspend');
  let pol2 = await S.getInstancePolicy();
  confere(rot('setInstanceRule: grava a regra e VALE NA HORA, sem tocar nas outras'), pol2.rules['nova.org']?.action === 'suspend' && pol2.rules['boa.org']?.action === 'allow' && Object.keys(pol2.rules).length === 4, JSON.stringify(pol2));
  await S.setInstanceRule('nova.org', 'allow');
  pol2 = await S.getInstancePolicy();
  confere(rot('setInstanceRule: trocar a ação substitui, não duplica'), pol2.rules['nova.org']?.action === 'allow' && Object.keys(pol2.rules).length === 4, JSON.stringify(pol2));
  await S.setInstanceRule('nova.org', null);
  let erroRemocao = null;
  try { await S.setInstanceRule('nunca-existiu.org', null); } catch (e) { erroRemocao = e; }
  pol2 = await S.getInstancePolicy();
  confere(rot('setInstanceRule: null remove, e remover o que não existe não falha'), pol2.rules['nova.org'] === undefined && Object.keys(pol2.rules).length === 3 && erroRemocao === null, JSON.stringify(pol2) + String(erroRemocao));

  // handles
  const h = (handle, uid, extra = {}) => ({ handle, uid, state: 'active', publicKeyPem: 'PEM', createdAtMs: T0, keyDeleteAfterMs: null, ...extra });
  const corrida = await Promise.all(Array.from({ length: 6 }, (_, i) => S.createHandleIfAbsent(h('disputado', `U${i}`))));
  confere(rot('handle: 6 criações SIMULTÂNEAS do mesmo handle → exatamente UMA vence'), corrida.filter(Boolean).length === 1, JSON.stringify(corrida));
  const dono = await S.getHandle('disputado');
  confere(rot('handle: o dono é quem venceu, e não é sobrescrito depois'), dono && corrida[Number(dono.uid.slice(1))] === true, JSON.stringify(dono));
  confere(rot('handle: criar de novo uma reserva existente → false'), (await S.createHandleIfAbsent(h('disputado', 'OUTRO'))) === false, 'sobrescreveu');
  confere(rot('handle: inexistente → null'), (await S.getHandle('naoexiste')) === null, 'não nulo');
  await S.createHandleIfAbsent(h('ana', 'U_ANA'));
  confere(rot('handle: findHandleByUid'), (await S.findHandleByUid('U_ANA'))?.handle === 'ana' && (await S.findHandleByUid('NINGUEM')) === null, 'busca errada');
  await S.setHandleState('ana', 'off');
  confere(rot('handle: setHandleState'), (await S.getHandle('ana')).state === 'off', 'estado não mudou');
  await S.putHandle(h('ana', 'U_ANA', { state: 'deleting', keyDeleteAfterMs: T0 + 1000 }));
  confere(rot('handle: chave ainda NÃO vencida não aparece'), (await S.listHandlesWithKeyDue(T0, 10)).length === 0, 'listou cedo');
  confere(rot('handle: chave vencida aparece'), igual((await S.listHandlesWithKeyDue(T0 + 2000, 10)).map((x) => x.handle), ['ana']), JSON.stringify(await S.listHandlesWithKeyDue(T0 + 2000, 10)));
  confere(rot('handle: sem prazo (null) nunca aparece como vencido'), !(await S.listHandlesWithKeyDue(T0 + 9e12, 10)).some((x) => x.handle === 'disputado'), 'null tratado como vencido');

  // conta
  confere(rot('conta: inexistente → null'), (await S.getAccount('SEM')) === null, 'não nulo');
  const conta = { uid: 'U_ANA', enabled: true, paused: false, handle: 'ana', eligibleSince: T0 + 5, enabledAtMs: T0, publicKeyPem: 'PEM', updatedAtMs: T0, alsoKnownAs: ['https://x.org/u/a'], movedTo: null };
  await S.saveAccount(conta);
  confere(rot('conta: ida e volta com todos os campos'), igual(await S.getAccount('U_ANA'), conta), JSON.stringify(await S.getAccount('U_ANA')));
  // RETROCOMPATIBILIDADE: documentos antigos ainda têm `alsoKnownAs` gravado e continuam sendo lidos sem quebrar...
  const legado = await S.getAccount('U_ANA');
  confere(rot('conta: alsoKnownAs legado continua sendo LIDO do banco (documento antigo não quebra)'), Array.isArray(legado.alsoKnownAs) && legado.alsoKnownAs.length === 1, JSON.stringify(legado.alsoKnownAs));
  // ...mas o ator público, montado a partir dessa mesma conta, NÃO o publica (nem o endereço que estava lá).
  // O que a pessoa cadastrava continua no banco (leitura retrocompativel) e NAO pode ser repassado ao ator: quem monta o
  // ator e o render, que ignora esse campo e so aceita o auto-alias da migracao vindo da rota.
  const atorDoLegado = buildActor({ id: 'https://hiperverso.social/ap/users/ana', handle: 'ana', name: 'Ana', summaryHtml: '', profileUrl: 'https://hiperverso.social/ana', inbox: 'i', outbox: 'o', followers: 'f', following: 'g', sharedInbox: 's', keyId: 'k', publicKeyPem: legado.publicKeyPem, publishedIso: '2026-01-01T00:00:00Z', movedTo: legado.movedTo });
  confere(rot('conta: o alsoKnownAs gravado pela pessoa NAO chega ao ator publico'), !JSON.stringify(atorDoLegado).includes('x.org/u/a'), JSON.stringify(atorDoLegado).slice(0, 160));

  // chave
  const selada = { v: 1, alg: 'A256GCM', kid: 'k1', iv: 'aXY=', ct: 'Y3Q=', tag: 'dGFn' };
  await S.saveSealedKey('U_ANA', selada);
  confere(rot('chave: ida e volta'), igual(await S.loadSealedKey('U_ANA'), selada), JSON.stringify(await S.loadSealedKey('U_ANA')));
  await S.deleteKey('U_ANA');
  confere(rot('chave: apagada de verdade'), (await S.loadSealedKey('U_ANA')) === null, 'ainda existe');
  // gravar SE ausente: é o que impede duas instâncias do servidor de criar chaves diferentes para o ator da instância
  const outra = { ...selada, kid: 'k2', ct: 'b3V0cmE=' };
  const primeira = await S.saveSealedKeyIfAbsent('@contrato', selada);
  const segunda = await S.saveSealedKeyIfAbsent('@contrato', outra);
  confere(rot('chave: gravar-se-ausente grava a primeira vez e recusa a segunda'), primeira === true && segunda === false, `${primeira}/${segunda}`);
  confere(rot('chave: a segunda tentativa NÃO sobrescreve a que já estava'), igual(await S.loadSealedKey('@contrato'), selada), JSON.stringify(await S.loadSealedKey('@contrato')));
  await S.deleteKey('@contrato');

  // perfil e posts, no formato que o app realmente grava
  const perfil = { uid: 'U_ANA', name: 'Ana', username: 'Ana_Silva', bio: 'bio', avatarUrl: 'https://media.exercitodolula.app/m/AAAAAAAAAAAAAAAAAAAAAA', coverUrl: null, website: 'https://a.org', location: 'Recife', createdAtMs: T0 - 5000, profileVisibility: 'public' };
  await F.seedProfile(perfil);
  const lido = await S.getProfile('U_ANA');
  confere(rot('perfil: mapeia os campos'), igual(lido, perfil), JSON.stringify(lido));
  confere(rot('perfil: NUNCA devolve e-mail (campo que existe no documento)'), !JSON.stringify(lido).includes('NAO-PODE'), 'e-mail vazou');
  confere(rot('perfil: inexistente → null'), (await S.getProfile('SEM')) === null, 'não nulo');

  const post = {
    id: 'P1', userId: 'U_ANA', text: 'olá #lula', hashtags: ['lula'], media: [{ url: 'https://media.exercitodolula.app/m/BBBBBBBBBBBBBBBBBBBBBB', type: 'video', alt: 'legenda' }],
    createdAtMs: T0 + 10, updatedAtMs: T0 + 99, visibility: 'followers', federation: 'followers', type: 'original', category: 'echo',
    isDeleted: false, hasPoll: false, sensitive: true, youtubeVideoId: null,
  };
  await F.seedPost(post);
  confere(rot('post: mapeia todos os campos (Timestamp → ms, mídia, enquete ausente)'), igual(await S.getPost('P1'), post), JSON.stringify(await S.getPost('P1')));
  await F.seedPost({ ...post, id: 'P2', hashtags: [], media: [], updatedAtMs: null, federation: null, hasPoll: true, visibility: 'public' });
  const p2 = await S.getPost('P2');
  confere(rot('post: listas ausentes viram [], federation ausente vira null, enquete é detectada'), igual([p2.hashtags, p2.media, p2.updatedAtMs, p2.federation, p2.hasPoll], [[], [], null, null, true]), JSON.stringify(p2));
  confere(rot('post: inexistente → null'), (await S.getPost('SEM')) === null, 'não nulo');

  // objetos federados e outbox
  const obj = (id, scope, ms, state = 'federated') => ({ postId: id, uid: 'U_ANA', objectId: `https://e.org/ap/notes/${id}`, scope, createdAtMs: ms, state, lastActivityAtMs: ms });
  for (let i = 1; i <= 5; i++) await S.putObject(obj(`PUB${i}`, 'public', T0 + i * 100));
  await S.putObject(obj('UNL', 'unlisted', T0 + 600));
  await S.putObject(obj('SEG', 'followers', T0 + 700));
  confere(rot('objeto: getObject ida e volta'), igual(await S.getObject('PUB3'), obj('PUB3', 'public', T0 + 300)), JSON.stringify(await S.getObject('PUB3')));
  confere(rot('outbox: conta SÓ o público'), (await S.countPublicObjects('U_ANA')) === 5, String(await S.countPublicObjects('U_ANA')));
  const pag1 = await S.listPublicObjects('U_ANA', null, 2);
  confere(rot('outbox: do mais novo ao mais velho'), igual(pag1.map((o) => o.postId), ['PUB5', 'PUB4']), JSON.stringify(pag1.map((o) => o.postId)));
  const pag2 = await S.listPublicObjects('U_ANA', pag1[1].createdAtMs, 2);
  const pag3 = await S.listPublicObjects('U_ANA', pag2[1].createdAtMs, 2);
  confere(rot('outbox: paginação por `before` percorre tudo, sem repetir nem pular'), igual([...pag1, ...pag2, ...pag3].map((o) => o.postId), ['PUB5', 'PUB4', 'PUB3', 'PUB2', 'PUB1']), JSON.stringify([...pag1, ...pag2, ...pag3].map((o) => o.postId)));
  confere(rot('outbox: NÃO lista não listado nem só-seguidores'), ![...pag1, ...pag2, ...pag3].some((o) => o.postId === 'UNL' || o.postId === 'SEG'), 'vazou alcance restrito');
  await S.putObject(obj('PUB5', 'public', T0 + 500, 'deleted'));
  confere(rot('outbox: objeto apagado SAI da outbox'), (await S.countPublicObjects('U_ANA')) === 4 && !(await S.listPublicObjects('U_ANA', null, 10)).some((o) => o.postId === 'PUB5'), 'apagado continua listado');
  confere(rot('objeto: o apagado continua consultável pelo id (para o 410)'), (await S.getObject('PUB5')).state === 'deleted', 'sumiu');
  const cont = await S.federationCounts();
  confere(rot('contagens da federação'), cont.publicObjects === 4 && cont.accounts >= 1, JSON.stringify(cont));

  // seguidores
  const seg = (n) => ({ uid: 'U_ANA', actorId: `https://m.org/users/${n}`, inbox: `https://m.org/users/${n}/inbox`, sharedInbox: n % 2 ? 'https://m.org/inbox' : null, domain: 'm.org', followActivity: { '@context': 'x', id: `https://m.org/f/${n}`, type: 'Follow', nested: { a: [1, 2] } }, createdAtMs: T0 + n });
  for (let i = 1; i <= 5; i++) await S.putFollower(seg(i));
  await S.putFollower({ ...seg(1), uid: 'U_BIA' });
  confere(rot('seguidor: ida e volta (inclusive o Follow com chaves como @context)'), igual(await S.getFollower('U_ANA', seg(3).actorId), seg(3)), JSON.stringify(await S.getFollower('U_ANA', seg(3).actorId)));
  confere(rot('seguidor: conta por pessoa'), (await S.countFollowers('U_ANA')) === 5 && (await S.countFollowers('U_BIA')) === 1, `${await S.countFollowers('U_ANA')}/${await S.countFollowers('U_BIA')}`);
  const todos = [];
  let depois = null;
  for (let i = 0; i < 10; i++) {
    const lote = await S.listFollowers('U_ANA', 2, depois);
    todos.push(...lote.map((x) => x.actorId));
    if (lote.length < 2) break;
    depois = lote[lote.length - 1].actorId;
  }
  confere(rot('seguidor: paginação de 2 em 2 percorre os 5, sem repetir nem pular, e não mistura outra pessoa'), todos.length === 5 && new Set(todos).size === 5, JSON.stringify(todos));
  confere(rot('seguidor: findFollowersByActor acha em todas as contas'), (await S.findFollowersByActor(seg(1).actorId)).length === 2, String((await S.findFollowersByActor(seg(1).actorId)).length));
  confere(rot('seguidor: deleteFollower → true, e false se já não existia'), (await S.deleteFollower('U_ANA', seg(2).actorId)) === true && (await S.deleteFollower('U_ANA', seg(2).actorId)) === false, 'retorno errado');
  confere(rot('seguidor: apagar um não apaga o de outra pessoa'), (await S.getFollower('U_BIA', seg(1).actorId)) !== null, 'apagou o alheio');

  // atores remotos e idempotência
  const remoto = { actorId: 'https://m.org/users/x', handle: 'x@m.org', domain: 'm.org', type: 'Person', inbox: 'https://m.org/users/x/inbox', sharedInbox: null, keyId: 'https://m.org/users/x#main-key', publicKeyPem: 'PEM', name: 'X', iconUrl: null, summary: '', movedTo: null, state: 'ok', fetchedAtMs: T0, lastForcedRefreshAtMs: 0 };
  await S.putRemoteActor(remoto);
  confere(rot('ator remoto: ida e volta (sem vazar o campo interno de expiração)'), igual(await S.getRemoteActor(remoto.actorId), remoto), JSON.stringify(await S.getRemoteActor(remoto.actorId)));
  confere(rot('ator remoto: inexistente → null'), (await S.getRemoteActor('https://nada.org/u')) === null, 'não nulo');
  // "Desde quando sumiu" tem de voltar da leitura: sem ele, o segundo 404 nunca seria reconhecido como confirmação e os
  // posts de uma conta apagada na origem ficariam no ar para sempre.
  const sumido = { ...remoto, actorId: 'https://m.org/users/sumido', state: 'gone', goneSinceMs: T0 - 1000, discoverable: true, indexable: false };
  await S.putRemoteActor(sumido);
  confere(rot('ator remoto: goneSinceMs, discoverable e indexable sobrevivem à ida e volta'), igual(await S.getRemoteActor(sumido.actorId), sumido), JSON.stringify(await S.getRemoteActor(sumido.actorId)));
  const vistos = await Promise.all(Array.from({ length: 6 }, () => S.markSeen('https://m.org/act/1', 1000)));
  confere(rot('markSeen: 6 chamadas SIMULTÂNEAS com o mesmo id → exatamente UMA é a primeira'), vistos.filter(Boolean).length === 1, JSON.stringify(vistos));
  confere(rot('markSeen: id diferente é outra primeira vez'), (await S.markSeen('https://m.org/act/2', 1000)) === true, 'tratou como repetido');

  // bloqueios
  await S.addUserBlock('U_ANA', { scope: 'actor', value: 'https://x.org/u/a' });
  await S.addUserBlock('U_ANA', { scope: 'domain', value: 'ruim.org' });
  await S.addUserBlock('U_ANA', { scope: 'domain', value: 'ruim.org' });
  await S.addUserBlock('U_BIA', { scope: 'domain', value: 'outro.org' });
  const bl = await S.listUserBlocks('U_ANA');
  confere(rot('bloqueio: lista os da pessoa, sem duplicar nem misturar'), bl.length === 2 && ordenado(bl.map((b) => `${b.scope}:${b.value}`)).join() === 'actor:https://x.org/u/a,domain:ruim.org', JSON.stringify(bl));
  await S.removeUserBlock('U_ANA', { scope: 'domain', value: 'ruim.org' });
  confere(rot('bloqueio: remover'), (await S.listUserBlocks('U_ANA')).length === 1 && (await S.listUserBlocks('U_BIA')).length === 1, 'removeu errado');

  // saída da federação: apaga objetos, outbox e bloqueios DA PESSOA, e só dela
  await S.putObject({ postId: 'DELA1', uid: 'U_SAI', objectId: 'https://e.org/ap/notes/DELA1', scope: 'public', createdAtMs: T0 + 1, state: 'federated', lastActivityAtMs: T0 + 1 });
  await S.putObject({ postId: 'DELA2', uid: 'U_SAI', objectId: 'https://e.org/ap/notes/DELA2', scope: 'followers', createdAtMs: T0 + 2, state: 'federated', lastActivityAtMs: T0 + 2 });
  await S.addUserBlock('U_SAI', { scope: 'actor', value: 'https://x.org/u/q' });
  const antesPurga = await S.countPublicObjects('U_ANA');
  await S.purgeUserData('U_SAI');
  confere(rot('purge: apaga os objetos (incluindo os não públicos) e a outbox da pessoa'),
    (await S.getObject('DELA1')) === null && (await S.getObject('DELA2')) === null && (await S.countPublicObjects('U_SAI')) === 0, 'sobrou objeto');
  confere(rot('purge: apaga os bloqueios da pessoa'), (await S.listUserBlocks('U_SAI')).length === 0, 'sobrou bloqueio');
  confere(rot('purge: NÃO toca no que é de outra pessoa'), (await S.countPublicObjects('U_ANA')) === antesPurga && (await S.listUserBlocks('U_BIA')).length === 1, 'apagou o alheio');
  await S.purgeUserData('NUNCA_EXISTIU');
  confere(rot('purge: pessoa sem dados não é erro'), true, '');

  // tarefas e posse temporária
  const job = (i, em = relogio.t) => ({ id: `j${i}`, op: 'create', uid: 'U_ANA', postId: `P${i}`, targets: null, createdAtMs: relogio.t, nextAttemptAt: em, attempts: 0, state: 'pending', note: null });
  for (let i = 1; i <= 6; i++) await S.enqueueJob(job(i));
  await S.enqueueJob(job(99, relogio.t + 500_000));
  let a = await S.claimDueJobs(relogio.t, 2, 30_000);
  confere(rot('tarefa: claim respeita o limite'), a.length === 2, String(a.length));
  const rest = await Promise.all([S.claimDueJobs(relogio.t, 10, 30_000), S.claimDueJobs(relogio.t, 10, 30_000), S.claimDueJobs(relogio.t, 10, 30_000)]);
  const ids = rest.flat().map((j) => j.id);
  confere(rot('tarefa: 3 workers SIMULTÂNEOS repartem o resto sem NENHUMA tarefa em dobro'), new Set(ids).size === ids.length && ids.length === 4, `${ids.length} reivindicadas, ${new Set(ids).size} distintas`);
  confere(rot('tarefa: uma já reivindicada não é entregue de novo'), (await S.claimDueJobs(relogio.t, 10, 30_000)).length === 0, 'duplicou');
  confere(rot('tarefa: a agendada para o futuro não é entregue antes da hora'), !ids.includes('j99') && !a.some((j) => j.id === 'j99'), 'entregou cedo');
  relogio.t += 31_000;
  const aposPosse = await S.claimDueJobs(relogio.t, 10, 30_000);
  confere(rot('tarefa: vencida a posse (worker que caiu), outra execução assume'), aposPosse.length === 6, `assumiu ${aposPosse.length}`);
  await S.finishJob('j1', 'done', null);
  await S.finishJob('j2', 'skipped', 'motivo');
  relogio.t += 31_000;
  const aposFim = await S.claimDueJobs(relogio.t, 10, 30_000);
  confere(rot('tarefa: concluída (done/skipped) sai da fila para sempre'), !aposFim.some((j) => j.id === 'j1' || j.id === 'j2') && aposFim.length === 4, `${aposFim.map((j) => j.id)}`);
  relogio.t += 31_000;
  await S.claimDueJobs(relogio.t, 20, 30_000);
  relogio.t += 600_000;
  const futura = await S.claimDueJobs(relogio.t, 20, 30_000);
  confere(rot('tarefa: a agendada vira devida quando a hora chega'), futura.some((j) => j.id === 'j99'), JSON.stringify(futura.map((j) => j.id)));

  // entregas
  relogio.t = T0 + 1_000_000;
  const ent = (i, extra = {}) => ({
    id: `d${i}`, uid: 'U_ANA', op: 'create', objectId: 'P1', activityId: `https://e.org/ap/act/${i}`, targetInbox: `https://m.org/inbox${i}`, domain: 'm.org',
    body: '{"a":"ç"}', status: 'pending', attempts: 0, nextAttemptAt: relogio.t, lastDetail: null, lastOutcome: null, createdAtMs: relogio.t + i, sentAtMs: null, ...extra,
  });
  confere(rot('entrega: criar a mesma duas vezes → true e depois false (idempotente)'), (await S.putDeliveryIfAbsent(ent(1))) === true && (await S.putDeliveryIfAbsent(ent(1, { body: 'OUTRO' }))) === false, 'duplicou');
  confere(rot('entrega: a repetida NÃO sobrescreve a original'), (await S.getDelivery('d1')).body === '{"a":"ç"}', 'sobrescreveu');
  for (let i = 2; i <= 5; i++) await S.putDeliveryIfAbsent(ent(i));
  const dc = await Promise.all([S.claimDueDeliveries(relogio.t, 10, 30_000), S.claimDueDeliveries(relogio.t, 10, 30_000)]);
  const dIds = dc.flat().map((d) => d.id);
  confere(rot('entrega: 2 workers SIMULTÂNEOS não pegam a mesma entrega'), new Set(dIds).size === dIds.length && dIds.length === 5, `${dIds.length} / ${new Set(dIds).size}`);
  confere(rot('entrega: preserva o corpo exato, com acentos'), dc.flat().every((d) => d.body === '{"a":"ç"}'), 'corpo alterado');
  await S.updateDelivery('d1', { status: 'pending', attempts: 1, nextAttemptAt: relogio.t + 60_000, lastDetail: 'HTTP 503', lastOutcome: 'retry' });
  confere(rot('entrega: reagendada fica FORA da fila até a hora'), !(await S.claimDueDeliveries(relogio.t, 10, 30_000)).some((d) => d.id === 'd1'), 'voltou cedo');
  relogio.t += 61_000;
  confere(rot('entrega: a posse foi LIBERADA ao atualizar — volta quando a hora chega'), (await S.claimDueDeliveries(relogio.t, 10, 30_000)).some((d) => d.id === 'd1'), 'ficou presa pela posse');
  await S.updateDelivery('d2', { status: 'sent', attempts: 1, nextAttemptAt: null, sentAtMs: relogio.t, lastDetail: 'HTTP 202', lastOutcome: 'sent' });
  await S.updateDelivery('d3', { status: 'dead', attempts: 8, nextAttemptAt: null, lastDetail: 'esgotadas', lastOutcome: 'retry' });
  relogio.t += 10 * 3600_000;
  const depoisTerminar = await S.claimDueDeliveries(relogio.t, 10, 30_000);
  confere(rot('entrega: enviada ou morta SAI da fila para sempre'), !depoisTerminar.some((d) => d.id === 'd2' || d.id === 'd3'), JSON.stringify(depoisTerminar.map((d) => d.id)));
  const d2 = await S.getDelivery('d2');
  confere(rot('entrega: o estado terminal fica registrado'), d2.status === 'sent' && d2.nextAttemptAt === null && d2.sentAtMs !== null, JSON.stringify(d2));
  await S.updateDelivery('d3', { status: 'pending', attempts: 0, nextAttemptAt: relogio.t });
  confere(rot('entrega: "tentar de novo" (dead → pending) volta à fila'), (await S.claimDueDeliveries(relogio.t, 10, 30_000)).some((d) => d.id === 'd3'), 'não voltou');
  const lista = await S.listDeliveries('U_ANA', 3);
  confere(rot('entrega: listagem da pessoa do mais novo ao mais velho, com limite'), igual(lista.map((d) => d.id), ['d5', 'd4', 'd3']), JSON.stringify(lista.map((d) => d.id)));
  confere(rot('entrega: listagem não mistura outra pessoa'), (await S.listDeliveries('U_BIA', 10)).length === 0, 'misturou');
  confere(rot('entrega: getDelivery inexistente → null'), (await S.getDelivery('zzz')) === null, 'não nulo');
  const prof = await S.queueDepth();
  confere(rot('fila: contagens para a observabilidade'), prof.dead === 0 && prof.deliveries >= 1 && typeof prof.jobs === 'number', JSON.stringify(prof));

  // saúde do domínio
  confere(rot('domínio: sem registro → null'), (await S.getDomainHealth('nunca.org')) === null, 'não nulo');
  await S.setDomainHealth({ domain: 'm.org', consecutiveFailures: 3, cooldownUntilMs: T0 + 5, lastFailureMs: T0 });
  confere(rot('domínio: ida e volta'), igual(await S.getDomainHealth('m.org'), { domain: 'm.org', consecutiveFailures: 3, cooldownUntilMs: T0 + 5, lastFailureMs: T0 }), JSON.stringify(await S.getDomainHealth('m.org')));
  // A RECUSA tem de voltar da leitura. O adaptador do Firestore descartava estes campos: o worker partia de zero a cada
  // 403 e a pausa de consentimento nunca disparou em produção. Este caso é o que teria pego o defeito.
  const recusa = { domain: 'r.org', consecutiveFailures: 0, cooldownUntilMs: 0, lastFailureMs: T0, consecutiveRefusals: 3, refusedUntilMs: T0 + 86_400_000 };
  await S.setDomainHealth(recusa);
  confere(rot('domínio: recusas (403) e fim da pausa sobrevivem à ida e volta'), igual(await S.getDomainHealth('r.org'), recusa), JSON.stringify(await S.getDomainHealth('r.org')));
  const morto = { domain: 'x.org', consecutiveFailures: 9, cooldownUntilMs: T0 + 9, lastFailureMs: T0, lastFailureClass: 'dns' };
  await S.setDomainHealth(morto);
  confere(rot('domínio: classe da última falha sobrevive à ida e volta'), igual(await S.getDomainHealth('x.org'), morto), JSON.stringify(await S.getDomainHealth('x.org')));

  // observabilidade
  let erro = null;
  const tBump = relogio.t;
  try {
    await S.audit({ atMs: T0, kind: 'inbox', type: 'Follow', domain: 'm.org', decision: 'aceita', reason: 'aceita-follow' });
    await S.bump('inbox.aceita');
    await S.bump('inbox.recusada.assinatura-digest', 3);
    await S.bump('inbox.aceita');
    await S.saveFlag({ fromActor: 'https://m.org/u/x', fromDomain: 'm.org', targets: ['https://e.org/ap/users/ana'], content: 'c', receivedAtMs: T0 });
  } catch (e) { erro = e; }
  confere(rot('auditoria, contadores (com ponto no nome) e denúncias gravam sem erro'), erro === null, String(erro));
  const dia = String(new Date(tBump).getUTCFullYear()) + String(new Date(tBump).getUTCMonth() + 1).padStart(2, '0') + String(new Date(tBump).getUTCDate()).padStart(2, '0');
  const lidos = await S.readCounters(dia);
  confere(rot('readCounters: devolve os contadores do dia, com o ponto no nome'), lidos['inbox.aceita'] === 2 && lidos['inbox.recusada.assinatura-digest'] === 3, JSON.stringify(lidos));
  confere(rot('readCounters: dia sem nada devolve objeto vazio'), igual(await S.readCounters('19990101'), {}), JSON.stringify(await S.readCounters('19990101')));
}

// ───────────── execução ─────────────

const memoria = fabricaMemoria();
await bateria(memoria);

let emulador = true;
try {
  const r = await fetch(`http://${FS_HOST}/`);
  emulador = r.ok || r.status === 404;
} catch { emulador = false; }

if (!emulador) {
  console.log(`FALHA o emulador do Firestore não responde em ${FS_HOST} — rode \`npm run emulators\` e tente de novo`);
  falhas++;
} else {
  const fs = await fabricaFirestore();
  await fs.limpar();
  try {
    await bateria(fs);

    // Específicos do adaptador: TTL e segredos.
    const exp = async (col, id) => fs.inspecionarExpira(col, id);
    const sha = (await import('node:crypto')).createHash;
    const idVisto = sha('sha256').update('https://m.org/act/1').digest('hex');
    confere('[firestore] TTL: ap_seen tem expireAt como Timestamp', (await exp('ap_seen', idVisto))?.toMillis !== undefined, 'sem expireAt');
    const idAtor = sha('sha256').update('https://m.org/users/x').digest('hex');
    confere('[firestore] TTL: ap_remote_actors tem expireAt', (await exp('ap_remote_actors', idAtor))?.toMillis !== undefined, 'sem expireAt');
    confere('[firestore] TTL: entrega terminal tem expireAt', (await exp('ap_deliveries', 'd2'))?.toMillis !== undefined, 'sem expireAt');
    confere('[firestore] TTL: entrega que VOLTOU para pending perde o expireAt (senão o TTL a apagaria na fila)', (await exp('ap_deliveries', 'd3')) === undefined || (await exp('ap_deliveries', 'd3')) === null, 'ainda expira');
    confere('[firestore] TTL: tarefa concluída tem expireAt', (await exp('ap_outbound', 'j1'))?.toMillis !== undefined, 'sem expireAt');
    const auditorias = await fs.db.collection('ap_audit').limit(1).get();
    confere('[firestore] TTL: auditoria tem expireAt', auditorias.docs[0]?.data().expireAt?.toMillis !== undefined, 'sem expireAt');
    const stats = await fs.db.collection('ap_stats').get();
    const contadores = stats.docs[0]?.data().c ?? {};
    confere('[firestore] contadores: o ponto no NOME é literal, e incrementa', contadores['inbox.aceita'] === 2 && contadores['inbox.recusada.assinatura-digest'] === 3, JSON.stringify(contadores));
    const seg = await fs.db.collection('ap_followers').limit(1).get();
    confere('[firestore] seguidor: o Follow vai como TEXTO (sem chaves exóticas no documento)', typeof seg.docs[0]?.data().followActivityJson === 'string' && !('followActivity' in seg.docs[0].data()), 'gravou como mapa');
  } finally {
    await fs.limpar();
  }
}

console.log('');
console.log(`${total} verificações.`);
if (falhas) {
  console.log(`${falhas} falha(s).`);
  process.exit(1);
}
console.log('Contrato do FederationStore OK: memória e Firestore se comportam igual.');
