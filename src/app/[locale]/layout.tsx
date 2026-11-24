
//home/user/studio/src/app/[locale]/layout.tsx
import type { Metadata, Viewport } from 'next';
import { notFound } from 'next/navigation';
import { NextIntlClientProvider } from 'next-intl';
import { getMessages } from 'next-intl/server';
import React from 'react';

import { Toaster } from "@/components/ui/toaster";
import AppLayout from '@/components/layout/AppLayout';
import { HiperversoMessagesHostProvider } from '@/modules/messages/hiperversoHost';
import { CurrentUserProvider } from '@/contexts/CurrentUserContext';
import { AuthProvider } from '@/contexts/AuthContext';
import { ThemeProvider } from '@/contexts/ThemeProvider';
import { siteConfig } from '@/config/site';
import { firebaseEnv } from '@/config/firebase';
import EmulatorBanner from '@/components/dev/EmulatorBanner';
import { FeedProvider } from '@/contexts/FeedContext';
import HapticsEffects from '@/components/system/HapticsEffects';
import PushBridge from '@/components/system/PushBridge';
import ProvenanceGuard from '@/components/system/ProvenanceGuard';
import SovereignEgressGuard from '@/components/system/SovereignEgressGuard';
import { SovereignAntiAutomationShield } from '@/components/system/SovereignAntiAutomationShield';
import BackButtonHandler from '@/components/system/BackButtonHandler';
import PwaUpdateNotifier from '@/components/pwa/PwaUpdateNotifier';
import ApkAutoUpdater from '@/components/system/ApkAutoUpdater';
import { CommentSettingsProvider } from '@/contexts/CommentSettingsContext';
import { ConsentProvider } from '@/contexts/ConsentContext';
import ConsentBanner from '@/components/consent/ConsentBanner';
import ConsentPreferencesDialog from '@/components/consent/ConsentPreferencesDialog';
import GoogleTagManager from '@/components/consent/GoogleTagManager';
import JsonLd from '@/components/shared/JsonLd';
import type { WithContext } from 'schema-dts';
import { WebSite } from 'schema-dts';

// Can be imported from a shared config
const locales = ['pt-BR', 'en'];
const SITE_NAME = siteConfig.name;
const SITE_DESCRIPTION = siteConfig.description;
const BASE_URL = siteConfig.baseUrl;

export const metadata: Metadata = {
  metadataBase: new URL(BASE_URL),
  title: {
    default: SITE_NAME,
    template: `%s | ${SITE_NAME}`,
  },
  description: SITE_DESCRIPTION,
  applicationName: SITE_NAME,
  manifest: "/manifest.webmanifest",
  appleWebApp: {
    capable: true,
    statusBarStyle: 'default',
    title: 'HiperVerso',
  },
  referrer: 'origin-when-cross-origin',
  alternates: {
    types: {
      'application/rss+xml': [{ url: '/feed.xml', title: 'HiperVerso (RSS)' }],
      'application/feed+json': [{ url: '/feed.json', title: 'HiperVerso (JSON Feed)' }],
    },
  },
  keywords: [
    'exe lula',
    'exercito do lula',
    'hiperverso',
    'hiperverso social',
    'hiperverso app',
    'fediverso brasileiro',
    'loja de apps br',
    'games br',
    'idp2p',
    'soberania digital',
    'social media',
    'news',
    'community',
  ],
  authors: [{ name: 'HiperVerso Team', url: BASE_URL }],
  creator: 'HiperVerso Team',
  publisher: 'HiperVerso',
  formatDetection: {
    email: false,
    address: false,
    telephone: false,
  },
  icons: {
    icon: '/favicon.ico',
    shortcut: [
      { url: '/favicon-16x16.png', sizes: '16x16', type: 'image/png' },
      { url: '/favicon-32x32.png', sizes: '32x32', type: 'image/png' },
    ],
    apple: [
      { url: '/apple-touch-icon.png', sizes: '180x180', type: 'image/png' },
    ],
  },
  openGraph: {
    type: 'website',
    title: {
      default: SITE_NAME,
      template: `%s | ${SITE_NAME}`,
    },
    description: SITE_DESCRIPTION,
    url: BASE_URL,
    siteName: SITE_NAME,
    images: [
      {
        url: `${BASE_URL}/exe-lula-og.png`,
        width: 1200,
        height: 630,
        alt: `Official ${SITE_NAME} Open Graph Image`
      },
    ],
    locale: 'pt_BR', // Default locale for OG
  },
  twitter: {
    card: 'summary_large_image',
    title: {
      default: SITE_NAME,
      template: `%s | ${SITE_NAME}`,
    },
    description: SITE_DESCRIPTION,
    images: [`${BASE_URL}/exe-lula-og.png`],
  },
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      'max-video-preview': -1,
      'max-image-preview': 'large',
      'max-snippet': -1,
    },
  },
  verification: {
    google: 'GOePk6RQvTH2ZlNFkQmqtHKF6Sd78GWTx83xHqBcuRc',
  },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  themeColor: "#0b5cff",
  // O teclado encolhe a página em vez de passar por cima dela. No app Android isso já acontece (adjustResize);
  // no navegador, sem esta linha, o compositor da conversa ficava atrás do teclado.
  interactiveWidget: 'resizes-content',
};


export default async function LocaleLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  // Validate that the incoming `locale` parameter is valid
  if (!locales.includes(locale as any)) notFound();
  
  // Receive messages provided in `i18n.ts`
  const messages = await getMessages({ locale });

  const webSiteSchema: WithContext<WebSite> = {
    '@context': 'https://schema.org',
    '@type': 'WebSite',
    name: siteConfig.name,
    alternateName: ['Hiperverso', 'Hiperverso Social', 'Hiperverso App', 'Exército do Lula'],
    url: siteConfig.baseUrl,
    description: siteConfig.description,
    sameAs: [
      'https://exercitodolula.app',
      'https://hiperverso.social',
      'https://hiperverso.app',
    ],
    potentialAction: {
      '@type': 'SearchAction',
      target: {
        '@type': 'EntryPoint',
        urlTemplate: `${siteConfig.baseUrl}/${locale}/search?q={search_term_string}`
      },
      'query-input': 'required name=search_term_string',
    },
    publisher: {
      '@type': 'Organization',
      name: 'HiperVerso / Hiperverso',
      alternateName: 'Hiperverso',
      url: siteConfig.baseUrl,
      sameAs: [
        'https://exercitodolula.app',
        'https://hiperverso.social',
        'https://hiperverso.app',
      ],
      logo: {
        '@type': 'ImageObject',
        url: `${siteConfig.baseUrl}/icons/icon-512.png`,
      },
    },
  };

  return (
    <>
      <JsonLd data={webSiteSchema} />
      <div className="sr-only">
        <h1>HiperVerso - A Fonte Soberana de Informação</h1>
        <p>
          Bem-vindo ao HiperVerso.
        </p>
      </div>
      {/*
        Nada do Google é injetado aqui. O Tag Manager fica em src/components/consent/, atrás do consentimento da
        pessoa — antes, o GTM carregava em TODA visita de produção, sem aviso e sem escolha, e o único freio era o
        modo emulador. O `<iframe>` de `<noscript>` do GTM saiu de vez: sem JavaScript não há como consentir, logo
        não há como medir.
        Publicidade não entra nesta lista porque não existe: o código de anúncios foi removido em 2026-11-19.
      */}

      {/* Preconnects and other head elements can be here or in metadata object */}
      <link rel="preconnect" href="https://firestore.googleapis.com" crossOrigin="anonymous" />
      <link rel="preconnect" href="https://firebasestorage.googleapis.com" crossOrigin="anonymous" />
      <link rel="preconnect" href="https://firebase.googleapis.com" crossOrigin="anonymous" />

      <NextIntlClientProvider locale={locale} messages={messages}>
        {/* O ConsentProvider envolve tudo: o rodapé e as configurações precisam reabrir o painel de preferências. */}
        <ConsentProvider>
          <ThemeProvider
            attribute="class"
            defaultTheme="dark"
            enableSystem
          >
            <AuthProvider>
              <CurrentUserProvider>
                <FeedProvider>
                  <CommentSettingsProvider>
                    <HiperversoMessagesHostProvider>
                      <AppLayout>
                        {children}
                      </AppLayout>
                    </HiperversoMessagesHostProvider>
                    <PwaUpdateNotifier />
                    <ApkAutoUpdater />
                  </CommentSettingsProvider>
                </FeedProvider>
                <Toaster />
                <HapticsEffects />
                <PushBridge />
                <SovereignEgressGuard />
                <SovereignAntiAutomationShield />
                <ProvenanceGuard />
                <BackButtonHandler />
              </CurrentUserProvider>
            </AuthProvider>
          </ThemeProvider>
          <GoogleTagManager />
          <ConsentBanner />
          <ConsentPreferencesDialog />
          {firebaseEnv.useEmulators && <EmulatorBanner />}
        </ConsentProvider>
      </NextIntlClientProvider>
    </>
  );
}
