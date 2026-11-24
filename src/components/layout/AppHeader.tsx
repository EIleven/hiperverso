// src/components/layout/AppHeader.tsx
'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import { useCurrentUser } from '@/contexts/CurrentUserContext';
import { Button } from '@/components/ui/button';
import Logo from '@/components/shared/Logo';
import GlobalSearch from './GlobalSearch';
import NotificationsBellButton from './NotificationsBellButton';
import { LogIn, UserPlus } from 'lucide-react';
import { useIsMobile } from '@/hooks/use-mobile';
import { cn } from '@/lib/utils';
import { useLocale } from 'next-intl';
import { SidebarTrigger } from '@/components/ui/sidebar'; // Importar o SidebarTrigger

interface AppHeaderProps {
  unreadNotifications?: number;
}

export default function AppHeader({ unreadNotifications = 0 }: AppHeaderProps) {
  const { currentUser, isLoading } = useCurrentUser();
  const [isSearchExpanded, setIsSearchExpanded] = useState(false);
  const locale = useLocale();

  return (
    // Some ao rolar para baixo e volta ao rolar para cima: veja `.chrome-header` (globals.css), movido por CSS e não por estado.
    <header className="chrome-header chrome-surface sticky top-0 z-30 grid h-12 grid-cols-3 items-center border-b border-border/70 px-2 sm:px-4 sm:h-14 min-[1100px]:hidden">
      {/* Left side: Login/Register Actions or Sidebar Trigger */}
      <div className="flex items-center justify-start gap-2">
        {isLoading ? null : currentUser ? (
            <div className="md:hidden"> {/* Só aparece em telas menores que 'md' */}
                 <SidebarTrigger />
            </div>
        ) : (
          <div className="flex items-center gap-1 sm:gap-2">
            <Button variant="ghost" size="icon" asChild>
              <Link href={`/${locale}/login`} aria-label="Login">
                <LogIn className="h-5 w-5" />
              </Link>
            </Button>
            <Button size="icon" asChild>
              <Link href={`/${locale}/register`} aria-label="Register">
                <UserPlus className="h-5 w-5" />
              </Link>
            </Button>
          </div>
        )}
      </div>

      {/* Center: Logo */}
      <div className={cn(
        "flex items-center justify-center",
        isSearchExpanded ? "hidden" : "flex"
      )}>
        <Logo />
      </div>

      {/* Right side: Notifications + Search */}
      <div className={cn(
        "flex items-center justify-end gap-1",
        isSearchExpanded && "col-span-3 -ml-12"
      )}>
        {!isSearchExpanded && !isLoading && currentUser && (
          <NotificationsBellButton unreadCount={unreadNotifications} variant="ghost" />
        )}
        <GlobalSearch isExpanded={isSearchExpanded} setIsExpanded={setIsSearchExpanded} />
      </div>
    </header>
  );
}
