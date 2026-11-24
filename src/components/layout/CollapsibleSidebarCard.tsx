// src/components/layout/CollapsibleSidebarCard.tsx
'use client';

import React, { useId } from 'react';
import Link from 'next/link';
import type { LucideIcon } from 'lucide-react';
import { ArrowUpRight, ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils';

interface CollapsibleSidebarCardProps {
  id: string;
  icon: LucideIcon;
  title: string;
  description?: string;
  count?: number;
  collapsed: boolean;
  onToggle: () => void;
  headerActions?: React.ReactNode;
  footerLink?: { href: string; label: string };
  children: React.ReactNode;
}

/**
 * Card informativo colapsável para a barra lateral direita (padrão X).
 * Quando recolhido, compacta o conteúdo em uma linha discreta para limpar a leitura.
 */
export default function CollapsibleSidebarCard({
  id,
  icon: Icon,
  title,
  description,
  count,
  collapsed,
  onToggle,
  headerActions,
  footerLink,
  children,
}: CollapsibleSidebarCardProps) {
  const reactId = useId();
  const contentId = `sidebar-card-${id}-${reactId}`;

  return (
    <section
      aria-label={title}
      className="rounded-2xl border border-border/70 bg-card/50 transition-colors duration-200 hover:border-border"
    >
      <div className="flex items-center justify-between gap-2 px-5 py-3.5">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={!collapsed}
          aria-controls={contentId}
          className="flex min-w-0 flex-1 items-center gap-2.5 rounded-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Icon className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
          <span className="truncate text-[15px] font-bold tracking-tight text-foreground">
            {title}
          </span>
          {collapsed && typeof count === 'number' && count > 0 && (
            <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
              {count}
            </span>
          )}
          <ChevronDown
            className={cn(
              'ml-auto h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-200',
              collapsed ? '-rotate-90' : 'rotate-0'
            )}
            aria-hidden="true"
          />
        </button>

        {!collapsed && headerActions && (
          <div className="flex shrink-0 items-center gap-1">{headerActions}</div>
        )}
      </div>

      <div
        id={contentId}
        aria-hidden={collapsed}
        className={cn(
          'grid transition-[grid-template-rows,opacity] duration-200 ease-out motion-reduce:transition-none',
          collapsed ? 'grid-rows-[0fr] opacity-0' : 'grid-rows-[1fr] opacity-100'
        )}
      >
        <div className="overflow-hidden">
          <div className="px-5 pb-4 pt-1">
            {description && (
              <p className="mb-3 text-xs leading-relaxed text-muted-foreground">{description}</p>
            )}
            {children}
            {footerLink && (
              <Link
                href={footerLink.href}
                className="mt-3 inline-flex items-center gap-1 rounded-md text-xs font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {footerLink.label}
                <ArrowUpRight className="h-3 w-3" aria-hidden="true" />
              </Link>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
