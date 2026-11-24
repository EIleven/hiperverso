// src/lib/services/searchService.ts
import type { User, Post } from '@/lib/types';
import { searchUsers } from './userService';
import { getTopHashtags } from './hashtagService';
import { getPostById } from './postReadService';
import type { ResultadoDaBusca } from '@/app/api/search/route';

export interface SearchResult {
  users: User[];
  hashtags: string[];
}

/**
 * O que a tela de busca recebe.
 *
 * Duas coisas mudaram em relacao a versao anterior, e as duas sao a correcao do mesmo bug:
 *
 * 1. Comentario NAO vem mais misturado com post. Ele tem tipo proprio e cartao proprio. Antes os dois iam juntos
 *    para a lista do feed, que espera post.
 * 2. As contagens sao o tamanho DAS LISTAS QUE A TELA VAI DESENHAR, calculadas depois de tudo o que pode remover
 *    um item. Era ai que nascia a aba com numero e lista vazia: o numero vinha do servico, e a lista ainda passava
 *    por filtros depois dele (idioma do feed, posts ocultos, item apagado no meio do caminho).
 */
export interface ResultadosDaBusca {
  top: Post[];
  latest: Post[];
  articles: Post[];
  comments: ResultadoDaBusca[];
  /** Paginas de fora que a rede citou. Vazio quando a pessoa desligou os resultados da Web. */
  web: ResultadoDaBusca[];
  people: User[];
  feeds: { tag: string; count: number }[];
  counts: {
    top: number;
    latest: number;
    articles: number;
    comments: number;
    web: number;
    people: number;
    feeds: number;
  };
  /** Termos ja normalizados, para a tela destacar. */
  termos: string[];
}

const VAZIO: ResultadosDaBusca = {
  top: [],
  latest: [],
  articles: [],
  comments: [],
  web: [],
  people: [],
  feeds: [],
  counts: { top: 0, latest: 0, articles: 0, comments: 0, web: 0, people: 0, feeds: 0 },
  termos: [],
};

/** Busca do campo do topo (pessoas e hashtags), para o resultado aparecer enquanto se digita. */
export const performGlobalSearch = async (
  query: string,
  activeUserId: string | null = null
): Promise<SearchResult> => {
  if (query.length < 2) {
    return { users: [], hashtags: [] };
  }

  const lowerCaseQuery = query.toLowerCase();

  try {
    const userPromise = searchUsers(query, activeUserId);
    const hashtagPromise = getTopHashtags(50).then(allHashtags =>
      allHashtags
        .filter(ht => ht.tag.toLowerCase().includes(lowerCaseQuery))
        .map(ht => ht.tag)
        .slice(0, 5)
    );

    const [users, hashtags] = await Promise.all([userPromise, hashtagPromise]);
    return { users, hashtags };
  } catch (error) {
    console.error("Error in performGlobalSearch:", error);
    return { users: [], hashtags: [] };
  }
};

interface RespostaDaApi {
  consulta?: { termos?: string[] };
  resultados?: {
    posts?: ResultadoDaBusca[];
    artigos?: ResultadoDaBusca[];
    comentarios?: ResultadoDaBusca[];
    web?: ResultadoDaBusca[];
  };
}

/**
 * A busca completa da pagina /search.
 *
 * O ranking e a varredura acontecem no SERVIDOR (/api/search). Antes isso rodava no navegador: baixava 200 posts e
 * 200 comentarios e fazia mais uma leitura por item -- cerca de 800 operacoes por busca, no aparelho de quem usa.
 * Agora o servidor devolve a lista ja ordenada, e aqui so se busca o conteudo completo do que a tela vai desenhar.
 */
export const getSearchResultsWithCounts = async (
  query: string,
  activeUserId: string | null = null,
  opcoes?: { mostrarSensivel?: boolean; mostrarWeb?: boolean }
): Promise<ResultadosDaBusca> => {
  const consulta = (query || '').trim();
  if (consulta.length < 2) return VAZIO;
  // O padrao e ESCONDER o sensivel. Quem quiser ver escolhe ver, nao o contrario.
  const sensivel = opcoes?.mostrarSensivel ? '&sensivel=mostrar' : '';

  try {
    const [respostaApi, people, feeds] = await Promise.all([
      fetch(`/api/search?q=${encodeURIComponent(consulta)}${sensivel}`)
        .then((r) => (r.ok ? (r.json() as Promise<RespostaDaApi>) : null))
        .catch(() => null),
      // Pessoas continuam vindo por aqui porque o cartao de pessoa precisa do objeto completo (botao de seguir).
      searchUsers(consulta, activeUserId).catch(() => [] as User[]),
      getTopHashtags(100)
        .then((todas) => todas.filter((ht) => ht.tag.toLowerCase().includes(consulta.toLowerCase().replace('#', ''))))
        .catch(() => [] as { tag: string; count: number }[]),
    ]);

    const ordenados = respostaApi?.resultados;
    const comments = ordenados?.comentarios ?? [];
    // A aba Web so aparece se a pessoa quis. A escolha e do aparelho (Configuracoes > Busca).
    const web = opcoes?.mostrarWeb === false ? [] : ordenados?.web ?? [];
    const idsDePost = [...(ordenados?.posts ?? []), ...(ordenados?.artigos ?? [])];

    // Uma leitura por item que REALMENTE vai aparecer (dezenas), em vez de uma por candidato (centenas).
    const hidratados = await Promise.all(
      idsDePost.map((r) => getPostById(r.id, activeUserId).catch(() => undefined)),
    );
    const posicao = new Map(idsDePost.map((r, i) => [r.id, i]));
    const posts = hidratados.filter((p): p is Post => p !== undefined && !p.isDeleted);

    // A ordem do servidor e a de relevancia; aqui ela e so preservada.
    const top = [...posts].sort((a, b) => (posicao.get(a.id) ?? 0) - (posicao.get(b.id) ?? 0));
    const latest = [...posts].sort(
      (a, b) => new Date(b.createdAt as string).getTime() - new Date(a.createdAt as string).getTime(),
    );
    const articles = top.filter((p) => p.category === 'news');

    return {
      top,
      latest,
      articles,
      comments,
      web,
      people,
      feeds,
      // Contagem = o que foi mesmo montado para a tela. Nunca uma estimativa de outro lugar.
      counts: {
        top: top.length,
        latest: latest.length,
        articles: articles.length,
        comments: comments.length,
        web: web.length,
        people: people.length,
        feeds: feeds.length,
      },
      termos: respostaApi?.consulta?.termos ?? [],
    };
  } catch (error) {
    console.error("Error getting search results with counts:", error);
    return VAZIO;
  }
};
