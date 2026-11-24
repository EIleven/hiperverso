// src/components/feed/PostCard.tsx
'use client';

import type { Post as PostType, User, Comment as CommentType, ReplyPermission, EmbeddedUserDetails } from '@/lib/types';
import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { format, formatDistanceToNow } from 'date-fns';
import { ptBR, enUS } from 'date-fns/locale';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { Repeat2, MessageSquare, Loader2, Globe, Users, Lock, Pin } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useCurrentUserId, useViewerSummary } from '@/contexts/CurrentUserContext';
import { Skeleton } from '@/components/ui/skeleton';
import PostCardSkeleton from './PostCardSkeleton';
import { Dialog, DialogContent, DialogTrigger, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import ImageViewer from '@/components/shared/ImageViewer'; // Import the new component
import MountOnceOpened from '@/components/shared/MountOnceOpened';
import SharePostDialog from './SharePostDialog';
import FloatingCommentBar from './FloatingCommentBar'; // Import the new component
import { useIsMobile } from '@/hooks/use-mobile';
import { useLocale } from 'next-intl';

import PostCardHeader from './PostCardHeader';
import PostCardContent from './PostCardContent';
import PostCardFooter from './PostCardFooter';
import CommentSection from './CommentSection';
import LoginOrRegisterPromptDialog from '@/components/auth/LoginOrRegisterPromptDialog';
import QuotePostDialogContent from './QuotePostDialogContent';
import PostAltTextDialog from './PostAltTextDialog';
import ReplyDialogContent from '../comments/ReplyDialogContent';
import InteractionCounts from './InteractionCounts'; // Import the new component
import SendViaDirectDialog from '@/components/messages/SendViaDirectDialog'; // Import SendViaDirectDialog
import UserProfileHoverCard from '@/components/profile/UserProfileHoverCard';

import { usePostDialogs } from '@/hooks/features/post/usePostDialogs';
import { usePostMainInteractions } from '@/hooks/features/post/usePostMainInteractions';
import { useCommentManagement } from '@/hooks/features/comment/useCommentManagement';
import { trackPostView, trackProfileClick } from '@/lib/services/analyticsService'; // Import the analytics service

import { useToast } from '@/hooks/use-toast';
import { auth } from '@/lib/firebase';
import { haptics } from '@/lib/haptics';
import { useLivePostCounters } from '@/hooks/features/feed/useLivePostCounters';
import { COUNTER_FIELDS, countersOf, createOptimisticTracker, mergeServerCounters } from '@/lib/feed/liveCounters';
import { useCommentSettings } from '@/hooks/features/comment/useCommentSettings'; // Import the new hook
import { buildThreadedComments } from './post-card-utils'; // Import the utility for threading
import CommentDisplaySettings from '@/components/comments/CommentDisplaySettings';
import { postsCollection } from '@/lib/services/postService';
import { getPostById } from '@/lib/services/postReadService';
import { canUserReplyToLoadedPost } from '@/lib/services/comments/commentReadService';
import { siteConfig } from '@/config/site';
import { notifyNavigationStart } from '@/components/layout/NavigationProgress';
import CommentCard from './CommentCard';
import { addCommentToPost } from '@/lib/services/comments/commentWriteActions';
import {
  dispatchPostInteraction,
  getCachedPostInteraction,
  POST_INTERACTION_EVENT,
  type PostInteractionEventDetail,
} from '@/lib/events/postInteractionState';
import {
  syncPostViewerState,
  VIEWER_ACTIONS_REFRESHED_EVENT,
  type ViewerActions,
} from '@/lib/services/viewerActions';


interface PostCardProps {
  post: PostType;
  onPostDeleted?: (postId: string) => void;
  isSinglePostView?: boolean;
  onPostCreated?: (newPost: PostType) => void; // Added for comment quotes -> posts
}

const getReplyPermissionIcon = (permission?: ReplyPermission) => {
  if (!permission) return null;
  switch (permission) {
    case 'everyone': return <Globe className="h-4 w-4 mr-2 text-muted-foreground" />;
    case 'followed': return <Users className="h-4 w-4 mr-2 text-muted-foreground" />;
    case 'mentioned': return <Lock className="h-4 w-4 mr-2 text-muted-foreground" />;
    default: return null;
  }
};

const getReplyPermissionText = (permission?: ReplyPermission): string => {
  if (!permission) return "Informação de resposta indisponível";
  switch (permission) {
      case 'everyone': return "Todos podem responder";
      case 'followed': return "Apenas pessoas que este usuário segue podem responder";
      case 'mentioned': return "Apenas pessoas mencionadas neste post podem responder";
      default: return "";
  }
};

function PostCard({
  post: initialPost,
  onPostDeleted,
  onPostCreated,
  isSinglePostView = false,
}: PostCardProps) {
  // Só id, nome, usuário e avatar de quem está logado: um seguidor novo ou uma mensagem não lida não redesenha o cartão.
  const loggedInUser = useViewerSummary();
  const currentUserId = useCurrentUserId();
  const router = useRouter();
  const searchParams = useSearchParams();
  const focusedCommentId = isSinglePostView ? searchParams?.get('commentId') : null;
  const { toast } = useToast();
  const isMobile = useIsMobile();
  const locale = useLocale();
  const postCardRef = useRef<HTMLDivElement>(null);

  const [post, setPost] = useState<PostType | null>(() => {
    const cached = getCachedPostInteraction(currentUserId, initialPost?.id);
    return cached ? { ...initialPost, ...cached } : initialPost;
  });
  const [canCurrentUserReplyToPost, setCanCurrentUserReplyToPost] = useState(true);

  useEffect(() => {
    const cached = getCachedPostInteraction(currentUserId, initialPost?.id);
    setPost(cached ? { ...initialPost, ...cached } : initialPost);
  }, [initialPost, currentUserId]);

  // O que a pessoa acabou de mudar (curtir, repostar...) fica "pendente" até o servidor alcançar: sem isto, o snapshot com o
  // número velho desfazia a curtida na tela para refazê-la segundos depois (liveCounters.ts).
  const postRef = useRef(post);
  postRef.current = post;
  const countersTracker = useRef(createOptimisticTracker());

  useEffect(() => {
    if (!currentUserId || !initialPost?.id) return;
    const onPostInteraction = (event: Event) => {
      const detail = (event as CustomEvent<PostInteractionEventDetail>).detail;
      if (detail.viewerId !== currentUserId || detail.postId !== initialPost.id) return;
      const atual = postRef.current;
      if (atual) {
        const agora = Date.now();
        const numeros = countersOf(atual);
        for (const campo of COUNTER_FIELDS) {
          const novo = (detail.patch as Record<string, unknown>)[campo];
          if (typeof novo === 'number') countersTracker.current.track(campo, numeros[campo], novo, agora);
        }
      }
      setPost((prev) => (prev ? { ...prev, ...detail.patch } : prev));
    };
    window.addEventListener(POST_INTERACTION_EVENT, onPostInteraction);

    const onViewerActionsRefreshed = (event: Event) => {
      const detail = (event as CustomEvent<{ viewerId: string; actions: ViewerActions }>).detail;
      if (!detail || detail.viewerId !== currentUserId) return;
      const atual = postRef.current;
      if (!atual || atual.id !== initialPost.id) return;
      const nextLiked = detail.actions.like.has(initialPost.id);
      const nextReposted = detail.actions.repost.has(initialPost.id);
      const nextBookmarked = detail.actions.bookmark.has(initialPost.id);
      const nextQuoted = detail.actions.quote.has(initialPost.id);
      if (
        Boolean(atual.isLiked) !== nextLiked ||
        Boolean(atual.isReposted) !== nextReposted ||
        Boolean(atual.isBookmarked) !== nextBookmarked ||
        Boolean(atual.isQuotedByCurrentUser) !== nextQuoted
      ) {
        dispatchPostInteraction(currentUserId, initialPost.id, {
          isLiked: nextLiked,
          isReposted: nextReposted,
          isBookmarked: nextBookmarked,
          isQuotedByCurrentUser: nextQuoted,
        });
      }
    };
    window.addEventListener(VIEWER_ACTIONS_REFRESHED_EVENT, onViewerActionsRefreshed);

    let cancelled = false;
    if (isSinglePostView) {
      void syncPostViewerState(currentUserId, initialPost.id).then((state) => {
        if (cancelled || !state) return;
        const atual = postRef.current;
        if (!atual || atual.id !== initialPost.id) return;
        if (
          Boolean(atual.isLiked) !== state.isLiked ||
          Boolean(atual.isReposted) !== state.isReposted ||
          Boolean(atual.isBookmarked) !== state.isBookmarked
        ) {
          dispatchPostInteraction(currentUserId, initialPost.id, state);
        }
      });
    }

    return () => {
      cancelled = true;
      window.removeEventListener(POST_INTERACTION_EVENT, onPostInteraction);
      window.removeEventListener(VIEWER_ACTIONS_REFRESHED_EVENT, onViewerActionsRefreshed);
    };
  }, [currentUserId, initialPost?.id, isSinglePostView]);

  // Contadores em tempo real (curtidas, reposts, comentários, citações): UM ouvinte por post, compartilhado entre cartões, e só
  // enquanto o cartão está perto da tela (useLivePostCounters). Visualizações não entram: mudam a cada pessoa que vê o post.
  // Para posts do Fediverso (ap_*), o mesmo gancho pede ao servidor, em lote e só quando o cartão chega perto da tela, que
  // confira o número na origem (remoteCountSync.ts): o feed já mostra curtidas/reposts/comentários sem abrir o post, e o número
  // novo chega por este mesmo ouvinte.
  useLivePostCounters(initialPost?.id, currentUserId, postCardRef, (data) => {
    const postId = initialPost?.id;
    setPost((prev) => {
      if (!prev || prev.id !== postId) return prev;
      const novos = mergeServerCounters(countersOf(prev), data, countersTracker.current, Date.now());
      return novos ? { ...prev, ...novos } : prev;
    });
  });

  // This ref stores the initial repost data and does not change on re-renders,
  // preventing the useEffect listener from re-attaching unnecessarily.
  const initialRepostDataRef = useRef({
    repostedBy: initialPost.repostedBy,
    repostedAt: initialPost.repostedAt,
  });

  const [isShareDialogOpen, setIsShareDialogOpen] = useState(false);
  const [isImageViewerOpen, setIsImageViewerOpen] = useState(false);
  const [selectedImageUrl, setSelectedImageUrl] = useState<string | null>(null);
  const [showComments, setShowComments] = useState(isSinglePostView);
  const [isAltTextDialogOpen, setIsAltTextDialogOpen] = useState(false);
  /* Funcionalidade de pedir Alt Text entre usuários desativada temporariamente:
  const [altRequested, setAltRequested] = useState(false);
  const [isRequestingAltText, setIsRequestingAltText] = useState(false);
  */

  const hasPostImages = Boolean(post?.media?.some((m) => m.type === 'image'));
  const hasMissingImageAlt = Boolean(
    post?.media?.some((m) => m.type === 'image' && !(typeof m.alt === 'string' && m.alt.trim().length > 0))
  );

  useEffect(() => {
    if (!isSinglePostView || searchParams?.get('addAlt') !== '1') return;
    if (!currentUserId || !post?.userId || post.userId !== currentUserId || !hasPostImages) return;
    setIsAltTextDialogOpen(true);
    router.replace(`/${locale}/post/${post.id}`, { scroll: false });
  }, [isSinglePostView, searchParams, currentUserId, post?.userId, post?.id, hasPostImages, router, locale]);

  const { settings } = useCommentSettings();
  const {
    showLoginPrompt,
    setShowLoginPrompt,
    openLoginPrompt,
    promptActionName,
    currentPath,
    isQuoteDialogOpen,
    setIsQuoteDialogOpen,
    isCommentDialogOpen,
    setIsCommentDialogOpen,
    isEditDialogOpen,
    setIsEditDialogOpen,
  } = usePostDialogs();

  /* Funcionalidade de pedir Alt Text entre usuários desativada temporariamente:
  const handleRequestAltText = useCallback(async (e?: React.MouseEvent | Event) => {
    e?.stopPropagation?.();
    if (!post?.id) return;
    if (!currentUserId) {
      openLoginPrompt('pedir descrição (Alt Text)');
      return;
    }
    if (altRequested || isRequestingAltText) return;
    setIsRequestingAltText(true);
    try {
      const token = await auth.currentUser?.getIdToken().catch(() => null);
      if (!token) throw new Error('Sessão expirada. Entre novamente.');
      const res = await fetch('/api/notifications/alt-text-request', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ postId: post.id }),
      });
      const json = (await res.json().catch(() => null)) as { alreadyRequested?: boolean; error?: string } | null;
      if (!res.ok) {
        throw new Error(json?.error || 'Não foi possível enviar a solicitação.');
      }
      setAltRequested(true);
      haptics.success();
      toast({
        title: json?.alreadyRequested ? 'Solicitação já enviada!' : 'Pedido de Alt Text enviado!',
        description: `@${post.user?.username || 'autor'} foi notificado(a) para descrever a imagem.`,
      });
    } catch (err) {
      toast({
        title: 'Não foi possível notificar',
        description: err instanceof Error ? err.message : 'Tente novamente em instantes.',
        variant: 'destructive',
      });
    } finally {
      setIsRequestingAltText(false);
    }
  }, [post?.id, post?.user?.username, currentUserId, altRequested, isRequestingAltText, openLoginPrompt, toast]);
  */

  const {
    loadedComments,
    areCommentsLoading,
    handleCommentAdded,
  } = useCommentManagement({
    postId: post?.id,
    currentUserId,
    showComments,
  });

  const onPostSuccessfullyDeleted = (postId: string) => {
    if (onPostDeleted) {
        onPostDeleted(postId);
    }
  };

  const postInteractions = usePostMainInteractions({
    post: post,
    setPost: setPost,
    currentUserId,
    openLoginPrompt,
    onPostSuccessfullyDeleted,
  });

  // Um repost de comentário é desenhado por `CommentCard` (mais abaixo), que tem as próprias interações. Este cartão não
  // instancia mais, para TODO post do feed, as interações de um comentário que ele nunca usava.
  const isRepostedComment = !!post?.repostedComment;

  const sortedAndFilteredComments = useMemo(() => {
    return buildThreadedComments(loadedComments, settings.sort, settings.view);
  }, [loadedComments, settings.sort, settings.view]);

  useEffect(() => {
    if (!isSinglePostView || !focusedCommentId || areCommentsLoading) return;
    const timer = setTimeout(() => {
      const el = document.getElementById('focused-comment');
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    }, 120);
    return () => clearTimeout(timer);
  }, [isSinglePostView, focusedCommentId, areCommentsLoading]);

  useEffect(() => {
    if (!post?.id || post.id.startsWith('http')) return;
    
    // Do not attach listener for unauthenticated users to prevent permission errors
    if (!currentUserId) return;

    // The real-time listener was removed from here to improve performance and stability.
    // The UI now relies on optimistic updates from interaction hooks and feed-level refreshing.

  }, [post?.id, currentUserId]); // Dependency array is stable now

  // Calculado na própria renderização: gravá-lo em estado por um efeito custava uma segunda renderização de CADA cartão.
  const createdAt = post?.createdAt;
  const repostedAt = post?.repostedAt;
  const toSafeDate = (value: unknown): Date | null => {
    if (!value) return null;
    if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
    if (typeof value === 'string' || typeof value === 'number') {
      const d = new Date(value);
      return Number.isNaN(d.getTime()) ? null : d;
    }
    if (typeof value === 'object' && 'toDate' in value && typeof (value as { toDate?: () => Date }).toDate === 'function') {
      const d = (value as { toDate: () => Date }).toDate();
      return Number.isNaN(d.getTime()) ? null : d;
    }
    return null;
  };
  const formatRelativeTime = (value: unknown) => {
    const date = toSafeDate(value);
    if (!date) return '';
    const localeOptions = locale === 'pt-BR' ? { locale: ptBR } : { locale: enUS };
    const formatted = formatDistanceToNow(date, { addSuffix: true, ...localeOptions });
    return locale === 'pt-BR' ? formatted.replace('cerca de ', '') : formatted;
  };
  const timeAgo = useMemo(() => formatRelativeTime(createdAt), [createdAt, locale]);
  const repostedTimeAgo = useMemo(() => formatRelativeTime(repostedAt), [repostedAt, locale]);
  const repostedDate = useMemo(() => toSafeDate(repostedAt), [repostedAt]);

  // Quem pode responder sai do próprio post (antes cada cartão baixava o post inteiro de novo, e de novo a cada curtida,
  // porque o efeito dependia do objeto `post`). Só os campos que mudam a resposta entram nas dependências.
  const postId = post?.id;
  const postAuthorId = post?.userId;
  const postReplyPermission = post?.replyPermission;
  const postText = post?.text;
  const postHeadline = post?.headline;
  const viewerUsername = loggedInUser?.username;
  useEffect(() => {
    if (!postId) {
      setCanCurrentUserReplyToPost(false);
      return;
    }
    let cancelled = false;
    canUserReplyToLoadedPost(
      { userId: postAuthorId, replyPermission: postReplyPermission, text: postText, headline: postHeadline },
      currentUserId ? { id: currentUserId, username: viewerUsername } : null,
    )
      .then((canReply) => { if (!cancelled) setCanCurrentUserReplyToPost(canReply); })
      .catch((error) => console.error('PostCard: não foi possível verificar quem pode responder', error));
    return () => { cancelled = true; };
  }, [postId, postAuthorId, postReplyPermission, postText, postHeadline, currentUserId, viewerUsername]);

  useEffect(() => {
    const isReposted = !!post?.repostedComment;
    if (isReposted) return;

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting && post?.id) {
            trackPostView(post.id, currentUserId);
            observer.disconnect();
          }
        });
      },
      { threshold: 0.5 }
    );
    const currentRef = postCardRef.current;
    if (currentRef) observer.observe(currentRef);
    return () => { if (currentRef) observer.unobserve(currentRef); };
  }, [post?.id, post?.repostedComment, currentUserId]);

  const openImage = (imageUrl: string) => {
    setSelectedImageUrl(imageUrl);
    setIsImageViewerOpen(true);
  };

  const handlePostQuoted = (newQuotePost: PostType, updatedOriginalPost: PostType) => {
    if (post && post.id === updatedOriginalPost.id) {
        setPost(updatedOriginalPost);
    }
    setIsQuoteDialogOpen(false);
    if(onPostCreated) onPostCreated(newQuotePost);
  };

  const handlePostEditedByDialog = (editedPost: PostType) => {
    setPost(editedPost);
    setIsEditDialogOpen(false);
  };

  const handleCardNavigation = (e: React.MouseEvent<HTMLDivElement> | React.KeyboardEvent<HTMLDivElement>) => {
    if (isSinglePostView || !post?.id) return;
    const target = e.target as HTMLElement;
    let currentElement: HTMLElement | null = target;
    while (currentElement && currentElement !== e.currentTarget) {
      if (currentElement.dataset.interactive === 'true' ||
          currentElement.closest('[data-interactive="true"]') ||
          currentElement.tagName === 'A' || currentElement.tagName === 'BUTTON' ||
          currentElement.tagName === 'TEXTAREA' || currentElement.tagName === 'INPUT' ||
          (currentElement.hasAttribute('role') &&
           ['button', 'menuitem', 'dialog', 'checkbox', 'switch'].includes(currentElement.getAttribute('role')!))
      ) {
        return;
      }
      currentElement = currentElement.parentElement;
    }

    if (isRepostedComment) {
        notifyNavigationStart();
        router.push(`/${locale}/post/${post.repostedComment!.parentPostId}?commentId=${post.repostedComment!.id}#focused-comment`);
        return;
    }
    notifyNavigationStart();
    router.push(`/${locale}/post/${post.id}`);
  };

  const handleCommentButtonClick = (e: React.MouseEvent) => {
      e.stopPropagation();
      if (!currentUserId && !canCurrentUserReplyToPost) {
          openLoginPrompt("comentar neste post");
          return;
      }
      if (!canCurrentUserReplyToPost && currentUserId && post && post.userId !== currentUserId) {
          toast({title: "Não é possível comentar", description: "Você não tem permissão para responder a este post.", variant: "destructive"});
          return;
      }
      const newShowState = !showComments;
      setShowComments(newShowState);
  };

  const handleProfileClickFromAvatar = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (isRepostedComment || !post) return;
    trackProfileClick(post.id);
  };
  
  // `false` = não enviou: o diálogo fica aberto com o texto e as imagens (só um erro ou `false` mantêm o formulário).
  const handleCreateTopLevelComment = async (data: { text?: string; media?: any[]; youtubeVideoId?: string; quotedPostObject?: PostType | null; replyPermission: ReplyPermission; allowReposts: boolean; sensitive?: boolean; }): Promise<boolean> => {
    if (!post?.id || !currentUserId) {
      openLoginPrompt("comentar");
      return false;
    }
    const newComment = await addCommentToPost(post.id, currentUserId, data);
    // Sem retorno o comentário não foi gravado (perfil do autor ou do post indisponível): antes o diálogo fechava
    // como se tivesse dado certo e o texto se perdia.
    if (!newComment) throw new Error('Não foi possível enviar o comentário. Seu texto foi mantido: tente de novo.');
    handleCommentAdded(newComment); // This comes from useCommentManagement
    toast({ title: "Comentário adicionado!" });
    return true;
  };


  if (!post) {
    return <PostCardSkeleton />;
  }
  
  if (post.isDeleted) return null;

  if (isRepostedComment) {
    return (
      <CommentCard
        comment={post.repostedComment!}
        repostedBy={post.repostedBy}
        repostedAt={post.repostedAt}
        onPostCreated={onPostCreated}
        parentPostAuthorId={post.repostedComment!.postAuthorId}
      />
    );
  }

  return (
    <>
      {/* Diálogos do cartão: só existem depois de abertos (MountOnceOpened); fechados eles eram centenas de componentes
          invisíveis no feed. */}
      <MountOnceOpened open={showLoginPrompt}>
        <LoginOrRegisterPromptDialog open={showLoginPrompt} onOpenChange={setShowLoginPrompt} actionName={promptActionName} currentPath={currentPath} />
      </MountOnceOpened>
      <MountOnceOpened open={isImageViewerOpen}>
        <ImageViewer
          isOpen={isImageViewerOpen}
          onOpenChange={setIsImageViewerOpen}
          imageUrl={selectedImageUrl}
          images={post?.media?.filter((m) => m.type !== 'video' && m.url).map((m) => m.url) ?? []}
          postUrl={post ? `${siteConfig.baseUrl}/${locale}/post/${post.id}` : undefined}
        />
      </MountOnceOpened>
      {!isRepostedComment && (
        <MountOnceOpened open={postInteractions.isSendViaDirectOpen}>
          <SendViaDirectDialog post={post} open={postInteractions.isSendViaDirectOpen} onOpenChange={postInteractions.setIsSendViaDirectOpen} />
        </MountOnceOpened>
      )}
      {post && (
        <MountOnceOpened open={isShareDialogOpen}>
          <SharePostDialog post={post} open={isShareDialogOpen} onOpenChange={setIsShareDialogOpen} />
        </MountOnceOpened>
      )}
      {post && hasPostImages && (
        <MountOnceOpened open={isAltTextDialogOpen}>
          <PostAltTextDialog
            post={post}
            open={isAltTextDialogOpen}
            onOpenChange={setIsAltTextDialogOpen}
            onMediaUpdated={(updatedMedia) => {
              setPost((prev) => (prev ? { ...prev, media: updatedMedia } : prev));
            }}
          />
        </MountOnceOpened>
      )}
      <Dialog open={isCommentDialogOpen} onOpenChange={setIsCommentDialogOpen}>
        <Card
            ref={postCardRef}
            data-post-id={post.id}
            className={cn("w-full rounded-none border-t-0 border-x-0 border-b border-border/70 overflow-hidden bg-transparent relative", !isSinglePostView && "feed-card hover:bg-muted/20 transition-colors duration-150 cursor-pointer", post.id === 'deleted-optimistically' && 'opacity-50 pointer-events-none')}
            onClick={!isSinglePostView ? handleCardNavigation : undefined}
            onKeyDown={!isSinglePostView ? (e) => { if (e.key === 'Enter' || e.key === ' ') handleCardNavigation(e); } : undefined}
            tabIndex={!isSinglePostView ? 0 : undefined}
            aria-label={!isSinglePostView && post.user ? `Ver post por ${post.user.name}` : (post.user ? `Post por ${post.user.name}` : 'Post')}
            role={!isSinglePostView ? "link" : "article"}
        >
            {post.isPinned && !post.repostedBy && (<div className="px-4 pt-2 text-xs font-semibold text-muted-foreground flex items-center"><Pin className="h-3 w-3 mr-2" /> Post Fixo</div>)}
            {post.repostedBy && (
                <div className="pt-2 px-4">
                    <div className="flex items-center space-x-3">
                        <div className="w-10 flex-shrink-0"></div>
                        <div className="text-xs text-muted-foreground" onClick={(e) => e.stopPropagation()} data-interactive="true">
                            <Repeat2 className="inline-block h-3 w-3 mr-1" />
                            {post.repostedBy.userId === currentUserId ? 'Você repostou' : <><UserProfileHoverCard user={{ ...post.repostedBy, id: post.repostedBy.userId } as unknown as User}><Link href={`/${locale}/profile/${post.repostedBy.userId}`} className="hover:underline font-semibold text-foreground">{post.repostedBy.name}</Link></UserProfileHoverCard>{' '}repostou</>}
                            {repostedTimeAgo && (
                              <span
                                className="ml-1 text-muted-foreground/80"
                                title={repostedDate ? format(repostedDate, "p · PP", { locale: locale === 'pt-BR' ? ptBR : enUS }) : undefined}
                              >
                                · {repostedTimeAgo}
                              </span>
                            )}
                        </div>
                    </div>
                </div>
            )}
            {!isSinglePostView && post.category === 'news' && post.newsCategory && null}

            <div className="px-5 py-4">
              <div className={cn("flex w-full", isSinglePostView && !isRepostedComment ? "flex-col" : "flex-row space-x-3")}>
                  {isSinglePostView && !isRepostedComment ? (
                      <div className="flex items-start space-x-3 w-full mb-4">
                          <div className="shrink-0">
                              <UserProfileHoverCard user={post.user!}><Link href={`/${locale}/profile/${post.user!.id}`} className="cursor-pointer" onClick={handleProfileClickFromAvatar} data-interactive="true"><Avatar className="h-10 w-10"><AvatarImage src={post.user!.avatarUrl} alt={post.user!.name} data-ai-hint={post.user!["data-ai-hint"] || "person portrait"} /><AvatarFallback>{post.user!.name?.substring(0, 1) || 'U'}</AvatarFallback></Avatar></Link></UserProfileHoverCard>
                          </div>
                          <div className="flex-1 min-w-0"><PostCardHeader post={post} currentUserId={currentUserId} timeAgo={timeAgo} isSinglePostView={isSinglePostView} /></div>
                      </div>
                  ) : (
                      <div className="shrink-0">
                          <UserProfileHoverCard user={post.user!}><Link href={`/${locale}/profile/${post.user!.id}`} className="cursor-pointer" onClick={handleProfileClickFromAvatar} data-interactive="true"><Avatar className="h-10 w-10"><AvatarImage src={post.user!.avatarUrl} alt={post.user!.name} data-ai-hint={post.user!["data-ai-hint"] || "person portrait"} /><AvatarFallback>{post.user!.name?.substring(0, 1) || 'U'}</AvatarFallback></Avatar></Link></UserProfileHoverCard>
                      </div>
                  )}
                  
                   <div className="flex-1 min-w-0">
                      {!isSinglePostView && <PostCardHeader post={post} currentUserId={currentUserId} timeAgo={timeAgo} isSinglePostView={isSinglePostView} />}
                      <div className={cn("mt-1", isSinglePostView && "mt-0")}>
                        <PostCardContent
                          post={post}
                          isSinglePostView={isSinglePostView}
                          onImageClick={openImage}
                          currentUserId={currentUserId}
                          onOpenAltTextEditor={() => setIsAltTextDialogOpen(true)}
                          // onRequestAltText={handleRequestAltText}
                          // altRequested={altRequested}
                          // isRequestingAltText={isRequestingAltText}
                        />
                      </div>
                      {isSinglePostView && !isRepostedComment && (
                          <>
                              <div className="mt-3 pt-3 border-t border-border text-muted-foreground flex items-center justify-between text-xs"><div className="flex items-center" title={getReplyPermissionText(post.replyPermission)}>{getReplyPermissionIcon(post.replyPermission)}<span className="pl-1">{getReplyPermissionText(post.replyPermission)}.</span></div><span className="pl-1">{format(new Date(post.createdAt), "p · PP", { locale: ptBR })}</span></div>
                              <InteractionCounts post={post} />
                          </>
                      )}
                      <PostCardFooter
                          post={post} currentUserId={currentUserId} isSinglePostView={isSinglePostView}
                          isQuoteDialogOpen={isQuoteDialogOpen} setIsQuoteDialogOpen={setIsQuoteDialogOpen}
                          isEditDialogOpen={isEditDialogOpen} setIsEditDialogOpen={setIsEditDialogOpen} onPostEdited={handlePostEditedByDialog}
                          canCurrentUserReplyToPost={canCurrentUserReplyToPost} onCommentButtonClick={handleCommentButtonClick}
                          onRepostToggle={postInteractions.handleRepostToggle} onQuoteButtonClick={(e) => { e.stopPropagation(); setIsQuoteDialogOpen(true); }} onUndoQuote={postInteractions.handleUndoQuote}
                          onLikePost={postInteractions.handleLikePost} isProcessingLike={postInteractions.isProcessingLike}
                          onBookmarkPost={postInteractions.handleBookmarkPost} isProcessingBookmark={postInteractions.isProcessingBookmark}
                          onCopyText={(e) => postInteractions.handleCopyText(e, post.text)} onSendViaDirect={postInteractions.handleSendViaDirect}
                          onShare={(e) => { e?.stopPropagation?.(); setIsShareDialogOpen(true); }} onMutePostAuthor={postInteractions.handleMutePostAuthor}
                          onBlockPostAuthor={postInteractions.handleBlockPostAuthor} onReportPostAction={postInteractions.handleReportPostAction}
                          onDeletePost={postInteractions.handleDeletePost} onPostQuoted={handlePostQuoted} onPinPost={postInteractions.handlePinPost} onHidePost={postInteractions.handleHidePost}
                          hasPostImages={hasPostImages}
                          hasMissingImageAlt={hasMissingImageAlt}
                          // altRequested={altRequested}
                          // isRequestingAltText={isRequestingAltText}
                          onOpenAltTextEditor={() => setIsAltTextDialogOpen(true)}
                          // onRequestAltText={handleRequestAltText}
                      />
                  </div>
              </div>
            </div>
            
            <DialogTrigger asChild>
                <CommentSection
                  post={post} commentsToDisplay={sortedAndFilteredComments} allComments={loadedComments} isLoadingComments={areCommentsLoading} loggedInUser={loggedInUser}
                  currentUserId={currentUserId} canCurrentUserReplyToPost={canCurrentUserReplyToPost} isSinglePostView={isSinglePostView} showCommentsState={showComments}
                  onCommentAdded={handleCommentAdded} onPostCreated={onPostCreated} openLoginPrompt={openLoginPrompt} isMobile={isMobile}
                  commentDisplaySettingsControl={<CommentDisplaySettings />}
                  focusedCommentId={focusedCommentId}
                  onClearFocusedComment={() => router.replace(`/${locale}/post/${post.id}`, { scroll: false })}
                />
            </DialogTrigger>

            {isSinglePostView && isMobile && loggedInUser && canCurrentUserReplyToPost && (<DialogTrigger asChild><FloatingCommentBar user={loggedInUser} /></DialogTrigger>)}
        </Card>
        <DialogContent>
            <DialogHeader className="sr-only"><DialogTitle>Responder ao Post</DialogTitle><DialogDescription>Crie uma resposta para este post. Sua resposta será visível para todos que podem ver a postagem original.</DialogDescription></DialogHeader>
            <ReplyDialogContent 
              parentPost={isRepostedComment ? post.repostedComment?.parentPostUser : post} 
              parentComment={isRepostedComment ? post.repostedComment : undefined} 
              onReplySubmitted={(newComment) => { handleCommentAdded(newComment); setIsCommentDialogOpen(false); }} 
              dialogClose={() => setIsCommentDialogOpen(false)} 
              onSendMessage={handleCreateTopLevelComment}
            />
        </DialogContent>
      </Dialog>
    </>
  );
}

// Um cartão só se redesenha quando o seu post (ou as funções que recebe) mudar: o feed pode redesenhar a lista sem
// tocar nos outros 59 cartões.
export default React.memo(PostCard);
