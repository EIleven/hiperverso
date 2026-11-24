
// next.config.ts
import type { NextConfig } from 'next';
import createNextIntlPlugin from 'next-intl/plugin';
import withPWAInit from 'next-pwa';
import { siteConfig } from './src/config/site';

const withNextIntl = createNextIntlPlugin('./src/i18n.ts');

const withPWA = withPWAInit({
  dest: 'public',
  register: true,
  buildExcludes: [/app-build-manifest\.json$/],
  // O APK em public/downloads/ (milhões de bytes) não pode entrar no pré-cache do service worker de todo visitante.
  // A imagem de compartilhamento (OG) também não: só robôs de redes sociais a leem.
  publicExcludes: ['!noprecache/**/*', '!downloads/**/*', '!exe-lula-og.png'],
  skipWaiting: true,
  disable: process.env.NODE_ENV === 'development',
  // O start_url "/" redireciona para o idioma e o cache de start-url do next-pwa guardaria uma resposta vazia
  // (opaqueredirect convertido em 200): o app instalado abriria em branco sem rede em vez de mostrar /offline.
  dynamicStartUrl: false,
  cacheStartUrl: false,
  fallbacks: {
    document: '/offline',
  },
  // Cache de runtime RESTRITO. O padrão do next-pwa guardava por 24 h o HTML e o RSC de rotas privadas e, por 1 h,
  // TODA resposta GET de outra origem: tráfego do Firestore, downloads do Storage com token na URL e chamadas com
  // Authorization. Os arquivos estáticos do build e de public/ já estão no pré-cache; navegações vão sempre à rede
  // (sem isso o fallback offline não dispara) e todo o resto, incluindo APIs e dados do Firebase, nunca é guardado.
  // As funções são serializadas no service worker: precisam ser autossuficientes (sem variáveis externas).
  runtimeCaching: [
    {
      urlPattern: ({ request, sameOrigin }: { request: Request; sameOrigin: boolean }) =>
        sameOrigin && request.mode === 'navigate',
      handler: 'NetworkOnly',
      options: { cacheName: 'navegacao' },
    },
  ],
});

const nextConfig: NextConfig = {
  // 1. Habilita React Strict Mode
  reactStrictMode: true,

  // 1.1 Oculta o indicador flutuante do Next.js Dev Tools sobre a interface
  devIndicators: false,

  // 2. Remove o header "X-Powered-By"
  poweredByHeader: false,

  // 3. Gzip/Brotli ao voar
  compress: true,

  // 4. TypeScript / ESLint relaxados em build (se for imprescindível)
  typescript: {
    ignoreBuildErrors: true,
  },
  eslint: {
    ignoreDuringBuilds: true,
  },

  // 5. Cabeçalhos de segurança + controle de cache
  async headers() {
    return [
      // ── Cabeçalhos de segurança, em TODA página ──
      //
      // Estes quatro não dependem de nada do app e não quebram tela nenhuma; deveriam estar aqui desde sempre.
      // `frame-ancestors 'none'` fecha clickjacking: sem ele, o site pode ser carregado dentro de um iframe
      // invisível de outro domínio, com um botão falso por cima — a pessoa pensa que clica numa coisa e clica em
      // outra, dentro da sessão dela.
      //
      // Não entra aqui um CSP completo (`default-src`, `script-src`). Um CSP apertado num app Next sem o nonce
      // montado página a página quebra a aplicação inteira, e um CSP frouxo dá falsa sensação de proteção. O
      // caminho certo é medir antes de bloquear: ver `Content-Security-Policy-Report-Only` abaixo.
      {
        source: '/:path*',
        headers: [
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Content-Security-Policy', value: "frame-ancestors 'none'" },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          // HSTS: o navegador passa a recusar http neste domínio. Hospedagem é só https, então não corta ninguém.
          { key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains' },
          // Nada de câmera, microfone ou localização por padrão: o app pede o que precisa via plugin nativo.
          { key: 'Permissions-Policy', value: 'camera=(self), microphone=(self), geolocation=(), interest-cohort=()' },
        ],
      },
      // Download do app Android: tipo correto para o instalador e latest.json sempre revalidado (versão nova aparece na hora).
      {
        source: '/downloads/:file*.apk',
        headers: [
          { key: 'Content-Type', value: 'application/vnd.android.package-archive' },
          { key: 'Cache-Control', value: 'public, max-age=300' },
        ],
      },
      {
        source: '/downloads/latest.json',
        headers: [{ key: 'Cache-Control', value: 'no-cache' }],
      },
      {
        source: '/post/:postId*',
        headers: [
          {
            key: 'Cache-Control',
            value: 'public, max-age=0, s-maxage=60, stale-while-revalidate=300',
          },
        ],
      },
    ];
  },

  // Domínio canônico: www.* redireciona (308) para o domínio principal, preservando caminho e consulta.
  // A decisão usa SOMENTE o cabeçalho Host. O destino é a constante oficial (nunca derivado de cabeçalhos do
  // cliente, então não há open redirect) e x-forwarded-host NÃO é considerado, pois pode ser forjado.
  // O redirecionamento principal também deve existir no provedor de hospedagem; este é a rede de segurança.
  async redirects() {
    return [
      {
        source: '/:path*',
        has: [{ type: 'host' as const, value: siteConfig.wwwHost.replace(/\./g, '\\.') }],
        destination: `${siteConfig.officialOrigin}/:path*`,
        permanent: true,
      },
    ];
  },

  // 6. Permitir imagens de terceiros e desabilitar otimizador em dev
  images: {
    remotePatterns: [
      { protocol: 'https', hostname: 'firebasestorage.googleapis.com' },
      { protocol: 'https', hostname: 'placehold.co' },
      { protocol: 'https', hostname: 'img.youtube.com' },
      { protocol: 'https', hostname: 'i.ytimg.com' },
      { protocol: 'https', hostname: 'cdn.bsky.app' },
      { protocol: 'https', hostname: 'media.licdn.com' },
      { protocol: 'https', hostname: 'uploads.intercept.com.br' },
      { protocol: 'https', hostname: 'pbs.twimg.com' },
      { protocol: 'https', hostname: 'avatars.githubusercontent.com' },
      { protocol: 'https', hostname: 'www.gravatar.com' },
      { protocol: 'https', hostname: 'i.imgur.com' },
      { protocol: 'https', hostname: 'media.giphy.com' },
      { protocol: 'https', hostname: 'cdn.sanity.io' },
      { protocol: 'https', hostname: 'cdn.discordapp.com' },
      { protocol: 'https', hostname: 'player.vimeo.com' },
      { protocol: 'https', hostname: 'i.vimeocdn.com' },
      { protocol: 'https', hostname: 'cdn.jsdelivr.net' },
      { protocol: 'https', hostname: 'unpkg.com' },
      { protocol: 'https', hostname: 'fonts.gstatic.com' },
      { protocol: 'https', hostname: 'cdn.shopify.com' },
      { protocol: 'https', hostname: 'caras.uol.com.br' },
      { protocol: 'http', hostname: '**' },
      { protocol: 'https', hostname: '**' },
    ],
    // Força a desativação do otimizador de imagem para contornar problemas no ambiente de desenvolvimento/estúdio.
    unoptimized: true,
  },

  // Aqui você pode adicionar outras chaves oficiais do Next.js:
  // - redirects()
  // - rewrites()
  // - i18n
  // 7. Experimentos (úteis, mas em Beta)
  experimental: {
    // mantém o histórico de scroll ao navegar pelo App Router
    scrollRestoration: true,
  },

  // 8. Metadados sempre dentro de <head>. Desde o Next 15.2, para quem não é robô de busca os metadados
  // (manifest, título, ícones, theme-color, Open Graph) são enviados em streaming DENTRO do <body>, e o Chrome só
  // lê <link rel="manifest"> como filho de <head>: sem isso o app nunca aparece como instalável ("no-manifest").
  // Casar todos os user agents desliga o streaming de metadados (o comportamento do Next 15.1 e anteriores).
  htmlLimitedBots: /.*/,
};

export default withPWA(withNextIntl(nextConfig));
