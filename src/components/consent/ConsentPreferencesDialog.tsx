// src/components/consent/ConsentPreferencesDialog.tsx
'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { useConsent } from '@/hooks/features/consent/useConsent';

/**
 * Painel granular do consentimento. Fica sempre montado: é por aqui que a pessoa muda ou REVOGA a escolha depois,
 * pelo link permanente "Preferências de privacidade" (LGPD, art. 8º, § 5º — revogação a qualquer momento, por
 * procedimento gratuito e facilitado).
 *
 * Os estritamente necessários aparecem na lista, mas sem interruptor: não há escolha a fazer e fingir que há seria
 * enganoso.
 */
export default function ConsentPreferencesDialog() {
  const t = useTranslations('Consent');
  const locale = useLocale();
  const { isPreferencesOpen, closePreferences, decide, analytics } = useConsent();
  const [wantsAnalytics, setWantsAnalytics] = useState(analytics);

  // Ao abrir, os interruptores mostram o que vale hoje (e não o que ficou de uma abertura anterior sem salvar).
  useEffect(() => {
    if (isPreferencesOpen) {
      setWantsAnalytics(analytics);
    }
  }, [isPreferencesOpen, analytics]);

  return (
    <Dialog open={isPreferencesOpen} onOpenChange={(open) => !open && closePreferences()}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('preferences.title')}</DialogTitle>
          <DialogDescription>{t('preferences.description')}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="rounded-lg border p-4">
            <div className="flex items-center justify-between gap-4">
              <Label className="text-base">{t('categories.necessary.title')}</Label>
              <span className="shrink-0 text-xs font-medium text-muted-foreground">
                {t('preferences.alwaysOn')}
              </span>
            </div>
            <p className="mt-1 text-sm text-muted-foreground">{t('categories.necessary.description')}</p>
          </div>

          <div className="rounded-lg border p-4">
            <div className="flex items-center justify-between gap-4">
              <Label htmlFor="consent-analytics" className="text-base">
                {t('categories.analytics.title')}
              </Label>
              <Switch
                id="consent-analytics"
                checked={wantsAnalytics}
                onCheckedChange={setWantsAnalytics}
              />
            </div>
            <p className="mt-1 text-sm text-muted-foreground">{t('categories.analytics.description')}</p>
          </div>

          <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-4">
            <div className="flex items-center justify-between gap-4">
              <Label className="text-base">{t('zeroAds.title')}</Label>
              <Link
                href={`/${locale}/profile/qdnRsBvLG8NdwrLv9GwiHDa1xi42?pix=1`}
                onClick={closePreferences}
                className="shrink-0 text-xs font-semibold text-emerald-500 hover:underline"
              >
                {t('supportPix')}
              </Link>
            </div>
            {/* Nao e uma categoria de consentimento: e a afirmacao de que publicidade nao existe aqui. Nao ha o
                que aceitar nem recusar, por isso nao ha botao. */}
            <p className="mt-1 text-sm text-muted-foreground">{t('zeroAds.description')}</p>
          </div>
        </div>

        <DialogFooter className="flex-col gap-2 sm:flex-row">
          <Button
            variant="outline"
            className="flex-1"
            onClick={() => decide({ analytics: false })}
          >
            {t('rejectAll')}
          </Button>
          <Button
            className="flex-1"
            onClick={() => decide({ analytics: wantsAnalytics })}
          >
            {t('preferences.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
