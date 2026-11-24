'use client';

const TRANSITION_CLASS = 'hv-theme-transition';
const TRANSITION_DURATION_MS = 420;

let transitionTimeoutId: ReturnType<typeof setTimeout> | null = null;

/**
 * Alterna o tema do app de forma fluida usando View Transitions quando suportado,
 * ou uma transição CSS temporária em todo o documento.
 */
export function switchThemeFluid(
  setTheme: (theme: string) => void,
  nextTheme: string
): void {
  if (typeof document === 'undefined' || typeof window === 'undefined') {
    setTheme(nextTheme);
    return;
  }

  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
    setTheme(nextTheme);
    return;
  }

  const doc = document as Document & {
    startViewTransition?: (callback: () => void) => { finished?: Promise<void> };
  };

  if (typeof doc.startViewTransition === 'function') {
    doc.startViewTransition(() => {
      setTheme(nextTheme);
    });
    return;
  }

  const root = document.documentElement;
  root.classList.add(TRANSITION_CLASS);
  if (transitionTimeoutId !== null) {
    clearTimeout(transitionTimeoutId);
  }
  setTheme(nextTheme);
  transitionTimeoutId = setTimeout(() => {
    root.classList.remove(TRANSITION_CLASS);
    transitionTimeoutId = null;
  }, TRANSITION_DURATION_MS);
}
