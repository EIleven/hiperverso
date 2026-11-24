// src/components/layout/NotificationsBellButton.tsx
'use client';

import React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Bell } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

interface NotificationsBellButtonProps {
  unreadCount?: number;
  variant?: 'pill' | 'ghost';
  className?: string;
}

/**
 * Botão rápido de notificações posicionado ao lado da busca (desktop e mobile),
 * exibindo contador de não lidas e destaque quando a rota ativa é /notifications.
 */
export default function NotificationsBellButton({
  unreadCount = 0,
  variant = 'pill',
  className,
}: NotificationsBellButtonProps) {
  const locale = useLocale();
  const pathname = usePathname();
  const t = useTranslations('DesktopSidebar');

  const pathnameWithoutLocale = pathname.replace(`/${locale}`, '') || '/';
  const isActive = pathnameWithoutLocale.startsWith('/notifications');
  const label = t('nav.notifications');

  return (
    <Button
      asChild
      variant="ghost"
      size="icon"
      className={cn(
        'relative shrink-0 rounded-full transition-colors',
        variant === 'pill'
          ? 'h-10 w-10 border border-border/70 bg-muted/40 hover:bg-muted/70'
          : 'h-9 w-9',
        isActive && 'border-primary/50 bg-primary/10 text-primary hover:bg-primary/15',
        className
      )}
    >
      <Link href={`/${locale}/notifications`} aria-label={label} title={label}>
        <Bell className={cn('h-5 w-5', isActive && 'stroke-[2.3]')} aria-hidden="true" />
        {unreadCount > 0 && (
          <Badge
            variant="default"
            className="absolute -top-1 -right-1 flex h-4 min-w-[1rem] items-center justify-center rounded-full px-1 text-[10px] leading-none"
          >
            {unreadCount > 9 ? '9+' : unreadCount}
          </Badge>
        )}
      </Link>
    </Button>
  );
}
