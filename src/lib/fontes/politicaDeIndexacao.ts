// src/lib/fontes/politicaDeIndexacao.ts
// Quem PODE entrar no índice de Fontes, e o que dele se guarda. Módulo PURO: sem rede, sem Firebase, sem DOM.
//
// ───────────────────────── A distinção que organiza este arquivo ─────────────────────────
// Mostrar a prévia de um link e GUARDAR aquela página num índice de busca são coisas diferentes, e só a segunda é
// indexação. A prévia acontece porque alguém aqui colou o endereço e quer ver o que é — é uma leitura pedida por
// uma pessoa, como abrir o site. Guardar título e resumo numa coleção que depois responde a buscas de estranhos é
// publicar um resumo do trabalho alheio, para sempre, sem ninguém ter perguntado.
//
// Por isso o `noindex` vale AQUI e não lá: a prévia continua aparecendo para quem colou o link (ela não é indexação
// e recusá-la seria quebrar a tela por nada), mas a página não entra no índice. É a mesma regra que um buscador
// sério segue, e é a única leitura honesta do pedido de quem escreveu `noindex`.
//
// O que se guarda é só o que o site publicou PARA SER visto assim: título, descrição, imagem de capa, idioma e
// data — os mesmos campos que ele entrega a qualquer leitor de prévia. Nada de texto integral, nada de conteúdo
// atrás de login, nada que o site não tenha colocado na própria etiqueta.

/** Tamanhos do que guardamos. Resumo é resumo: se crescer vira cópia. */
export const MAX_TITULO = 200;
export const MAX_DESCRICAO = 400;
export const MAX_URL = 2000;

export type MotivoDeRecusa =
  | 'url-invalida'
  | 'url-longa-demais'
  | 'nao-e-http'
  | 'host-nosso'
  | 'host-privado'
  | 'arquivo-de-midia'
  | 'noindex';

/** Hosts nossos: o conteúdo da própria rede já é buscável pelo índice interno. */
const NOSSOS = /(^|\.)(hiperverso\.(app|social)|exercitodolula\.app)$/i;

const PRIVADO = /^(localhost$|127\.|10\.|192\.168\.|169\.254\.|0\.0\.0\.0$|\[?::1\]?$|172\.(1[6-9]|2\d|3[01])\.)/i;

/** Arquivo não é página: imagem, vídeo e documento não entram num índice de texto. */
const EXTENSAO_DE_ARQUIVO =
  /\.(jpe?g|png|gif|webp|avif|svg|bmp|ico|mp4|webm|mov|m4v|mp3|m4a|ogg|wav|zip|rar|gz|7z|exe|dmg|apk)$/i;

/** Parâmetros que só servem para rastrear quem clicou: saem da URL canônica. */
const PARAMETRO_DE_RASTREIO = /^(utm_|fbclid|gclid|msclkid|mc_|_hs|ref$|ref_src$|igshid$|si$|s$|at_)/i;

/**
 * A URL canônica: o mesmo artigo com cinco endereços diferentes vira UM registro.
 * Sem isto o índice encheria de duplicata e a busca mostraria a mesma página cinco vezes.
 */
export function canonizar(bruta: string): { ok: true; url: string; host: string } | { ok: false; motivo: MotivoDeRecusa } {
  if (typeof bruta !== 'string' || bruta.length === 0) return { ok: false, motivo: 'url-invalida' };
  if (bruta.length > MAX_URL) return { ok: false, motivo: 'url-longa-demais' };

  let u: URL;
  try {
    u = new URL(bruta);
  } catch {
    return { ok: false, motivo: 'url-invalida' };
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { ok: false, motivo: 'nao-e-http' };

  const host = u.hostname.toLowerCase();
  if (!host.includes('.')) return { ok: false, motivo: 'host-privado' };
  if (PRIVADO.test(host)) return { ok: false, motivo: 'host-privado' };
  if (NOSSOS.test(host)) return { ok: false, motivo: 'host-nosso' };
  if (EXTENSAO_DE_ARQUIVO.test(u.pathname)) return { ok: false, motivo: 'arquivo-de-midia' };

  u.hash = '';
  u.username = '';
  u.password = '';
  u.hostname = host;
  for (const p of [...u.searchParams.keys()]) if (PARAMETRO_DE_RASTREIO.test(p)) u.searchParams.delete(p);
  // Ordem estável: `?b=2&a=1` e `?a=1&b=2` são a mesma página.
  u.searchParams.sort();
  if (u.pathname.endsWith('/') && u.pathname.length > 1) u.pathname = u.pathname.replace(/\/+$/, '');
  if (u.port === '80' || u.port === '443') u.port = '';

  return { ok: true, url: u.toString(), host };
}

export interface SinaisDaPagina {
  /** Cabeçalho `X-Robots-Tag` da resposta. */
  xRobotsTag?: string | null;
  /** Conteúdo de `<meta name="robots">`. */
  metaRobots?: string | null;
  /** Conteúdo de `<meta name="hiperverso-index">` — o opt-out dedicado desta rede. */
  metaHiperverso?: string | null;
}

/**
 * O site pediu para não ser indexado?
 *
 * Três caminhos, e qualquer um basta. O terceiro existe para quem quer recusar SÓ a gente, sem mexer no que diz aos
 * outros buscadores — pedir que alguém saia do Google inteiro para sair daqui seria um preço absurdo de cobrar.
 */
export function pediuParaNaoIndexar(sinais: SinaisDaPagina): boolean {
  const diz = (v: string | null | undefined) => (typeof v === 'string' ? v.toLowerCase() : '');
  const proibitivo = (v: string) => /\b(noindex|none)\b/.test(v);
  return (
    proibitivo(diz(sinais.xRobotsTag)) ||
    proibitivo(diz(sinais.metaRobots)) ||
    proibitivo(diz(sinais.metaHiperverso))
  );
}

export interface PaginaParaIndexar {
  url: string;
  host: string;
  titulo: string;
  descricao: string;
  imagem: string | null;
  idioma: string | null;
  publicadoEm: string | null;
}

export type Veredito =
  | { ok: true; pagina: PaginaParaIndexar }
  | { ok: false; motivo: MotivoDeRecusa };

const limpar = (v: unknown, teto: number): string =>
  typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, teto) : '';

/** Normaliza o idioma para duas letras. `pt-BR` e `pt_br` viram `pt`. */
export function idiomaCurto(bruto: unknown): string | null {
  if (typeof bruto !== 'string') return null;
  const m = bruto.trim().toLowerCase().match(/^([a-z]{2})(?:[-_][a-z0-9]+)*$/);
  return m ? m[1] : null;
}

/** Data de publicação, só se for uma data plausível. Data inventada ordenaria o índice errado. */
export function dataDePublicacao(bruto: unknown, agora: number = Date.now()): string | null {
  if (typeof bruto !== 'string' || bruto.trim() === '') return null;
  const t = Date.parse(bruto);
  if (!Number.isFinite(t)) return null;
  if (t < Date.UTC(1995, 0, 1) || t > agora + 7 * 86_400_000) return null;
  return new Date(t).toISOString();
}

/** Decide se esta página entra no índice, e com quais campos. */
export function avaliarParaIndice(
  urlBruta: string,
  dados: {
    titulo?: unknown;
    descricao?: unknown;
    imagem?: unknown;
    idioma?: unknown;
    publicadoEm?: unknown;
    sinais?: SinaisDaPagina;
  },
  agora: number = Date.now(),
): Veredito {
  const canon = canonizar(urlBruta);
  if (!canon.ok) return canon;
  if (dados.sinais && pediuParaNaoIndexar(dados.sinais)) return { ok: false, motivo: 'noindex' };

  let imagem: string | null = null;
  if (typeof dados.imagem === 'string' && dados.imagem.trim()) {
    try {
      const abs = new URL(dados.imagem, canon.url);
      if (abs.protocol === 'http:' || abs.protocol === 'https:') imagem = abs.toString().slice(0, MAX_URL);
    } catch {
      imagem = null;
    }
  }

  return {
    ok: true,
    pagina: {
      url: canon.url,
      host: canon.host,
      titulo: limpar(dados.titulo, MAX_TITULO),
      descricao: limpar(dados.descricao, MAX_DESCRICAO),
      imagem,
      idioma: idiomaCurto(dados.idioma),
      publicadoEm: dataDePublicacao(dados.publicadoEm, agora),
    },
  };
}

/** Identificador estável do registro: a mesma URL canônica sempre cai no mesmo lugar. */
export function chaveDaPagina(urlCanonica: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < urlCanonica.length; i++) {
    const c = urlCanonica.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 + c, 0x85ebca6b) >>> 0;
  }
  return (h1.toString(36) + h2.toString(36)).padStart(13, '0').slice(0, 20);
}
