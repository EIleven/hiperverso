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
  const badgeText = unreadCount > 99 ? '99+' : String(unreadCount);
  const accessibleLabel = unreadCount > 0 ? `${label} (${unreadCount} não lidas)` : label;

  return (
    <Button
      asChild
      variant="ghost"
      size="icon"
      className={cn(
        'relative shrink-0 overflow-visible rounded-full transition-colors',
        variant === 'pill'
          ? 'h-10 w-10 border border-border/70 bg-muted/40 hover:bg-muted/70'
          : 'h-9 w-9',
        isActive && 'border-primary/50 bg-primary/10 text-primary hover:bg-primary/15',
        className
      )}
    >
      <Link href={`/${locale}/notifications`} aria-label={accessibleLabel} title={accessibleLabel}>
        <Bell className={cn('h-5 w-5', isActive && 'stroke-[2.3]')} aria-hidden="true" />
        {unreadCount > 0 && (
          <Badge
            variant="default"
            aria-hidden="true"
            className="pointer-events-none absolute -top-0.5 -right-0.5 flex h-[18px] min-w-[18px] items-center justify-center rounded-full border-0 px-1 py-0 text-[10px] font-bold leading-none tabular-nums shadow-sm ring-2 ring-background"
          >
            {badgeText}
          </Badge>
        )}
      </Link>
    </Button>
  );
}
