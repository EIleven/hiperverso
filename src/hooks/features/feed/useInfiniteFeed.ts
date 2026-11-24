// src/hooks/features/feed/useInfiniteFeed.ts
import { useCallback, useRef, useEffect } from 'react';
import type { Post, Comment } from '@/lib/types';
import { Timestamp as FirestoreTimestamp } from 'firebase/firestore';
import type { PaginatedPostsOptions } from '@/lib/services/postReadService';
import { useCurrentUserId } from '@/contexts/CurrentUserContext';
import { useFeedActions, useFeedState, initialFeedState } from '@/contexts/FeedContext';
import { cacheService } from '@/lib/services/cacheService';
import { getFeedActivityMillis, sortAndDedupeFeedItems } from '@/lib/feedUtils';

export type FetchPostsFunction<C = FirestoreTimestamp | string | number | null> = (
  cursor: C | null,
  limit: number,
  activeUserId: string | null,
  options: PaginatedPostsOptions
) => Promise<{
  posts: (Post | Comment)[];
  nextCursor: C | null;
  hasMore?: boolean;
}>;

interface UseInfiniteFeedProps<C> {
  feedId: string;
  fetchPostsFunction: FetchPostsFunction<C>;
  options: PaginatedPostsOptions;
  limit?: number;
  enabled?: boolean;
}

interface UseInfiniteFeedResult<C> {
  posts: (Post | Comment)[];
  loadMorePosts: () => Promise<void>;
  isLoading: boolean;
  isRefreshing: boolean;
  isLoadingMore: boolean;
  hasMore: boolean;
  error: Error | null;
  resetFeed: () => Promise<void>;
  prependPosts: (newItems: (Post | Comment)[]) => void;
  removePostById: (itemId: string) => void;
  getNewestPostTimestamp: () => C | null;
}

const newestActivity = (items: (Post | Comment)[]): FirestoreTimestamp | null => {
  const millis = items.length > 0 ? getFeedActivityMillis(items[0]) : 0;
  return millis > 0 ? FirestoreTimestamp.fromMillis(millis) : null;
};

export function useInfiniteFeed<C = FirestoreTimestamp | string | number | null>({
  feedId,
  fetchPostsFunction,
  options,
  limit = 15,
  enabled = true,
}: UseInfiniteFeedProps<C>): UseInfiniteFeedResult<C> {
  // Ações fixas (não redesenham) + o estado DESTE feed (só ele redesenha esta lista).
  const { getFeedState, setFeedState, removePostFromFeed, saveScrollPosition } = useFeedActions();
  const activeUserId = useCurrentUserId();
  const viewerKey = activeUserId ?? 'visitor';
  const queryKey = JSON.stringify(options);
  const requestKey = `${viewerKey}\u0000${queryKey}`;
  const cacheFeedId = `${feedId}\u0000${queryKey}`;
  const currentRequestRef = useRef(requestKey);
  const initialRequestRef = useRef<string | null>(null);
  const optionsRef = useRef(options);
  currentRequestRef.current = requestKey;
  optionsRef.current = options;

  // O mesmo feedId pode sobreviver a uma troca de conta ou a uma edição de feed personalizado. Estado de outro usuário
  // ou de outra consulta nunca é renderizado, nem por um frame, enquanto a nova leitura começa.
  const storedState = useFeedState(feedId);
  const stateBelongsToQuery = storedState.viewerKey === viewerKey && storedState.queryKey === queryKey;
  const feedState = stateBelongsToQuery
    ? storedState
    : { ...initialFeedState, viewerKey, queryKey };

  const {
    posts,
    isLoading,
    isRefreshing,
    isLoadingMore,
    hasMore,
    error,
  } = feedState;

  const loadItemsInternal = useCallback(async (isInitialLoad: boolean) => {
    if (!enabled) return;
    const thisRequest = requestKey;
    const rawState = getFeedState(feedId);
    const currentState = rawState.viewerKey === viewerKey && rawState.queryKey === queryKey
      ? rawState
      : { ...initialFeedState, viewerKey, queryKey };

    setFeedState(feedId, isInitialLoad
      ? { viewerKey, queryKey, isLoading: true, error: null }
      : { viewerKey, queryKey, isLoadingMore: true, error: null });

    try {
      const cursorToUse = isInitialLoad ? null : currentState.cursor;
      const result = await fetchPostsFunction(cursorToUse as C, limit, activeUserId, optionsRef.current);
      if (currentRequestRef.current !== thisRequest) return;

      // A leitura da rede substitui a primeira página em cache. Assim posts apagados, autores removidos de um feed e
      // permissões revogadas não ficam misturados com um resultado atual.
      const combined = isInitialLoad ? result.posts : [...currentState.posts, ...result.posts];
      const uniquePosts = sortAndDedupeFeedItems(combined);
      setFeedState(feedId, {
        viewerKey,
        queryKey,
        posts: uniquePosts,
        cursor: result.nextCursor as FirestoreTimestamp,
        hasMore: result.hasMore !== undefined ? result.hasMore : result.nextCursor !== null,
        initialLoadDone: true,
        newestPostTimestamp: newestActivity(uniquePosts),
      });
      await cacheService.saveFeedToCache(viewerKey, cacheFeedId, uniquePosts as Post[]);
    } catch (cause: unknown) {
      if (currentRequestRef.current !== thisRequest) return;
      const nextError = cause instanceof Error ? cause : new Error('Falha ao carregar itens');
      setFeedState(feedId, { viewerKey, queryKey, error: nextError });
      console.error('useInfiniteFeed: Error fetching items:', cause);
    } finally {
      if (currentRequestRef.current === thisRequest) {
        setFeedState(feedId, { viewerKey, queryKey, isLoading: false, isLoadingMore: false, isRefreshing: false });
      }
    }
  }, [activeUserId, cacheFeedId, enabled, feedId, fetchPostsFunction, getFeedState, limit, queryKey, requestKey, setFeedState, viewerKey]);

  const loadMorePosts = useCallback(async () => {
    const rawState = getFeedState(feedId);
    if (rawState.viewerKey !== viewerKey || rawState.queryKey !== queryKey) return;
    if (rawState.isLoading || rawState.isLoadingMore || !rawState.hasMore || !enabled) return;
    await loadItemsInternal(false);
  }, [enabled, feedId, getFeedState, loadItemsInternal, queryKey, viewerKey]);

  const resetFeed = useCallback(async () => {
    await cacheService.clearFeedCache(viewerKey, cacheFeedId);
    saveScrollPosition(feedId, 0); // atualizar recomeça do topo: a posição guardada deixa de valer
    setFeedState(feedId, { ...initialFeedState, viewerKey, queryKey, isLoading: true, isRefreshing: true });
    await loadItemsInternal(true);
  }, [cacheFeedId, feedId, loadItemsInternal, queryKey, saveScrollPosition, setFeedState, viewerKey]);

  useEffect(() => {
    if (!enabled) return;
    const latestState = getFeedState(feedId);
    if (latestState.viewerKey === viewerKey && latestState.queryKey === queryKey && latestState.initialLoadDone) return;
    if (initialRequestRef.current === requestKey) return;
    initialRequestRef.current = requestKey;
    let cancelled = false;

    setFeedState(feedId, { ...initialFeedState, viewerKey, queryKey, isLoading: true });
    void (async () => {
      const cachedPosts = await cacheService.getFeedFromCache(viewerKey, cacheFeedId);
      if (cancelled || currentRequestRef.current !== requestKey) return;
      if (cachedPosts.length > 0) {
        setFeedState(feedId, {
          viewerKey,
          queryKey,
          posts: sortAndDedupeFeedItems(cachedPosts),
          newestPostTimestamp: newestActivity(cachedPosts),
          isLoading: true,
        });
      }
      await loadItemsInternal(true);
      if (currentRequestRef.current === requestKey) initialRequestRef.current = null;
    })();

    return () => {
      cancelled = true;
      if (initialRequestRef.current === requestKey) {
        initialRequestRef.current = null;
      }
    };
  }, [cacheFeedId, enabled, feedId, getFeedState, loadItemsInternal, queryKey, requestKey, setFeedState, viewerKey]);

  const prependPosts = useCallback((newItems: (Post | Comment)[]) => {
    if (!newItems || newItems.length === 0) return;
    const rawState = getFeedState(feedId);
    const currentItems = rawState.viewerKey === viewerKey && rawState.queryKey === queryKey ? rawState.posts : [];
    const uniquePosts = sortAndDedupeFeedItems([...newItems, ...currentItems]);
    setFeedState(feedId, {
      viewerKey,
      queryKey,
      posts: uniquePosts,
      newestPostTimestamp: newestActivity(uniquePosts),
    });
    void cacheService.saveFeedToCache(viewerKey, cacheFeedId, uniquePosts as Post[]);
  }, [cacheFeedId, feedId, getFeedState, queryKey, setFeedState, viewerKey]);

  const removePostById = useCallback((itemId: string) => {
    removePostFromFeed(itemId);
  }, [removePostFromFeed]);

  const getNewestPostTimestamp = useCallback(() => {
    const rawState = getFeedState(feedId);
    if (rawState.viewerKey !== viewerKey || rawState.queryKey !== queryKey) return null;
    return rawState.newestPostTimestamp as C | null;
  }, [feedId, getFeedState, queryKey, viewerKey]);

  return {
    posts,
    loadMorePosts,
    isLoading,
    isRefreshing,
    isLoadingMore,
    hasMore,
    error,
    resetFeed,
    prependPosts,
    removePostById,
    getNewestPostTimestamp,
  };
}
