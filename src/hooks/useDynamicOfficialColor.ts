// src/hooks/useDynamicOfficialColor.ts
'use client';

import { useEffect, useRef, useState } from 'react';
import {
  applyDocumentAccentColor,
  transitionDocumentAccentColor,
  getOfficialDynamicColor,
  isValidHexColor,
  OFFICIAL_ROTATION_INTERVAL_MS,
  type NetworkThemeColor,
} from '@/lib/utils/themeColor';

interface UseDynamicOfficialColorOptions {
  userAccentColor?: string | null;
  isHighContrast?: boolean;
}

/**
 * Hook do Hiperverso:
 * Alterna a cor oficial da rede a cada 5 minutos para visitantes e usuários
 * que não possuem cor personalizada definida no perfil.
 *
 * Características:
 * - Se o usuário logado tem cor personalizada (`userAccentColor`), ela é preservada intacta.
 * - Para visitantes, sincroniza em blocos de 5 minutos (:00, :05, :10, etc.) no mundo inteiro.
 * - Atualiza na hora ao voltar à aba após suspensão/segundo plano (`visibilitychange`).
 * - Em modo alto contraste, respeita acessibilidade estrita (sem sobreposição de estilos inline).
 */
export function useDynamicOfficialColor({
  userAccentColor,
  isHighContrast = false,
}: UseDynamicOfficialColorOptions = {}) {
  const hasCustomAccent = isValidHexColor(userAccentColor);

  const [currentColor, setCurrentColor] = useState<NetworkThemeColor>(() =>
    getOfficialDynamicColor()
  );
  const isFirstApplyRef = useRef(true);

  useEffect(() => {
    let cancelAccentTransition: (() => void) | null = null;

    // 1. Aplicação imediata no primeiro carregamento; transições subsequentes são fluidas.
    if (isFirstApplyRef.current) {
      isFirstApplyRef.current = false;
      applyDocumentAccentColor(userAccentColor, {
        highContrast: isHighContrast,
        fallbackToDynamicOfficial: true,
      });
    } else {
      cancelAccentTransition = transitionDocumentAccentColor(userAccentColor, {
        highContrast: isHighContrast,
        fallbackToDynamicOfficial: true,
        durationMs: 480,
      });
    }

    // Se estiver em alto contraste ou se o usuário escolheu uma cor própria,
    // não precisa do temporizador de rotação dinâmico da rede.
    if (isHighContrast || hasCustomAccent) {
      return () => {
        cancelAccentTransition?.();
      };
    }

    let intervalId: ReturnType<typeof setInterval> | null = null;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;

    const refreshOfficialColor = () => {
      const next = getOfficialDynamicColor();
      setCurrentColor(next);
      cancelAccentTransition?.();
      cancelAccentTransition = transitionDocumentAccentColor(undefined, {
        highContrast: false,
        fallbackToDynamicOfficial: true,
        durationMs: 1200,
      });
    };

    // Sincroniza com a virada do próximo bloco de 5 minutos exato
    const scheduleNextRotation = () => {
      const now = Date.now();
      const msUntilNext = OFFICIAL_ROTATION_INTERVAL_MS - (now % OFFICIAL_ROTATION_INTERVAL_MS);

      timeoutId = setTimeout(() => {
        refreshOfficialColor();
        intervalId = setInterval(refreshOfficialColor, OFFICIAL_ROTATION_INTERVAL_MS);
      }, msUntilNext);
    };

    scheduleNextRotation();

    // Quando o usuário volta à aba (ou acorda dispositivo), sincroniza imediatamente
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        refreshOfficialColor();
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      cancelAccentTransition?.();
      if (timeoutId) clearTimeout(timeoutId);
      if (intervalId) clearInterval(intervalId);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [userAccentColor, isHighContrast, hasCustomAccent]);

  return {
    currentColor,
    isDynamicActive: !isHighContrast && !hasCustomAccent,
  };
}

