import createIntlMiddleware from 'next-intl/middleware';
import { NextResponse, type NextRequest } from 'next/server';
import { evaluateRequestSecurity } from '@/lib/security/antiBotGuard';

const locales = ['pt-BR', 'en'];

const intlMiddleware = createIntlMiddleware({
  locales,
  defaultLocale: 'pt-BR',
});

export default function middleware(request: NextRequest) {
  const rawHost = (request.headers.get('x-forwarded-host') || request.headers.get('host') || '')
    .split(':')[0]
    .toLowerCase();

  if (rawHost === 'www.hiperverso.app' || rawHost === 'www.hiperverso.social') {
    const apexHost = rawHost.slice(4);
    const target = new URL(`${request.nextUrl.pathname}${request.nextUrl.search}`, `https://${apexHost}`);
    return NextResponse.redirect(target, 308);
  }

  // Prefetches internos do Next.js (navegação suave entre links/abas) passam direto sem contar no rate-limit
  const isNextPrefetchOrRsc =
    request.headers.get('next-router-prefetch') === '1' ||
    request.headers.get('purpose') === 'prefetch' ||
    request.headers.get('rsc') === '1';

  // Em desenvolvimento local, desabilita o bloqueio anti-bot para permitir QA/testes automatizados;
  // em produção permanece sempre ativo.
  const isDevelopment = process.env.NODE_ENV === 'development';

  if (!isDevelopment && !isNextPrefetchOrRsc) {
    const ip =
      (request.headers.get('x-forwarded-for') || '').split(',')[0]?.trim() ||
      request.headers.get('x-real-ip') ||
      'unknown';
    const hasHumanOrConsent =
      request.cookies.get('__hv_human')?.value === '1' ||
      Boolean(request.cookies.get('NEXT_LOCALE')?.value);
    const ownerQaToken =
      request.headers.get('x-soberan-owner-key') ||
      request.cookies.get('__soberan_owner_qa')?.value ||
      null;

    const verdict = evaluateRequestSecurity({
      ip,
      path: request.nextUrl.pathname,
      query: request.nextUrl.search ? request.nextUrl.search.slice(1) : '',
      method: request.method,
      userAgent: request.headers.get('user-agent'),
      acceptLanguage: request.headers.get('accept-language'),
      acceptHeader: request.headers.get('accept'),
      secChUa: request.headers.get('sec-ch-ua'),
      webdriverHeader: request.headers.get('sec-ch-ua-webdriver'),
      ownerQaToken,
      hasHumanCookie: hasHumanOrConsent,
      isAuthenticated: Boolean(
        request.cookies.get('__session')?.value || request.headers.get('authorization')
      ),
    });

    // Só bloqueia quando for realmente 'block' (scanners nmap/sqlmap, bots de IA/CLI explícitos ou DDoS pesado)
    if (verdict.action === 'block') {
      return new NextResponse('Acesso automatizado nao autorizado bloqueado.', {
        status: 403,
        headers: {
          'Content-Type': 'text/plain; charset=utf-8',
          'Cache-Control': 'no-store, no-cache, must-revalidate',
          'Retry-After': String(verdict.retryAfterSec || 30),
          'X-Robots-Tag': 'noindex, nofollow, noarchive, nosnippet, noimageindex, noai, noimageai',
        },
      });
    }
  }

  if (request.method === 'GET') {
    const accept = (request.headers.get('accept') || '').toLowerCase();
    const wantsAp =
      accept.includes('application/activity+json') || accept.includes('application/ld+json');
    if (wantsAp) {
      const match = request.nextUrl.pathname.match(/^\/(?:pt-BR|en)\/post\/([A-Za-z0-9_-]+)\/?$/);
      if (match?.[1]) {
        return NextResponse.rewrite(new URL(`/ap/notes/${match[1]}`, request.url));
      }
    }
  }

  const response = intlMiddleware(request);
  response.headers.set('X-Robots-Tag', 'noai, noimageai');
  if (request.cookies.get('__hv_bot')) {
    response.cookies.delete('__hv_bot');
  }
  return response;
}

export const config = {
  matcher: [
    '/((?!(?:api|ap|_next|_vercel|\\.well-known|m|mp|nodeinfo|offline|feed\\.json|feed\\.xml|downloads|icons|brand)(?:/|$)|.*\\..*).*)',
  ],
};
