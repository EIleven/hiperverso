// src/components/layout/DesktopSidebar.tsx
'use client';

import React, { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import {
  User,
  Settings,
  LogOut,
  LogIn,
  UserPlus,
  Newspaper,
  Edit,
  Bookmark,
  Folder,
  Shield,
  ListPlus,
  ArrowUp,
  MoreHorizontal,
  KeyRound,
  ArrowLeftRight,
  Sun,
  Moon,
  MailWarning,
} from 'lucide-react';
import {
  Sidebar,
  SidebarHeader,
  SidebarContent,
  SidebarFooter,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuButton,
  useSidebar,
} from '@/components/ui/sidebar';
import { Button } from '@/components/ui/button';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import type { User as UserType } from '@/lib/types';
import { compactCount, exactCountTitle } from '@/lib/media/videoQueue';
import { Badge as UiBadge } from '@/components/ui/badge';
import { useLocale, useTranslations } from 'next-intl';
import { useTheme } from 'next-themes';
import UniverseLensBar from '@/components/idp2p/UniverseLensBar';
import { switchThemeFluid } from '@/lib/utils/fluidTheme';
import {
  scrollToTopSmoothly,
  subscribeFeedScrollTarget,
  type FeedScrollTarget,
} from '@/lib/feedScrollTop';

interface NavItem {
  href: string;
  label: string;
  icon: React.ElementType;
  requiresAuth: boolean;
  authHref?: (userId: string) => string;
  showBadge?: boolean;
}

interface DesktopSidebarProps {
  currentUser: UserType | null | undefined;
  canCreateContent: boolean;
  isLoadingCurrentUser: boolean;
  unreadNotifications: number;
  unreadMessages: number;
  pathname: string;
  navItems: NavItem[];
  handleLogout: () => Promise<void>;
  clientHasMounted: boolean;
  onManageFeedsClick: () => void;
}

const PRIMARY_ORDER = ['/', '/explore', '/notifications', '/messages'];

const DesktopSidebar: React.FC<DesktopSidebarProps> = ({
  currentUser,
  canCreateContent,
  isLoadingCurrentUser,
  unreadNotifications,
  unreadMessages,
  pathname,
  navItems,
  handleLogout,
  clientHasMounted,
  onManageFeedsClick,
}) => {
  const t = useTranslations('DesktopSidebar');
  const locale = useLocale();
  const { state: sidebarState } = useSidebar();
  const { resolvedTheme, setTheme } = useTheme();
  const [accountSwitcherOpen, setAccountSwitcherOpen] = useState(false);

  const isCompact = sidebarState === 'collapsed';
  const pathnameWithoutLocale = pathname.replace(`/${locale}`, '') || '/';

  // Mantém a ordem no padrão X: Início, Explorar, Notificações, Mensagens.
  // Rotas secundárias (Leitura limpa / Identidade P2P) vão para o menu "Mais".
  const primaryNavItems = PRIMARY_ORDER.map((routeSuffix) =>
    navItems.find((item) => (item.href.replace(`/${locale}`, '') || '/') === routeSuffix)
  ).filter((item): item is NavItem => Boolean(item));

  const navButtonClass = cn(
    'h-12 rounded-full text-[15.5px] gap-3.5 px-3.5 text-sidebar-foreground/85 transition-colors',
    'hover:bg-muted/60 hover:text-foreground',
    'data-[active=true]:bg-transparent data-[active=true]:font-bold data-[active=true]:text-foreground',
    isCompact && 'px-0 justify-center w-11 mx-auto'
  );

  const isDark = resolvedTheme !== 'light';
  const toggleTheme = () => {
    switchThemeFluid(setTheme, isDark ? 'light' : 'dark');
  };

  return (
    <Sidebar
      variant="sidebar"
      collapsible="icon"
      className="hidden md:flex relative h-screen sticky top-0 justify-self-start transition-[width] duration-200"
      style={{ width: isCompact ? '76px' : 'var(--sidebar-left-width)' }}
    >
      {/* Topo limpo: somente marca no padrão X (perfil foi removido do topo) */}
      <SidebarHeader className={cn('px-3 pt-4 pb-2', isCompact && 'px-2 items-center')}>
        <Link
          href={`/${locale}`}
          aria-label="HiperVerso Início"
          className={cn(
            'inline-flex items-center gap-2.5 rounded-full p-2 transition-colors hover:bg-muted/60 group',
            isCompact && 'justify-center'
          )}
        >
          <span
            aria-hidden="true"
            className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-primary/15 text-primary border border-primary/30 font-black text-sm tracking-tight group-hover:bg-primary/20 transition-colors"
          >
            HV
          </span>
          <span
            className={cn(
              'text-lg font-bold tracking-tight text-foreground group-hover:text-primary transition-colors',
              isCompact && 'hidden'
            )}
          >
            HiperVerso
          </span>
        </Link>
      </SidebarHeader>

      <SidebarContent className="px-2 py-1">
        <SidebarMenu className="gap-1.5">
          {primaryNavItems.map((item) => {
            if (item.requiresAuth && !currentUser && clientHasMounted) {
              return null;
            }

            if (!clientHasMounted || (item.requiresAuth && isLoadingCurrentUser)) {
              return (
                <SidebarMenuItem key={`${item.label}-loading-desktop`}>
                  <SidebarMenuButton asChild tooltip={item.label} className={cn(navButtonClass, 'pointer-events-none opacity-50')}>
                    <Link href="#" aria-disabled={true} tabIndex={-1} style={{ pointerEvents: 'none' }}>
                      <Skeleton className="h-5 w-5 rounded-sm shrink-0" />
                      <Skeleton className={cn('h-4 w-24 rounded-sm', isCompact && 'hidden')} />
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              );
            }

            let actualHref = item.href;
            if (item.requiresAuth && currentUser && item.authHref) {
              actualHref = item.authHref(currentUser.id);
            }

            const itemHrefWithoutLocale = item.href.replace(`/${locale}`, '') || '/';
            let isActive = false;
            if (item.href.includes('/messages')) isActive = pathnameWithoutLocale.startsWith('/messages');
            else if (item.href.includes('/notifications')) isActive = pathnameWithoutLocale.startsWith('/notifications');
            else if (item.href.includes('/explore')) isActive = pathnameWithoutLocale.startsWith('/explore');
            else isActive = pathnameWithoutLocale === itemHrefWithoutLocale;

            const isNotificationsItem = item.href.includes('/notifications');
            const isMessagesItem = item.href.includes('/messages');
            const count = isNotificationsItem ? unreadNotifications : isMessagesItem ? unreadMessages : 0;

            return (
              <SidebarMenuItem key={`${item.label}-desktop`}>
                <SidebarMenuButton asChild tooltip={item.label} isActive={isActive} className={navButtonClass}>
                  <Link href={actualHref}>
                    <div className="relative shrink-0">
                      <item.icon className={cn('h-5 w-5', isActive && 'stroke-[2.4]')} />
                      {item.showBadge && clientHasMounted && currentUser && !isLoadingCurrentUser && count > 0 && (
                        <UiBadge
                          variant="default"
                          className="pointer-events-none absolute -top-1.5 -right-2 flex h-[18px] min-w-[18px] items-center justify-center rounded-full border-0 px-1 py-0 text-[10px] font-bold leading-none tabular-nums ring-2 ring-background"
                        >
                          {count > 99 ? '99+' : count}
                        </UiBadge>
                      )}
                    </div>
                    <span className={cn(isCompact && 'hidden')}>{item.label}</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
            );
          })}

          {clientHasMounted && currentUser && (
            <>
              <SidebarMenuItem key="bookmarks-desktop">
                <SidebarMenuButton
                  asChild
                  tooltip={t('bookmarks')}
                  isActive={pathnameWithoutLocale.startsWith('/bookmarks')}
                  className={navButtonClass}
                >
                  <Link href={`/${locale}/bookmarks`}>
                    <Bookmark className={cn('h-5 w-5 shrink-0', pathnameWithoutLocale.startsWith('/bookmarks') && 'stroke-[2.4]')} />
                    <span className={cn(isCompact && 'hidden')}>{t('bookmarks')}</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>

              <SidebarMenuItem key="profile-desktop">
                <SidebarMenuButton
                  asChild
                  tooltip={t('nav.profile')}
                  isActive={pathnameWithoutLocale.startsWith(`/profile/${currentUser.id}`)}
                  className={navButtonClass}
                >
                  <Link href={`/${locale}/profile/${currentUser.id}`}>
                    <User
                      className={cn(
                        'h-5 w-5 shrink-0',
                        pathnameWithoutLocale.startsWith(`/profile/${currentUser.id}`) && 'stroke-[2.4]'
                      )}
                    />
                    <span className={cn(isCompact && 'hidden')}>{t('nav.profile')}</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </>
          )}

          {/* Menu "Mais" no padrão X agrupando itens secundários e alternância fluida de tema */}
          {clientHasMounted && (
            <SidebarMenuItem key="more-desktop">
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <SidebarMenuButton tooltip="Mais" className={navButtonClass}>
                    <MoreHorizontal className="h-5 w-5 shrink-0" />
                    <span className={cn(isCompact && 'hidden')}>Mais</span>
                  </SidebarMenuButton>
                </DropdownMenuTrigger>
                <DropdownMenuContent side="right" align="start" className="w-56 rounded-2xl p-1.5">
                  {currentUser && (
                    <>
                      <DropdownMenuItem onClick={onManageFeedsClick} className="rounded-xl cursor-pointer gap-2.5 py-2">
                        <ListPlus className="h-4 w-4 text-muted-foreground" />
                        <span>{t('feeds')}</span>
                      </DropdownMenuItem>
                      <DropdownMenuItem asChild className="rounded-xl cursor-pointer gap-2.5 py-2">
                        <Link href={`/${locale}/breaknews`}>
                          <Newspaper className="h-4 w-4 text-muted-foreground" />
                          <span>Leitura limpa</span>
                        </Link>
                      </DropdownMenuItem>
                      <DropdownMenuItem asChild className="rounded-xl cursor-pointer gap-2.5 py-2">
                        <Link href={`/${locale}/keys`}>
                          <KeyRound className="h-4 w-4 text-muted-foreground" />
                          <span>Identidade P2P</span>
                        </Link>
                      </DropdownMenuItem>
                      <DropdownMenuItem asChild className="rounded-xl cursor-pointer gap-2.5 py-2">
                        <Link href={`/${locale}/drafts`}>
                          <Edit className="h-4 w-4 text-muted-foreground" />
                          <span>{t('drafts')}</span>
                        </Link>
                      </DropdownMenuItem>
                      <DropdownMenuItem asChild className="rounded-xl cursor-pointer gap-2.5 py-2">
                        <Link href={`/${locale}/files`}>
                          <Folder className="h-4 w-4 text-muted-foreground" />
                          <span>{t('files')}</span>
                        </Link>
                      </DropdownMenuItem>
                      {currentUser.isAdmin && (
                        <DropdownMenuItem asChild className="rounded-xl cursor-pointer gap-2.5 py-2">
                          <Link href={`/${locale}/admin`}>
                            <Shield className="h-4 w-4 text-muted-foreground" />
                            <span>{t('adminPanel')}</span>
                          </Link>
                        </DropdownMenuItem>
                      )}
                      <DropdownMenuSeparator />
                    </>
                  )}

                  <DropdownMenuItem onClick={toggleTheme} className="rounded-xl cursor-pointer gap-2.5 py-2">
                    {isDark ? (
                      <Sun className="h-4 w-4 text-muted-foreground" />
                    ) : (
                      <Moon className="h-4 w-4 text-muted-foreground" />
                    )}
                    <span>{isDark ? 'Modo claro' : 'Modo escuro'}</span>
                  </DropdownMenuItem>

                  {currentUser && (
                    <DropdownMenuItem asChild className="rounded-xl cursor-pointer gap-2.5 py-2">
                      <Link href={`/${locale}/settings`}>
                        <Settings className="h-4 w-4 text-muted-foreground" />
                        <span>{t('settings')}</span>
                      </Link>
                    </DropdownMenuItem>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            </SidebarMenuItem>
          )}
        </SidebarMenu>
      </SidebarContent>

      {/* Rodapé com pill compacta da conta no padrão X */}
      <SidebarFooter className={cn('mt-auto p-3 pb-5', isCompact && 'px-2 items-center')}>
        {!clientHasMounted || isLoadingCurrentUser ? (
          <Skeleton className={cn('h-12 rounded-full', isCompact ? 'w-11' : 'w-full')} />
        ) : currentUser ? (
          <>
            <UniverseLensBar
              userId={currentUser.id}
              name={currentUser.name}
              avatarUrl={currentUser.avatarUrl}
              username={currentUser.username}
              federatedLoginProvider={currentUser.federatedLoginProvider}
              federatedLoginHandle={currentUser.federatedLoginHandle}
              compact={isCompact}
              headless
              controlledSwitcherOpen={accountSwitcherOpen}
              onControlledSwitcherOpenChange={setAccountSwitcherOpen}
            />

            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  aria-label={`Conta de ${currentUser.name}`}
                  className={cn(
                    'flex w-full items-center gap-2.5 rounded-full p-2 text-left transition-colors hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                    isCompact && 'w-11 h-11 justify-center p-0'
                  )}
                >
                  <Avatar className="h-9 w-9 shrink-0 ring-1 ring-border">
                    <AvatarImage
                      src={currentUser.avatarUrl}
                      alt={currentUser.name}
                      data-ai-hint={currentUser['data-ai-hint'] || 'person avatar'}
                    />
                    <AvatarFallback className="text-sm font-semibold">
                      {currentUser.name?.substring(0, 1) || '?'}
                    </AvatarFallback>
                  </Avatar>
                  <div className={cn('min-w-0 flex-1', isCompact && 'hidden')}>
                    <p className="truncate text-sm font-semibold leading-tight text-foreground">
                      {currentUser.name}
                    </p>
                    <p className="truncate text-xs text-muted-foreground">
                      @{currentUser.username}
                    </p>
                  </div>
                  <MoreHorizontal
                    className={cn('h-4 w-4 shrink-0 text-muted-foreground', isCompact && 'hidden')}
                    aria-hidden="true"
                  />
                </button>
              </DropdownMenuTrigger>

              <DropdownMenuContent side="top" align="start" className="w-60 rounded-2xl p-1.5">
                <DropdownMenuLabel className="px-2.5 py-2 font-normal">
                  <p className="truncate text-sm font-bold text-foreground">{currentUser.name}</p>
                  <p className="truncate text-xs text-muted-foreground">@{currentUser.username}</p>
                  <div className="mt-2 flex items-center gap-3 text-xs text-muted-foreground">
                    <Link
                      href={`/${locale}/profile/${currentUser.id}/following`}
                      className="hover:underline"
                      title={exactCountTitle(currentUser.followingCount)}
                    >
                      <span className="font-bold text-foreground">
                        {compactCount(currentUser.followingCount)}
                      </span>{' '}
                      {t('following')}
                    </Link>
                    <Link
                      href={`/${locale}/profile/${currentUser.id}/followers`}
                      className="hover:underline"
                      title={exactCountTitle(currentUser.followersCount)}
                    >
                      <span className="font-bold text-foreground">
                        {compactCount(currentUser.followersCount)}
                      </span>{' '}
                      {t('followers')}
                    </Link>
                  </div>
                </DropdownMenuLabel>
                <DropdownMenuSeparator />

                <DropdownMenuItem asChild className="rounded-xl cursor-pointer gap-2.5 py-2">
                  <Link href={`/${locale}/profile/${currentUser.id}`}>
                    <User className="h-4 w-4 text-muted-foreground" />
                    <span>Meu perfil</span>
                  </Link>
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() => setAccountSwitcherOpen(true)}
                  className="rounded-xl cursor-pointer gap-2.5 py-2"
                >
                  <ArrowLeftRight className="h-4 w-4 text-muted-foreground" />
                  <span>Trocar de conta / IDP2P</span>
                </DropdownMenuItem>
                {!canCreateContent && (
                  <DropdownMenuItem asChild className="rounded-xl cursor-pointer gap-2.5 py-2 text-amber-500 focus:text-amber-500">
                    <Link href={`/${locale}/auth/verify-email`}>
                      <MailWarning className="h-4 w-4" />
                      <span>Confirmar e-mail</span>
                    </Link>
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem asChild className="rounded-xl cursor-pointer gap-2.5 py-2">
                  <Link href={`/${locale}/settings`}>
                    <Settings className="h-4 w-4 text-muted-foreground" />
                    <span>{t('settings')}</span>
                  </Link>
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onClick={handleLogout}
                  className="rounded-xl cursor-pointer gap-2.5 py-2 text-destructive focus:text-destructive"
                >
                  <LogOut className="h-4 w-4" />
                  <span>{t('logout')}</span>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        ) : (
          <div className={cn('space-y-2', isCompact && 'hidden')}>
            <Button variant="outline" className="w-full rounded-full" asChild>
              <Link href={`/${locale}/login`}>
                <LogIn className="mr-2 h-4 w-4" /> {t('login')}
              </Link>
            </Button>
            <Button className="w-full rounded-full" asChild>
              <Link href={`/${locale}/register`}>
                <UserPlus className="mr-2 h-4 w-4" /> {t('register')}
              </Link>
            </Button>
            <div className="flex flex-wrap items-center justify-center gap-x-2 gap-y-1 pt-1 text-center text-xs text-sidebar-foreground/60">
              <Link href={`/${locale}/terms`} className="hover:underline">
                {t('terms')}
              </Link>
              <span>&middot;</span>
              <Link href={`/${locale}/privacy`} className="hover:underline">
                {t('privacy')}
              </Link>
              <span>&middot;</span>
              <Link href={`/${locale}/community-guidelines`} className="hover:underline">
                {t('guidelines')}
              </Link>
              <span>&middot;</span>
              <Link href={`/${locale}/cookies`} className="hover:underline">
                {t('cookies')}
              </Link>
            </div>
          </div>
        )}
      </SidebarFooter>

      <DesktopScrollTopButton isCompact={isCompact} />
    </Sidebar>
  );
};

const SHOW_DESKTOP_SCROLL_TOP_AFTER = 300;

function DesktopScrollTopButton({ isCompact }: { isCompact: boolean }) {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [feedTarget, setFeedTarget] = useState<FeedScrollTarget | null>(null);

  useEffect(() => subscribeFeedScrollTarget(setFeedTarget), []);

  useEffect(() => {
    let rafId = 0;
    const syncVisibility = () => {
      rafId = 0;
      const button = buttonRef.current;
      if (!button) return;
      const shouldShow = window.scrollY > SHOW_DESKTOP_SCROLL_TOP_AFTER;
      if ((button.dataset.visible === 'true') === shouldShow) return;
      button.dataset.visible = shouldShow ? 'true' : 'false';
      button.setAttribute('aria-hidden', shouldShow ? 'false' : 'true');
      button.tabIndex = shouldShow ? 0 : -1;
    };
    const onScroll = () => {
      if (rafId !== 0) return;
      rafId = window.requestAnimationFrame(syncVisibility);
    };
    syncVisibility();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      window.removeEventListener('scroll', onScroll);
      if (rafId !== 0) window.cancelAnimationFrame(rafId);
    };
  }, []);

  const hasNewPosts = feedTarget?.hasNewPosts === true;
  const label = hasNewPosts ? 'Voltar ao topo e ver novos posts' : 'Voltar ao topo';

  return (
    <div
      className={cn(
        'pointer-events-none absolute z-30',
        isCompact ? 'bottom-24 left-1/2 -translate-x-1/2' : 'bottom-24 right-3'
      )}
    >
      <Button
        ref={buttonRef}
        type="button"
        variant={hasNewPosts ? 'default' : 'secondary'}
        size="icon"
        onClick={() => scrollToTopSmoothly(feedTarget)}
        aria-label={label}
        title={label}
        aria-hidden="true"
        data-visible="false"
        tabIndex={-1}
        className={cn(
          'relative h-10 w-10 rounded-full shadow-lg transition-all duration-200 pointer-events-none scale-90 opacity-0',
          'data-[visible=true]:scale-100 data-[visible=true]:opacity-100 data-[visible=true]:pointer-events-auto',
          'hover:scale-105 active:scale-95',
          hasNewPosts
            ? 'bg-primary text-primary-foreground hover:bg-primary/90 ring-2 ring-primary/25'
            : 'bg-card/95 text-foreground border border-border hover:border-primary/60 hover:bg-primary hover:text-primary-foreground'
        )}
      >
        <ArrowUp className="h-5 w-5" aria-hidden="true" />
        {hasNewPosts && (
          <span
            className="absolute -top-0.5 -right-0.5 h-2.5 w-2.5 rounded-full bg-emerald-400 ring-2 ring-background"
            aria-hidden="true"
          />
        )}
      </Button>
    </div>
  );
}

export default DesktopSidebar;
