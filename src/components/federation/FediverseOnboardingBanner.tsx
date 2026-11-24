'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Globe, Sparkles, X } from 'lucide-react';
import { useLocale } from 'next-intl';
import { useCurrentUser } from '@/contexts/CurrentUserContext';

const STORAGE_PREFIX = 'exe-lula:federated-intro-seen:';

/**
 * Apresentação amigável e única das novidades (Fediverso, Bluesky/Atmosfera e aba 🦑).
 * Assim que o usuário dispensa ou clica em um dos atalhos, é marcada no navegador e nunca mais se repete.
 */
export default function FediverseOnboardingBanner() {
  const { currentUser } = useCurrentUser();
  const locale = useLocale();
  const [visivel, setVisivel] = useState(false);

  const storageKey = currentUser?.id ? `${STORAGE_PREFIX}${currentUser.id}` : null;

  useEffect(() => {
    if (!storageKey) {
      setVisivel(false);
      return;
    }
    try {
      const jaViu = localStorage.getItem(storageKey) === '1';
      setVisivel(!jaViu);
    } catch {
      setVisivel(false);
    }
  }, [storageKey]);

  const dispensar = () => {
    setVisivel(false);
    if (!storageKey) return;
    try {
      localStorage.setItem(storageKey, '1');
    } catch {
      // Ignora erro de storage (ex.: navegação privada restrita)
    }
  };

  if (!visivel || !currentUser) return null;

  return (
    <div
      data-testid="fediverse-onboarding-banner"
      className="mx-3 my-2.5 rounded-xl border border-primary/25 bg-primary/5 p-3.5 text-xs shadow-sm"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2 font-semibold text-foreground">
          <span className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary/15 text-primary">
            <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />
          </span>
          <span>Novidade: o HiperVerso agora conversa com o Fediverso e o Bluesky</span>
        </div>
        <button
          type="button"
          onClick={dispensar}
          aria-label="Fechar aviso"
          className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <X className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      </div>

      <ul className="mt-2.5 space-y-1.5 text-muted-foreground leading-relaxed">
        <li>
          <strong className="text-foreground">Fediverso (<Globe className="inline h-3 w-3 text-primary align-text-bottom" />):</strong>{' '}
          ative seu <span className="font-mono text-foreground">@usuario@hiperverso.social</span> para trocar posts e respostas com Mastodon e Misskey.
        </li>
        <li>
          <strong className="text-foreground">Bluesky (Atmosfera):</strong>{' '}
          conecte sua conta Bluesky e escolha em cada post ou citação para onde quer enviar.
        </li>
        <li>
          <strong className="text-foreground">Aba Principal:</strong>{' '}
          reúne só as pessoas da nossa rede, mantendo seu feed limpo e organizado.
        </li>
      </ul>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Link
          href={`/${locale}/settings/fediverse`}
          onClick={dispensar}
          className="inline-flex items-center rounded-md bg-primary px-2.5 py-1.5 text-[11px] font-medium text-primary-foreground transition-opacity hover:opacity-90"
        >
          Configurar Fediverso
        </Link>
        <Link
          href={`/${locale}/settings/connections`}
          onClick={dispensar}
          className="inline-flex items-center rounded-md border border-border bg-background px-2.5 py-1.5 text-[11px] font-medium text-foreground transition-colors hover:bg-muted"
        >
          Conectar Bluesky
        </Link>
        <button
          type="button"
          onClick={dispensar}
          className="ml-auto text-[11px] font-medium text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
        >
          Entendi, não mostrar de novo
        </button>
      </div>
    </div>
  );
}

