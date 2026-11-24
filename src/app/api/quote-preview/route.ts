// src/app/api/quote-preview/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { LRUCache } from 'lru-cache';
import { getPublicPostById as getOwnPost } from '@/lib/services/postReadService';
import { adminFirestore } from '@/lib/server/firebaseAdmin';
import { JSDOM, VirtualConsole } from 'jsdom';
import type { Post } from '@/lib/types';
import { siteConfig } from '@/config/site';
import { assertSafeUrl, safeFetchText, UnsafeUrlError } from '@/lib/security/safe-fetch';
import { registrarFonte, sinaisDoDocumento } from '@/lib/fontes/registrarFonte';
import { requestIp, takeRateLimit } from '@/lib/server/requestAuth';
import { evaluateRequestSecurity } from '@/lib/security/antiBotGuard';

const PREVIEWS_PER_WINDOW = 120;
const PREVIEW_WINDOW_MS = 10 * 60 * 1000;
const PREVIEW_CACHE_HEADERS = {
  'Cache-Control': 'public, max-age=300, s-maxage=1800, stale-while-revalidate=3600',
};

interface CachedPreviewResult {
  status: number;
  body: unknown;
}

const previewCache = new LRUCache<string, CachedPreviewResult>({
  max: 1000,
  ttl: 30 * 60 * 1000,
});
const inFlightPreviews = new Map<string, Promise<CachedPreviewResult>>();

// Links para posts do próprio site (o domínio oficial e o www) viram o post; posts federados viram citação nativa ActivityPub; o resto vira pré-visualização de artigo.
const OWN_HOST_REGEX = new RegExp(`(^|\\.)${siteConfig.officialHost.replace(/\./g, '\\.')}$`);
const FEDIVERSE_STATUS_PATH_REGEX = /\/(?:@[^/]+\/\d+|users\/[^/]+\/statuses\/\d+|ap\/users\/[^/]+\/statuses\/\d+|notes\/[a-zA-Z0-9_-]+|statuses\/\d+)/i;

function stripHtmlToText(html: string): string {
  if (!html) return '';
  try {
    const dom = new JSDOM(`<body>${html}</body>`, { virtualConsole: new VirtualConsole() });
    return (dom.window.document.body.textContent || '').replace(/\s+/g, ' ').trim();
  } catch {
    return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  }
}

async function resolveFediverseStatusPreview(urlToPreview: string, parsedUrl: URL): Promise<Record<string, unknown> | null> {
  // Primeiro tenta localizar se este post federado já está indexado no HiperVerso
  try {
    const db = adminFirestore();
    const byApId = await db.collection('posts').where('apId', '==', urlToPreview).limit(1).get();
    const docSnap = !byApId.empty
      ? byApId.docs[0]
      : (await db.collection('posts').where('externalUrl', '==', urlToPreview).limit(1).get()).docs[0];
    if (docSnap?.exists) {
      const own = await getOwnPost(docSnap.id);
      if (own) return own as unknown as Record<string, unknown>;
    }
  } catch {
    // Fallback para busca ActivityPub direta
  }

  if (!FEDIVERSE_STATUS_PATH_REGEX.test(parsedUrl.pathname)) return null;

  try {
    const res = await safeFetchText(urlToPreview, {
      headers: {
        'Accept': 'application/activity+json, application/ld+json; profile="https://www.w3.org/ns/activitystreams", application/json',
        'User-Agent': `${siteConfig.name}/1.0 (+https://${siteConfig.officialHost})`,
      },
    });
    if (!res.ok) return null;
    const trimmed = res.text.trim();
    if (!trimmed.startsWith('{')) return null;

    const apObj = JSON.parse(trimmed) as Record<string, any>;
    const obj = apObj?.type === 'Create' && apObj?.object && typeof apObj.object === 'object' ? apObj.object : apObj;
    if (!obj || (obj.type !== 'Note' && obj.type !== 'Article' && typeof obj.content !== 'string')) {
      return null;
    }

    const cleanText = stripHtmlToText(String(obj.content || obj.summary || ''));
    const attachments = Array.isArray(obj.attachment) ? obj.attachment : obj.attachment ? [obj.attachment] : [];
    const media = attachments
      .filter((att: any) => att?.url && (String(att?.mediaType || '').startsWith('image/') || String(att?.mediaType || '').startsWith('video/') || att?.type === 'Image' || att?.type === 'Video'))
      .map((att: any) => ({
        url: String(att.url),
        type: String(att?.mediaType || '').startsWith('video/') || att?.type === 'Video' ? 'video' : 'image',
        alt: typeof att.name === 'string' ? att.name : '',
      }));

    let authorName = parsedUrl.hostname;
    let authorUsername = parsedUrl.hostname;
    let avatarUrl = `https://www.google.com/s2/favicons?domain=${parsedUrl.hostname}&sz=64`;

    const attributedTo = typeof obj.attributedTo === 'string' ? obj.attributedTo : obj.attributedTo?.id;
    if (typeof attributedTo === 'string' && attributedTo.startsWith('http')) {
      try {
        assertSafeUrl(attributedTo);
        const actorRes = await safeFetchText(attributedTo, {
          headers: {
            'Accept': 'application/activity+json, application/ld+json; profile="https://www.w3.org/ns/activitystreams"',
            'User-Agent': `${siteConfig.name}/1.0 (+https://${siteConfig.officialHost})`,
          },
        });
        if (actorRes.ok && actorRes.text.trim().startsWith('{')) {
          const actor = JSON.parse(actorRes.text) as Record<string, any>;
          if (actor.name || actor.preferredUsername) {
            authorName = String(actor.name || actor.preferredUsername);
          }
          if (actor.preferredUsername) {
            authorUsername = `${actor.preferredUsername}@${new URL(attributedTo).hostname}`;
          }
          if (actor.icon?.url) {
            avatarUrl = String(actor.icon.url);
          }
        }
      } catch {
        // Segue com dados básicos do domínio
      }
    }

    const handleMatch = parsedUrl.pathname.match(/\/@([^/]+)\//);
    if (authorUsername === parsedUrl.hostname && handleMatch?.[1]) {
      authorUsername = `${handleMatch[1]}@${parsedUrl.hostname}`;
      if (authorName === parsedUrl.hostname) authorName = handleMatch[1];
    }

    return {
      id: String(obj.id || urlToPreview),
      isFediverseQuote: true,
      fediverseHandle: authorUsername.startsWith('@') ? authorUsername : `@${authorUsername}`,
      apObjectUrl: String(obj.id || urlToPreview),
      headline: authorName,
      text: cleanText,
      media,
      hasMedia: media.length > 0,
      sourceUrl: String(obj.url || urlToPreview),
      user: {
        id: String(attributedTo || parsedUrl.hostname),
        name: authorName,
        username: authorUsername,
        avatarUrl,
      },
      createdAt: String(obj.published || new Date().toISOString()),
    };
  } catch {
    return null;
  }
}

// Function to clean up the article content, copied from extract-article route
const cleanArticleContent = (element: Element): string => {
    const content = element.cloneNode(true) as Element;
    const unwantedTags = ['script', 'style', 'nav', 'footer', 'aside', 'form', 'button', 'iframe', 'header'];
    unwantedTags.forEach(tag => {
        content.querySelectorAll(tag).forEach(el => el.remove());
    });
    const unwantedSelectors = [
        '[class*="ad"]', '[id*="ad"]', '[class*="social"]', '[id*="social"]',
        '[class*="comment"]', '[id*="comment"]', '[class*="subscribe"]', '[id*="subscribe"]',
        '[class*="related"]', '[id*="related"]', '[class*="popup"]', '[id*="popup"]'
    ];
    unwantedSelectors.forEach(selector => {
         content.querySelectorAll(selector).forEach(el => el.remove());
    });
    return content.innerHTML;
};

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const ip = requestIp(request);
  const guard = evaluateRequestSecurity({
    ip,
    path: '/api/quote-preview',
    userAgent: request.headers.get('user-agent'),
    acceptLanguage: request.headers.get('accept-language'),
  });
  if (!guard.allowed && guard.action === 'block') {
    return NextResponse.json(
      { message: 'Bloqueio temporário anti-bot.' },
      { status: 429, headers: { 'Retry-After': String(guard.retryAfterSec || 30) } }
    );
  }
  const urlToPreview = request.nextUrl.searchParams.get('url');
  if (!urlToPreview || !urlToPreview.startsWith('http')) {
    return NextResponse.json(
      { message: 'A valid URL parameter is required' },
      { status: 400 }
    );
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(urlToPreview);
  } catch {
    // "http" ou "http://" sozinhos passam na checagem acima e não são endereços: erro de quem pediu, não do servidor.
    return NextResponse.json({ message: 'A valid URL parameter is required' }, { status: 400 });
  }

  try {
    const { hostname, pathname } = parsedUrl;

    // 1. Posts do próprio site
    if (OWN_HOST_REGEX.test(hostname)) {
      const match = pathname.match(/\/(?:[a-zA-Z]{2}-[a-zA-Z]{2}\/)?post\/([a-zA-Z0-9]+)/);
      if (match?.[1]) {
        const postData = await getOwnPost(match[1]);
        if (!postData) {
          return NextResponse.json({ message: 'Post not found or inaccessible' }, { status: 404 });
        }
        return NextResponse.json(postData);
      }
    }

    // 2. URLs genéricas (leitura do artigo). A busca roda no servidor, então passa por safeFetchText: recusa endereços
    // internos (SSRF, inclusive o servidor de metadados do Google Cloud), confere cada redirecionamento e limita tempo,
    // tamanho e tipo de conteúdo. Veja src/lib/security/safe-fetch.ts.
    // A prévia é pública (visitantes também veem citações de links), mas com limite por IP para não virar robô de busca.
    if (!takeRateLimit(`preview:${requestIp(request)}`, PREVIEWS_PER_WINDOW, PREVIEW_WINDOW_MS)) {
      return NextResponse.json({ message: 'Muitas prévias em pouco tempo. Tente de novo em alguns minutos.' }, { status: 429 });
    }
    try {
      assertSafeUrl(urlToPreview);
    } catch (error) {
      if (error instanceof UnsafeUrlError) return NextResponse.json({ message: 'Esta URL não é permitida.' }, { status: 400 });
      return NextResponse.json({ message: 'A valid URL parameter is required' }, { status: 400 });
    }
    const cacheKey = parsedUrl.toString();
    const cached = previewCache.get(cacheKey);
    if (cached) {
      return NextResponse.json(cached.body, {
        status: cached.status,
        headers: cached.status === 200 ? PREVIEW_CACHE_HEADERS : undefined,
      });
    }

    let pending = inFlightPreviews.get(cacheKey);
    if (!pending) {
      pending = (async (): Promise<CachedPreviewResult> => {
        const fediversePost = await resolveFediverseStatusPreview(urlToPreview, parsedUrl);
        if (fediversePost) {
          const okFed = { status: 200, body: fediversePost };
          previewCache.set(cacheKey, okFed);
          return okFed;
        }
        let response;
        try {
          response = await safeFetchText(urlToPreview, {
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/109.0.0.0 Safari/537.36',
              'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
            },
          });
        } catch (error) {
          if (error instanceof UnsafeUrlError) return { status: 400, body: { message: 'Esta URL não é permitida.' } };
          // O site do link não respondeu (não existe, recusou a conexão, demorou): é problema do LINK, não do nosso servidor.
          console.warn('[quote-preview] não foi possível acessar o link:', String((error as Error)?.message ?? error));
          const failResult = { status: 422, body: { message: 'Não foi possível acessar este link.' } };
          previewCache.set(cacheKey, failResult, { ttl: 5 * 60 * 1000 });
          return failResult;
        }

        // O site respondeu com erro (404, 403, 5xx...): sem prévia, mas isto não é um defeito do nosso servidor (antes virava 500).
        if (!response.ok) {
          const failResult = { status: 422, body: { message: `Não foi possível ler este link (o site respondeu ${response.status}).` } };
          previewCache.set(cacheKey, failResult, { ttl: 5 * 60 * 1000 });
          return failResult;
        }

        const html = response.text;
        // Console silencioso: o jsdom despeja no log do servidor cada folha de estilo que não consegue interpretar.
        const dom = new JSDOM(html, { url: urlToPreview, virtualConsole: new VirtualConsole() });
        const document = dom.window.document;

        const title = document.querySelector('meta[property="og:title"]')?.getAttribute('content') ||
                      document.querySelector('meta[name="twitter:title"]')?.getAttribute('content') ||
                      document.querySelector('title')?.textContent ||
                      document.querySelector('h1')?.textContent ||
                      'No title found';

        const mainImageUrl = document.querySelector('meta[property="og:image"]')?.getAttribute('content') ||
                             document.querySelector('meta[name="twitter:image"]')?.getAttribute('content') ||
                             null;

        const selectors = ['article', '[class*="article-body"]', '[class*="post-content"]', 'main'];
        let bestCandidate: Element | null = null;
        for (const selector of selectors) {
          const element = document.querySelector(selector);
          if (element) {
            bestCandidate = element;
            break;
          }
        }

        const description = document.querySelector('meta[property="og:description"]')?.getAttribute('content') ||
                          document.querySelector('meta[name="description"]')?.getAttribute('content') ||
                          (bestCandidate ? bestCandidate.textContent?.substring(0, 200) : '') || '';

        // ── Índice de Fontes ──
        // A página já foi buscada porque alguém colou o link: o custo está pago. Em vez de jogar fora o que foi
        // lido, guarda-se o resumo — e o índice cresce sem UMA requisição a mais e sem rastrear ninguém.
        //
        // `void` de propósito: quem está esperando é uma pessoa olhando a prévia. Gravar no índice não pode
        // atrasar essa tela, e uma falha aqui não pode estragá-la. A política de SE pode entrar (noindex, host
        // nosso, arquivo de mídia) mora em lib/fontes/politicaDeIndexacao.ts.
        void registrarFonte({
          urlOriginal: response.finalUrl || urlToPreview,
          titulo: title,
          descricao: description,
          imagem: mainImageUrl,
          idioma:
            document.querySelector('html')?.getAttribute('lang') ||
            document.querySelector('meta[property="og:locale"]')?.getAttribute('content') ||
            null,
          publicadoEm:
            document.querySelector('meta[property="article:published_time"]')?.getAttribute('content') ||
            document.querySelector('time[datetime]')?.getAttribute('datetime') ||
            null,
          sinais: sinaisDoDocumento(document, response.headers),
        }).catch(() => {});

        // Construct a Post-like object for the preview card
        const previewData: Partial<Post> = {
          id: urlToPreview,
          headline: title,
          text: description.substring(0, 300), // Use description as text preview
          media: mainImageUrl ? [{ url: new URL(mainImageUrl, urlToPreview).href, type: 'image', alt: title }] : [],
          hasMedia: !!mainImageUrl,
          category: 'news',
          sourceUrl: urlToPreview,
          user: { // Mock a generic user for the source
            id: hostname,
            name: hostname.replace(/^www\./, ''),
            username: hostname.replace(/\./g, '').substring(0, 15),
            avatarUrl: `https://www.google.com/s2/favicons?domain=${hostname}&sz=64`
          } as any,
          createdAt: new Date().toISOString(),
          // Fill other required fields
          type: 'original', allowReposts: true, replyPermission: 'everyone', visibility: 'public',
          isEdited: false, editCount: 0, postFormat: 'standard',
          likes: 0, reposts: 0, quotesCount: 0, commentsCount: 0, views: 0,
        };

        const okResult = { status: 200, body: previewData };
        previewCache.set(cacheKey, okResult);
        return okResult;
      })().finally(() => {
        inFlightPreviews.delete(cacheKey);
      });
      inFlightPreviews.set(cacheKey, pending);
    }

    const result = await pending;
    return NextResponse.json(result.body, {
      status: result.status,
      headers: result.status === 200 ? PREVIEW_CACHE_HEADERS : undefined,
    });

  } catch (err: any) {
    console.error('[quote-preview] error fetching generic preview:', err);
    return NextResponse.json(
      { message: err.message || 'Error generating URL preview' },
      { status: 500 }
    );
  }
}
