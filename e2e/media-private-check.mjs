#!/usr/bin/env node
/**
 * Testa a autorização de mídia PRIVADA — anexo de mensagem, arquivo pessoal e mídia restrita — sem app nem
 * emuladores.
 *   node e2e/media-private-check.mjs
 *
 * O que está em jogo: até esta camada, anexo de mensagem recebia `getDownloadURL()`, um token permanente que
 * funciona sem login, ignora as regras do Storage, não expira e não se revoga ao bloquear alguém ou excluir a conta.
 * A troca é por uma rota que **refaz a autorização a cada requisição**. Por isso os cenários abaixo verificam
 * sobretudo o que precisa PARAR de funcionar.
 *
 * Sai com código 1 se algo falhar.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, relative } from 'node:path';

const {
  PRIVATE_MEDIA_HEADERS,
  authorizePrivateMedia,
  canRenderInline,
  conversationIdFor,
  dispositionFor,
} = await import('../src/lib/media/privateAccess.ts');

const { caminhoDaUrlAntiga, isLegacyStorageUrl, tokenDaUrlAntiga } = await import('../src/lib/media/legacyUrl.ts');

const RAIZ = fileURLToPath(new URL('..', import.meta.url));
let falhas = 0;

function confere(nome, condicao, motivo, detalhe) {
  if (condicao) console.log(`OK    ${nome}${detalhe ? ` — ${detalhe}` : ''}`);
  else { falhas++; console.log(`FALHA ${nome} — ${motivo}`); }
}

// Todos os fluxos de upload dependem destas cinco funcoes. Uma substituicao multilinha antiga removeu as
// definicoes, mas o build do App Hosting nao fez typecheck e publicou o modulo mesmo assim. Esta verificacao le o
// fonte de proposito: importar o modulo exigiria DOM, Firebase cliente e browser-image-compression.
const uploadServiceSource = readFileSync(join(RAIZ, 'src/lib/services/mediaUploadService.ts'), 'utf8');
const uploadRouteSource = readFileSync(join(RAIZ, 'src/app/api/media/upload/route.ts'), 'utf8');
for (const factory of [
  'avatarPathFactory',
  'coverPathFactory',
  'postMediaPathFactory',
  'directMessageMediaPathFactory',
  'userFilesPathFactory',
]) {
  confere(
    `a fabrica de caminho ${factory} esta definida e exportada`,
    new RegExp(`export\\s+const\\s+${factory}\\s*:`).test(uploadServiceSource),
    `${factory} e importada pelo app, mas nao esta definida no servico de upload`,
  );
}
confere(
  'o upload passa pela API autenticada do proprio sistema',
  uploadServiceSource.includes("request.open('POST', '/api/media/upload')") &&
    uploadRouteSource.includes('verifyRequestMember(request)'),
  'o SDK Web do Firebase cria token permanente no objeto mesmo sem getDownloadURL',
);
confere(
  'o servidor usa o bucket administrativo sem metadado de token',
  uploadRouteSource.includes('adminBucket().file(storagePath)') &&
    uploadRouteSource.includes('await object.save(bytes') &&
    !uploadRouteSource.includes('firebaseStorageDownloadTokens'),
  'o objeto precisa nascer sem credencial permanente',
);

const DONO = 'uidDono';
const PARCEIRO = 'uidParceiro';
const ESTRANHO = 'uidEstranho';

const anexo = (extra = {}) => ({ ownerUid: DONO, kind: 'dm', visibility: 'private', deleted: false, ...extra });
const ctx = (extra = {}) => ({
  requesterUid: PARCEIRO,
  participantIds: [DONO, PARCEIRO],
  ownerBlockedRequester: false,
  requesterBlockedOwner: false,
  ...extra,
});

// ───────────── 1. Id de conversa derivado ─────────────

confere(
  'o id da conversa é derivado e estável, em qualquer ordem',
  conversationIdFor('b', 'a') === 'a_b' && conversationIdFor('a', 'b') === 'a_b',
  'a ordem dos participantes não pode mudar o id',
  conversationIdFor('a', 'b'),
);

// ───────────── 2. Os nove cenários pedidos ─────────────

const CENARIOS = [
  // [nome, media, contexto, permitido?, motivo esperado]
  ['acesso autorizado: participante', anexo(), ctx(), true, 'participante'],
  ['acesso autorizado: o próprio dono', anexo(), ctx({ requesterUid: DONO }), true, 'dono'],
  ['DESLOGADO não acessa', anexo(), ctx({ requesterUid: null }), false, 'sem-sessao'],
  [
    'PARTICIPANTE REMOVIDO da conversa não acessa',
    anexo(),
    ctx({ participantIds: [DONO, 'uidOutro'] }),
    false,
    'nao-participa',
  ],
  ['conversa inexistente não acessa', anexo(), ctx({ participantIds: null }), false, 'nao-participa'],
  ['estranho à conversa não acessa', anexo(), ctx({ requesterUid: ESTRANHO, participantIds: [DONO, PARCEIRO] }), false, 'nao-participa'],
  ['BLOQUEADO pelo dono não acessa', anexo(), ctx({ ownerBlockedRequester: true }), false, 'bloqueado'],
  ['quem bloqueou o dono não acessa', anexo(), ctx({ requesterBlockedOwner: true }), false, 'bloqueado'],
  ['CONTEÚDO EXCLUÍDO não acessa, nem o dono', anexo({ deleted: true }), ctx({ requesterUid: DONO }), false, 'removido'],
  ['conteúdo excluído não acessa, nem o participante', anexo({ deleted: true }), ctx(), false, 'removido'],
  [
    'ARQUIVO PESSOAL: só o dono',
    { ownerUid: DONO, kind: 'userFile', visibility: 'private', deleted: false },
    ctx(),
    false,
    'nao-participa',
  ],
  [
    'arquivo pessoal: o dono acessa',
    { ownerUid: DONO, kind: 'userFile', visibility: 'private', deleted: false },
    ctx({ requesterUid: DONO }),
    true,
    'dono',
  ],
  [
    'mídia de post que virou PRIVADA: participante da conversa não acessa',
    { ownerUid: DONO, kind: 'postMedia', visibility: 'private', deleted: false },
    ctx(),
    false,
    'nao-participa',
  ],
  [
    'mídia de post privada: o autor acessa',
    { ownerUid: DONO, kind: 'postMedia', visibility: 'private', deleted: false },
    ctx({ requesterUid: DONO }),
    true,
    'dono',
  ],
  [
    'mídia PÚBLICA não é servida por esta rota',
    anexo({ visibility: 'public' }),
    ctx(),
    false,
    'nao-e-privada',
  ],
  [
    'tipo desconhecido é negado por padrão',
    { ownerUid: DONO, kind: 'tipoNovo', visibility: 'private', deleted: false },
    ctx(),
    false,
    'tipo-sem-regra',
  ],
];

for (const [nome, media, contexto, permitido, motivo] of CENARIOS) {
  const d = authorizePrivateMedia(media, contexto);
  confere(
    nome,
    d.allow === permitido && d.reason === motivo,
    `veio allow=${d.allow} reason=${d.reason}, esperado allow=${permitido} reason=${motivo}`,
    d.reason,
  );
}

// A exclusão da CONTA é coberta por onUserDeletedCleanup, que apaga media/, conversations e os social_*. Aqui se
// prova a consequência: sem conversa, não há acesso — e é por isso que apagar a conta corta o anexo na hora.
confere(
  'excluir a conta corta o acesso, porque a conversa deixa de existir',
  authorizePrivateMedia(anexo(), ctx({ participantIds: null })).allow === false,
  'sem a conversa o acesso tem de cair',
);

// ───────────── 3. Enumerar ids não leva a nada ─────────────

const { isValidMediaId } = await import('../src/lib/media/mediaId.ts');
const TENTATIVAS = ['', '1', 'aaaa', '../../x', 'user_uploads/u/x.jpg', 'a'.repeat(22) + 'b', '%2e%2e%2f'];
confere(
  'tentativas de enumerar id são recusadas antes de qualquer leitura',
  TENTATIVAS.every((t) => !isValidMediaId(t)),
  'algum id malformado passaria',
);
confere(
  'id válido sem sessão continua não acessando',
  authorizePrivateMedia(anexo(), ctx({ requesterUid: null })).allow === false,
  'adivinhar o id não basta: ainda precisa de sessão E autorização',
);

// ───────────── 4. Formatos: inline só o que é seguro ─────────────

const FORMATOS = [
  ['JPEG', 'image/jpeg', true],
  ['PNG', 'image/png', true],
  ['GIF', 'image/gif', true],
  ['WebP', 'image/webp', true],
  ['MP4', 'video/mp4', true],
  ['WebM', 'video/webm', true],
  ['MP3', 'audio/mpeg', true],
  ['M4A', 'audio/mp4', true],
  ['PDF', 'application/pdf', true],
  ['SVG', 'image/svg+xml', false],
  ['HTML', 'text/html', false],
  ['XHTML', 'application/xhtml+xml', false],
  ['XML', 'text/xml', false],
  ['ZIP', 'application/zip', false],
  ['desconhecido', 'application/octet-stream', false],
  ['vazio', '', false],
];
for (const [nome, tipo, inline] of FORMATOS) {
  confere(`formato ${nome} ${inline ? 'abre no navegador' : 'vai como download'}`,
    canRenderInline(tipo) === inline,
    `canRenderInline("${tipo}") = ${canRenderInline(tipo)}`);
}
confere(
  'SVG NUNCA é inline, mesmo com parâmetro no tipo',
  canRenderInline('image/svg+xml; charset=utf-8') === false,
  'SVG inline do nosso domínio, com a sessão em cookie, é XSS armazenado',
);
confere(
  'pedir download força attachment mesmo para imagem',
  dispositionFor('image/jpeg', true) === 'attachment' && dispositionFor('image/jpeg', false) === 'inline',
  'o parâmetro de download tem de valer',
);

// ───────────── 5. Cabeçalhos: sem cache, sem índice, sem incorporar ─────────────

confere(
  'mídia privada não é guardada em cache',
  /no-store/.test(PRIVATE_MEDIA_HEADERS['Cache-Control']),
  'com cache, revogar o acesso deixaria de ter efeito imediato',
);
confere(
  'mídia privada não é indexada',
  /noindex/.test(PRIVATE_MEDIA_HEADERS['X-Robots-Tag']),
  'anexo privado não pode entrar em buscador',
);
confere(
  'mídia privada não é legível por outro site',
  PRIVATE_MEDIA_HEADERS['Access-Control-Allow-Origin'] === undefined &&
    PRIVATE_MEDIA_HEADERS['Cross-Origin-Resource-Policy'] === 'same-origin',
  'sem CORP e com CORS aberto, outro site leria o anexo',
);
confere(
  'a resposta varia por cookie',
  /Cookie/.test(PRIVATE_MEDIA_HEADERS.Vary),
  'sem Vary: Cookie um intermediário poderia servir a resposta de uma pessoa para outra',
);

// ───────────── 6. Token antigo copiado antes da migração ─────────────

const URL_ANTIGA =
  'https://firebasestorage.googleapis.com/v0/b/echo-b5aw9.firebasestorage.app/o/user_uploads%2FuidDono%2Fdms%2Fimages%2Fabc.jpg?alt=media&token=11111111-2222-3333-4444-555555555555';

confere(
  'a URL antiga é reconhecida como dependente de token',
  isLegacyStorageUrl(URL_ANTIGA),
  'a conferência final depende de reconhecer o que ainda é antigo',
);
confere(
  'o caminho do objeto é extraído da URL antiga',
  caminhoDaUrlAntiga(URL_ANTIGA) === 'user_uploads/uidDono/dms/images/abc.jpg',
  `veio ${caminhoDaUrlAntiga(URL_ANTIGA)}`,
  caminhoDaUrlAntiga(URL_ANTIGA),
);
confere(
  'o token é identificável, só para relatório',
  tokenDaUrlAntiga(URL_ANTIGA) === '11111111-2222-3333-4444-555555555555',
  'o relatório precisa poder contar quantos objetos ainda têm token',
);
for (const [nome, u] of [
  ['URL nova pública', 'https://media.exercitodolula.app/m/abcdefghijklmnopqrstuv'],
  ['URL nova privada', '/mp/abcdefghijklmnopqrstuv'],
  ['site qualquer', 'https://exemplo.test/imagem.jpg'],
  ['vazio', ''],
  ['nulo', null],
  ['host parecido', 'https://firebasestorage.googleapis.com.evil.test/o/user_uploads%2Fx'],
]) {
  confere(`não confunde com URL antiga: ${nome}`, isLegacyStorageUrl(u) === false, `${u} foi tratado como antigo`);
}
confere(
  'caminho fora de user_uploads é recusado',
  caminhoDaUrlAntiga('https://firebasestorage.googleapis.com/v0/b/x/o/outra%2Fcoisa?alt=media&token=1') === null,
  'só objeto nosso conta',
);

// ───────────── 7. O código faz o que foi desenhado ─────────────


const ler = (...p) => readFileSync(join(RAIZ, ...p), 'utf8');
const rota = ler('src', 'app', 'mp', '[id]', 'route.ts');
const upload = ler('src', 'lib', 'services', 'mediaUploadService.ts');
const sessao = ler('src', 'app', 'api', 'auth', 'session', 'route.ts');
const visibilidade = ler('src', 'app', 'api', 'media', 'visibility', 'route.ts');
const migracao = ler('scripts', 'migrar-tokens-midia.mjs');

// Verificacao por string exata, e nao por regex: a palavra getDownloadURL aparece nos comentarios que explicam
// por que ela saiu, e um guarda grosseiro acusaria a propria documentacao.
const chamaGetDownloadURL =
  upload.includes('getDownloadURL(uploadTask') ||
  upload.includes('getDownloadURL(storageRef') ||
  upload.includes('getDownloadURL(ref') ||
  upload.includes('  getDownloadURL,');
confere(
  'NENHUM caminho do codigo gera token permanente',
  !chamaGetDownloadURL,
  'getDownloadURL cria firebaseStorageDownloadTokens, que é a credencial permanente que esta camada remove',
);
confere(
  'o upload devolve somente a URL criada junto do registro',
  upload.includes('return uploadThroughServer(') &&
    uploadRouteSource.includes("collection('media').doc(mediaId).create") &&
    uploadRouteSource.includes('return json({ downloadURL, filePath: storagePath, mediaId }, 201)'),
  'objeto sem registro ou registro sem objeto não pode ser tratado como upload concluído',
);
confere(
  'mídia privada recebe o caminho autenticado',
  uploadRouteSource.includes('privateMediaPath(mediaId)'),
  'privado não pode receber URL pública',
);
confere(
  'a rota privada exige sessão',
  rota.includes('verifySessionUser(request)'),
  'sem sessão não há como saber quem pede',
);
confere(
  'toda negativa da rota privada é 404',
  rota.includes('status: 404') && !/status: 403/.test(rota),
  'um 403 confirmaria a existência do id',
);
confere(
  'a rota privada confere participação e bloqueio ao vivo',
  rota.includes('conversationIdFor(') && rota.includes('blockedUsers'),
  'é isso que faz o acesso parar na hora',
);
confere(
  'a sessão confere revogação a cada requisição',
  ler('src', 'lib', 'server', 'requestAuth.ts').includes('verifySessionCookie(valor, true)'),
  'sem checkRevoked, conta desativada continuaria acessando até o cookie expirar',
);
confere(
  'o cookie de sessão é HttpOnly, Secure e SameSite strict',
  /httpOnly: true/.test(sessao) && /secure: true/.test(sessao) && /sameSite: 'strict'/.test(sessao),
  'cookie de sessão frouxo permitiria roubo ou uso por outro site',
);
confere(
  'o cookie usa o nome __session, o único que o App Hosting repassa',
  sessao.includes("SESSION_COOKIE = '__session'"),
  'com outro nome a CDN remove o cookie e a mídia privada responde 404 para todos',
);
confere(
  'o cookie não é compartilhado com o domínio de mídia pública',
  !/domain:/.test(sessao),
  'definir domain faria a sessão viajar para media.*, que serve conteúdo público com CORS aberto',
);
confere(
  'público virando privado revoga o token do objeto',
  visibilidade.includes('firebaseStorageDownloadTokens: null'),
  'sem revogar, a URL antiga continuaria concedendo acesso ao que deixou de ser público',
);
confere(
  'só o dono muda a visibilidade da própria mídia',
  visibilidade.includes('dados.ownerUid !== uid'),
  'sem isso qualquer conta tornaria privada a mídia de outra pessoa',
);
confere(
  'a migração é somente leitura por padrão',
  /const APLICAR = args\.has\('--aplicar'\)/.test(migracao) && /if \(!APLICAR\)/.test(migracao),
  'migração que grava sem pedir é armadilha',
);
confere(
  'a migração ABORTA se for revogar antes de registrar',
  /ABORTADO[\s\S]{0,200}registrar/.test(migracao),
  'revogar antes do registro deixaria o anexo inacessível pelos dois caminhos',
);
confere(
  'a migração revoga só os PRIVADOS',
  migracao.includes('privadosComToken') && /preservados[\s\S]{0,80}publicosComToken/.test(migracao),
  'revogar token de mídia pública quebraria card já compartilhado fora',
);

// ───────────── 8. Matriz obrigatória de testes ─────────────
//
// Cada linha abaixo é um item da matriz acordada. Elas repetem cenários já cobertos acima de propósito: a matriz é
// o contrato, e precisa ser legível como contrato — se alguém mudar a autorização, é por aqui que vai ver o que
// quebrou, com o nome do cenário em vez de um detalhe de implementação.

const matriz = [
  [
    'Proprietário abre arquivo pessoal → PERMITIDO',
    authorizePrivateMedia(
      { ownerUid: DONO, kind: 'userFile', visibility: 'private', deleted: false },
      { requesterUid: DONO, participantIds: null, ownerBlockedRequester: false, requesterBlockedOwner: false },
    ).allow === true,
  ],
  [
    'Aba anônima abre arquivo pessoal → NEGADO',
    authorizePrivateMedia(
      { ownerUid: DONO, kind: 'userFile', visibility: 'private', deleted: false },
      { requesterUid: null, participantIds: null, ownerBlockedRequester: false, requesterBlockedOwner: false },
    ).allow === false,
  ],
  [
    'Outro usuário abre arquivo pessoal → NEGADO',
    authorizePrivateMedia(
      { ownerUid: DONO, kind: 'userFile', visibility: 'private', deleted: false },
      { requesterUid: ESTRANHO, participantIds: null, ownerBlockedRequester: false, requesterBlockedOwner: false },
    ).allow === false,
  ],
  [
    'Participante abre anexo da conversa → PERMITIDO',
    authorizePrivateMedia(
      { ownerUid: DONO, kind: 'dm', visibility: 'private', deleted: false },
      { requesterUid: PARCEIRO, participantIds: [DONO, PARCEIRO], ownerBlockedRequester: false, requesterBlockedOwner: false },
    ).allow === true,
  ],
  [
    'Não participante abre anexo → NEGADO',
    authorizePrivateMedia(
      { ownerUid: DONO, kind: 'dm', visibility: 'private', deleted: false },
      { requesterUid: ESTRANHO, participantIds: [DONO, PARCEIRO], ownerBlockedRequester: false, requesterBlockedOwner: false },
    ).allow === false,
  ],
  [
    'Bloqueado abre anexo → NEGADO',
    authorizePrivateMedia(
      { ownerUid: DONO, kind: 'dm', visibility: 'private', deleted: false },
      { requesterUid: PARCEIRO, participantIds: [DONO, PARCEIRO], ownerBlockedRequester: true, requesterBlockedOwner: false },
    ).allow === false,
  ],
  [
    'Post público vira privado → rota pública para de responder',
    authorizePrivateMedia(
      { ownerUid: DONO, kind: 'postMedia', visibility: 'private', deleted: false },
      { requesterUid: ESTRANHO, participantIds: null, ownerBlockedRequester: false, requesterBlockedOwner: false },
    ).allow === false,
  ],
  [
    'Arquivo excluído → NEGADO, mesmo para o dono',
    authorizePrivateMedia(
      { ownerUid: DONO, kind: 'userFile', visibility: 'private', deleted: true },
      { requesterUid: DONO, participantIds: null, ownerBlockedRequester: false, requesterBlockedOwner: false },
    ).allow === false,
  ],
];

for (const [nome, passou] of matriz) {
  confere(`MATRIZ · ${nome}`, passou, 'o cenário da matriz mudou de comportamento');
}

// ───────────── 9. Nenhum upload escapa do registro ─────────────
//
// Mídia final nunca pode voltar ao SDK Web: ele cria token permanente. A única exceção é a fonte TRANSITÓRIA de
// vídeo, privada e apagada pelo worker/lifecycle; ela precisa do protocolo retomável para vídeos longos.

const uploadsFora = [];
const varrerUploads = (dir) => {
  for (const nome of readdirSync(dir)) {
    const caminho = join(dir, nome);
    if (statSync(caminho).isDirectory()) { varrerUploads(caminho); continue; }
    if (!/\.(ts|tsx)$/.test(nome)) continue;
    const texto = readFileSync(caminho, 'utf8');
    const temUpload = texto.includes('uploadBytesResumable(') || texto.includes('uploadBytes(') ||
      texto.includes('uploadString(');
    const relativo = relative(join(RAIZ, 'src'), caminho);
    const stagingVideoAutorizado = relativo === join('lib', 'services', 'mediaUploadService.ts') &&
      texto.includes("fetch('/api/media/video/init'") &&
      texto.includes('uploadBytesResumable(');
    // Anexo CIFRADO grande (ate 200 MB) tambem precisa do protocolo retomavel. A liberacao e CONDICIONAL: so vale
    // enquanto o arquivo fechar o envio pelo servidor, que e quem apaga o token permanente gravado no objeto.
    // Tirar o fechamento faz esta guarda voltar a acusar -- que e o comportamento desejado.
    const cifradoAutorizado = relativo === join('lib', 'services', 'encryptedMediaService.ts') &&
      texto.includes('fecharEnvio(') &&
      texto.includes("JSON.stringify({ finalizar: mediaId })");
    if (temUpload && !stagingVideoAutorizado && !cifradoAutorizado) {
      uploadsFora.push(relativo);
    }
  }
};
varrerUploads(join(RAIZ, 'src'));
confere(
  'nenhum upload FINAL usa o SDK Web do Firebase Storage',
  uploadsFora.length === 0,
  `upload Web do Firebase encontrado em: ${uploadsFora.join(', ')}`,
  'só a fonte transitória de vídeo pode usar upload retomável direto',
);

confere(
  'a API apaga o objeto se a criação do registro falhar',
  uploadRouteSource.includes('if (uploaded)') && uploadRouteSource.includes('await object.delete()'),
  'uma falha no banco não pode deixar objeto órfão no bucket',
);

// O regex das Functions e o do app precisam concordar no formato do id: são pacotes diferentes e a duplicação é
// deliberada, então o teste é quem garante que não divergem.
const funcsMedia = readFileSync(join(RAIZ, 'functions', 'src', 'mediaAccess.ts'), 'utf8');
confere(
  'Functions e app concordam no formato do id da mídia',
  funcsMedia.includes('[A-Za-z0-9_-]{22}'),
  'o formato do id divergiu entre functions/ e src/, e a extração nas Functions deixaria de achar as mídias',
);
for (const [nome, gancho] of [
  ['perfil que troca de visibilidade', 'applyMediaVisibilityByOwnerPosts(db, userId'],
  ['conta excluída', 'tombstoneMediaByOwner(db, uid)'],
]) {
  confere(
    `Functions tratam mídia em: ${nome}`,
    readFileSync(join(RAIZ, 'functions', 'src', 'index.ts'), 'utf8').includes(gancho),
    `falta a chamada ${gancho}`,
  );
}

// Toda exclusão de conteúdo precisa tirar a mídia do ar E do bucket. Dois defeitos reais passaram por aqui: com a URL
// opaca (/m/<id>) o cliente deixou de achar o objeto para apagar, e as Functions só tombavam o registro (ou nem isso, no
// post "tombado", no comentário e na mensagem). O guarda confere, função por função, que a purga é chamada.
const funcsIndexSource = readFileSync(join(RAIZ, 'functions', 'src', 'index.ts'), 'utf8');
const corpoDaFunction = (nome) => {
  const inicio = funcsIndexSource.indexOf('export const ' + nome + ' =');
  if (inicio < 0) return '';
  const fim = funcsIndexSource.indexOf('\nexport const ', inicio + 10);
  return funcsIndexSource.slice(inicio, fim < 0 ? undefined : fim);
};
for (const nome of ['onPostDeleted', 'onPostUpdated', 'onCommentDeleted', 'onCommentUpdated', 'onDirectMessageDeleted']) {
  confere(
    'Functions removem a mídia em: ' + nome,
    corpoDaFunction(nome).includes('purgarMidiaDe('),
    nome + ' não chama purgarMidiaDe: a mídia do conteúdo apagado continuaria servida e guardada',
  );
}
confere(
  'a purga apaga o objeto do bucket, só de quem escreveu o conteúdo, e cancela vídeo ainda não processado',
  funcsMedia.includes('.delete({ignoreNotFound: true})') &&
    funcsMedia.includes('dados.ownerUid !== ownerUid') &&
    funcsMedia.includes('UPLOAD_CANCELAVEL'),
  'purgeMedia precisa: apagar o objeto, recusar mídia de outra pessoa e cancelar o upload pendente',
);
// O app Admin das Functions é criado com opções explícitas; nesse caso o firebase-admin NÃO lê o bucket do ambiente.
// Sem storageBucket, getStorage().bucket() falhava com "Bucket name not specified or invalid" em produção e a revogação
// de token e a remoção de mídia nunca funcionaram (aviso silencioso nos logs: "0 tokens revogados").
confere(
  'o app das Functions define storageBucket (sem isso nenhuma remoção de mídia chega ao bucket)',
  funcsIndexSource.includes('storageBucket: STORAGE_BUCKET'),
  'initializeApp sem storageBucket: getStorage().bucket() lança e a purga/revogação só registram aviso',
);
confere(
  'a mensagem direta guarda o anexo em fileUrl e a extração de ids o enxerga',
  funcsMedia.includes('anotar(data.fileUrl)'),
  'sem isso o anexo de uma mensagem apagada nunca seria encontrado',
);

// ───────────── 10. Ciclo do cookie __session ─────────────

const ctxAuth = ler('src', 'contexts', 'AuthContext.tsx');
const sessaoCliente = ler('src', 'lib', 'services', 'serverSession.ts');
const authSvc2 = ler('src', 'lib', 'services', 'authService.ts');

confere(
  'SESSÃO · criada a partir do observador de autenticação',
  ctxAuth.includes('syncServerSession()') && ctxAuth.includes('onAuthUserChanged'),
  'sem isso o cookie não nasce, e a mídia privada não carrega em nenhum lugar',
);
confere(
  'SESSÃO · renovada a cada carregamento de página',
  sessaoCliente.includes('let ultimoUid: string | null | undefined;') &&
    sessaoCliente.includes('if (uid === ultimoUid) return;'),
  'o controle começa indefinido de propósito: se o cookie expirou, o primeiro carregamento o renova',
);
// A ordem precisa ser conferida DENTRO de logoutUser: o arquivo tem varios signOut (fluxos de erro do cadastro),
// e um indexOf no arquivo inteiro pegaria o primeiro deles, que nada tem a ver com o logout.
const corpoLogout = authSvc2.slice(
  authSvc2.indexOf('export const logoutUser'),
  authSvc2.indexOf('export const getCurrentUser'),
);
confere(
  'SESSÃO · apagada no logout, ANTES do signOut',
  corpoLogout.includes('clearServerSession()') &&
    corpoLogout.indexOf('clearServerSession()') < corpoLogout.indexOf('signOut(auth)'),
  'depois do signOut não há mais ID token para identificar a chamada que apaga o cookie',
);
confere(
  'SESSÃO · o endereço de limpeza existe no servidor',
  sessao.includes("export async function DELETE") && sessao.includes("maxAge: 0"),
  'sem DELETE o cookie sobreviveria ao logout',
);
confere(
  'SESSÃO · a rota recusa quem não tem cookie',
  rota.includes('if (!requesterUid) return naoEncontrado();'),
  'aba anônima tem de cair antes de qualquer leitura',
);
confere(
  'SESSÃO · aba anônima é negada pela autorização também',
  authorizePrivateMedia(anexo(), ctx({ requesterUid: null })).reason === 'sem-sessao',
  'defesa em duas camadas: rota e autorização',
);
confere(
  'SESSÃO · outro usuário autenticado é negado',
  authorizePrivateMedia(
    { ownerUid: DONO, kind: 'userFile', visibility: 'private', deleted: false },
    ctx({ requesterUid: ESTRANHO }),
  ).allow === false,
  'estar logado não basta: precisa ser o dono ou participar da conversa',
);

// ───────────── 11. Matriz final ─────────────

const migracao2 = readFileSync(join(RAIZ, 'scripts', 'migrar-tokens-midia.mjs'), 'utf8');

const matrizFinal = [
  [
    'URL pública própria serve mídia pública',
    // A rota pública exige visibility public; a privada recusa o que é público. Os dois lados conferidos.
    rota.includes("doc.visibility !== 'public'") === false &&
      ler('src', 'app', 'm', '[id]', 'route.ts').includes("doc.visibility !== 'public'"),
  ],
  [
    'URL Firebase privada ANTES da revogação é classificada como exposta',
    migracao2.includes('privadosComToken') && migracao2.includes('<- a exposição'),
  ],
  [
    'URL Firebase privada DEPOIS da revogação é verificada na conferência',
    /FALHA \$\{privadosComToken\.length\} objetos privados AINDA têm token/.test(migracao2),
  ],
  [
    'a revogação toca somente objetos privados',
    migracao2.includes('a revogar: ${privadosComToken.length} objetos PRIVADOS') &&
      migracao2.includes('publicosComToken.length} públicos'),
  ],
  [
    'revogar ABORTA se a reescrita não aconteceu',
    /ABORTADO[\s\S]{0,400}reescrever/.test(migracao2),
  ],
  [
    'logout seguido de tentativa de acesso é negado',
    authorizePrivateMedia(anexo(), ctx({ requesterUid: null })).allow === false,
  ],
  [
    'o backup registra documento, campo e valor anterior',
    migracao2.includes('documento: doc.name') &&
      migracao2.includes('campos: caminhos.map') &&
      migracao2.includes('valoresAnteriores: caminhos'),
  ],
  [
    'o backup tem hash e contagem, e a restauração os confere',
    migracao2.includes("createHash('sha256')") &&
      migracao2.includes('INTEGRIDADE FALHOU'),
  ],
  [
    'o backup fica fora do repositório por padrão',
    migracao2.includes("join(homedir(), 'soberan-backups')"),
  ],
  [
    'o backup é gravado só para o dono (permissão 600)',
    migracao2.includes('mode: 0o600'),
  ],
  [
    'a restauração recusa backup de outro projeto',
    migracao2.includes('cabecalho.projeto !== PROJECT'),
  ],
];

for (const [nome, passou] of matrizFinal) {
  confere(`MATRIZ FINAL · ${nome}`, passou, 'o cenário da matriz final mudou de comportamento');
}

// ───────────── 12. Cobertura: nenhuma referência fica de fora ─────────────

confere(
  'a varredura de referências é RECURSIVA, não uma lista de campos',
  migracao2.includes('function* valoresDeTexto') && migracao2.includes('function* valorRecursivo'),
  'lista de campos à mão deixa referência de fora quando a estrutura muda — foi o que aconteceu na primeira contagem',
);
confere(
  'a troca sabe mexer dentro de array e de mapa aninhado',
  migracao2.includes('function trocarNoCaminho') && migracao2.includes("caminho.match(/[^.[\\]]+/g)"),
  'media[0].url precisa ser alcançável, e updateMask só aceita o campo raiz',
);
confere(
  'o escopo separa o obrigatório do opcional',
  migracao2.includes("const ESCOPO = flag('--escopo') ?? 'privado'") &&
    migracao2.includes('refsPrivadas') &&
    migracao2.includes('refsPublicas'),
  'reescrever 4233 referências para corrigir 19 objetos seria risco sem retorno',
);
confere(
  'a fase registrar deriva do ALVO, e por isso respeita o escopo',
  /FASE === 'registrar'[\s\S]{0,900}new Set\(alvo\.map\(\(r\) => r\.storagePath\)\)/.test(migracao2) &&
    /const alvo = ESCOPO === 'tudo'[\s\S]{0,200}refsPrivadasMigraveis/.test(migracao2),
  'registrar precisa sair das referências do escopo; derivar do bucket registraria todo objeto público e os órfãos',
);
confere(
  'registrar não registra objeto que ninguém referencia',
  migracao2.includes('órfãos deixados de fora') &&
    !migracao2.includes("const candidatos = ESCOPO === 'privado'"),
  'o filtro antigo saía do inventário inteiro, e órfão registrado é órfão dado por administrado',
);
confere(
  'a conferência final só trava por referência PRIVADA',
  migracao2.includes('referências a objeto PRIVADO ainda apontam para o Storage'),
  'referência pública legada é aceita por decisão e não pode travar a conferência',
);

// ───────────── 10. A rota PÚBLICA /m/{id} não pode virar página ─────────────
//
// O defeito trancado aqui: a regra do banco deixava um membro logado registrar um arquivo DELE com
// `contentType: 'text/html'`, e a rota pública servia aquilo com `Content-Disposition: inline` no domínio
// principal — script rodando no site e dentro da WebView do app, alcançando o que o navegador guarda.
// A defesa (`canRenderInline`) já existia e já barrava HTML, SVG e XML: a rota privada usava, a pública não.
{
  const rotaPublica = readFileSync(join(RAIZ, 'src/app/m/[id]/route.ts'), 'utf8');
  confere(
    'a rota pública decide o disposition pelo TIPO, em vez de servir tudo inline',
    rotaPublica.includes('canRenderInline(contentType)') && !/'Content-Disposition': 'inline'/.test(rotaPublica),
    'voltou a servir qualquer tipo como inline',
  );
  confere(
    'e manda uma segunda tranca, para o caso de ser aberta como documento',
    /Content-Security-Policy/.test(rotaPublica) && /sandbox/.test(rotaPublica),
    'sem CSP de sandbox na mídia pública',
  );
  confere(
    'HTML, SVG e XML nunca são inline',
    ['text/html', 'image/svg+xml', 'application/xhtml+xml', 'text/xml', 'application/xml'].every(
      (t) => canRenderInline(t) === false,
    ),
    'algum tipo que vira documento passou por inline',
  );
  confere(
    'e o que é desenhável continua inline (imagem, vídeo, áudio, PDF)',
    ['image/png', 'image/jpeg', 'video/mp4', 'audio/mpeg', 'application/pdf'].every((t) => canRenderInline(t) === true),
    'quebrou a exibição do que é legítimo',
  );

  const regras = readFileSync(join(RAIZ, 'firestore.rules'), 'utf8');
  const blocoMedia = regras.slice(regras.indexOf('match /media/{mediaId}'), regras.indexOf('match /userFiles/'));
  confere(
    'NENHUM cliente registra mídia: quem cria é o servidor, pelo Admin SDK',
    /allow create: if false;/.test(blocoMedia),
    'a criação de registro de mídia voltou a ser aberta ao cliente',
  );
}

if (falhas) {
  console.log(`\n${falhas} falha(s) na mídia privada.`);
  process.exit(1);
}
console.log('\nMídia privada OK: sem token, autorização refeita a cada pedido, privado nunca público.');
