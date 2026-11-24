// src/components/layout/MobileBottomNavigationBar.tsx
'use client';

import React, { useState, useEffect, useRef, useCallback } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { User as UserIcon, LogIn } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Skeleton } from '@/components/ui/skeleton';
import { Badge as UiBadge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import type { User } from '@/lib/types';
import { useLocale, useTranslations } from 'next-intl';
import { useIsMobile } from '@/hooks/use-mobile';

interface NavItem {
  href: string;
  label: string;
  icon: React.ElementType;
  requiresAuth: boolean;
  authHref?: (userId: string) => string; 
  showBadge?: boolean;
}

interface MobileBottomNavigationBarProps {
  currentUser: User | null | undefined;
  isLoadingCurrentUser: boolean;
  navItems: NavItem[];
  unreadNotifications: number;
  unreadMessages: number;
  pathname: string;
  setShowLoginPrompt: (show: boolean) => void;
  setPromptActionName: (action: string) => void;
}

const MobileBottomNavigationBar: React.FC<MobileBottomNavigationBarProps> = ({
  currentUser,
  isLoadingCurrentUser,
  navItems,
  unreadNotifications,
  unreadMessages,
  pathname,
  setShowLoginPrompt,
  setPromptActionName,
}) => {
  const t = useTranslations('MobileBottomNav');
  const locale = useLocale();
  const isMobileOrTablet = useIsMobile(); // This hook now covers up to 799px

  // This component should only render on screens 799px or less
  if (!isMobileOrTablet) {
    return null;
  }
  
  const profileNavItem: NavItem & { isProfileLink: boolean } = currentUser
    ? { href: `/${locale}/profile/${currentUser.id}`, label: t('profile'), icon: UserIcon, requiresAuth: true, isProfileLink: true, authHref: (id) => `/${locale}/profile/${id}` }
    : { href: `/${locale}/login`, label: t('login'), icon: LogIn, requiresAuth: false, isProfileLink: true };

  // Mantém a barra inferior limpa no padrão mobile (máx. 5 ações principais).
  // Rotas secundárias (Marcadores, Leitura limpa, Identidade P2P) ficam no menu gaveta.
  const visibleNavItems = navItems
    .filter(item => !item.requiresAuth || !!currentUser)
    .slice(0, 4);

  const allDisplayItems = [
    ...visibleNavItems,
    profileNavItem,
  ].filter(Boolean);


  return (
    // Some ao rolar para baixo e volta ao rolar para cima: veja `.chrome-bottom` (globals.css), movido por CSS e não por estado.
    <div className="chrome-bottom fixed bottom-0 left-0 right-0 h-14 bg-background border-t border-border shadow-md flex items-center justify-around z-40">
      {allDisplayItems.map((item) => {
        let actualHref = item.href;
        let isActive = false;
        let isEffectivelyDisabled = false;

        if (isLoadingCurrentUser && (item.requiresAuth || (item as any).isProfileLink)) {
          return (
            <div key={`${item.label}-skeleton-bottom-nav`} className="flex flex-1 flex-col items-center justify-center p-1">
              <Skeleton className="h-[36px] w-[36px] rounded-md" />
            </div>
          );
        } else if (item.requiresAuth && !currentUser) {
          isEffectivelyDisabled = true;
        } else if (item.requiresAuth && currentUser && item.authHref) {
          actualHref = item.authHref(currentUser.id);
        }
        
        const pathnameWithoutLocale = pathname.replace(`/${locale}`, '') || '/';
        const itemHrefWithoutLocale = item.href.replace(`/${locale}`, '') || '/';

        if ((item as any).isProfileLink && currentUser) isActive = pathnameWithoutLocale.startsWith(`/profile/${currentUser.id}`);
        else if (item.href.includes('/messages')) isActive = pathnameWithoutLocale.startsWith("/messages");
        else if (item.href.includes('/notifications')) isActive = pathnameWithoutLocale.startsWith("/notifications");
        else if (item.href.includes('/explore')) isActive = pathnameWithoutLocale.startsWith("/explore");
        else isActive = pathnameWithoutLocale === itemHrefWithoutLocale && !isEffectivelyDisabled;
        
        const isNotificationsItem = item.href.includes('/notifications');
        const isMessagesItem = item.href.includes('/messages');
        const count = isNotificationsItem ? unreadNotifications : isMessagesItem ? unreadMessages : 0;

        const handleClick = (e: React.MouseEvent) => {
          if (isEffectivelyDisabled) {
            e.preventDefault();
            setPromptActionName(t('promptAction', { action: item.label.toLowerCase() }));
            setShowLoginPrompt(true);
          }
        };

        return (
          <Button
            key={`${item.label}-mobile-bottom-nav`}
            variant="ghost"
            asChild={!isEffectivelyDisabled}
            onClick={handleClick}
            className={cn(
              "group flex flex-1 items-center justify-center p-1 h-full min-w-0 hover:bg-transparent focus-visible:bg-transparent",
              isActive ? "text-primary" : "text-muted-foreground",
              "hover:text-primary transition-colors relative"
            )}
            aria-label={item.label}
          >
            {isEffectivelyDisabled ? (
              <div className="flex items-center justify-center rounded-full px-3 py-1.5 transition-all duration-150 group-hover:bg-primary/10 group-hover:text-primary group-active:scale-95">
                {(item as any).isProfileLink && !currentUser ? (
                  <LogIn size={22} />
                ) : (
                  <item.icon size={22} />
                )}
              </div>
            ) : (
              <Link href={actualHref} className="flex items-center justify-center w-full h-full">
                {(item as any).isProfileLink && currentUser ? (
                  <Avatar className={cn(
                    "w-8 h-8 transition-transform duration-150 group-active:scale-95",
                    isActive && "ring-2 ring-primary ring-offset-1 ring-offset-background"
                  )}>
                    <AvatarImage src={currentUser.avatarUrl} alt={currentUser.name} data-ai-hint={currentUser["data-ai-hint"]}/>
                    <AvatarFallback>{currentUser.name?.substring(0,1) || '?'}</AvatarFallback>
                  </Avatar>
                ) : (
                  <div className={cn(
                    "relative flex items-center justify-center rounded-full px-3 py-1.5 transition-all duration-150 group-active:scale-95 group-hover:bg-primary/10 group-hover:text-primary",
                    isActive && "bg-primary/15 text-primary"
                  )}>
                    <item.icon size={22} className={cn(isActive && isMessagesItem && "fill-primary/25 stroke-[2.25]")} />
                    {item.showBadge && currentUser && count > 0 && (
                      <UiBadge variant="default" className="absolute -top-0.5 right-0 flex h-4 min-w-[1rem] items-center justify-center rounded-full px-1 text-[10px]">
                        {count > 9 ? '9+' : count}
                      </UiBadge>
                    )}
                  </div>
                )}
              </Link>
            )}
          </Button>
        );
      })}
    </div>
  );
};

export default MobileBottomNavigationBar;
