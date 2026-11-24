'use client';

const TRANSITION_CLASS = 'hv-theme-transition';
const TRANSITION_DURATION_MS = 480;

let transitionTimeoutId: ReturnType<typeof setTimeout> | null = null;

/**
 * Alterna o tema do app de forma fluida aplicando transição CSS temporária
 * sincronizada antes da troca de classe do `next-themes` (evita o corte brusco
 * causado por snapshots assíncronos de ViewTransition).
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

  const root = document.documentElement;
  root.classList.add(TRANSITION_CLASS);
  // Garante que o navegador calcule os estilos atuais com transição ativa antes da troca de tema.
  void root.offsetWidth;

  if (transitionTimeoutId !== null) {
    clearTimeout(transitionTimeoutId);
  }
  setTheme(nextTheme);
  transitionTimeoutId = setTimeout(() => {
    root.classList.remove(TRANSITION_CLASS);
    transitionTimeoutId = null;
  }, TRANSITION_DURATION_MS);
}
