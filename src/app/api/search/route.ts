// src/app/api/search/route.ts
// O motor de busca da rede, do lado do servidor. Código próprio, sem API de busca de terceiro.
//
// ───────────────────────── Por que esta rota existe ─────────────────────────
// A busca anterior acontecia no NAVEGADOR: baixava 200 posts + 200 comentários e, para cada um, fazia mais uma
// leitura (`getPostById` / `getCommentById`). Eram ~400 documentos e ~400 idas extras ao banco por letra pesquisada,
// no aparelho de quem usa. Em celular com dado contado isso é caro e lento, e ainda obrigava a mandar para o cliente
// conteúdo que ele nem vai mostrar.
//
// Aqui são DUAS consultas no servidor, sem leitura por item: o ranking usa o que já está desnormalizado no próprio
// documento (título, texto, hashtags, autor, curtidas). O que volta para a tela é uma lista ordenada de ids com o
// trecho já recortado — e a tela busca o conteúdo só do que vai mesmo desenhar.
//
// Nada aqui consulta serviço de busca de fora, e nada daqui alimenta treinamento de modelo. A ordem vem de
// src/lib/search/ranking.ts, que é auditável linha a linha e não tem termo comercial nenhum.
import { NextResponse, type NextRequest } from 'next/server';
import { enderecoNormalizado, remotoPodeAparecerNaBusca } from '@/lib/activitypub/consentimentoDoAtor';
import { adminFirestore } from '@/lib/server/firebaseAdmin';
import { requestIp, takeRateLimit } from '@/lib/server/requestAuth';
import { linhaNormalizada, normalizar, tokens } from '@/lib/search/indiceDeTexto';
import { ordenarPorRelevancia, trechoComDestaque, type DocumentoIndexado } from '@/lib/search/ranking';
import { interpretar, passaNoFiltro, type ItemFiltravel } from '@/lib/search/operadores';
import { dominioBloqueado } from '@/lib/fontes/bloqueio';
import { COLECAO_FONTES } from '@/lib/fontes/registrarFonte';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** Janela de candidatos lida do banco. Mais que isto encarece sem melhorar: o ranking já separa o que presta. */
const CANDIDATOS_POSTS = 400;
/** A consulta por tag usa indice e por isso vai fundo no historico sem ler o que nao serve. */
const CANDIDATOS_POR_TAG = 200;
/** A consulta por TERMO tambem usa indice (searchTokens). E o que faz a busca alcancar o passado. */
const CANDIDATOS_POR_TERMO = 300;
/** Paginas externas candidatas por busca. O indice de Fontes e pequeno; nao precisa de janela grande. */
const CANDIDATOS_WEB = 150;
/** Teto do `array-contains-any` no Firestore. */
const MAX_TERMOS_NA_CONSULTA = 30;
const CANDIDATOS_COMENTARIOS = 300;
const CANDIDATOS_PESSOAS = 120;

/** Quantos resultados cada aba devolve. */
const POR_ABA = 30;

const JANELA_MS = 60_000;

const json = (body: Record<string, unknown>, status = 200) =>
  NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } });

export type TipoDeResultado = 'post' | 'artigo' | 'comentario' | 'pessoa' | 'web';

export interface ResultadoDaBusca {
  id: string;
  tipo: TipoDeResultado;
  /** Resultado da aba Fontes: o endereco real da pagina, para o link ir DIRETO ao site. */
  url?: string;
  /** O dominio, mostrado no cartao. Quem le precisa ver de onde veio antes de clicar. */
  dominio?: string;
  imagem?: string | null;
  /** Post pai, quando o resultado é um comentário: é o link para onde a pessoa vai. */
  postPaiId?: string;
  titulo?: string;
  trecho: string;
  /** Pares [início, fim] dentro de `trecho` para a tela destacar sem receber HTML pronto. */
  marcas: Array<[number, number]>;
  autorNome?: string;
  autorHandle?: string;
  autorAvatar?: string | null;
  criadoEm?: number;
  curtidas?: number;
  pontos: number;
}

const paraMs = (valor: unknown): number | undefined => {
  if (!valor) return undefined;
  if (typeof valor === 'number' && Number.isFinite(valor)) return valor;
  if (typeof valor === 'string') {
    const t = Date.parse(valor);
    return Number.isFinite(t) ? t : undefined;
  }
  const o = valor as { toMillis?: unknown; _seconds?: unknown; seconds?: unknown };
  if (typeof o.toMillis === 'function') {
    try {
      const t = (o.toMillis as () => number)();
      return Number.isFinite(t) ? t : undefined;
    } catch {
      return undefined;
    }
  }
  const s = typeof o._seconds === 'number' ? o._seconds : typeof o.seconds === 'number' ? o.seconds : null;
  return s === null ? undefined : s * 1000;
};

const texto = (v: unknown): string => (typeof v === 'string' ? v : '');

/**
 * As formas que uma hashtag pode ter sido GRAVADA.
 *
 * As hashtags sao guardadas com o `#` e com a caixa que a pessoa digitou (ver extractHashtagsFromString), e o
 * banco compara exato. Entao procurar `#reforma` tem de tentar tambem `#Reforma` e `#REFORMA` -- senao a busca
 * por tag dependeria de acertar a caixa de quem escreveu, coisa que ninguem tem como saber.
 */
const variantesDaTag = (tag: string): string[] => {
  const limpa = tag.replace(/^#/, '').trim();
  if (!limpa) return [];
  const min = limpa.toLowerCase();
  const cap = min.charAt(0).toUpperCase() + min.slice(1);
  return Array.from(new Set([limpa, min, cap, min.toUpperCase()])).map((t) => '#' + t);
};
const lista = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

type Candidato = DocumentoIndexado &
  ItemFiltravel & {
    tipo: TipoDeResultado;
    postPaiId?: string;
    titulo?: string;
    corpoOriginal: string;
    autorNome?: string;
    autorHandle?: string;
    autorAvatar?: string | null;
    sensivel?: boolean;
    url?: string;
    dominio?: string;
    imagem?: string | null;
    /** De alguém de OUTRO servidor (perfil `ap_` ou post/comentário federado). */
    remoto?: boolean;
    /** Dono do conteúdo, para ler o consentimento do perfil remoto. */
    autorId?: string;
    /** `remoteDiscoverable`/`remoteIndexable` do perfil remoto. Só `true` é sim. */
    descobrivel?: boolean;
    indexavel?: boolean;
    /** A consulta é o endereço exato desta pessoa (`pessoa@servidor`). */
    enderecoExato?: boolean;
  };

export async function GET(request: NextRequest) {
  const ip = requestIp(request);
  if (!takeRateLimit(`busca:ip:${ip}`, 60, JANELA_MS)) {
    return json({ error: 'too-many-requests' }, 429);
  }

  const bruto = (request.nextUrl.searchParams.get('q') ?? '').slice(0, 200).trim();
  if (bruto.length < 2) {
    return json({ resultados: [], contagens: { posts: 0, artigos: 0, comentarios: 0, pessoas: 0 } });
  }

  // A barra de busca e o painel de Busca Avancada sao a mesma coisa: os dois chegam aqui como texto, e e aqui que
  // os operadores viram filtro (src/lib/search/operadores.ts).
  const avancada = interpretar(bruto);
  const termos = tokens(avancada.texto || bruto);
  const frases = avancada.frases;
  const alvo = normalizar((avancada.texto || bruto).replace(/"/g, ''));
  const semSensivel = request.nextUrl.searchParams.get('sensivel') !== 'mostrar';
  // Só aspas, ou só palavras vazias: não há o que procurar, e varrer o banco por nada seria desperdício.
  if (termos.length === 0 && frases.length === 0) {
    return json({ resultados: [], contagens: { posts: 0, artigos: 0, comentarios: 0, pessoas: 0 } });
  }

  const db = adminFirestore();
  const candidatos: Candidato[] = [];
  // Quantos candidatos cada caminho trouxe. Declarado aqui porque a resposta, la embaixo, fica fora do try.
  const alcance: { janelaRecente: number; indiceDeTermos: number | false; indiceDeTags: number | false } = {
    janelaRecente: 0,
    indiceDeTermos: false,
    indiceDeTags: false,
  };

  // Busca por TAG tem caminho proprio, e isso muda o alcance de verdade: as outras consultas leem a janela dos
  // posts mais recentes, que numa rede ativa cobre poucas horas. A tag TEM indice no banco, entao a consulta por
  // tag varre o historico inteiro sem ler o que nao interessa. Enquanto nao houver indice de termos, este e o
  // unico caminho da busca que alcanca o que foi publicado semanas atras.
  const tagsProcuradas =
    avancada.tags.length > 0
      ? avancada.tags
      : /^#?[\p{L}0-9_]{2,40}$/u.test(bruto.trim())
        ? [bruto.trim()]
        : [];
  const variantes = Array.from(new Set(tagsProcuradas.flatMap(variantesDaTag))).slice(0, 25);

  // A consulta por TERMO e o que tira a busca da janela das ultimas horas: o banco encontra o post pelo termo,
  // em qualquer data. Posts publicados antes de `searchTokens` existir nao tem o campo e por isso nao aparecem
  // por aqui -- continuam vindo pela janela recente ate o preenchimento retroativo rodar.
  const termosNaConsulta = termos.slice(0, MAX_TERMOS_NA_CONSULTA);

  try {
    const [posts, porTermo, porTag, comentarios, pessoas, fontes] = await Promise.all([
      db
        .collection('posts')
        .where('visibility', '==', 'public')
        .where('isDeleted', '==', false)
        .orderBy('createdAt', 'desc')
        .limit(CANDIDATOS_POSTS)
        .get(),
      // Se o indice de searchTokens ainda nao existe, esta consulta falha e e descartada: a busca continua
      // funcionando pela janela recente, sem erro na tela.
      termosNaConsulta.length > 0
        ? db
            .collection('posts')
            .where('searchTokens', 'array-contains-any', termosNaConsulta)
            .where('visibility', '==', 'public')
            .where('isDeleted', '==', false)
            .orderBy('createdAt', 'desc')
            .limit(CANDIDATOS_POR_TERMO)
            .get()
            .catch(() => null)
        : Promise.resolve(null),
      variantes.length > 0
        ? db
            .collection('posts')
            .where('hashtags', 'array-contains-any', variantes)
            .where('visibility', '==', 'public')
            .where('isDeleted', '==', false)
            .orderBy('createdAt', 'desc')
            .limit(CANDIDATOS_POR_TAG)
            .get()
            .catch(() => null)
        : Promise.resolve(null),
      // Este formato (isDeleted + postVisibility + createdAt) e o que JA TEM indice em producao. Buscar so por
      // isDeleted exigiria um indice novo de grupo de colecao, e indice novo nao entra sem combinar antes.
      // Custo conhecido: comentario antigo, de quando postVisibility ainda nao era gravado, fica de fora ate haver
      // um preenchimento retroativo desse campo.
      db
        .collectionGroup('comments')
        .where('isDeleted', '==', false)
        .where('postVisibility', '==', 'public')
        .orderBy('createdAt', 'desc')
        .limit(CANDIDATOS_COMENTARIOS)
        .get()
        .catch(() => null),
      db.collection('users').orderBy('followersCount', 'desc').limit(CANDIDATOS_PESSOAS).get().catch(() => null),
      // Aba Fontes. Sem `orderBy`, de proposito: `array-contains-any` sozinho usa o indice automatico de campo
      // unico e nao exige indice composto. A ordem quem da e o ranking, em memoria.
      termosNaConsulta.length > 0
        ? db
            .collection(COLECAO_FONTES)
            .where('searchTokens', 'array-contains-any', termosNaConsulta)
            .limit(CANDIDATOS_WEB)
            .get()
            .catch(() => null)
        : Promise.resolve(null),
    ]);

    alcance.janelaRecente = posts.size;
    alcance.indiceDeTermos = porTermo ? porTermo.size : false;
    alcance.indiceDeTags = porTag ? porTag.size : false;

    const vistos = new Set<string>();
    for (const doc of [...posts.docs, ...(porTermo?.docs ?? []), ...(porTag?.docs ?? [])]) {
      if (vistos.has(doc.id)) continue;
      vistos.add(doc.id);
      const d = doc.data();
      const autor = (d.authorDetails ?? {}) as Record<string, unknown>;
      const titulo = texto(d.headline);
      const corpo = texto(d.text);
      const autorId = texto(d.userId);
      candidatos.push({
        id: doc.id,
        tipo: d.category === 'news' ? 'artigo' : 'post',
        remoto: d.isRemoteFediverse === true || autorId.startsWith('ap_'),
        autorId,
        tags: lista(d.hashtags).map((h) => h.replace(/^#/, '').toLowerCase()),
        temMidia: d.hasMedia === true || (Array.isArray(d.media) && d.media.length > 0),
        temFonte: typeof d.sourceUrl === 'string' && d.sourceUrl.length > 0,
        sensivel: d.isSensitive === true || d.sensitive === true,

        titulo: titulo || undefined,
        corpoOriginal: corpo,
        tokensTitulo: tokens(`${titulo} ${texto(autor.name)} ${texto(autor.username)}`),
        tokensCorpo: tokens(`${corpo} ${lista(d.hashtags).join(' ')}`),
        tituloNormalizado: titulo ? linhaNormalizada(titulo) : undefined,
        linha: linhaNormalizada(`${titulo} ${corpo}`),
        curtidas: typeof d.likes === 'number' ? d.likes : 0,
        respostas: typeof d.commentsCount === 'number' ? d.commentsCount : 0,
        criadoEm: paraMs(d.createdAt),
        autorNome: texto(autor.name) || undefined,
        autorHandle: texto(autor.username) || undefined,
        autorAvatar: texto(autor.avatarUrl) || null,
      });
    }

    for (const doc of comentarios?.docs ?? []) {
      const d = doc.data();
      // `postVisibility` é cópia desnormalizada e falta nos comentários antigos. Filtrar por ela na consulta
      // escondia comentários legítimos; aqui o que vale é: se o campo existe, precisa ser público; se não existe,
      // confere-se o post pai pelo id (ele veio na mesma leitura quando é um dos candidatos).
      const vis = texto(d.postVisibility);
      if (vis && vis !== 'public') continue;
      const paiId = doc.ref.parent.parent?.id;
      if (!paiId) continue;
      const autor = (d.authorDetails ?? {}) as Record<string, unknown>;
      const corpo = texto(d.text);
      const autorDoComentario = texto(d.userId);
      candidatos.push({
        id: doc.id,
        tipo: 'comentario',
        remoto: d.isRemoteFediverse === true || autorDoComentario.startsWith('ap_'),
        autorId: autorDoComentario,
        postPaiId: paiId,
        tags: lista(d.hashtags).map((h) => h.replace(/^#/, '').toLowerCase()),
        temMidia: d.hasMedia === true,
        sensivel: d.isSensitive === true,
        corpoOriginal: corpo,
        tokensTitulo: tokens(`${texto(autor.name)} ${texto(autor.username)}`),
        tokensCorpo: tokens(`${corpo} ${lista(d.hashtags).join(' ')}`),
        linha: linhaNormalizada(corpo),
        curtidas: typeof d.likes === 'number' ? d.likes : 0,
        respostas: typeof d.repliesCount === 'number' ? d.repliesCount : 0,
        criadoEm: paraMs(d.createdAt),
        autorNome: texto(autor.name) || undefined,
        autorHandle: texto(autor.username) || undefined,
        autorAvatar: texto(autor.avatarUrl) || null,
      });
    }

    for (const doc of pessoas?.docs ?? []) {
      const d = doc.data();
      const nome = texto(d.name);
      const handle = texto(d.username);
      const bio = texto(d.bio);
      const pessoaRemota = d.isRemoteFediverse === true || doc.id.startsWith('ap_');
      candidatos.push({
        id: doc.id,
        tipo: 'pessoa',
        remoto: pessoaRemota,
        descobrivel: d.remoteDiscoverable === true,
        enderecoExato: pessoaRemota && enderecoNormalizado(handle) === enderecoNormalizado(bruto),
        titulo: nome || handle,
        tags: [],
        corpoOriginal: bio,
        tokensTitulo: tokens(`${nome} ${handle}`),
        tokensCorpo: tokens(bio),
        tituloNormalizado: nome ? linhaNormalizada(nome) : undefined,
        handleNormalizado: handle ? normalizar(handle) : undefined,
        linha: linhaNormalizada(`${nome} ${handle} ${bio}`),
        curtidas: typeof d.followersCount === 'number' ? d.followersCount : 0,
        criadoEm: paraMs(d.createdAt),
        autorNome: nome || undefined,
        autorHandle: handle || undefined,
        autorAvatar: texto(d.avatarUrl) || null,
      });
    }
    for (const doc of fontes?.docs ?? []) {
      const d = doc.data();
      const host = texto(d.host);
      // Bloqueio vale na LEITURA tambem: bloquear um dominio tem de tira-lo dos resultados na hora, e nao so
      // impedir registros novos.
      if (!host || dominioBloqueado(host)) continue;
      const titulo = texto(d.titulo);
      const descricao = texto(d.descricao);
      candidatos.push({
        id: doc.id,
        tipo: 'web',
        titulo: titulo || host,
        corpoOriginal: descricao,
        url: texto(d.url),
        dominio: host,
        imagem: texto(d.imagem) || null,
        tokensTitulo: tokens(`${titulo} ${host}`),
        tokensCorpo: tokens(descricao),
        tituloNormalizado: titulo ? linhaNormalizada(titulo) : undefined,
        linha: linhaNormalizada(`${titulo} ${descricao}`),
        // `citacoes` e o unico sinal de relevancia deste indice, e e organico: quantas vezes a rede voltou a esta
        // pagina. Nao ha, e nao vai haver, como pagar para subir.
        curtidas: typeof d.citacoes === 'number' ? d.citacoes : 0,
        criadoEm: paraMs(d.publicadoEm) ?? paraMs(d.vistaEm),
      });
    }
  } catch (error) {
    console.error('[busca] falha ao ler candidatos:', error);
    return json({ error: 'search-failed' }, 500);
  }

  // CONSENTIMENTO DE QUEM É DE FORA. Perfil remoto só aparece na busca de pessoas com `discoverable` (ou pelo endereço
  // exato); texto de post remoto só é achado por palavra com `indexable`. Busca EXPLÍCITA por #tag continua achando:
  // quem marcou o post com a tag pediu para ser achado por ela (é a semântica do Mastodon). Ausente não é sim.
  // O consentimento mora no perfil `ap_` do autor; lido em lote, uma vez por autor.
  const autoresRemotos = Array.from(
    new Set(candidatos.filter((c) => c.remoto && c.tipo !== 'pessoa' && c.autorId).map((c) => c.autorId as string)),
  ).slice(0, 300);
  const indexavelPorAutor = new Map<string, boolean>();
  if (autoresRemotos.length > 0) {
    const perfis = await db.getAll(...autoresRemotos.map((id) => db.collection('users').doc(id))).catch(() => []);
    for (const perfil of perfis) indexavelPorAutor.set(perfil.id, perfil.data()?.remoteIndexable === true);
  }
  const buscaExplicitaPorTag = avancada.tags.length > 0 || bruto.trim().startsWith('#');
  const tagsExplicitas = buscaExplicitaPorTag
    ? (avancada.tags.length > 0 ? avancada.tags : [bruto.trim()]).map((t) => t.replace(/^#/, '').toLowerCase())
    : [];

  // FILTRO antes de RANKING, de proposito: filtro diz SE o item entra, ranking diz em que ordem. Misturar os dois
  // produz "filtro" que na verdade so empurra o item para baixo -- e ai a pessoa ve o que pediu para nao ver.
  const agora = Date.now();
  const filtrados = candidatos.filter((c) => {
    if (semSensivel && c.sensivel) return false;
    if (
      !remotoPodeAparecerNaBusca({
        tipo: c.tipo,
        remoto: c.remoto === true,
        descobrivel: c.descobrivel,
        indexavel: c.autorId ? indexavelPorAutor.get(c.autorId) === true : false,
        enderecoExato: c.enderecoExato,
        casouPorTagExplicita: buscaExplicitaPorTag && (c.tags ?? []).some((t) => tagsExplicitas.includes(t)),
      })
    ) {
      return false;
    }
    return passaNoFiltro(
      { tipo: c.tipo, autorHandle: c.autorHandle, tags: c.tags, criadoEm: c.criadoEm, temMidia: c.temMidia, temFonte: c.temFonte, linha: c.linha },
      avancada,
      agora,
    );
  });

  const ordenados = ordenarPorRelevancia(filtrados, { termos, frases, textoNormalizado: alvo }, agora);

  // Nota zero = nenhum termo bateu. Entra aqui porque o candidato veio da janela recente, não porque serve.
  // Com filtro avancado ligado e sem texto (so `de:@alguem`, por exemplo) nao ha termo para bater: vale o filtro.
  const semTexto = termos.length === 0 && frases.length === 0;
  const comRelevancia = semTexto
    ? ordenados
    : ordenados.filter((x) => x.porque.bm25 > 0 || x.porque.frase > 0 || x.porque.handleExato > 0);

  // Ordenacao escolhida pela pessoa. `relevancia` e a de ordenarPorRelevancia e ja esta aplicada.
  if (avancada.ordenacao === 'recentes') comRelevancia.sort((a, b) => (b.item.criadoEm ?? 0) - (a.item.criadoEm ?? 0));
  else if (avancada.ordenacao === 'curtidos') comRelevancia.sort((a, b) => (b.item.curtidas ?? 0) - (a.item.curtidas ?? 0));

  const porTipo = (tipo: TipoDeResultado) => comRelevancia.filter((x) => x.item.tipo === tipo);
  const empacotar = (x: (typeof comRelevancia)[number]): ResultadoDaBusca => {
    const { trecho, marcas } = trechoComDestaque(x.item.corpoOriginal || x.item.titulo || '', termos);
    return {
      id: x.item.id,
      tipo: x.item.tipo,
      ...(x.item.postPaiId ? { postPaiId: x.item.postPaiId } : {}),
      ...(x.item.titulo ? { titulo: x.item.titulo } : {}),
      trecho,
      marcas,
      ...(x.item.url ? { url: x.item.url } : {}),
      ...(x.item.dominio ? { dominio: x.item.dominio } : {}),
      ...(x.item.imagem ? { imagem: x.item.imagem } : {}),
      autorNome: x.item.autorNome,
      autorHandle: x.item.autorHandle,
      autorAvatar: x.item.autorAvatar ?? null,
      criadoEm: x.item.criadoEm,
      curtidas: x.item.curtidas,
      pontos: Number(x.pontos.toFixed(4)),
    };
  };

  const posts = porTipo('post').slice(0, POR_ABA).map(empacotar);
  const artigos = porTipo('artigo').slice(0, POR_ABA).map(empacotar);
  const comentarios = porTipo('comentario').slice(0, POR_ABA).map(empacotar);
  const pessoas = porTipo('pessoa').slice(0, POR_ABA).map(empacotar);
  const web = porTipo('web').slice(0, POR_ABA).map(empacotar);

  return json({
    consulta: {
      termos,
      frases,
      filtros: avancada,
      // De onde vieram os candidatos. `indiceDeTermos: false` significa que a busca por palavra ainda esta
      // limitada a janela recente -- ou o indice nao existe, ou os posts ainda nao tem searchTokens.
      alcance,
    },
    resultados: { posts, artigos, comentarios, pessoas, web },
    // As contagens são o tamanho DAS LISTAS DEVOLVIDAS. Contar uma coisa e devolver outra era exatamente o bug da
    // aba com número e lista vazia: o número vinha do serviço e a lista passava ainda por filtros na tela.
    contagens: {
      posts: posts.length,
      artigos: artigos.length,
      comentarios: comentarios.length,
      pessoas: pessoas.length,
      web: web.length,
    },
  });
}
