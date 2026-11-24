// src/components/search/SearchResultsTabs.tsx
'use client';

import React, { useState, useEffect } from 'react';
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { getSearchResultsWithCounts, type ResultadosDaBusca } from '@/lib/services/searchService';
import ResultadoDeComentario from './ResultadoDeComentario';
import ResultadoDeFonte from './ResultadoDeFonte';
import { usePreferenciasDeBusca } from '@/hooks/usePreferenciasDeBusca';
import type { Post, User } from '@/lib/types';
import FeedList from '@/components/feed/FeedList';
import UserListItem from '@/components/profile/UserListItem';
import HashtagListItem from './HashtagListItem';
import { Skeleton } from '@/components/ui/skeleton';
import Link from 'next/link';
import { ExternalLink, Frown, Globe, UserCheck } from 'lucide-react';
import { useCurrentUser } from '@/contexts/CurrentUserContext';
import { useLocale, useTranslations } from 'next-intl';
import { classifySearchQuery } from '@/lib/search/searchQueryParser';
import { Badge } from '@/components/ui/badge';
import { ScrollArea, ScrollBar } from '@/components/ui/scroll-area';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';

interface RemoteFediverseProfile {
  actorId: string;
  handle: string;
  domain: string;
  name: string;
  summary: string;
  iconUrl: string | null;
  url: string;
}

const FEDIVERSE_HANDLE_RE = /^@?[A-Za-z0-9_.-]{1,64}@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;

interface SearchResultsTabsProps {
  query: string;
}

type SearchTab = 'top' | 'latest' | 'people' | 'comments' | 'web' | 'feeds' | 'articles';

const SearchSkeleton = () => (
    <div className="space-y-4">
        {[...Array(3)].map((_, i) => (
            <div key={i} className="flex items-start space-x-3 p-2">
                <Skeleton className="h-10 w-10 rounded-full" />
                <div className="flex-1 space-y-2">
                    <Skeleton className="h-4 w-1/4" />
                    <Skeleton className="h-4 w-full" />
                    <Skeleton className="h-4 w-3/4" />
                </div>
            </div>
        ))}
    </div>
);

const EmptyState = ({ message }: { message: string }) => (
    <div className="text-center py-10">
        <Frown className="mx-auto h-12 w-12 text-muted-foreground" />
        <p className="mt-4 text-muted-foreground">{message}</p>
    </div>
);


export default function SearchResultsTabs({ query }: SearchResultsTabsProps) {
  const t = useTranslations('SearchResultsTabs');
  const locale = useLocale();
  const [activeTab, setActiveTab] = useState<SearchTab>('top');
  const [results, setResults] = useState<ResultadosDaBusca | null>(null);
  const [remoteProfile, setRemoteProfile] = useState<RemoteFediverseProfile | null>(null);
  const [localUrlPath, setLocalUrlPath] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const { currentUser } = useCurrentUser();
  const { preferencias: prefsDeBusca } = usePreferenciasDeBusca(currentUser?.id);
  const mostrarSensivel = !prefsDeBusca.filtrarSensivel;
  const mostrarWeb = prefsDeBusca.resultadosWeb;
  
  useEffect(() => {
    // Reset results and fetch everything when query changes
    const fetchAllResultsAndCounts = async () => {
        setIsLoading(true);
        setResults(null); // Clear previous results
        setRemoteProfile(null);
        setLocalUrlPath(null);
        try {
            const trimmed = query.trim();
            const classified = classifySearchQuery(trimmed);
            if (classified.kind === 'local-url') {
              setLocalUrlPath(classified.path);
            }
            const shouldLookupRemote =
              classified.kind === 'fediverse-handle' || classified.kind === 'fediverse-profile-url';
            const [data, fediRes] = await Promise.all([
              getSearchResultsWithCounts(query, currentUser?.id, { mostrarSensivel, mostrarWeb }),
              shouldLookupRemote
                ? fetch(`/api/ap/lookup?q=${encodeURIComponent(trimmed)}`).then((r) => (r.ok ? r.json() : null)).catch(() => null)
                : Promise.resolve(null),
            ]);
            setResults(data);
            if (fediRes && typeof fediRes.handle === 'string') {
              setRemoteProfile(fediRes as RemoteFediverseProfile);
            }
        } catch (error) {
            console.error(`Failed to fetch all search results for query "${query}":`, error);
            setResults(null);
        } finally {
            setIsLoading(false);
        }
    };
    fetchAllResultsAndCounts();
  }, [query, currentUser, mostrarSensivel, mostrarWeb]);

  const handleFollowStateChange = (updatedUser: User) => {
    setResults((prev) => {
      if (!prev) return prev;
      return { ...prev, people: prev.people.map((u) => (u.id === updatedUser.id ? updatedUser : u)) };
    });
  };

  const renderRemoteProfileCard = () => {
    if (localUrlPath) {
      return (
        <div className="mb-4 rounded-xl border border-primary/30 bg-primary/5 p-4 shadow-sm flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-sm font-semibold text-foreground">Link interno detectado</p>
            <p className="text-xs text-muted-foreground truncate font-mono">{localUrlPath}</p>
          </div>
          <Button asChild size="sm">
            <Link href={localUrlPath}>Abrir agora</Link>
          </Button>
        </div>
      );
    }
    if (!remoteProfile) return null;
    const profileHref = `/${locale}/fediverse/${encodeURIComponent(remoteProfile.handle)}`;
    return (
      <div className="mb-4 rounded-xl border bg-card p-4 shadow-sm">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <Link href={profileHref} className="flex min-w-0 items-start gap-3 group">
            <Avatar className="h-12 w-12 shrink-0">
              {remoteProfile.iconUrl && <AvatarImage src={remoteProfile.iconUrl} alt={remoteProfile.name} />}
              <AvatarFallback>{remoteProfile.name.substring(0, 1).toUpperCase()}</AvatarFallback>
            </Avatar>
            <div className="min-w-0 space-y-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="truncate font-semibold group-hover:underline">{remoteProfile.name}</span>
                <Badge variant="secondary" className="gap-1 text-[11px]">
                  <Globe className="h-3 w-3" />
                  Fediverso ({remoteProfile.domain})
                </Badge>
              </div>
              <p className="truncate font-mono text-xs text-muted-foreground">@{remoteProfile.handle}</p>
              {remoteProfile.summary && (
                <p className="line-clamp-3 text-sm text-muted-foreground">{remoteProfile.summary}</p>
              )}
            </div>
          </Link>
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            <Button asChild size="sm">
              <Link href={profileHref}>
                <UserCheck className="mr-2 h-3.5 w-3.5" />
                Ver perfil
              </Link>
            </Button>
            <Button asChild size="sm" variant="outline">
              <a href={remoteProfile.url} target="_blank" rel="noopener noreferrer">
                <ExternalLink className="mr-2 h-3.5 w-3.5" />
                Servidor
              </a>
            </Button>
          </div>
        </div>
      </div>
    );
  };

  /**
   * O numero da aba sai da MESMA lista que a aba desenha. Enquanto a contagem vinha do servico e a lista passava
   * por filtros depois dele (idioma do feed, posts ocultos, item apagado no meio), existia o caso de aba marcando
   * 12 com a tela vazia -- e quem usa so via o app mentindo.
   */
  const contagemDaAba = (aba: SearchTab): number => {
    if (!results) return 0;
    const extraRemoto = remoteProfile && (aba === 'top' || aba === 'people') ? 1 : 0;
    return results.counts[aba] + extraRemoto;
  };

  const renderContent = () => {
    if (isLoading) {
        return <SearchSkeleton />;
    }

    const showRemoteHere = Boolean(remoteProfile) && (activeTab === 'top' || activeTab === 'people');

    if (contagemDaAba(activeTab) === 0 && !showRemoteHere) {
        return <EmptyState message={t('noResults')} />;
    }

    switch (activeTab) {
        case 'top':
        case 'latest':
        case 'articles': {
            // `semFiltroDeIdioma`: na busca a pessoa pediu AQUILO. Esconder um resultado pelo idioma escolhido no
            // feed era metade da causa do contador que nao batia com a lista.
            const lista = results ? results[activeTab] : [];
            return (
                <div>
                    {showRemoteHere && renderRemoteProfileCard()}
                    {lista.length > 0 && (
                        <FeedList initialPosts={lista} feedId={`search-${activeTab}-${query}`} semFiltroDeIdioma />
                    )}
                </div>
            );
        }
        case 'web':
            // Cartao com o dominio visivel e link DIRETO ao site -- sem redirecionador que registre o clique.
            return (
                <div className="space-y-2">
                    {(results?.web ?? []).map((r) => (
                        <ResultadoDeFonte key={r.id} resultado={r} />
                    ))}
                </div>
            );
        case 'comments':
            // Comentario tem cartao proprio: trecho, autor e link para o post pai. Antes ia cru para a lista do
            // feed, que espera post.
            return (
                <div className="space-y-2">
                    {(results?.comments ?? []).map((c) => (
                        <ResultadoDeComentario key={`${c.postPaiId}-${c.id}`} resultado={c} locale={locale} />
                    ))}
                </div>
            );
        case 'people':
            return (
                <div className="space-y-1">
                    {showRemoteHere && renderRemoteProfileCard()}
                    {(results?.people ?? []).map(user => (
                        <UserListItem 
                            key={user.id} 
                            userToList={user} 
                            activeUserId={currentUser?.id || null} 
                            onFollowStateChange={handleFollowStateChange}
                        />
                    ))}
                </div>
            );
        case 'feeds':
             return (
                <div className="space-y-1">
                    {(results?.feeds ?? []).map(hashtag => (
                        <HashtagListItem key={hashtag.tag} tag={hashtag.tag} count={hashtag.count} />
                    ))}
                </div>
            );
        default:
            return null;
    }
  };
  
  const TabTriggerWithCount = ({ value, label }: { value: SearchTab, label: string }) => (
    <TabsTrigger value={value} className="flex items-center gap-2">
      <span>{label}</span>
      {!isLoading && results && (
        <Badge variant={activeTab === value ? 'default' : 'secondary'} className="px-2 py-0.5 text-xs">
          {contagemDaAba(value)}
        </Badge>
      )}
    </TabsTrigger>
  );

  return (
    <Tabs value={activeTab} onValueChange={(value) => setActiveTab(value as SearchTab)} className="w-full">
      <ScrollArea className="w-full whitespace-nowrap border-b border-border">
        <TabsList className="inline-flex h-auto w-max bg-background">
          <TabTriggerWithCount value="top" label={t('top')} />
          <TabTriggerWithCount value="latest" label={t('latest')} />
          <TabTriggerWithCount value="people" label={t('people')} />
          <TabTriggerWithCount value="comments" label="Comentários" />
          {/* A aba Fontes some quando a pessoa desliga os resultados da Web em Configuracoes > Busca. */}
          {mostrarWeb && <TabTriggerWithCount value="web" label="Fontes" />}
          <TabTriggerWithCount value="feeds" label={t('feeds')} />
          <TabTriggerWithCount value="articles" label={t('articles')} />
        </TabsList>
        <ScrollBar orientation="horizontal" className="h-2" />
      </ScrollArea>
      <TabsContent value={activeTab} className="mt-4">
          {renderContent()}
      </TabsContent>
    </Tabs>
  );
}
