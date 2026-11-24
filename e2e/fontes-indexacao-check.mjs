#!/usr/bin/env node
/**
 * A política de indexação da aba Fontes (src/lib/fontes/politicaDeIndexacao.ts):
 *   node e2e/fontes-indexacao-check.mjs        (ou: npm run e2e:fontes)
 *
 * O que está em jogo aqui não é um recurso, é uma promessa pública. A rede se comprometeu a respeitar quem pede
 * para não ser indexado — e um compromisso desses se quebra em silêncio: ninguém reclama quando um site aparece
 * num índice que não deveria, porque ninguém fica olhando. Então cada caminho de recusa é executado.
 *
 * A distinção que o módulo existe para sustentar: mostrar a PRÉVIA de um link é uma leitura pedida por quem colou
 * o endereço; GUARDAR aquela página num índice que depois responde a estranhos é publicar o trabalho alheio. Só a
 * segunda é indexação, e é só nela que o `noindex` manda.
 *
 * Sai com código 1 se algo falhar.
 */
import {
  MAX_DESCRICAO,
  MAX_TITULO,
  avaliarParaIndice,
  canonizar,
  chaveDaPagina,
  dataDePublicacao,
  idiomaCurto,
  pediuParaNaoIndexar,
} from '../src/lib/fontes/politicaDeIndexacao.ts';
import { DOMINIOS_BLOQUEADOS, dominioBloqueado, motivoDoBloqueio, normalizarHost } from '../src/lib/fontes/bloqueio.ts';

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

const AGORA = Date.parse('2026-11-19T12:00:00Z');

// ───────────────────────── O pedido para não indexar ─────────────────────────
confere('NOINDEX · cabeçalho X-Robots-Tag', pediuParaNaoIndexar({ xRobotsTag: 'noindex' }) === true, 'ignorou o cabeçalho');
confere('NOINDEX · meta robots', pediuParaNaoIndexar({ metaRobots: 'noindex, nofollow' }) === true, 'ignorou a meta');
confere(
  'NOINDEX · o opt-out só nosso, para quem não quer sair do resto da web',
  pediuParaNaoIndexar({ metaHiperverso: 'noindex' }) === true,
  'ignorou o opt-out dedicado',
);
confere('NOINDEX · "none" também proíbe', pediuParaNaoIndexar({ metaRobots: 'none' }) === true, 'aceitou none');
confere('NOINDEX · maiúsculas não escapam', pediuParaNaoIndexar({ metaRobots: 'NoIndex' }) === true, 'escapou pela caixa');
confere(
  'NOINDEX · no meio de outras diretivas continua valendo',
  pediuParaNaoIndexar({ xRobotsTag: 'max-image-preview:large, noindex, max-snippet:-1' }) === true,
  'perdeu a diretiva no meio',
);
confere(
  'NOINDEX · quem NÃO pediu nada é indexável',
  pediuParaNaoIndexar({}) === false && pediuParaNaoIndexar({ metaRobots: 'index, follow' }) === false,
  'recusou quem não pediu',
);
confere(
  'NOINDEX · "nofollow" sozinho não é "noindex" (são pedidos diferentes)',
  pediuParaNaoIndexar({ metaRobots: 'nofollow' }) === false,
  'confundiu nofollow com noindex',
);
confere(
  'NOINDEX · "noindexação" não dispara por acaso (a palavra é inteira)',
  pediuParaNaoIndexar({ metaRobots: 'indexable' }) === false,
  'casou pedaço de palavra',
);
{
  const v = avaliarParaIndice('https://jornal.exemplo/materia', { titulo: 'x', sinais: { metaRobots: 'noindex' } }, AGORA);
  confere('NOINDEX · e a página é recusada de verdade', v.ok === false && v.motivo === 'noindex', JSON.stringify(v));
}

// ───────────────────────── A URL canônica ─────────────────────────
const c = (u) => canonizar(u);
confere('CANÔNICA · tira o fragmento', c('https://a.com/x#parte').url === 'https://a.com/x', c('https://a.com/x#parte').url);
confere('CANÔNICA · tira a barra final', c('https://a.com/x/').url === 'https://a.com/x', c('https://a.com/x/').url);
confere('CANÔNICA · mantém a raiz', c('https://a.com/').url === 'https://a.com/', c('https://a.com/').url);
confere(
  'CANÔNICA · tira os parâmetros de rastreio e guarda os de conteúdo',
  c('https://a.com/x?utm_source=zap&fbclid=1&pagina=2').url === 'https://a.com/x?pagina=2',
  c('https://a.com/x?utm_source=zap&fbclid=1&pagina=2').url,
);
confere(
  'CANÔNICA · ordem dos parâmetros não cria duplicata',
  c('https://a.com/x?b=2&a=1').url === c('https://a.com/x?a=1&b=2').url,
  `${c('https://a.com/x?b=2&a=1').url} vs ${c('https://a.com/x?a=1&b=2').url}`,
);
confere('CANÔNICA · host em minúsculas', c('https://WWW.A.COM/x').url.includes('www.a.com'), c('https://WWW.A.COM/x').url);
confere('CANÔNICA · porta padrão some', c('https://a.com:443/x').url === 'https://a.com/x', c('https://a.com:443/x').url);
confere(
  'CANÔNICA · a chave é estável e igual para a mesma página',
  chaveDaPagina(c('https://a.com/x?b=2&a=1').url) === chaveDaPagina(c('https://a.com/x?a=1&b=2').url),
  'a mesma página geraria dois registros',
);
confere(
  'CANÔNICA · páginas diferentes não colidem',
  chaveDaPagina('https://a.com/x') !== chaveDaPagina('https://a.com/y'),
  'colisão de chave',
);

// ───────────────────────── O que não entra ─────────────────────────
for (const [nome, url, motivo] of [
  ['não é http', 'javascript:alert(1)', 'nao-e-http'],
  ['arquivo local', 'file:///etc/passwd', 'nao-e-http'],
  ['endereço quebrado', 'nao é url', 'url-invalida'],
  ['host privado', 'http://192.168.0.1/admin', 'host-privado'],
  ['localhost', 'http://localhost:3000/x', 'host-privado'],
  ['a nossa própria rede', 'https://hiperverso.app/pt-BR/post/1', 'host-nosso'],
  ['o domínio antigo também', 'https://exercitodolula.app/x', 'host-nosso'],
  ['imagem não é página', 'https://a.com/foto.jpg', 'arquivo-de-midia'],
  ['vídeo não é página', 'https://a.com/clipe.mp4', 'arquivo-de-midia'],
  ['instalador não é página', 'https://a.com/app.apk', 'arquivo-de-midia'],
]) {
  const v = canonizar(url);
  confere(`RECUSA · ${nome}`, v.ok === false && v.motivo === motivo, JSON.stringify(v));
}
confere(
  'RECUSA · URL gigante não entra (nem consome memória)',
  canonizar(`https://a.com/${'x'.repeat(5000)}`).motivo === 'url-longa-demais',
  'aceitou URL gigante',
);

// ───────────────────────── O que se guarda ─────────────────────────
{
  const v = avaliarParaIndice(
    'https://jornal.exemplo/materia?utm_source=x',
    {
      titulo: '  Reforma   agrária  avança \n',
      descricao: 'O plano completo.',
      imagem: '/capa.jpg',
      idioma: 'pt-BR',
      publicadoEm: '2026-11-10T10:00:00Z',
    },
    AGORA,
  );
  confere('GUARDA · aceita uma página comum', v.ok === true, JSON.stringify(v));
  confere('GUARDA · o título vem limpo, sem espaço sobrando', v.ok && v.pagina.titulo === 'Reforma agrária avança', v.ok ? v.pagina.titulo : '');
  confere('GUARDA · a imagem relativa vira absoluta', v.ok && v.pagina.imagem === 'https://jornal.exemplo/capa.jpg', v.ok ? String(v.pagina.imagem) : '');
  confere('GUARDA · o idioma vira duas letras', v.ok && v.pagina.idioma === 'pt', v.ok ? String(v.pagina.idioma) : '');
  confere('GUARDA · a URL guardada já é a canônica', v.ok && v.pagina.url === 'https://jornal.exemplo/materia', v.ok ? v.pagina.url : '');
  confere('GUARDA · o domínio fica visível (o cartão mostra a origem real)', v.ok && v.pagina.host === 'jornal.exemplo', v.ok ? v.pagina.host : '');
}
{
  const v = avaliarParaIndice('https://a.com/x', { titulo: 'T'.repeat(900), descricao: 'D'.repeat(2000) }, AGORA);
  confere(
    'GUARDA · resumo é resumo: título e descrição têm teto (senão vira cópia do site)',
    v.ok && v.pagina.titulo.length === MAX_TITULO && v.pagina.descricao.length === MAX_DESCRICAO,
    v.ok ? `${v.pagina.titulo.length}/${v.pagina.descricao.length}` : '',
  );
}
confere(
  'GUARDA · imagem com endereço inválido não derruba o registro',
  (() => { const v = avaliarParaIndice('https://a.com/x', { titulo: 't', imagem: 'javascript:alert(1)' }, AGORA); return v.ok && v.pagina.imagem === null; })(),
  'aceitou imagem com esquema perigoso',
);
confere('IDIOMA · lixo vira null', idiomaCurto('não sei') === null && idiomaCurto(42) === null, 'aceitou lixo');
confere('IDIOMA · pt_BR também vale', idiomaCurto('pt_BR') === 'pt', String(idiomaCurto('pt_BR')));

// ───────────────────────── A data ─────────────────────────
confere('DATA · data real passa', dataDePublicacao('2026-11-10T10:00:00Z', AGORA) === '2026-11-10T10:00:00.000Z', String(dataDePublicacao('2026-11-10T10:00:00Z', AGORA)));
confere(
  'DATA · data no futuro é recusada (ordenaria o índice errado)',
  dataDePublicacao('2030-01-01T00:00:00Z', AGORA) === null,
  'aceitou data futura',
);
confere('DATA · data absurda no passado é recusada', dataDePublicacao('1200-01-01T00:00:00Z', AGORA) === null, 'aceitou ano 1200');
confere(
  'DATA · sem data é null, não é hoje (não se inventa data de publicação)',
  dataDePublicacao(undefined, AGORA) === null && dataDePublicacao('', AGORA) === null,
  'inventou data',
);

// ───────────────────────── Domínios bloqueados ─────────────────────────
// O bloqueio vale nas DUAS pontas: na gravação (não encher o índice) e na leitura (bloquear depois tem de tirar
// dos resultados na hora, não quando alguém lembrar de limpar a coleção).
confere('BLOQUEIO · o domínio bloqueado é barrado', dominioBloqueado('fllics.com') === true, 'passou');
confere('BLOQUEIO · com www também', dominioBloqueado('www.fllics.com') === true, 'o www escapou');
confere(
  'BLOQUEIO · subdomínio não é brecha (senão o bloqueio se contorna com um prefixo)',
  dominioBloqueado('cdn.fllics.com') === true,
  'o subdomínio escapou',
);
confere(
  'BLOQUEIO · mas nome PARECIDO não é bloqueado (naofllics.com é outro site)',
  dominioBloqueado('naofllics.com') === false && dominioBloqueado('fllics.com.br') === false,
  'bloqueou um site de terceiro por semelhança de nome',
);
confere('BLOQUEIO · site comum passa', dominioBloqueado('www.bbc.com') === false, 'bloqueou site legítimo');
confere('BLOQUEIO · host vazio não quebra', dominioBloqueado('') === false && dominioBloqueado(null ?? '') === false, 'quebrou com vazio');
confere('BLOQUEIO · ponto final e caixa não escapam', dominioBloqueado('FLLICS.COM.') === true, 'escapou pela forma do host');
confere(
  'BLOQUEIO · todo bloqueio tem motivo escrito (lista sem motivo vira nome que ninguém sabe por que está lá)',
  DOMINIOS_BLOQUEADOS.every((b) => typeof b.motivo === 'string' && b.motivo.length > 20),
  'há bloqueio sem motivo',
);
confere('BLOQUEIO · o motivo é recuperável para o painel e o log', (motivoDoBloqueio('fllics.com') || '').includes('automatizada'), String(motivoDoBloqueio('fllics.com')));
confere('BLOQUEIO · quem não está na lista não tem motivo', motivoDoBloqueio('www.bbc.com') === null, 'inventou motivo');
confere('BLOQUEIO · normalizar tira www e caixa', normalizarHost('WWW.Exemplo.COM.') === 'exemplo.com', normalizarHost('WWW.Exemplo.COM.'));

console.log('');
console.log(`${total} verificações.`);
if (falhas) {
  console.log(`${falhas} falha(s).`);
  process.exit(1);
}
console.log('Fontes OK: quem pede para não ser indexado não é, a URL é canônica e o que se guarda é resumo, não cópia.');
