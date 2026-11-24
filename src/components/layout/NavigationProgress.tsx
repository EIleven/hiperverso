'use client';

import React, { useEffect, useState } from 'react';
import { usePathname, useSearchParams } from 'next/navigation';
import { Loader2 } from 'lucide-react';
import PostCardSkeleton from '@/components/feed/PostCardSkeleton';

const NAV_START_EVENT = 'hv:nav-start';
const LOADING_PAGE_DELAY_MS = 85;
const SAFETY_TIMEOUT_MS = 8000;

export interface NavigationFeedbackState {
  isNavigating: boolean;
  showLoadingPage: boolean;
}

/**
 * Notifica o indicador global antes de chamadas programáticas (`router.push`),
 * garantindo resposta visual imediata antes mesmo da resposta do Next.js.
 */
export function notifyNavigationStart(): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(NAV_START_EVENT));
}

export function NavigationWatcher({
  onStateChange,
}: {
  onStateChange: (state: NavigationFeedbackState) => void;
}) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const routeKey = `${pathname}?${searchParams?.toString() ?? ''}`;

  useEffect(() => {
    let delayTimer: ReturnType<typeof setTimeout> | null = null;
    let safetyTimer: ReturnType<typeof setTimeout> | null = null;
    let active = false;

    const clearTimers = () => {
      if (delayTimer !== null) {
        clearTimeout(delayTimer);
        delayTimer = null;
      }
      if (safetyTimer !== null) {
        clearTimeout(safetyTimer);
        safetyTimer = null;
      }
    };

    const stopNavigation = () => {
      clearTimers();
      if (!active) return;
      active = false;
      onStateChange({ isNavigating: false, showLoadingPage: false });
    };

    const startNavigation = () => {
      clearTimers();
      active = true;
      onStateChange({ isNavigating: true, showLoadingPage: false });
      delayTimer = setTimeout(() => {
        if (active) {
          onStateChange({ isNavigating: true, showLoadingPage: true });
        }
      }, LOADING_PAGE_DELAY_MS);
      safetyTimer = setTimeout(stopNavigation, SAFETY_TIMEOUT_MS);
    };

    const handleClick = (event: MouseEvent) => {
      if (
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      ) {
        return;
      }

      const target = event.target as HTMLElement | null;
      const anchor = target?.closest('a[href]') as HTMLAnchorElement | null;
      if (!anchor) return;
      if (anchor.target && anchor.target !== '_self') return;
      if (anchor.hasAttribute('download')) return;

      const rawHref = anchor.getAttribute('href');
      if (!rawHref || rawHref.startsWith('#') || rawHref.startsWith('mailto:') || rawHref.startsWith('tel:')) {
        return;
      }

      try {
        const nextUrl = new URL(anchor.href, window.location.href);
        if (nextUrl.origin !== window.location.origin) return;
        const currentTarget = `${window.location.pathname}${window.location.search}`;
        const nextTarget = `${nextUrl.pathname}${nextUrl.search}`;
        if (currentTarget === nextTarget) return;
        startNavigation();
      } catch {
        // Ignora URLs malformadas
      }
    };

    const handlePopState = () => startNavigation();
    const handleCustomStart = () => startNavigation();

    document.addEventListener('click', handleClick, true);
    window.addEventListener('popstate', handlePopState);
    window.addEventListener(NAV_START_EVENT, handleCustomStart);

    return () => {
      clearTimers();
      document.removeEventListener('click', handleClick, true);
      window.removeEventListener('popstate', handlePopState);
      window.removeEventListener(NAV_START_EVENT, handleCustomStart);
    };
  }, [onStateChange]);

  useEffect(() => {
    onStateChange({ isNavigating: false, showLoadingPage: false });
  }, [routeKey, onStateChange]);

  return null;
}

export function NavigationProgressBar({ isNavigating }: { isNavigating: boolean }) {
  const [progress, setProgress] = useState(0);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    let trickleTimer: ReturnType<typeof setInterval> | null = null;
    let finishTimer: ReturnType<typeof setTimeout> | null = null;

    if (isNavigating) {
      setVisible(true);
      setProgress(22);
      trickleTimer = setInterval(() => {
        setProgress((prev) => {
          if (prev >= 86) return prev;
          return prev + Math.max(1.5, (88 - prev) * 0.16);
        });
      }, 140);
    } else if (visible) {
      setProgress(100);
      finishTimer = setTimeout(() => {
        setVisible(false);
        setProgress(0);
      }, 220);
    }

    return () => {
      if (trickleTimer !== null) clearInterval(trickleTimer);
      if (finishTimer !== null) clearTimeout(finishTimer);
    };
  }, [isNavigating, visible]);

  if (!visible) return null;

  return (
    <div
      aria-hidden="true"
      className="pointer-events-none fixed left-0 right-0 top-0 z-[100] h-[3px] overflow-hidden bg-transparent"
    >
      <div
        className="h-full bg-primary shadow-[0_0_12px_hsl(var(--primary)/0.65)] transition-[width,opacity] duration-200 ease-out"
        style={{
          width: `${progress}%`,
          opacity: progress >= 100 ? 0 : 1,
        }}
      />
    </div>
  );
}

export function PageTransitionSkeleton() {
  return (
    <div className="hv-page-enter w-full min-w-0" role="status" aria-live="polite" aria-label="Carregando página">
      <div className="flex items-center gap-2 border-b border-border/70 px-4 py-3 text-xs font-medium text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
        <span>Carregando página...</span>
      </div>
      <PostCardSkeleton />
      <PostCardSkeleton />
      <PostCardSkeleton />
    </div>
  );
}
