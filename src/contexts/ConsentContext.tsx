// src/contexts/ConsentContext.tsx
'use client';

import React, { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  ACCEPT_ALL,
  CONSENT_STORAGE_KEY,
  REJECT_ALL,
  consentModeSignals,
  decisionFrom,
  grantedChoice,
  needsDecision as decisionIsMissing,
  parseStoredConsent,
  type ConsentChoice,
  type ConsentDecision,
} from '@/lib/consent/consentState';
import { updateGoogleConsent } from '@/lib/consent/googleConsent';
import { ConsentContext, type ConsentContextValue } from '@/hooks/features/consent/useConsent';

export function ConsentProvider({ children }: { children: ReactNode }) {
  const [decision, setDecision] = useState<ConsentDecision | null>(null);
  const [isReady, setIsReady] = useState(false);
  const [isPreferencesOpen, setIsPreferencesOpen] = useState(false);

  // Lê a decisão guardada uma vez, já no cliente. Enquanto isso o estado é "sem decisão": nada opcional carrega.
  useEffect(() => {
    let stored: ConsentDecision | null = null;
    try {
      stored = parseStoredConsent(localStorage.getItem(CONSENT_STORAGE_KEY));
    } catch {
      // Navegação privada ou armazenamento bloqueado: seguimos sem decisão e o aviso aparece de novo.
    }
    setDecision(stored);
    setIsReady(true);
    // Repete o sinal para o Google a cada carregamento: a decisão vive aqui, não na tag.
    if (stored) updateGoogleConsent(consentModeSignals(stored));
  }, []);

  const decide = useCallback((choice: ConsentChoice) => {
    const next = decisionFrom(choice);
    try {
      localStorage.setItem(CONSENT_STORAGE_KEY, JSON.stringify(next));
    } catch {
      // Não deu para guardar: a escolha vale nesta navegação e perguntamos de novo na próxima.
    }
    setDecision(next);
    updateGoogleConsent(consentModeSignals(next));
    setIsPreferencesOpen(false);
  }, []);

  const acceptAll = useCallback(() => decide(ACCEPT_ALL), [decide]);
  const rejectAll = useCallback(() => decide(REJECT_ALL), [decide]);
  const openPreferences = useCallback(() => setIsPreferencesOpen(true), []);
  const closePreferences = useCallback(() => setIsPreferencesOpen(false), []);

  const value = useMemo<ConsentContextValue>(() => {
    const granted = grantedChoice(decision);
    return {
      decision,
      needsDecision: decisionIsMissing(decision),
      analytics: granted.analytics,
      isReady,
      decide,
      acceptAll,
      rejectAll,
      isPreferencesOpen,
      openPreferences,
      closePreferences,
    };
  }, [decision, isReady, decide, acceptAll, rejectAll, isPreferencesOpen, openPreferences, closePreferences]);

  return <ConsentContext.Provider value={value}>{children}</ConsentContext.Provider>;
}
