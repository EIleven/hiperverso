// src/components/profile/ProfileContentTabs.tsx
'use client';

import React, { useState, useMemo, useRef, useEffect, useCallback } from 'react';
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import FeedList, { FeedListHandle } from '@/components/feed/FeedList';
import FeedContainer from '@/components/feed/FeedContainer';
import PaginatedCommentList from '@/components/profile/PaginatedCommentList';
import LikedItemsFeedList from '@/components/feed/LikedItemsFeedList';
import type { User, Post, Comment } from '@/lib/types';
import type { PaginatedPostsOptions } from '@/lib/services/postReadService';
import { useFeedActions } from '@/contexts/FeedContext';
import { useTabSwipe } from '@/hooks/useTabSwipe';
import { useIsMobile } from '@/hooks/use-mobile';
import { useTranslations } from 'next-intl';
import { getPostById } from '@/lib/services/postReadService';
import { isRemoteId } from '@/lib/federation/remoteId';
import { useCurrentUserId } from '@/contexts/CurrentUserContext';
import PostCard from '../feed/PostCard';

interface ProfileContentTabsProps {
  profileUser: User;
  activeUser: User | null;
  isOwnProfile: boolean;

  onPostCreatedFromCommentQuote: (newPost: Post) => void;

  newlyCreatedPostForFeed: Post | null;
  onPostPrependedInFeed: () => void;
  onCommentUpdated?: (updatedComment: Comment) => void;
  onPostUpdatedInFeed?: (updatedPost: Post) => void;
  syncNonce?: number;
}

type ProfileTabValue = 'posts' | 'comments' | 'reposts' | 'quotes' | 'media' | 'likes';
const TABS_ORDER: ProfileTabValue[] = ['posts', 'comments', 'reposts', 'quotes', 'media', 'likes'];
/** Até aqui a barra de abas ainda está no fluxo normal da página: não há posição de rolagem a restaurar. */
const RESTORE_SCROLL_ABOVE = 56;

export default function ProfileContentTabs({
  profileUser,
  activeUser,
  isOwnProfile,
  onPostCreatedFromCommentQuote,
  newlyCreatedPostForFeed,
  onPostPrependedInFeed,
  syncNonce = 0,
}: ProfileContentTabsProps) {
  const t = useTranslations('ProfileTabs');
  const [activeTab, setActiveTab] = useState<ProfileTabValue>('posts');
  const [pinnedPost, setPinnedPost] = useState<Post | null>(null);
  const tabsRef = useRef<HTMLDivElement>(null);
  const isMobile = useIsMobile();
  const currentUserId = useCurrentUserId();

  const { getScrollPosition, saveScrollPosition } = useFeedActions();

  const postsFeedRef = useRef<FeedListHandle>(null);
  const repostsFeedRef = useRef<FeedListHandle>(null);
  const quotesFeedRef = useRef<FeedListHandle>(null);
  const mediaFeedRef = useRef<FeedListHandle>(null);
  const commentsFeedRef = useRef<FeedListHandle>(null);

  const postsFeedId = useMemo(
    () => (syncNonce > 0 ? `profile_posts_${profileUser.id}_${syncNonce}` : `profile_posts_${profileUser.id}`),
    [profileUser.id, syncNonce],
  );
  const repostsFeedId = useMemo(
    () => (syncNonce > 0 ? `profile_reposts_${profileUser.id}_${syncNonce}` : `profile_reposts_${profileUser.id}`),
    [profileUser.id, syncNonce],
  );
  const quotesFeedId = useMemo(
    () => (syncNonce > 0 ? `profile_quotes_${profileUser.id}_${syncNonce}` : `profile_quotes_${profileUser.id}`),
    [profileUser.id, syncNonce],
  );
  const mediaFeedId = useMemo(
    () => (syncNonce > 0 ? `profile_media_${profileUser.id}_${syncNonce}` : `profile_media_${profileUser.id}`),
    [profileUser.id, syncNonce],
  );
  const commentsFeedId = useMemo(() => `profile_comments_${profileUser.id}`, [profileUser.id]);

  useEffect(() => {
    // Resposta de um perfil (ou de uma fixação) anterior não pode sobrescrever o atual: ao trocar de perfil o componente é
    // reaproveitado, e uma busca lenta do perfil de antes chegava depois e fixava o post errado no topo.
    let cancelado = false;
    const pinnedPostId = profileUser.pinnedPostId;
    if (!pinnedPostId) {
      setPinnedPost(null);
      return;
    }
    // Enquanto o post novo carrega, não deixa à vista o fixado do perfil anterior (o mesmo post, ao reabrir, permanece).
    setPinnedPost((atual) => (atual && atual.id === pinnedPostId ? atual : null));
    getPostById(pinnedPostId, currentUserId)
      .then((post) => {
        if (!cancelado) setPinnedPost(post ? { ...post, isPinned: true } : null);
      })
      .catch((error) => {
        console.error('Failed to fetch pinned post:', error);
        if (!cancelado) setPinnedPost(null);
      });
    return () => {
      cancelado = true;
    };
  }, [profileUser.pinnedPostId, currentUserId]);

  const getFeedIdForTab = useCallback((tab: string) => {
    if (tab === 'posts') return postsFeedId;
    if (tab === 'reposts') return repostsFeedId;
    if (tab === 'quotes') return quotesFeedId;
    if (tab === 'media') return mediaFeedId;
    if (tab === 'comments') return commentsFeedId;
    return null;
  }, [postsFeedId, repostsFeedId, quotesFeedId, mediaFeedId, commentsFeedId]);

  const activeTabRef = useRef(activeTab);
  activeTabRef.current = activeTab;

  const handleRefresh = useCallback(async () => {
    switch (activeTabRef.current) {
      case 'posts':
        await postsFeedRef.current?.resetFeed();
        break;
      case 'reposts':
        await repostsFeedRef.current?.resetFeed();
        break;
      case 'quotes':
        await quotesFeedRef.current?.resetFeed();
        break;
      case 'media':
        await mediaFeedRef.current?.resetFeed();
        break;
      case 'comments':
        await commentsFeedRef.current?.resetFeed();
        break;
      default:
        break;
    }
  }, []);

  const handleTabChange = useCallback((value: string) => {
    // Guarda onde a aba de saída estava ANTES de trocar; daqui em diante qualquer rolagem pertence à aba nova.
    const currentFeedId = getFeedIdForTab(activeTabRef.current);
    if (currentFeedId) saveScrollPosition(currentFeedId, window.scrollY);
    activeTabRef.current = value as ProfileTabValue;
    setActiveTab(value as ProfileTabValue);
  }, [getFeedIdForTab, saveScrollPosition]);

  // Arrastar de lado troca de aba (celular). Só toque, sem capturar o gesto: a rolagem vertical segue inteira com o navegador.
  const swipeProps = useTabSwipe({
    enabled: isMobile,
    onSwipe: (direction) => {
      const currentIndex = TABS_ORDER.indexOf(activeTabRef.current);
      const target = TABS_ORDER[currentIndex + (direction === 'next' ? 1 : -1)];
      if (target) handleTabChange(target);
    },
  });

  // A posição de rolagem da aba ativa é gravada a cada rolagem no repositório de feeds, SEM avisar ninguém (antes cada
  // pausa virava um estado do React e redesenhava a página).
  useEffect(() => {
    const onScroll = () => {
      const feedId = getFeedIdForTab(activeTabRef.current);
      if (feedId) saveScrollPosition(feedId, window.scrollY);
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, [getFeedIdForTab, saveScrollPosition]);

  // Voltar a uma aba devolve a posição em que ela estava; uma aba nova começa do topo.
  const previousTabRef = useRef<ProfileTabValue | null>(null);
  useEffect(() => {
    const isTabSwitch = previousTabRef.current !== null && previousTabRef.current !== activeTab;
    previousTabRef.current = activeTab;
    const feedId = getFeedIdForTab(activeTab);
    if (!feedId) return;
    const saved = getScrollPosition(feedId);
    if (!isTabSwitch && saved <= RESTORE_SCROLL_ABOVE) return;
    const frame = requestAnimationFrame(() => window.scrollTo({ top: saved, behavior: 'auto' }));
    return () => cancelAnimationFrame(frame);
  }, [activeTab, getFeedIdForTab, getScrollPosition]);

  // A sombra da barra de abas só aparece enquanto ela está presa ao topo. Um observador de interseção avisa quando o
  // marcador logo acima dela sai da tela: nenhuma leitura de layout a cada rolagem, nem estado do React.
  const stickySentinelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const sentinel = stickySentinelRef.current;
    const bar = tabsRef.current;
    if (!sentinel || !bar) return;
    const parsedHeaderHeight = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--header-height'));
    const headerHeight = Number.isFinite(parsedHeaderHeight) ? parsedHeaderHeight : 56;
    const observer = new IntersectionObserver(
      ([entry]) => { bar.dataset.stuck = entry.isIntersecting ? 'false' : 'true'; },
      { rootMargin: `-${headerHeight}px 0px 0px 0px` },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, []);

  // A visibilidade do perfil escolhe a consulta: perfil privado -> posts "só para seguidores".
  const postsFeedOptions = useMemo((): PaginatedPostsOptions => ({
    profileUserId: profileUser.id,
    profileVisibility: profileUser.profileVisibility,
    feedContext: 'profile_posts',
    excludePostId: profileUser.pinnedPostId || undefined,
  }), [profileUser.id, profileUser.profileVisibility, profileUser.pinnedPostId]);

  const repostsFeedOptions = useMemo((): PaginatedPostsOptions => ({
    profileUserId: profileUser.id,
    profileVisibility: profileUser.profileVisibility,
    feedContext: 'profile_reposts',
  }), [profileUser.id, profileUser.profileVisibility]);

  const quotesFeedOptions = useMemo((): PaginatedPostsOptions => ({
    profileUserId: profileUser.id,
    profileVisibility: profileUser.profileVisibility,
    feedContext: 'profile_quotes',
  }), [profileUser.id, profileUser.profileVisibility]);

  const mediaFeedOptions = useMemo((): PaginatedPostsOptions => ({
    profileUserId: profileUser.id,
    profileVisibility: profileUser.profileVisibility,
    feedContext: 'profile_media'
  }), [profileUser.id, profileUser.profileVisibility]);

  const commentsFeedOptions = useMemo((): PaginatedPostsOptions => ({
    profileUserId: profileUser.id,
    feedContext: 'profile_comments'
  }), [profileUser.id]);


  // Um post que a pessoa acabou de criar (uma citação feita a partir do próprio perfil) entra no topo da lista da aba que
  // está aberta, mas só se pertencer a ela: o mesmo critério das consultas (posts: tudo; citações: type "quote"; mídia: com
  // mídia; reposts: nunca). Antes o perfil repassava o post com nomes de propriedade que o FeedList não tem, e ele só
  // aparecia depois de atualizar.
  const novoPostParaAba = (aba: 'posts' | 'quotes' | 'media'): Post | null => {
    const novo = newlyCreatedPostForFeed;
    if (!novo || novo.userId !== profileUser.id) return null;
    if (aba === 'quotes') return novo.type === 'quote' ? novo : null;
    if (aba === 'media') return novo.hasMedia ? novo : null;
    return novo;
  };

  if (profileUser.hasBlockedCurrentUser && !isOwnProfile && !activeUser?.isAdmin) {
    return null;
  }
  if (profileUser.isBlocked && !isOwnProfile && !activeUser?.isAdmin) {
    return null;
  }

  return (
    <Tabs value={activeTab} onValueChange={handleTabChange} className="w-full">
      <div ref={stickySentinelRef} aria-hidden="true" className="h-px" />
      {/* Barra de abas presa logo abaixo do cabeçalho (ou no topo, quando ele some): `.chrome-sticky`, por CSS. */}
      <div
        ref={tabsRef}
        data-stuck="false"
        className="chrome-sticky sticky z-20 bg-background transition-shadow data-[stuck=true]:shadow-md"
      >
        <TabsList className="flex w-full overflow-x-auto no-scrollbar justify-start sm:justify-between bg-background">
          <TabsTrigger value="posts" className="shrink-0 flex-1">{t('posts')}</TabsTrigger>
          <TabsTrigger value="comments" className="shrink-0 flex-1">{t('comments')}</TabsTrigger>
          <TabsTrigger value="reposts" className="shrink-0 flex-1">{t('reposts')}</TabsTrigger>
          <TabsTrigger value="quotes" className="shrink-0 flex-1">{t('quotes')}</TabsTrigger>
          <TabsTrigger value="media" className="shrink-0 flex-1">{t('media')}</TabsTrigger>
          <TabsTrigger value="likes" className="shrink-0 flex-1">{t('likes')}</TabsTrigger>
        </TabsList>
      </div>

      <div {...swipeProps} style={{ overscrollBehaviorX: 'none' }}>
        <div style={{ display: activeTab === 'posts' ? 'block' : 'none' }}>
            <TabsContent value="posts" className="mt-4">
              {pinnedPost && (
                <PostCard
                  post={pinnedPost}
                />
              )}
              <FeedContainer onRefresh={handleRefresh}>
                  <FeedList
                    ref={postsFeedRef}
                    key={postsFeedId}
                    feedId={postsFeedId}
                    feedContextOptions={postsFeedOptions}
                    onPostCreated={onPostCreatedFromCommentQuote}
                    newPostToPrepend={activeTab === 'posts' ? novoPostParaAba('posts') : null}
                    onPostPrepended={onPostPrependedInFeed}
                  />
              </FeedContainer>
            </TabsContent>
        </div>

        <div style={{ display: activeTab === 'comments' ? 'block' : 'none' }}>
            <TabsContent value="comments" className="mt-4">
               <FeedContainer onRefresh={handleRefresh}>
                    <PaginatedCommentList
                        ref={commentsFeedRef}
                        key={commentsFeedId} // Use feedId as key to remount
                        feedId={commentsFeedId}
                        onPostCreatedFromCommentQuote={onPostCreatedFromCommentQuote}
                        feedContextOptions={commentsFeedOptions}
                    />
               </FeedContainer>
            </TabsContent>
        </div>

        <div style={{ display: activeTab === 'reposts' ? 'block' : 'none' }}>
            <TabsContent value="reposts" className="mt-4">
              <FeedContainer onRefresh={handleRefresh}>
                  <FeedList
                    ref={repostsFeedRef}
                    key={repostsFeedId}
                    feedId={repostsFeedId}
                    feedContextOptions={repostsFeedOptions}
                    onPostCreated={onPostCreatedFromCommentQuote}
                  />
              </FeedContainer>
            </TabsContent>
        </div>

        <div style={{ display: activeTab === 'quotes' ? 'block' : 'none' }}>
            <TabsContent value="quotes" className="mt-4">
              <FeedContainer onRefresh={handleRefresh}>
                  <FeedList
                    ref={quotesFeedRef}
                    key={quotesFeedId}
                    feedId={quotesFeedId}
                    feedContextOptions={quotesFeedOptions}
                    onPostCreated={onPostCreatedFromCommentQuote}
                    newPostToPrepend={activeTab === 'quotes' ? novoPostParaAba('quotes') : null}
                    onPostPrepended={onPostPrependedInFeed}
                  />
              </FeedContainer>
            </TabsContent>
        </div>

        <div style={{ display: activeTab === 'media' ? 'block' : 'none' }}>
            <TabsContent value="media" className="mt-4">
              <FeedContainer onRefresh={handleRefresh}>
                  <FeedList
                    ref={mediaFeedRef}
                    key={mediaFeedId}
                    feedId={mediaFeedId}
                    feedContextOptions={mediaFeedOptions}
                    onPostCreated={onPostCreatedFromCommentQuote}
                    newPostToPrepend={activeTab === 'media' ? novoPostParaAba('media') : null}
                    onPostPrepended={onPostPrependedInFeed}
                  />
              </FeedContainer>
            </TabsContent>
        </div>

        <div style={{ display: activeTab === 'likes' ? 'block' : 'none' }}>
            <TabsContent value="likes" className="mt-4 space-y-3">
              {isRemoteId(profileUser.id) && (
                <p className="text-xs text-muted-foreground px-3 py-2 rounded-md border border-border bg-muted/30">
                  Servidores do Fediverso mantêm a lista de curtidas privada por padrão; aparecem aqui apenas curtidas em posts federados no HiperVerso.
                </p>
              )}
              {/* A lista de curtidas exige login (regra do Firestore). */}
              {activeUser ? (
                <LikedItemsFeedList
                  key={`profile-likes-${profileUser.id}`}
                  userId={profileUser.id}
                  onPostCreatedFromQuote={onPostCreatedFromCommentQuote}
                />
              ) : (
                <p className="py-8 text-center text-sm text-muted-foreground">{t('likesLoginRequired')}</p>
              )}
            </TabsContent>
        </div>

      </div>
    </Tabs>
  );
}
