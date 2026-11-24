// src/hooks/features/consent/useConsent.ts
// Contexto e tipos do consentimento. O provedor fica em src/contexts/ConsentContext.tsx (mesma divisão do
// CommentSettingsContext).
'use client';

import { createContext, useContext } from 'react';
import type { ConsentChoice, ConsentDecision } from '@/lib/consent/consentState';

export interface ConsentContextValue {
  /** Decisão válida para a versão atual do aviso, ou `null` enquanto ninguém decidiu. */
  decision: ConsentDecision | null;
  /** O aviso precisa aparecer. */
  needsDecision: boolean;
  /** Medição de uso concedida. */
  analytics: boolean;
  /** Publicidade concedida. */
  /**
   * O localStorage já foi lido. Antes disso nada é decidido nem exibido: no servidor e no primeiro render o estado é
   * sempre "sem decisão", então o banner não pisca e nenhuma tag entra por engano.
   */
  isReady: boolean;
  /** Grava a escolha por categoria (usado pelo "Salvar escolhas"). */
  decide: (choice: ConsentChoice) => void;
  acceptAll: () => void;
  rejectAll: () => void;
  isPreferencesOpen: boolean;
  openPreferences: () => void;
  closePreferences: () => void;
}

export const ConsentContext = createContext<ConsentContextValue | null>(null);

export function useConsent(): ConsentContextValue {
  const value = useContext(ConsentContext);
  if (!value) {
    throw new Error('useConsent precisa estar dentro de <ConsentProvider>.');
  }
  return value;
}
