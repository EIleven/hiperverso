// src/components/layout/AppLayout.tsx
'use client';

import React, { useState, useEffect, useCallback, useMemo, cloneElement } from 'react';
import type { ReactElement } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { SidebarProvider } from '@/components/ui/sidebar';
import { useToast } from '@/hooks/use-toast';
import PostCardSkeleton from '@/components/feed/PostCardSkeleton';
import { useIsMobile } from '@/hooks/use-mobile';
import { cn } from '@/lib/utils';
import { useCurrentUser } from '@/contexts/CurrentUserContext';
import LoginOrRegisterPromptDialog from '@/components/auth/LoginOrRegisterPromptDialog';
import { logoutUser as serverLogoutUser } from '@/lib/services/authService';
import type { Post, User } from '@/lib/types';
import { useUnreadNotificationsCount } from '@/hooks/features/notifications/useUnreadNotificationsCount';
import { ToastAction } from '@/components/ui/toast';
import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { Home, TrendingUp, Bell, MessageSquare, Search, Newspaper, KeyRound } from 'lucide-react';

import DesktopSidebar from './DesktopSidebar';
import MobileBottomNavigationBar from './MobileBottomNavigationBar';
import FloatingComposeDock from './FloatingComposeDock';
import GlobalSearch from './GlobalSearch';
import RightSidebar from './RightSidebar';
import AppHeader from './AppHeader';
import ScrollChrome from './ScrollChrome';
import DeviceLoginApprover from '@/components/auth/DeviceLoginApprover';
import GlobalP2pListener from '@/components/messages/GlobalP2pListener';
import { VisitorWelcomeTour, MemberWelcomeTour } from '@/components/onboarding/QuickTourDialog';
import ManageFeedsDialog from '@/components/feed/ManageFeedsDialog';
import { HIGH_CONTRAST_THEME } from '@/lib/utils/themeColor';
import { useDynamicOfficialColor } from '@/hooks/useDynamicOfficialColor';
import { useTheme } from 'next-themes';
import { useHiperChatMode } from '@/hooks/useHiperChatMode';
import HiperChatShell from './HiperChatShell';
import { useHiperChatPreferences } from '@/hooks/useHiperChatPreferences';
import { useAvisoSonoro } from '@/hooks/useAvisoSonoro';

const AppLayoutContentSkeleton: React.FC = () => (
  <div className="w-full min-w-0">
    <PostCardSkeleton />
    <PostCardSkeleton />
    <PostCardSkeleton />
  </div>
);

interface AppLayoutProps {
  children: ReactElement;
}

const AppLayout = ({ children }: AppLayoutProps) => {
  const t = useTranslations('AppLayout');
  const { currentUser, firebaseUser, isLoading: isLoadingCurrentUser, refreshCurrentUser, logout } = useCurrentUser();
  const unreadNotificationsCount = useUnreadNotificationsCount(currentUser?.id);
  const unreadMessagesCount = currentUser?.totalUnreadMessages || 0;
  const locale = useLocale();

  const [isCreatePostDialogOpen, setIsCreatePostDialogOpen] = useState(false);
  const [isCreateNewsDialogOpen, setIsCreateNewsDialogOpen] = useState(false);
  const [isManageFeedsDialogOpen, setIsManageFeedsDialogOpen] = useState(false);
  const [clientHasMounted, setClientHasMounted] = useState(false);

  // Cor oficial da rede: se o usuário escolheu uma cor no perfil, respeita estritamente.
  // Se for visitante / não logado (ou sem cor definida), alterna dinamicamente
  // a cor oficial do Hiperverso a cada 5 minutos de forma sincronizada e profissional.
  const { theme } = useTheme();
  useDynamicOfficialColor({
    userAccentColor: currentUser?.accentColor,
    isHighContrast: theme === HIGH_CONTRAST_THEME,
  });

  const [showLoginPrompt, setShowLoginPrompt] = useState(false);
  const [promptActionName, setPromptActionName] = useState('');

  const router = useRouter();
  const pathname = usePathname();
  const { toast } = useToast();
  const isMobile = useIsMobile();
  
  useEffect(() => {
    setClientHasMounted(true);
  }, []);

  const navItems = [
    { href: `/${locale}`, label: t('nav.feed'), icon: Home, requiresAuth: false, showBadge: false },
    { href: `/${locale}/explore`, label: t('nav.explore'), icon: Search, requiresAuth: false, showBadge: false },
    { href: `/${locale}/messages`, label: t('nav.messages'), icon: MessageSquare, requiresAuth: true, authHref: () => `/${locale}/messages`, showBadge: true },
    { href: `/${locale}/notifications`, label: t('nav.notifications'), icon: Bell, requiresAuth: true, authHref: () => `/${locale}/notifications`, showBadge: true },
    { href: `/${locale}/breaknews`, label: 'Leitura limpa', icon: Newspaper, requiresAuth: true, showBadge: false },
    { href: `/${locale}/keys`, label: 'Identidade P2P', icon: KeyRound, requiresAuth: true, showBadge: false },
  ];

  const handleLogout = async () => {
    try {
      await serverLogoutUser();
      logout(); // This synchronously clears the state
      toast({ title: t('logoutSuccessTitle'), description: t('logoutSuccessDescription') });
      router.push(`/${locale}/login`);
    } catch (error: any) {
      toast({
        title: t('logoutErrorTitle'),
        description: error.message || t('logoutErrorDescription'),
        variant: 'destructive',
      });
    }
  };

  // Identidade fixa: o elemento da página abaixo só muda quando a página muda. Antes cada renderização do layout (uma
  // notificação nova, um contador de mensagens, a rolagem) recriava a função e o elemento e redesenhava a página inteira.
  const handlePostCreated = useCallback((newPost: Post) => {
    toast({
      title: newPost.category === 'news' ? t('articlePublished') : t('postSent'),
      action: (
        <ToastAction altText={t('viewPost')} asChild>
          <Link href={`/${locale}/post/${newPost.id}`}>{t('viewPost')}</Link>
        </ToastAction>
      ),
    });
    setIsCreatePostDialogOpen(false);
    setIsCreateNewsDialogOpen(false);

    if (typeof (window as any).handleGlobalPostCreation === 'function') {
      (window as any).handleGlobalPostCreation(newPost);
    }
  }, [locale, t, toast]);

  const childrenWithProps = useMemo(
    () => (React.isValidElement(children)
      ? cloneElement(children, { onPostCreated: handlePostCreated } as any)
      : children),
    [children, handlePostCreated],
  );

  const fabHiddenPaths = [
    `/${locale}/post`,
    `/${locale}/notifications`,
    `/${locale}/explore`,
    `/${locale}/search`,
    `/${locale}/settings`,
    `/${locale}/messages`,
    `/${locale}/keys`,
    `/${locale}/download`,
    `/${locale}/admin`,
    `/${locale}/files`,
    `/${locale}/drafts`,
    `/${locale}/bookmarks`,
    `/${locale}/share`,
    `/${locale}/dev`,
    `/${locale}/about`,
    `/${locale}/privacy`,
    `/${locale}/terms`,
    `/${locale}/cookies`,
    `/${locale}/community-guidelines`,
    `/${locale}/accessibility`,
    `/${locale}/manifesto`,
    `/${locale}/fediverse`,
    `/${locale}/advertising`,
    `/${locale}/help`,
    `/${locale}/login`,
    `/${locale}/register`,
    `/${locale}/auth`,
  ];
  const isFederatedLoginAccount = Boolean(
    (currentUser as (User & { federatedLoginProvider?: string }) | null)?.federatedLoginProvider
  );
  const canCreateContent = Boolean(firebaseUser?.emailVerified === true || isFederatedLoginAccount);
  const shouldShowFab = clientHasMounted && Boolean(currentUser) && canCreateContent
    && !fabHiddenPaths.some((path) => pathname.startsWith(path));
  
  // Dentro de uma conversa, no celular, a barra de abas sai de cena: ela é fixa no rodapé e disputava o mesmo lugar do
  // compositor com o teclado aberto — o botão de enviar ficava atrás dela. A conversa já tem cabeçalho com Voltar.
  const emConversaAberta =
    pathname.startsWith(`/${locale}/messages/user/`) || pathname.startsWith(`/${locale}/messages/group/`);
  const showMobileNav = clientHasMounted && isMobile && !emConversaAberta;
  // Mensagens são uma tarefa focada: no desktop a conversa usa a área central inteira, sem tendências e artigos ao lado.
  const isMessagesRoute = pathname.startsWith(`/${locale}/messages`);
  const isAuthRoute =
    pathname.startsWith(`/${locale}/login`) ||
    pathname.startsWith(`/${locale}/register`) ||
    pathname.startsWith(`/${locale}/auth`);
  const isHiperChat = useHiperChatMode();
  // O som é do HiperChat porque o botão que o desliga mora lá. No HiperVerso nada apita, como antes.
  const { preferencias: prefsDoChat } = useHiperChatPreferences(currentUser?.id);
  useAvisoSonoro(unreadMessagesCount, Boolean(isHiperChat && prefsDoChat.som));
  const isAllowedHiperChatRoute =
    isMessagesRoute ||
    isAuthRoute ||
    pathname.startsWith(`/${locale}/settings`);

  useEffect(() => {
    if (!clientHasMounted || !isHiperChat) return;
    if (!isAllowedHiperChatRoute) {
      router.replace(`/${locale}/messages`);
    }
  }, [clientHasMounted, isHiperChat, isAllowedHiperChatRoute, router, locale]);

  if (clientHasMounted && isHiperChat) {
    return (
      <>
        {currentUser && <GlobalP2pListener currentUser={currentUser} />}
        <HiperChatShell
          locale={locale}
          pathname={pathname}
          currentUser={currentUser}
          unreadMessages={unreadMessagesCount}
          isMobile={isMobile}
          onLogout={handleLogout}
        >
          {!isAuthRoute && isLoadingCurrentUser && !currentUser ? (
            <AppLayoutContentSkeleton />
          ) : (
            childrenWithProps
          )}
        </HiperChatShell>
        <DeviceLoginApprover />
      </>
    );
  }

  return (
    <>
      <ScrollChrome />
      <LoginOrRegisterPromptDialog
        open={showLoginPrompt}
        onOpenChange={setShowLoginPrompt}
        actionName={promptActionName}
        currentPath={pathname}
      />
      {currentUser && (
        <>
          <GlobalP2pListener currentUser={currentUser} />
          <MemberWelcomeTour user={currentUser} />
          <ManageFeedsDialog
            open={isManageFeedsDialogOpen}
            onOpenChange={setIsManageFeedsDialogOpen}
            user={currentUser}
            onPreferencesChanged={refreshCurrentUser}
          />
        </>
      )}
      <VisitorWelcomeTour isGuest={clientHasMounted && !isLoadingCurrentUser && !currentUser} />
      <div
        data-hv-conversa={emConversaAberta ? 'aberta' : undefined}
        data-hv-recibos={prefsDoChat.confirmacaoDeLeitura ? 'on' : 'off'}
        className={cn(
          'bg-background',
          // Numa conversa no celular a tela é toda da conversa: altura exata do que se vê, sem rolagem de página.
          // (min-h-screen sozinho mede a tela COM a barra do navegador escondida, e sobrava faixa vazia no rodapé.)
          emConversaAberta
            ? 'min-h-screen max-[799px]:h-[100dvh] max-[799px]:min-h-0 max-[799px]:overflow-hidden'
            : 'min-h-screen',
        )}
      >
        <SidebarProvider forceCollapsed={isMessagesRoute}>
          <div
            className={cn(
              'w-full',
              isMessagesRoute
                ? 'flex max-w-[1400px] mx-auto justify-center px-0 min-[801px]:px-4'
                : 'min-h-screen flex justify-center max-w-[1680px] mx-auto min-[800px]:grid min-[800px]:grid-cols-[minmax(76px,1fr)_minmax(0,660px)_minmax(76px,1fr)] min-[800px]:gap-x-4 min-[800px]:px-4 min-[1100px]:grid-cols-[minmax(76px,1fr)_minmax(0,660px)_minmax(272px,1fr)] min-[1100px]:gap-x-5 min-[1100px]:px-4 min-[1280px]:grid-cols-[minmax(240px,1fr)_minmax(0,660px)_minmax(280px,1fr)] min-[1280px]:gap-x-5 min-[1280px]:px-4 min-[1440px]:grid-cols-[minmax(260px,1fr)_minmax(0,720px)_minmax(300px,1fr)] min-[1440px]:gap-x-7 min-[1440px]:px-6 min-[1600px]:grid-cols-[minmax(276px,1fr)_minmax(0,780px)_minmax(310px,1fr)] min-[1600px]:gap-x-10 min-[1600px]:px-8'
            )}
          >
            <DesktopSidebar
              currentUser={currentUser}
              canCreateContent={canCreateContent}
              isLoadingCurrentUser={isLoadingCurrentUser}
              unreadNotifications={unreadNotificationsCount}
              unreadMessages={unreadMessagesCount}
              pathname={pathname}
              navItems={navItems}
              handleLogout={handleLogout}
              clientHasMounted={clientHasMounted}
              onManageFeedsClick={() => setIsManageFeedsDialogOpen(true)}
            />
            
            <main
              className={cn(
                'w-full min-w-0',
                isMessagesRoute
                  ? 'flex-1 max-w-[1200px]'
                  : 'max-w-[660px] min-[1440px]:max-w-[720px] min-[1600px]:max-w-[780px] justify-self-center min-h-screen min-[800px]:border-x min-[800px]:border-border/70'
              )}
            >
              <AppHeader unreadNotifications={unreadNotificationsCount} />
              {/* Dentro de uma conversa a tela tem altura exata: um aviso a mais aqui empurraria o compositor para fora
                  da área visível. O aviso continua em todas as outras telas, inclusive na lista de conversas. */}
              {clientHasMounted && firebaseUser && !firebaseUser.emailVerified && !isFederatedLoginAccount
                && !emConversaAberta
                && !pathname.startsWith(`/${locale}/auth/verify-email`) && (
                <div className="border-b border-amber-500/30 bg-amber-500/10 p-3 text-sm">
                  Confirme seu e-mail para publicar e interagir.{' '}
                  <Link className="font-medium underline" href={`/${locale}/auth/verify-email`}>Confirmar agora</Link>
                </div>
              )}
              {!clientHasMounted || (!isAuthRoute && isLoadingCurrentUser && !currentUser) ? (
                <AppLayoutContentSkeleton />
              ) : (
                childrenWithProps
              )}
            </main>

            {!isMessagesRoute && <RightSidebar unreadNotifications={unreadNotificationsCount} />}
          </div>
          
          {showMobileNav && (
            <MobileBottomNavigationBar
              currentUser={currentUser}
              isLoadingCurrentUser={isLoadingCurrentUser}
              navItems={navItems}
              unreadNotifications={unreadNotificationsCount}
              unreadMessages={unreadMessagesCount}
              pathname={pathname}
              setShowLoginPrompt={setShowLoginPrompt}
              setPromptActionName={setPromptActionName}
            />
          )}
          
          {shouldShowFab && (
            <FloatingComposeDock
              currentUser={currentUser}
              isLoadingCurrentUser={isLoadingCurrentUser}
              isCreatePostDialogOpen={isCreatePostDialogOpen}
              setIsCreatePostDialogOpen={setIsCreatePostDialogOpen}
              isCreateNewsDialogOpen={isCreateNewsDialogOpen}
              setIsCreateNewsDialogOpen={setIsCreateNewsDialogOpen}
              onPostCreated={handlePostCreated}
              clientHasMounted={clientHasMounted}
            />
          )}
        </SidebarProvider>
      </div>
      {/* Banner flutuante de instalação PWA removido para evitar poluição visual (download acessível em /download). */}
      <DeviceLoginApprover />
    </>
  );
};

export default AppLayout;
