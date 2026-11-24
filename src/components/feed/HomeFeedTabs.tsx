// src/components/feed/HomeFeedTabs.tsx
'use client';

import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import FeedList, { type FeedListHandle } from '@/components/feed/FeedList';
import type { Post, CustomFeed, TabPreferences } from '@/lib/types';
import type { PaginatedPostsOptions } from '@/lib/services/postReadService';
import { useCurrentUser } from '@/contexts/CurrentUserContext';
import FeedContainer from './FeedContainer';
import { collectionGroup, onSnapshot, query, where, orderBy, limit, Timestamp as FirestoreTimestamp, type Query } from 'firebase/firestore';
import { postsCollection } from '@/lib/services/postService';
import { db } from '@/lib/firebase';
import { getFollowedUserIds, getCustomFeeds } from '@/lib/services/userService';
import { isRemoteId } from '@/lib/federation/remoteId';
import { useDebounce } from '@/hooks/use-debounce';
import { useFeedActions, useFeedSelector } from '@/contexts/FeedContext';
import { useTabSwipe } from '@/hooks/useTabSwipe';
import { useIsMobile } from '@/hooks/use-mobile';

interface HomeFeedTabsProps {
  newPostToPrepend: Post | null;
  onPostPrepended: () => void;
}

type FeedTabValue = 'following' | 'local_network' | 'explore' | 'articles';

const ACTIVE_TAB_STORAGE_KEY = 'soberan-active-feed-tab';
const DEFAULT_TAB = 'explore';
/** Até aqui a barra de abas ainda está no fluxo normal da página: não há posição de rolagem a restaurar. */
const RESTORE_SCROLL_ABOVE = 56;

const readSavedTab = (): string => {
  try {
    return localStorage.getItem(ACTIVE_TAB_STORAGE_KEY) || DEFAULT_TAB;
  } catch {
    return DEFAULT_TAB;
  }
};

// O post criado/citado entra no feed da tela inicial por esta ponte (a página define `handleGlobalPostCreation`). Ler a
// função só na hora de usar a mantém válida mesmo que a página a defina depois da primeira renderização desta lista.
const handleGlobalPostCreated = (newPost: Post) => {
  const handler = (window as any).handleGlobalPostCreation;
  if (typeof handler === 'function') handler(newPost);
};

export default function HomeFeedTabs({ newPostToPrepend, onPostPrepended }: HomeFeedTabsProps) {
  const { currentUser, isLoading: isLoadingUser } = useCurrentUser();
  // Esta árvore só é montada no navegador (depois da hidratação), então já abre na aba que a pessoa deixou.
  const [activeTab, setActiveTab] = useState<string>(() => (typeof window === 'undefined' ? DEFAULT_TAB : readSavedTab()));
  const [customFeeds, setCustomFeeds] = useState<CustomFeed[]>([]);
  const [tabPreferences, setTabPreferences] = useState<TabPreferences>({ hidden: [], pinnedOrder: [] });
  const [isLoadingFeeds, setIsLoadingFeeds] = useState(true);

  const { getScrollPosition, saveScrollPosition, setFeedState } = useFeedActions();
  const isMobile = useIsMobile();

  const feedRefs = useRef<{[key: string]: React.RefObject<FeedListHandle>}>({});

  // Uma aba só carrega o feed na PRIMEIRA vez em que é aberta (antes as três carregavam ao abrir o app, duas escondidas).
  // Depois de aberta ela continua montada e escondida, então voltar a ela devolve a mesma lista na mesma posição.
  const visitedTabsRef = useRef<Set<string>>(new Set());
  visitedTabsRef.current.add(activeTab);
  const activeTabRef = useRef(activeTab);
  activeTabRef.current = activeTab;

  const TABS_ORDER = useMemo((): {id: string, name: string}[] => {
    const defaultTabs: {id: string, name: string}[] = [];
    if (currentUser && !tabPreferences.hidden.includes('following')) {
      defaultTabs.push({ id: 'following', name: 'Seguindo' });
    }
    if (!tabPreferences.hidden.includes('local_network')) {
      defaultTabs.push({ id: 'local_network', name: 'Principal' });
    }
    if (!tabPreferences.hidden.includes('explore')) {
      defaultTabs.push({ id: 'explore', name: 'Explorar' });
    }
    if (!tabPreferences.hidden.includes('articles')) {
      defaultTabs.push({ id: 'articles', name: 'Artigos' });
    }

    const pinnedFeeds = (tabPreferences.pinnedOrder || [])
      .map(feedId => {
        const feed = customFeeds.find(f => f.id === feedId);
        return feed ? { id: feed.id, name: feed.name } : null;
      })
      .filter((f): f is {id: string; name: string} => f !== null);

    return [...defaultTabs, ...pinnedFeeds];
  }, [currentUser, tabPreferences, customFeeds]);


  useEffect(() => {
    if (currentUser && !isLoadingUser) {
      setIsLoadingFeeds(true);
      getCustomFeeds(currentUser.id).then(feeds => {
        setCustomFeeds(feeds);
        setTabPreferences(currentUser.tabPreferences || { hidden: [], pinnedOrder: [] });
        setIsLoadingFeeds(false);
      });
    } else if (!isLoadingUser) {
      // Reset for logged out user
      setCustomFeeds([]);
      setTabPreferences({ hidden: [], pinnedOrder: [] });
      setIsLoadingFeeds(false);
    }
  }, [currentUser, isLoadingUser]);


  const handleTabChange = useCallback((value: string) => {
    // Guarda onde a aba de saída estava ANTES de trocar (o navegador reposiciona a página quando a lista some) e, daqui
    // em diante, qualquer rolagem pertence à aba nova.
    saveScrollPosition(activeTabRef.current, window.scrollY);
    activeTabRef.current = value;
    setActiveTab(value);
    try {
      localStorage.setItem(ACTIVE_TAB_STORAGE_KEY, value);
    } catch { /* sem armazenamento: a aba só não é lembrada */ }
  }, [saveScrollPosition]);

  // Arrastar de lado troca de aba (celular). Só toque, sem capturar o gesto: a rolagem vertical segue inteira com o navegador.
  const swipeProps = useTabSwipe({
    enabled: isMobile,
    onSwipe: (direction) => {
      const currentIndex = TABS_ORDER.findIndex(t => t.id === activeTabRef.current);
      const target = TABS_ORDER[currentIndex + (direction === 'next' ? 1 : -1)];
      if (currentIndex >= 0 && target) handleTabChange(target.id);
    },
  });

  useEffect(() => {
    // Ensure activeTab is valid
    if (TABS_ORDER.length > 0 && !TABS_ORDER.find(t => t.id === activeTab)) {
      setActiveTab(TABS_ORDER[0].id);
    }
  }, [TABS_ORDER, activeTab]);

  // A posição de rolagem da aba ativa é gravada a cada rolagem, mas no repositório de feeds e SEM avisar ninguém: antes
  // cada pausa de 100 ms virava um estado do React e redesenhava o feed inteiro.
  useEffect(() => {
    const onScroll = () => saveScrollPosition(activeTabRef.current, window.scrollY);
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, [saveScrollPosition]);

  // Voltar a uma aba (ou ao feed, vindo de um post) devolve a posição em que ela estava. Uma aba que ainda não tinha
  // posição começa do topo, em vez de herdar a rolagem da aba anterior.
  const previousTabRef = useRef<string | null>(null);
  useEffect(() => {
    const isTabSwitch = previousTabRef.current !== null && previousTabRef.current !== activeTab;
    previousTabRef.current = activeTab;
    const saved = getScrollPosition(activeTab);
    if (!isTabSwitch && saved <= RESTORE_SCROLL_ABOVE) return;
    const frame = requestAnimationFrame(() => window.scrollTo({ top: saved, behavior: 'auto' }));
    return () => cancelAnimationFrame(frame);
  }, [activeTab, getScrollPosition]);


  const hasNewPosts = useFeedSelector(activeTab, (state) => state.hasNewItems);
  const activeNewestPostTimestamp = useFeedSelector(activeTab, (state) => state.newestPostTimestamp);
  const debouncedActiveTab = useDebounce(activeTab, 300);

  const handleRefresh = useCallback(async () => {
    const activeFeedRef = feedRefs.current[activeTabRef.current];
    if (activeFeedRef?.current) {
      await activeFeedRef.current.resetFeed();
      setFeedState(activeTabRef.current, { hasNewItems: false });
    }
  }, [setFeedState]);

  useEffect(() => {
    if (!currentUser || !debouncedActiveTab) return;

    let isSubscribed = true;

    const setupListener = async () => {
        // O item mais novo do feed traz a data como texto ISO: a comparação no Firestore precisa de Timestamp (antes
        // comparava data com texto e o aviso de "novos posts" nunca aparecia).
        const newest = activeNewestPostTimestamp as unknown;
        const newestMillis = newest instanceof FirestoreTimestamp ? newest.toMillis() : new Date(String(newest ?? '')).getTime();
        if (!Number.isFinite(newestMillis)) return () => {};
        const since = FirestoreTimestamp.fromMillis(newestMillis);

        // Só os feeds públicos que têm "novos posts"; basta saber se existe UM (limit 1), não ler todos.
        const queries: Query[] = [];
        const chunks = (ids: string[], size: number) => {
          const result: string[][] = [];
          for (let index = 0; index < ids.length; index += size) result.push(ids.slice(index, index + size));
          return result;
        };

        if (debouncedActiveTab === 'explore') {
          queries.push(query(postsCollection, where('visibility', '==', 'public'), where('createdAt', '>', since), orderBy('createdAt', 'desc'), limit(1)));
        } else if (debouncedActiveTab === 'local_network') {
          // O 🦑 só avisa de atividade LOCAL, mas a consulta não distingue: com 5 itens, cinco posts remotos recentes escondiam
          // qualquer post daqui e o aviso nunca aparecia. 30 dá margem; o filtro de baixo descarta os remotos.
          queries.push(query(postsCollection, where('visibility', '==', 'public'), where('createdAt', '>', since), orderBy('createdAt', 'desc'), limit(30)));
          queries.push(query(collectionGroup(db, 'reposts'), where('createdAt', '>', since), orderBy('createdAt', 'desc'), limit(30)));
        } else if (debouncedActiveTab === 'articles') {
          queries.push(query(postsCollection, where('visibility', '==', 'public'), where('category', '==', 'news'), where('createdAt', '>', since), orderBy('createdAt', 'desc'), limit(1)));
        } else {
          const customFeed = customFeeds.find((feed) => feed.id === debouncedActiveTab);
          const selectedIds = [...new Set(debouncedActiveTab === 'following'
            ? await getFollowedUserIds(currentUser.id)
            : (customFeed?.userIds ?? []))];
          if (selectedIds.length === 0) return () => {};

          for (const authorIds of chunks(selectedIds, 30)) {
            queries.push(query(postsCollection, where('userId', 'in', authorIds), where('visibility', '==', 'public'), where('createdAt', '>', since), orderBy('createdAt', 'desc'), limit(1)));
            queries.push(query(collectionGroup(db, 'reposts'), where('userId', 'in', authorIds), where('createdAt', '>', since), orderBy('createdAt', 'desc'), limit(1)));
          }

          // Contas do Fediverso (ap_) nunca têm posts "só para seguidores": nenhuma consulta nem ouvinte para elas (eram uns 130
          // ouvintes inúteis para quem segue 1.300 contas; a paginação já fazia esse filtro).
          const followed = (debouncedActiveTab === 'following'
            ? selectedIds
            : (await getFollowedUserIds(currentUser.id)).filter((id) => selectedIds.includes(id))
          ).filter((id) => !isRemoteId(id));
          if (selectedIds.includes(currentUser.id)) followed.push(currentUser.id);
          for (const authorIds of chunks([...new Set(followed)], 10)) {
            queries.push(query(postsCollection, where('userId', 'in', authorIds), where('visibility', '==', 'followers'), where('createdAt', '>', since), orderBy('createdAt', 'desc'), limit(1)));
          }
        }

        const unsubscribers = queries.map((feedQuery) => onSnapshot(feedQuery, (snapshot) => {
          const hasMatchingDoc = snapshot.docs.some((d) => {
            if (d.metadata.hasPendingWrites) return false;
            if (debouncedActiveTab !== 'local_network') return true;
            const data = d.data();
            return !isRemoteId(data?.userId) && data?.isRemoteFediverse !== true;
          });
          if (isSubscribed && !snapshot.empty && hasMatchingDoc) {
            setFeedState(debouncedActiveTab, { hasNewItems: true });
          }
        }, (error) => {
          console.error(`Error on snapshot listener for ${debouncedActiveTab}:`, error);
        }));
        return () => unsubscribers.forEach((unsubscribe) => unsubscribe());
    }

    const unsubscribePromise = setupListener();

    return () => {
      isSubscribed = false;
      unsubscribePromise.then(unsub => unsub && unsub());
    };
  }, [activeNewestPostTimestamp, customFeeds, debouncedActiveTab, currentUser, setFeedState]);


  // As consultas de cada aba, montadas uma vez por mudança nas abas (e não a cada renderização).
  const feedOptionsByTab = useMemo(() => {
    const options: Record<string, PaginatedPostsOptions> = {};
    for (const tab of TABS_ORDER) {
      if (['following', 'local_network', 'explore', 'articles'].includes(tab.id)) {
        options[tab.id] = { feedContext: tab.id as FeedTabValue };
      } else {
        const customFeed = customFeeds.find(f => f.id === tab.id);
        options[tab.id] = customFeed ? { feedContext: 'custom', customFeedUserIds: customFeed.userIds } : {};
      }
    }
    return options;
  }, [TABS_ORDER, customFeeds]);

  const renderFeedList = (tabId: string) => {
    const customFeed = customFeeds.find(f => f.id === tabId);

    // Um post recém-criado só entra otimisticamente nos feeds aos quais realmente pertence. Antes o mesmo valor era
    // enviado para todas as abas montadas e podia aparecer em "Seguindo" ou num feed personalizado sem o autor.
    const isLocalAuthor = !!newPostToPrepend && !isRemoteId(newPostToPrepend.userId);
    const canPrepend = !!newPostToPrepend && (
      (tabId === 'explore' && newPostToPrepend.visibility === 'public')
      || (tabId === 'local_network' && newPostToPrepend.visibility === 'public' && isLocalAuthor)
      || (tabId === 'articles' && newPostToPrepend.visibility === 'public' && newPostToPrepend.category === 'news')
      || (!!currentUser && !!customFeed?.userIds.includes(currentUser.id))
    );

    if (!feedRefs.current[tabId]) {
      feedRefs.current[tabId] = React.createRef<FeedListHandle>();
    }

    return (
      <FeedList
        ref={feedRefs.current[tabId]}
        key={tabId}
        feedId={tabId}
        feedContextOptions={feedOptionsByTab[tabId]}
        onPostCreated={handleGlobalPostCreated}
        newPostToPrepend={canPrepend ? newPostToPrepend : null}
        onPostPrepended={onPostPrepended}
      />
    );
  };

  return (
    <FeedContainer onRefresh={handleRefresh} hasNewPosts={hasNewPosts}>
      <Tabs value={activeTab} onValueChange={handleTabChange} className="w-full">
        {/* Abas fixas: logo abaixo do cabeçalho quando ele aparece e no topo quando ele some (`.chrome-sticky`, por CSS). */}
        <div className="chrome-sticky chrome-surface sticky z-20 border-b border-border/70">
          <TabsList
            className="grid w-full h-[54px] rounded-none bg-transparent p-0"
            style={{ gridTemplateColumns: `repeat(${TABS_ORDER.length > 0 ? TABS_ORDER.length : 1}, minmax(0, 1fr))` }}
          >
              {TABS_ORDER.map(tab => (
                <TabsTrigger
                  key={tab.id}
                  value={tab.id}
                  className="relative h-full rounded-none bg-transparent px-4 text-sm font-medium text-muted-foreground shadow-none transition-colors hover:bg-muted/35 hover:text-foreground data-[state=active]:bg-transparent data-[state=active]:font-bold data-[state=active]:text-foreground data-[state=active]:shadow-none after:pointer-events-none after:absolute after:bottom-0 after:left-1/2 after:h-[3px] after:w-14 after:-translate-x-1/2 after:rounded-full after:bg-primary after:opacity-0 after:transition-all after:duration-200 data-[state=active]:after:opacity-100"
                >
                  {tab.name}
                </TabsTrigger>
              ))}
          </TabsList>
        </div>

        {/* Avisos de onboarding removidos do topo do feed para manter a timeline limpa (acessíveis em Configurações e Identidade P2P). */}

        <div {...swipeProps} style={{ overscrollBehaviorX: 'none' }}>
          {TABS_ORDER.filter(tab => visitedTabsRef.current.has(tab.id)).map(tab => (
            <div key={tab.id} style={{ display: activeTab === tab.id ? 'block' : 'none' }}>
              {renderFeedList(tab.id)}
            </div>
          ))}
        </div>
      </Tabs>
    </FeedContainer>
  );
}
