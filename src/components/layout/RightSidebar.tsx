// src/components/layout/RightSidebar.tsx
'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { Newspaper, SlidersHorizontal, TrendingUp, Users } from 'lucide-react';
import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';

import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import UserListItem from '@/components/profile/UserListItem';
import UserProfileHoverCard from '@/components/profile/UserProfileHoverCard';
import TopNewsItem from '@/components/trending/TopNewsItem';
import RecommendationSettingsDialog from '@/components/recommendations/RecommendationSettingsDialog';
import GlobalSearch from '@/components/layout/GlobalSearch';
import NotificationsBellButton from '@/components/layout/NotificationsBellButton';
import CollapsibleSidebarCard from '@/components/layout/CollapsibleSidebarCard';
import { useCurrentUserId } from '@/contexts/CurrentUserContext';
import { useMediaQuery } from '@/hooks/use-media-query';
import { fetchPaginatedPosts } from '@/lib/services/postReadService';
import { getTrendingTopics } from '@/lib/services/hashtagService';
import { getSuggestedUsers } from '@/lib/services/userService';
import type { Post, RecommendationPreferences, User } from '@/lib/types';
import { deepCopyPost } from '@/lib/utils/dataTransformers';
import { FOLLOW_STATE_EVENT, type FollowStateEventDetail } from '@/lib/events/followState';
import { readRecommendationPreferences, REC_PREFS_EVENT } from '@/lib/recommendations/preferences';

type SidebarTopic = { topic: string; count: number; topUsers: User[] };

const COLLAPSED_STORAGE_KEY = 'hiperverso:right-sidebar-collapsed';
const ARTICLES_CACHE_TTL_MS = 2 * 60 * 1000;

let cachedPublicArticles: { items: Post[]; expiresAt: number } | null = null;
let articlesInFlight: Promise<Post[]> | null = null;

async function fetchCachedPublicArticles(): Promise<Post[]> {
  if (cachedPublicArticles && Date.now() <= cachedPublicArticles.expiresAt) {
    return cachedPublicArticles.items;
  }
  if (articlesInFlight) return articlesInFlight;

  articlesInFlight = fetchPaginatedPosts(null, 5, null, { feedContext: 'articles' })
    .then((newsResponse) => {
      const items = newsResponse.posts
        .filter((item): item is Post => 'type' in item)
        .slice(0, 5)
        .map((item) => deepCopyPost(item)!);
      if (items.length > 0) {
        cachedPublicArticles = { items, expiresAt: Date.now() + ARTICLES_CACHE_TTL_MS };
      }
      return items;
    })
    .finally(() => {
      articlesInFlight = null;
    });

  return articlesInFlight;
}

function readCollapsedState(): Record<string, boolean> {
  if (typeof window === 'undefined') return {};
  try {
    const raw = window.localStorage.getItem(COLLAPSED_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, boolean>) : {};
  } catch {
    return {};
  }
}

function SidebarContentSkeleton() {
  return (
    <div className="space-y-5" aria-hidden="true">
      <div className="flex items-center gap-2">
        <Skeleton className="h-10 flex-1 rounded-full" />
        <Skeleton className="h-10 w-10 shrink-0 rounded-full" />
      </div>
      <div className="space-y-3 rounded-2xl border border-border/70 p-5">
        <Skeleton className="h-5 w-28" />
        <Skeleton className="h-3 w-48" />
        <div className="flex flex-wrap gap-2">
          {[36, 44, 32, 48, 40, 36].map((width, index) => (
            <Skeleton key={index} className="h-7 rounded-full" style={{ width: `${width * 2}px` }} />
          ))}
        </div>
      </div>
      <div className="space-y-3 rounded-2xl border border-border/70 p-5">
        <Skeleton className="h-5 w-36" />
        {[...Array(3)].map((_, index) => (
          <div key={index} className="flex items-center gap-3 py-1">
            <Skeleton className="h-9 w-9 rounded-full" />
            <div className="flex-1 space-y-2">
              <Skeleton className="h-3.5 w-2/3" />
              <Skeleton className="h-3 w-1/2" />
            </div>
            <Skeleton className="h-8 w-20 rounded-md" />
          </div>
        ))}
      </div>
      <div className="space-y-3 rounded-2xl border border-border/70 p-5">
        <Skeleton className="h-5 w-32" />
        {[...Array(3)].map((_, index) => (
          <div key={index} className="flex gap-3 py-2">
            <Skeleton className="h-[72px] w-[72px] rounded-md" />
            <div className="flex-1 space-y-2">
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-4/5" />
              <Skeleton className="h-3 w-2/3" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

interface RightSidebarProps {
  unreadNotifications?: number;
}

export default function RightSidebar({ unreadNotifications = 0 }: RightSidebarProps) {
  const [clientHasMounted, setClientHasMounted] = useState(false);
  const [trendingTopics, setTrendingTopics] = useState<SidebarTopic[]>([]);
  const [topNewsItems, setTopNewsItems] = useState<Post[]>([]);
  const [suggestedUsers, setSuggestedUsers] = useState<User[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [recPrefs, setRecPrefs] = useState<RecommendationPreferences>(() => readRecommendationPreferences());
  const [recDialogOpen, setRecDialogOpen] = useState(false);
  const [collapsedCards, setCollapsedCards] = useState<Record<string, boolean>>({});
  const locale = useLocale();
  const t = useTranslations('RightSidebar');
  // Só o id: um seguidor novo ou uma mensagem não lida não pode refazer as três leituras da barra lateral.
  const currentUserId = useCurrentUserId();
  // A barra lateral só aparece a partir de 1100 px: no celular ela nem busca conteúdo.
  const isVisible = useMediaQuery('(min-width: 1100px)');

  useEffect(() => {
    setClientHasMounted(true);
    setCollapsedCards(readCollapsedState());
  }, []);

  const toggleCard = useCallback((cardId: string) => {
    setCollapsedCards((prev) => {
      const next = { ...prev, [cardId]: !prev[cardId] };
      try {
        window.localStorage.setItem(COLLAPSED_STORAGE_KEY, JSON.stringify(next));
      } catch {
        // ignore storage restrictions
      }
      return next;
    });
  }, []);

  const fetchSidebarContent = useCallback(async () => {
    setIsLoading(true);
    try {
      const [topics, articles, usersResponse] = await Promise.all([
        getTrendingTopics(8),
        fetchCachedPublicArticles(),
        recPrefs.enabled ? getSuggestedUsers(currentUserId, 3, recPrefs) : Promise.resolve([]),
      ]);
      setTrendingTopics(topics);
      setTopNewsItems(articles);
      setSuggestedUsers(usersResponse);
    } catch (error) {
      console.error('RightSidebar: Failed to fetch content:', error);
      setTrendingTopics([]);
      setTopNewsItems([]);
      setSuggestedUsers([]);
    } finally {
      setIsLoading(false);
    }
  }, [currentUserId, recPrefs]);

  useEffect(() => {
    const onPrefsChanged = (event: Event) => {
      const detail = (event as CustomEvent<RecommendationPreferences>).detail;
      if (detail) setRecPrefs(detail);
    };
    window.addEventListener(REC_PREFS_EVENT, onPrefsChanged);
    return () => window.removeEventListener(REC_PREFS_EVENT, onPrefsChanged);
  }, []);

  useEffect(() => {
    if (clientHasMounted && isVisible) void fetchSidebarContent();
  }, [clientHasMounted, isVisible, fetchSidebarContent]);

  useEffect(() => {
    const syncFollowState = (event: Event) => {
      const detail = (event as CustomEvent<FollowStateEventDetail>).detail;
      if (detail.activeUserId !== currentUserId || !detail.isFollowing) return;
      setSuggestedUsers((users) => users.filter((user) => user.id !== detail.targetUserId));
    };
    window.addEventListener(FOLLOW_STATE_EVENT, syncFollowState);
    return () => window.removeEventListener(FOLLOW_STATE_EVENT, syncFollowState);
  }, [currentUserId]);

  // Seguir alguém atualiza apenas essa linha. Refazer tendências, artigos e sugestões inteiras tornava o toque mais caro.
  const handleFollowStateChange = (updatedUser: User) => {
    setSuggestedUsers((users) =>
      updatedUser.isFollowing
        ? users.filter((user) => user.id !== updatedUser.id)
        : users.map((user) => (user.id === updatedUser.id ? { ...user, ...updatedUser } : user))
    );
  };

  const asideClassName =
    'sticky top-0 hidden h-screen w-[var(--sidebar-right-width)] flex-shrink-0 justify-self-end overflow-y-auto px-0 py-4 min-[1100px]:block no-scrollbar';

  if (!clientHasMounted || isLoading) {
    return (
      <aside className={asideClassName} aria-label={t('sidebarLabel')}>
        <SidebarContentSkeleton />
      </aside>
    );
  }

  return (
    <aside className={asideClassName} aria-label={t('sidebarLabel')}>
      <div className="space-y-5">
        <div className="sticky top-0 z-10 bg-background/85 px-1 pb-3 pt-1 backdrop-blur-md">
          <div className="flex items-center gap-2">
            <div className="min-w-0 flex-1">
              <GlobalSearch isExpanded alwaysExpanded setIsExpanded={() => {}} />
            </div>
            {currentUserId && (
              <NotificationsBellButton unreadCount={unreadNotifications} variant="pill" />
            )}
          </div>
        </div>

        <CollapsibleSidebarCard
          id="trending"
          icon={TrendingUp}
          title={t('trendingTopics')}
          description={t('trendingDescription')}
          count={trendingTopics.length}
          collapsed={Boolean(collapsedCards.trending)}
          onToggle={() => toggleCard('trending')}
          footerLink={{
            href: `/${locale}/explore#network-pulse-title`,
            label: t('seeAll'),
          }}
        >
          {trendingTopics.length > 0 ? (
            <div className="flex flex-wrap gap-2" role="list">
              {trendingTopics.map(({ topic, count, topUsers }) => {
                const isHashtag = topic.startsWith('#');
                const url = isHashtag
                  ? `/${locale}/tag/${encodeURIComponent(topic.substring(1))}`
                  : `/${locale}/search?q=${encodeURIComponent(topic)}`;
                const leadUser = topUsers[0];

                return (
                  <div
                    key={topic}
                    role="listitem"
                    className="group inline-flex max-w-full items-center gap-1.5 rounded-full border border-border/70 bg-transparent px-2.5 py-1.5 text-xs transition-colors hover:border-primary/45 hover:bg-primary/5"
                  >
                    {leadUser && (
                      <UserProfileHoverCard user={leadUser}>
                        <Link
                          href={`/${locale}/profile/${leadUser.id}`}
                          data-interactive="true"
                          onClick={(e) => e.stopPropagation()}
                          className="shrink-0 rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        >
                          <Avatar className="h-5 w-5 shrink-0">
                            <AvatarImage src={leadUser.avatarUrl} alt={leadUser.name} />
                            <AvatarFallback>{leadUser.name?.[0] || '#'}</AvatarFallback>
                          </Avatar>
                        </Link>
                      </UserProfileHoverCard>
                    )}
                    <Link
                      href={url}
                      data-interactive="true"
                      title={`${topic} · ${t('mentionsCount', { count })}`}
                      className="flex min-w-0 items-center gap-1.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <span className="truncate font-medium text-primary group-hover:underline">
                        {topic}
                      </span>
                      <span className="shrink-0 text-muted-foreground">{count.toLocaleString(locale)}</span>
                    </Link>
                  </div>
                );
              })}
            </div>
          ) : (
            <p className="py-1 text-sm text-muted-foreground">{t('noTrendingTopics')}</p>
          )}
        </CollapsibleSidebarCard>

        {recPrefs.enabled && suggestedUsers.length > 0 && (
          <CollapsibleSidebarCard
            id="suggested"
            icon={Users}
            title={t('suggestedUsers')}
            description={t('suggestedUsersDescription')}
            count={suggestedUsers.length}
            collapsed={Boolean(collapsedCards.suggested)}
            onToggle={() => toggleCard('suggested')}
            headerActions={
              currentUserId ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 text-muted-foreground hover:text-foreground shrink-0"
                  onClick={() => setRecDialogOpen(true)}
                  title="Configurar algoritmo de sugestões"
                  aria-label="Configurar algoritmo de sugestões"
                >
                  <SlidersHorizontal className="h-3.5 w-3.5" />
                </Button>
              ) : undefined
            }
            footerLink={{
              href: `/${locale}/explore#suggested-accounts-title`,
              label: t('seeAll'),
            }}
          >
            <div className="space-y-1">
              {suggestedUsers.map((user) => (
                <UserListItem
                  key={user.id}
                  userToList={user}
                  activeUserId={currentUserId}
                  onFollowStateChange={handleFollowStateChange}
                  variant="compact"
                />
              ))}
            </div>
          </CollapsibleSidebarCard>
        )}
        <RecommendationSettingsDialog open={recDialogOpen} onOpenChange={setRecDialogOpen} />

        <CollapsibleSidebarCard
          id="articles"
          icon={Newspaper}
          title={t('topArticles')}
          description={t('topArticlesDescription')}
          count={topNewsItems.length}
          collapsed={Boolean(collapsedCards.articles)}
          onToggle={() => toggleCard('articles')}
          footerLink={{
            href: `/${locale}/trending`,
            label: t('seeAll'),
          }}
        >
          {topNewsItems.length > 0 ? (
            <div className="divide-y divide-border/60">
              {topNewsItems.map((newsItem) => (
                <TopNewsItem
                  key={newsItem.id}
                  newsItem={newsItem}
                  density="compact"
                  className="rounded-none border-0 px-0 py-2.5 hover:bg-muted/25"
                />
              ))}
            </div>
          ) : (
            <p className="py-1 text-sm text-muted-foreground">{t('noTopArticles')}</p>
          )}
        </CollapsibleSidebarCard>

        <footer
          aria-label="Links institucionais e políticas"
          className="px-1 pt-2 pb-24 text-xs text-muted-foreground"
        >
          <nav className="flex flex-wrap items-center gap-x-3 gap-y-1.5 leading-relaxed">
            <Link href={`/${locale}/manifesto`} className="font-medium text-foreground/80 hover:text-foreground hover:underline">
              Manifesto
            </Link>
            <Link href={`/${locale}/dev`} className="font-medium text-foreground/80 hover:text-foreground hover:underline">
              DEV
            </Link>
            <Link href={`/${locale}/about`} className="hover:text-foreground hover:underline">
              Sobre
            </Link>
            <Link href={`/${locale}/privacy`} className="hover:text-foreground hover:underline">
              Política de Privacidade
            </Link>
            <Link href={`/${locale}/terms`} className="hover:text-foreground hover:underline">
              Termos de Uso
            </Link>
            <Link
              href={`/${locale}/community-guidelines`}
              className="hover:text-foreground hover:underline"
            >
              Diretrizes da Comunidade
            </Link>
            <Link href={`/${locale}/cookies`} className="hover:text-foreground hover:underline">
              Cookies
            </Link>
            <Link
              href={`/${locale}/accessibility`}
              className="hover:text-foreground hover:underline"
            >
              Acessibilidade
            </Link>
            <Link href={`/${locale}/fediverse`} className="hover:text-foreground hover:underline">
              Fediverso
            </Link>
            <Link href={`/${locale}/help`} className="hover:text-foreground hover:underline">
              Ajuda
            </Link>
            <Link href={`/${locale}/download`} className="hover:text-foreground hover:underline">
              App
            </Link>
          </nav>
          <p className="mt-2.5 text-[11px] text-muted-foreground/80">
            © {new Date().getFullYear()} HiperVerso
          </p>
        </footer>
      </div>
    </aside>
  );
}
