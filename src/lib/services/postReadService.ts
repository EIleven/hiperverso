// src/lib/services/postReadService.ts
import { filterForVisitor } from '@/lib/feed/publicVisibility';
import { db } from '@/lib/firebase';
import type { Post, User, Comment, OriginalPostDetails, ReplyPermission, EmbeddedUserDetails, LikedItem, PostType, CustomFeed } from '@/lib/types';
import {
  doc,
  getDoc,
  collection,
  query,
  where,
  getDocs,
  Timestamp as FirestoreTimestamp,
  orderBy,
  limit as firestoreLimit,
  startAfter,
  collectionGroup,
  or, // Import the 'or' operator
  and, // Added and
  onSnapshot,
  type DocumentData,
  type DocumentSnapshot,
  type Query,
  type QueryConstraint,
  type QueryDocumentSnapshot,
} from 'firebase/firestore';
import {
    deepCopyPost,
    deepCopyComment
} from '@/lib/utils/dataTransformers';
import {
    extractHashtagsFromString,
} from '@/lib/utils/textUtils';
import { getUser, getFollowedUserIds, searchUsers as serverSearchUsers } from './userService';
import { janelaDeAtividades } from '@/lib/feed/activityWindow';
import { isRemoteId } from '@/lib/federation/remoteId';
import { remotoPodeAparecerNaDescoberta } from '@/lib/activitypub/consentimentoDoAtor';
import { isFromSuspendedFediverseDomain } from '@/lib/federation/suspendedDomains';
import { getCurrentUserId } from './authService';
import { postsCollection } from './postService';
import { getCommentsForPost, getCommentById } from './comments';
import { getViewerActions } from './viewerActions';
import { getFeedContentKey } from '@/lib/feedUtils';

export const getComparableTime = (timestamp: FirestoreTimestamp | string | Date | undefined): number => {
  if (!timestamp) return 0; 
  if (typeof (timestamp as any).toMillis === 'function') { 
    return (timestamp as FirestoreTimestamp).toMillis();
  }
  if (timestamp instanceof Date) { 
    return timestamp.getTime();
  }
  if (typeof timestamp === 'string') { 
    const date = new Date(timestamp);
    return isNaN(date.getTime()) ? 0 : date.getTime(); 
  }
  if (typeof timestamp === 'number') { // Handle plain numbers
    return timestamp;
  }
  console.warn("Unexpected timestamp type in getComparableTime (postReadService):", timestamp);
  return 0;
};

const createEmbeddedUserDetails = (user: User): EmbeddedUserDetails => {
  let avatarToEmbed = user.avatarUrl;
  if (user.avatarUrl && user.avatarUrl.startsWith('data:image')) {
    console.warn(`[EmbedWarning] User ${user.id} has base64 avatar in postReadService. Using placeholder for embedding.`);
    avatarToEmbed = ''; // Placeholder or a default URL
  }
  return {
    userId: user.id,
    name: user.name,
    username: user.username,
    avatarUrl: avatarToEmbed,
    "data-ai-hint": user["data-ai-hint"] || null,
  };
};

const getPostDataFromUrl = async (url: string): Promise<Post | null> => {
    try {
        const baseUrl = typeof window === 'undefined' ? (process.env.NEXT_PUBLIC_BASE_URL || 'http://localhost:9002') : '';
        const apiUrl = `${baseUrl}/api/quote-preview?url=${encodeURIComponent(url)}`;
        
        const response = await fetch(apiUrl);
        if (!response.ok) {
            console.error(`API call to /api/quote-preview failed for URL: ${url} with status: ${response.status}`);
            return null;
        }

        const data = await response.json();
        return data as Post;
    } catch (e) {
        console.error(`Failed to fetch preview for URL ${url} via API route:`, e);
        return null;
    }
};


/**
 * Fetches a post by its ID without requiring authentication.
 * Includes essential public author details for previews.
 * @param postId The ID of the post to fetch.
 * @returns The public post data or null if not found.
 */
export async function getPublicPostById(postId: string): Promise<Post | null> {
  if (!postId) return null;

  if (postId.startsWith('http')) {
    return getPostDataFromUrl(postId);
  }

  const postDocRef = doc(postsCollection, postId);
  try {
    const postSnap = await getDoc(postDocRef);
    if (!postSnap.exists()) return null;

    const postData = postSnap.data() as any;
    const author = await getUser(postData.userId, null); // Fetch author data without active user context

    if (!author) {
       console.warn(`[getPublicPostById] Could not resolve author for post ${postId}.`);
       // Return post without author details if author not found
       return {
         ...postData,
         id: postSnap.id,
         createdAt: new Date(getComparableTime(postData.createdAt)).toISOString(),
         updatedAt: postData.updatedAt ? new Date(getComparableTime(postData.updatedAt)).toISOString() : null,
       } as Post;
    }
    
    // Construct the public post object
    const publicPost: Post = {
      ...postData,
      id: postSnap.id,
      user: author,
      authorDetails: createEmbeddedUserDetails(author),
      createdAt: new Date(getComparableTime(postData.createdAt)).toISOString(),
      updatedAt: postData.updatedAt ? new Date(getComparableTime(postData.updatedAt)).toISOString() : null,
      // Ensure fields that require auth are set to default/false values
      isLiked: false,
      isReposted: false,
      isQuotedByCurrentUser: false,
      isBookmarked: false,
      comments: [], // Comments are not fetched for public previews
    };
    return deepCopyPost(publicPost) ?? null;
  } catch (error) {
    console.error(`Error in getPublicPostById for postId ${postId}:`, error);
    return null;
  }
}

const unavailableQuote = (details: OriginalPostDetails): OriginalPostDetails => ({
  id: details.id,
  authorDetails: details.authorDetails,
  type: details.type,
  createdAt: details.createdAt,
  isUnavailable: true,
} as OriginalPostDetails);

// A citação mostra o original como ele está AGORA (editado, apagado ou fechado para quem não segue o autor), não a
// cópia guardada no momento da citação. Se quem vê não pode lê-lo, aparece "post indisponível".
async function resolveQuotedOriginal(embedded: OriginalPostDetails): Promise<OriginalPostDetails> {
  try {
    const snap = await getDoc(doc(postsCollection, embedded.id));
    const fresh = snap.exists() ? (snap.data() as Post) : null;
    if (fresh && !fresh.isDeleted) {
      const inner = fresh.originalPostDetails;
      return {
        ...embedded,
        authorDetails: fresh.authorDetails ?? embedded.authorDetails,
        type: fresh.type ?? embedded.type,
        text: fresh.text ?? null,
        headline: fresh.headline ?? null,
        media: fresh.media ?? null,
        youtubeVideoId: fresh.youtubeVideoId ?? null,
        hasMedia: !!fresh.hasMedia,
        isEdited: !!fresh.isEdited,
        visibility: fresh.visibility,
        category: fresh.category ?? embedded.category,
        sourceUrl: fresh.sourceUrl ?? null,
        createdAt: fresh.createdAt ? new Date(getComparableTime(fresh.createdAt)).toISOString() : embedded.createdAt,
        // Citação de citação: a cópia de dentro de um autor que ficou privado foi limpa pela Function.
        originalPostDetails: inner && inner.visibility && inner.visibility !== 'public' ? unavailableQuote(inner) : (inner ?? null),
      } as OriginalPostDetails;
    }
  } catch {
    // Sem permissão: post "só para seguidores" de alguém que a pessoa não segue.
  }
  return unavailableQuote(embedded);
}

async function buildPostFromSnapshot(
  postSnap: QueryDocumentSnapshot<DocumentData> | DocumentSnapshot<DocumentData>,
  activeUserId: string | null = getCurrentUserId()
): Promise<Post | undefined> {
  if (!postSnap.exists()) return undefined;
  const postId = postSnap.id;
  const postData = postSnap.data() as any;

  if (isFromSuspendedFediverseDomain(postData)) return undefined;

  const [author, actions] = await Promise.all([
    getUser(postData.userId, activeUserId),
    activeUserId ? getViewerActions(activeUserId) : Promise.resolve(null),
  ]);

  if (!author) return undefined;

  if (activeUserId && activeUserId !== author.id) {
    if (author.isBlocked || author.hasBlockedCurrentUser) {
      console.log(`[getPostById] Access denied for post ${postId} due to block status.`);
      return undefined;
    }
  }

  const isLikedByViewer = actions ? actions.like.has(postId) : false;
  const isBookmarkedByViewer = actions ? actions.bookmark.has(postId) : false;
  const isRepostedByViewer = actions ? actions.repost.has(postId) : false;
  const isQuotedByCurrentUser = actions ? actions.quote.has(postId) : false;

  const resolveOriginalPromise = (async (): Promise<OriginalPostDetails | undefined> => {
    if (!postData.originalPostDetails) return undefined;
    const embeddedDetails = postData.originalPostDetails;
    const quotedId = typeof embeddedDetails.id === 'string' ? embeddedDetails.id : '';
    if (
      isFromSuspendedFediverseDomain(embeddedDetails) ||
      isFromSuspendedFediverseDomain({ remoteUrl: quotedId })
    ) {
      return unavailableQuote(embeddedDetails as OriginalPostDetails);
    }
    if (postData.type === 'quote' && quotedId && !quotedId.startsWith('http')) {
      return resolveQuotedOriginal(embeddedDetails as OriginalPostDetails);
    }
    if (embeddedDetails.userId) {
      const originalAuthor = await getUser(embeddedDetails.userId, activeUserId);
      if (originalAuthor) {
        const result = {
          ...embeddedDetails,
          user: originalAuthor,
        } as OriginalPostDetails;
        if (!result.authorDetails) {
          result.authorDetails = createEmbeddedUserDetails(originalAuthor);
        }
        return result;
      }
      return embeddedDetails;
    }
    return embeddedDetails;
  })();

  const resolveQuotedCommentPromise = (async (): Promise<Comment | undefined> => {
    if (!postData.quotedCommentId) return undefined;
    const ids = postData.quotedCommentId.split('/');
    const parentPostId = ids[0];
    const commentId = ids[1];
    if (parentPostId && commentId) {
      const comment = await getCommentById(parentPostId, commentId, activeUserId);
      return comment ?? undefined;
    }
    return undefined;
  })();

  const [originalPostDetailsWithUser, quotedCommentWithUser] = await Promise.all([
    resolveOriginalPromise,
    resolveQuotedCommentPromise,
  ]);

  const postToReturn: Post = {
    ...postData,
    id: postSnap.id,
    user: author,
    authorDetails: postData.authorDetails || createEmbeddedUserDetails(author),
    commentsCount: postData.commentsCount || 0,
    comments: [],
    isLiked: isLikedByViewer,
    isBookmarked: isBookmarkedByViewer,
    isReposted: isRepostedByViewer,
    isQuotedByCurrentUser: isQuotedByCurrentUser,
    originalPostDetails: originalPostDetailsWithUser,
    quotedComment: quotedCommentWithUser,
    createdAt: new Date(getComparableTime(postData.createdAt)).toISOString(),
    updatedAt: postData.updatedAt ? new Date(getComparableTime(postData.updatedAt)).toISOString() : null,
    hashtags: postData.hashtags || null,
    hasMedia: postData.hasMedia || false,
  };
  return deepCopyPost(postToReturn);
}

export const getPostById = async (postId: string, activeUserId: string | null = getCurrentUserId()): Promise<Post | undefined> => {
  if (!postId) return undefined;
  
  if (postId.startsWith('http')) {
      const postData = await getPostDataFromUrl(postId);
      return postData ? deepCopyPost(postData) : undefined;
  }
  
  const postDocRef = doc(postsCollection, postId);
  try {
    const postSnap = await getDoc(postDocRef);
    return await buildPostFromSnapshot(postSnap, activeUserId);
  } catch (error: any) {
    if (error.code === 'permission-denied') {
        console.warn(`[getPostById] Permission denied for post ${postId}. The profile may be private or inaccessible. Returning undefined.`);
        return undefined;
    }
    console.error(`Error fetching post ${postId}:`, String(error)); 
    throw error;
  }
};

export interface PaginatedPostsOptions {
  profileUserId?: string;
  profileVisibility?: 'public' | 'private'; // do perfil em profileUserId: privado -> posts "followers"
  tagName?: string;
  feedContext?: 'explore' | 'following' | 'local_network' | 'articles' | 'profile_posts' | 'profile_media' | 'profile_reposts' | 'profile_quotes' | 'profile_comments' | 'top_news' | 'custom';
  searchQuery?: string;
  searchType?: 'top' | 'latest' | 'articles';
  excludePostId?: string;
  since?: FirestoreTimestamp | null; // Added for incremental loading
  newsCategory?: string;
  customFeedUserIds?: string[];
}

export interface PaginatedPostsResponse {
  posts: (Post | Comment)[];
  nextCursor: FirestoreTimestamp | null;
  hasMore: boolean;
}

export interface PaginatedLikedItemsResponse {
  items: LikedItem[];
  nextCursor: FirestoreTimestamp | null;
  hasMore: boolean;
}

export interface PaginatedBookmarksResponse {
  items: LikedItem[];
  nextCursor: FirestoreTimestamp | null;
  hasMore: boolean;
}

export async function fetchPaginatedBookmarks(
  userId: string,
  cursor: FirestoreTimestamp | null,
  limit: number,
  activeUserId: string | null = getCurrentUserId()
): Promise<PaginatedBookmarksResponse> {
  let bookmarksQuery = query(
    collection(db, 'users', userId, 'bookmarks'),
    orderBy('createdAt', 'desc')
  );

  if (cursor) {
    bookmarksQuery = query(bookmarksQuery, startAfter(cursor));
  }
  bookmarksQuery = query(bookmarksQuery, firestoreLimit(limit + 1));

  try {
    const bookmarksSnapshot = await getDocs(bookmarksQuery);
    const fetchedDocs = bookmarksSnapshot.docs;

    const hasMore = fetchedDocs.length > limit;
    if (hasMore) {
      fetchedDocs.pop();
    }

    const itemPromises = fetchedDocs.map(async (bookmarkDoc) => {
      const contentId = bookmarkDoc.id;
      const data = bookmarkDoc.data();
      const contentType = data.contentType || 'post'; // Assume post for old bookmarks
      const bookmarkedAt = (data.createdAt as FirestoreTimestamp)?.toDate().toISOString() || new Date().toISOString();

      if (contentType === 'post') {
        const post = await getPostById(contentId, activeUserId);
        if (post) return { type: 'post', content: post, likedAt: bookmarkedAt } as LikedItem;
      } else if (contentType === 'comment') {
        const parentPostId = data.parentPostId;
        if (!parentPostId) {
            console.warn(`Bookmarked comment ${contentId} is missing parentPostId.`);
            return null;
        }
        const comment = await getCommentById(parentPostId, contentId, activeUserId);
        if (comment) return { type: 'comment', content: comment, likedAt: bookmarkedAt } as LikedItem;
      }
      return null;
    });

    const items = (await Promise.all(itemPromises)).filter(Boolean) as LikedItem[];
    const nextCursor = hasMore && fetchedDocs.length > 0 ? fetchedDocs[fetchedDocs.length - 1].data().createdAt as FirestoreTimestamp : null;

    return { items, nextCursor, hasMore };
  } catch (error) {
    console.error("Error fetching paginated bookmarks:", error);
    throw error;
  }
}


export async function fetchPaginatedLikedItems(
  userId: string,
  cursor: FirestoreTimestamp | null,
  limit: number,
  activeUserId: string | null = getCurrentUserId()
): Promise<PaginatedLikedItemsResponse> {
  let likesQuery = query(
    collectionGroup(db, 'likes'),
    where('userId', '==', userId),
    orderBy('createdAt', 'desc')
  );

  if (cursor) {
    likesQuery = query(likesQuery, startAfter(cursor));
  }
  likesQuery = query(likesQuery, firestoreLimit(limit + 1));

  try {
    const likesSnapshot = await getDocs(likesQuery);
    const fetchedDocs = likesSnapshot.docs;

    const hasMore = fetchedDocs.length > limit;
    if (hasMore) {
      fetchedDocs.pop();
    }

    const itemPromises = fetchedDocs.map(async (likeDoc) => {
      const parentRef = likeDoc.ref.parent.parent;
      if (!parentRef) return null;

      const likedAt = (likeDoc.data().createdAt as FirestoreTimestamp)?.toDate().toISOString() || new Date().toISOString();

      if (parentRef.parent.id === 'posts') {
        const post = await getPostById(parentRef.id, activeUserId);
        if (post) return { type: 'post', content: post, likedAt } as LikedItem;
      } else if (parentRef.parent.id === 'comments') {
        const postId = parentRef.parent.parent?.id;
        const commentId = parentRef.id;
        if (!postId || !commentId) return null;

        const fullComment = await getCommentById(postId, commentId, activeUserId);
        if(fullComment) {
             return { type: 'comment', content: fullComment, likedAt } as LikedItem;
        }
      }
      return null;
    });

    const items = (await Promise.all(itemPromises)).filter(Boolean) as LikedItem[];
    const nextCursor = hasMore && fetchedDocs.length > 0 ? fetchedDocs[fetchedDocs.length - 1].data().createdAt as FirestoreTimestamp : null;

    return { items, nextCursor, hasMore };
  } catch (error) {
    console.error("Error fetching paginated liked items:", error);
    throw error;
  }
}

// --- Feeds de atividade (Explorar, Seguindo, Perfil): posts + reposts, com visibilidade e paginação por tempo ---
// Cada fonte (consulta) devolve até limit+1 itens do mais novo para o mais antigo; a página junta as fontes e só vai
// até a "fronteira" (o item mais antigo garantido de toda fonte que veio cheia), para não pular nada entre páginas.
// O cursor é a data da última atividade da página. Antes esses feeds não paginavam (hasMore sempre falso) e traziam
// tudo de uma vez, montando todos os posts, inclusive os que não iam aparecer.

const chunkIds = (ids: string[], size: number): string[][] => {
  const chunks: string[][] = [];
  for (let i = 0; i < ids.length; i += size) chunks.push(ids.slice(i, i + size));
  return chunks;
};

// Entre as contas seguidas, as de perfil privado: os posts delas são "só para seguidores" e vêm em consultas próprias
// de no máximo 10 autores (as regras conferem "segue o autor" para cada um, e o limite por consulta é 10).
type FeedActivity = { kind: 'post' | 'repost'; doc: QueryDocumentSnapshot<DocumentData>; ts: FirestoreTimestamp; time: number };

const toActivity = (kind: FeedActivity['kind'], snap: QueryDocumentSnapshot<DocumentData>): FeedActivity | null => {
  const ts = snap.data().createdAt;
  return ts instanceof FirestoreTimestamp ? { kind, doc: snap, ts, time: ts.toMillis() } : null;
};

/**
 * Explorar é DESCOBERTA: post de quem é de outro servidor só entra se a pessoa marcou `discoverable` no próprio perfil
 * (gravado em `remoteDiscoverable` no espelho `ap_`). Ausente não é sim. Conteúdo local não passa por aqui.
 */
function remotoNaDescoberta(userId: unknown, marcadoRemoto: boolean, autor: User | undefined): boolean {
  const remoto = marcadoRemoto || (typeof userId === 'string' && isRemoteId(userId));
  return remotoPodeAparecerNaDescoberta({ remoto, descobrivel: autor?.remoteDiscoverable === true });
}

async function hydrateActivity(activity: FeedActivity, activeUserId: string | null, options: PaginatedPostsOptions): Promise<Post | null> {
  const isProfileFeed = options.feedContext === 'profile_posts';
  const isLocalNetwork = options.feedContext === 'local_network';
  if (activity.kind === 'post') {
    const data = activity.doc.data();
    if (data.type === 'repost') return null; // modelo antigo: o repost agora é um marcador
    if (options.feedContext === 'profile_quotes' && data.type !== 'quote') return null;
    if (isLocalNetwork && (isRemoteId(data.userId) || data.isRemoteFediverse === true)) return null;
    if (options.excludePostId && activity.doc.id === options.excludePostId) return null; // fixado, mostrado à parte
    const montado = (await buildPostFromSnapshot(activity.doc, activeUserId)) ?? null;
    if (montado && options.feedContext === 'explore' && !remotoNaDescoberta(data.userId, data.isRemoteFediverse === true, montado.user)) return null;
    return montado;
  }

  const repostData = activity.doc.data();
  if (isLocalNetwork && (isRemoteId(repostData.userId) || repostData.isRemoteFediverse === true)) return null;
  const reposter = await getUser(repostData.userId, activeUserId);
  if (!reposter) return null;
  if (!isProfileFeed && (reposter.isBlocked || reposter.hasBlockedCurrentUser)) return null;
  // O marcador não tem visibilidade própria. A atividade de uma conta privada só pode aparecer ao dono e aos
  // seguidores; no Explorar ela nunca entra, mesmo quando quem está olhando segue essa conta.
  if (reposter.profileVisibility === 'private') {
    if (options.feedContext === 'explore') return null;
    if (reposter.id !== activeUserId && !reposter.isFollowing) return null;
  }

  const pathParts = activity.doc.ref.path.split('/');
  if (pathParts.includes('comments')) {
    const postId = pathParts[1];
    const commentId = pathParts[3];
    if (!postId || !commentId) return null;
    const originalComment = await getCommentById(postId, commentId, activeUserId);
    if (!originalComment || originalComment.isDeleted) return null;
    if (originalComment.postVisibility !== 'public') {
      const entregaRestrita = options.feedContext !== 'explore' && reposter.id === originalComment.postAuthorId;
      if (!entregaRestrita) return null;
    }
    return {
      id: `repost-comment-${commentId}-${activity.doc.id}`,
      type: 'repost',
      userId: reposter.id,
      user: reposter,
      authorDetails: createEmbeddedUserDetails(reposter),
      repostedBy: createEmbeddedUserDetails(reposter),
      repostedAt: activity.ts.toDate().toISOString(),
      createdAt: originalComment.createdAt,
      repostedComment: originalComment,
      text: null, media: [], hasMedia: false, visibility: originalComment.postVisibility, allowReposts: true, replyPermission: 'everyone',
      category: 'echo', likes: 0, reposts: 0, quotesCount: 0, commentsCount: 0, views: 0,
      isEdited: false, editCount: 0, postFormat: 'standard', comments: [], isLiked: false,
    } as Post;
  }

  const originalPostId = activity.doc.ref.parent.parent?.id;
  if (!originalPostId) return null;
  const originalPost = await getPostById(originalPostId, activeUserId);
  if (!originalPost || originalPost.isDeleted) return null;
  if (isLocalNetwork && (isRemoteId(originalPost.userId) || (originalPost as Post & { isRemoteFediverse?: boolean }).isRemoteFediverse === true)) return null;
  if (originalPost.visibility !== 'public') {
    const entregaRestrita = options.feedContext !== 'explore' && reposter.id === originalPost.userId;
    if (!entregaRestrita) return null;
  }
  if (isProfileFeed && originalPost.userId === activeUserId) return null;
  // No Explorar, o post de quem é de fora só entra com `discoverable` -- também quando chega pelo repost de alguém daqui.
  if (
    options.feedContext === 'explore' &&
    !remotoNaDescoberta(originalPost.userId, (originalPost as Post & { isRemoteFediverse?: boolean }).isRemoteFediverse === true, originalPost.user)
  ) {
    return null;
  }
  return {
    ...originalPost,
    repostedBy: createEmbeddedUserDetails(reposter),
    repostedAt: activity.ts.toDate().toISOString(),
  } as Post;
}

async function fetchActivityPage(
  cursor: FirestoreTimestamp | null,
  limit: number,
  activeUserId: string | null,
  options: PaginatedPostsOptions,
): Promise<{ items: Post[]; lastTs: FirestoreTimestamp | null; hasMore: boolean }> {
  const isLocalNetwork = options.feedContext === 'local_network';
  const pageSize = isLocalNetwork ? 100 : options.feedContext === 'profile_quotes' ? Math.max(limit * 2, 24) : limit + 1;
  const before: QueryConstraint[] = cursor ? [where('createdAt', '<', cursor)] : [];
  const postQuery = (...filters: QueryConstraint[]) =>
    query(postsCollection, ...filters, where('isDeleted', '==', false), ...before, orderBy('createdAt', 'desc'), firestoreLimit(pageSize));
  const repostQuery = (...filters: QueryConstraint[]) =>
    query(collectionGroup(db, 'reposts'), ...filters, ...before, orderBy('createdAt', 'desc'), firestoreLimit(pageSize));
  const postQueries: Query<DocumentData>[] = [];
  const repostQueries: Query<DocumentData>[] = [];

  // Feed "Seguindo" e feed criado pela pessoa funcionam igual: o que muda é a lista de autores. No feed criado, a
  // lista é a que ela escolheu; só entram posts só-para-seguidores de quem ela realmente segue (antes o feed criado
  // trazia só posts públicos, não trazia reposts e não tinha paginação nenhuma: acabava na primeira página).
  const autoresDoFeed = [...new Set((options.feedContext === 'following'
    ? (activeUserId ? await getFollowedUserIds(activeUserId) : [])
    : (options.customFeedUserIds ?? [])).filter(Boolean))];
  if (options.feedContext === 'following' || options.feedContext === 'custom') {
    if (!activeUserId || autoresDoFeed.length === 0) return { items: [], lastTs: null, hasMore: false };
    for (const chunk of chunkIds(autoresDoFeed, 30)) {
      postQueries.push(postQuery(where('userId', 'in', chunk), where('visibility', '==', 'public')));
      repostQueries.push(repostQuery(where('userId', 'in', chunk)));
    }
    // Perfis privados da lista que a pessoa segue: os posts deles são "followers" e ela tem direito de ver. Num feed
    // criado, ela pode ter posto alguém que não segue — esse fica de fora (as regras recusariam a consulta).
    let autoresComAcessoRestrito = autoresDoFeed;
    if (options.feedContext === 'custom') {
      const seguindo = new Set(await getFollowedUserIds(activeUserId));
      autoresComAcessoRestrito = autoresDoFeed.filter((id) => id === activeUserId || seguindo.has(id));
    }
    // Consultar diretamente `visibility == followers` elimina um cache de cinco minutos sobre quais contas eram
    // privadas. Se alguém alternava a privacidade, o feed podia omitir seus posts até o cache vencer. As regras só
    // aceitam até dez autores por consulta e todos aqui são seguidos (ou o próprio usuário).
    // Contas ap_ do Fediverso nunca têm posts com visibility == 'followers' no Firestore.
    const localRestrictedAuthors = autoresComAcessoRestrito.filter((id) => !isRemoteId(id));
    for (const chunk of chunkIds(localRestrictedAuthors, 10)) {
      postQueries.push(postQuery(where('userId', 'in', chunk), where('visibility', '==', 'followers')));
    }
  } else if (options.feedContext === 'profile_posts' && options.profileUserId) {
    const profileId = options.profileUserId;
    const visibility = profileId === activeUserId
      ? []
      : [where('visibility', '==', options.profileVisibility === 'private' ? 'followers' : 'public')];
    postQueries.push(postQuery(where('userId', '==', profileId), ...visibility));
    repostQueries.push(repostQuery(where('userId', '==', profileId)));
  } else if (options.feedContext === 'profile_reposts' && options.profileUserId) {
    repostQueries.push(repostQuery(where('userId', '==', options.profileUserId)));
  } else if (options.feedContext === 'profile_quotes' && options.profileUserId) {
    const profileId = options.profileUserId;
    const visibility = profileId === activeUserId
      ? []
      : [where('visibility', '==', options.profileVisibility === 'private' ? 'followers' : 'public')];
    postQueries.push(query(
      postsCollection,
      where('userId', '==', profileId),
      ...visibility,
      where('isDeleted', '==', false),
      ...before,
      orderBy('createdAt', 'desc'),
      firestoreLimit(Math.max(pageSize * 3, 30)),
    ));
  } else {
    postQueries.push(postQuery(where('visibility', '==', 'public')));
    repostQueries.push(repostQuery());
  }

  const snapshots = await Promise.all([...postQueries, ...repostQueries].map(q => getDocs(q)));
  const fontes = snapshots.map((snapshot, index) => {
    const kind: FeedActivity['kind'] = index < postQueries.length ? 'post' : 'repost';
    const atividades = snapshot.docs.map(snap => toActivity(kind, snap)).filter((a): a is FeedActivity => !!a);
    return {
      itens: atividades.map((a) => ({ time: a.time, item: a })),
      cheia: snapshot.docs.length >= pageSize && atividades.length > 0,
    };
  });
  // A janela e o cursor saem de uma função pura (src/lib/feed/activityWindow.ts), testada: a página não corta um empate de data e
  // a próxima consulta começa no instante da fronteira, então nada com a mesma data de outro item é pulado.
  const { janela: itensDaJanela, proximoLimiteMs, temMais } = janelaDeAtividades(fontes, limit, (a) => {
    const data = a.doc.data();
    if (a.kind === 'post') {
      if (data.type === 'repost') return false;
      if (options.feedContext === 'profile_quotes' && data.type !== 'quote') return false;
      if (options.excludePostId && a.doc.id === options.excludePostId) return false;
    }
    return !(isLocalNetwork && (isRemoteId(data.userId) || data.isRemoteFediverse === true));
  });
  const window = itensDaJanela.map((x) => x.item);
  const hydrated = await Promise.all(window.map(activity => hydrateActivity(activity, activeUserId, options)));

  // Um item por conteúdo: o post e o repost dele aparecem uma vez, na atividade mais recente.
  const seen = new Set<string>();
  const items: Post[] = [];
  for (const post of hydrated) {
    if (!post) continue;
    const contentId = getFeedContentKey(post);
    if (seen.has(contentId)) continue;
    seen.add(contentId);
    items.push(post);
  }
  return {
    items,
    lastTs: proximoLimiteMs === null ? null : FirestoreTimestamp.fromMillis(proximoLimiteMs),
    hasMore: temMais,
  };
}

async function fetchActivityFeed(
  cursor: FirestoreTimestamp | null,
  limit: number,
  activeUserId: string | null,
  options: PaginatedPostsOptions,
): Promise<PaginatedPostsResponse> {
  // Se uma página vier quase vazia (posts apagados, autores bloqueados), busca mais algumas vezes: uma página vazia
  // com "tem mais" deixaria a rolagem infinita parada.
  const posts: Post[] = [];
  const seen = new Set<string>();
  let nextCursor = cursor;
  let hasMore = true;
  const maxRounds = options.feedContext === 'local_network' ? 12 : options.feedContext === 'profile_quotes' ? 6 : 3;
  for (let round = 0; round < maxRounds && hasMore && posts.length < limit; round++) {
    const prevCursorMs = nextCursor?.toMillis() ?? null;
    const page = await fetchActivityPage(nextCursor, limit, activeUserId, options);
    for (const post of page.items) {
      const key = getFeedContentKey(post);
      if (seen.has(key)) continue;
      seen.add(key);
      // Sem teto aqui: o cursor da página já passou por TODOS estes itens, e o que sobrasse do teto seria perdido (a página pode
      // ter mais de `limit` itens quando uma rodada anterior veio magra ou quando há empate de data na borda).
      posts.push(post);
    }
    const nextCursorMs = page.lastTs?.toMillis() ?? null;
    if (!page.lastTs || (prevCursorMs !== null && nextCursorMs === prevCursorMs)) {
      nextCursor = page.lastTs;
      hasMore = false;
      break;
    }
    nextCursor = page.lastTs;
    hasMore = page.hasMore;
    // Já temos um lote sólido para exibir rápido; o prefetch da rolagem traz o restante sem travar a tela.
    if (posts.length >= Math.min(limit, 14) || (round >= 1 && posts.length >= 10)) break;
  }
  return { posts, nextCursor: hasMore ? nextCursor : null, hasMore };
}

/**
 * O feed, já recortado para quem está vendo. Quem NÃO tem conta recebe só o que a vitrine mostra (ver
 * lib/feed/publicVisibility.ts): nada com aviso de conteúdo e nada fora do português. Com conta, a lista é a de sempre.
 * O recorte fica AQUI, numa saída só, porque a busca tem vários `return` e todas as telas passam por este caminho.
 */
export async function fetchPaginatedPosts(
  cursor: FirestoreTimestamp | null,
  limit: number,
  activeUserId: string | null = getCurrentUserId(),
  options: PaginatedPostsOptions = {}
): Promise<PaginatedPostsResponse> {
  const resposta = await buscarPaginaDePosts(cursor, limit, activeUserId, options);
  if (activeUserId) return resposta;
  return { ...resposta, posts: [...filterForVisitor(resposta.posts, activeUserId)] };
}

async function buscarPaginaDePosts(
  cursor: FirestoreTimestamp | null,
  limit: number,
  activeUserId: string | null,
  options: PaginatedPostsOptions = {}
): Promise<PaginatedPostsResponse> {

  if (options.feedContext === ('profile_likes' as any)) {
    throw new Error("fetchPaginatedPosts should not be called for 'profile_likes'. Use fetchPaginatedLikedItems instead.");
  }
  
  if (options.searchQuery) {
    const searchResults = await searchPosts(options.searchQuery, activeUserId, options.searchType);
    return { posts: searchResults, nextCursor: null, hasMore: false };
  }
  
  if (options.tagName) {
    const searchTag = options.tagName.startsWith('#') ? options.tagName : `#${options.tagName}`;
    
    const POST_LIMIT = 50;
    const COMMENT_LIMIT = 50;

    const postsQuery = query(
        postsCollection,
        where("hashtags", "array-contains", searchTag),
        where("visibility", "==", "public"),
        where("isDeleted", "==", false),
        orderBy("createdAt", "desc"),
        firestoreLimit(POST_LIMIT)
    );

    const commentsQuery = query(
        collectionGroup(db, 'comments'),
        where("hashtags", "array-contains", searchTag),
        where("postVisibility", "==", "public"),
        where("isDeleted", "==", false),
        orderBy("createdAt", "desc"),
        firestoreLimit(COMMENT_LIMIT)
    );

    const recentPostsQuery = query(
        postsCollection,
        where("visibility", "==", "public"),
        where("isDeleted", "==", false),
        orderBy("createdAt", "desc"),
        firestoreLimit(250)
    );

    const recentCommentsQuery = query(
        collectionGroup(db, 'comments'),
        where("postVisibility", "==", "public"),
        where("isDeleted", "==", false),
        orderBy("createdAt", "desc"),
        firestoreLimit(200)
    );
    
    try {
        const [postsRes, commentsRes, recentPostsRes, recentCommentsRes] = await Promise.allSettled([
            getDocs(postsQuery),
            getDocs(commentsQuery),
            getDocs(recentPostsQuery),
            getDocs(recentCommentsQuery),
        ]);

        const postIds = new Set<string>();
        if (postsRes.status === 'fulfilled') {
            postsRes.value.docs.forEach(d => postIds.add(d.id));
        }
        if (recentPostsRes.status === 'fulfilled') {
            recentPostsRes.value.docs.forEach(d => {
                if (postIds.has(d.id)) return;
                const data = d.data();
                const tags = extractHashtagsFromString(`${data.text || ''} ${data.headline || ''}`);
                if (tags.includes(searchTag)) postIds.add(d.id);
            });
        }

        const commentKeys = new Map<string, { postId: string; commentId: string }>();
        if (commentsRes.status === 'fulfilled') {
            commentsRes.value.docs.forEach(d => {
                const postId = d.ref.parent.parent?.id;
                if (postId) commentKeys.set(`${postId}/${d.id}`, { postId, commentId: d.id });
            });
        }
        if (recentCommentsRes.status === 'fulfilled') {
            recentCommentsRes.value.docs.forEach(d => {
                const postId = d.ref.parent.parent?.id;
                if (!postId || commentKeys.has(`${postId}/${d.id}`)) return;
                const data = d.data();
                const tags = extractHashtagsFromString(data.text || '');
                if (tags.includes(searchTag)) commentKeys.set(`${postId}/${d.id}`, { postId, commentId: d.id });
            });
        }

        const postPromises = Array.from(postIds).map(id => getPostById(id, activeUserId));
        const commentPromises = Array.from(commentKeys.values()).map(({ postId, commentId }) =>
            getCommentById(postId, commentId, activeUserId)
        );

        const posts = (await Promise.all(postPromises)).filter((p): p is Post => !!p);
        const comments = (await Promise.all(commentPromises)).filter((c): c is Comment => !!c);

        const combined = [...posts, ...comments];

        combined.sort((a, b) => getComparableTime(b.createdAt) - getComparableTime(a.createdAt));
        
        return {
            posts: combined,
            nextCursor: null,
            hasMore: false,
        };

    } catch (e: any) {
        console.error("Error in fetchPaginatedPosts for hashtag:", String(e));
        throw e;
    }
  }
  
  if (options.feedContext === 'explore' || options.feedContext === 'following' || options.feedContext === 'local_network'
      || options.feedContext === 'profile_posts' || options.feedContext === 'profile_reposts'
      || options.feedContext === 'profile_quotes' || options.feedContext === 'custom') {
    return fetchActivityFeed(cursor as FirestoreTimestamp | null, limit, activeUserId, options);
  }

  let q = query(postsCollection, where("isDeleted", "==", false));
  
  const isPublicFeed = options.feedContext === 'articles' || options.feedContext === 'top_news';

  // Toda consulta precisa garantir a visibilidade (as regras recusam listagens que possam trazer posts fechados):
  // o próprio perfil vê tudo; o perfil de outra pessoa, os posts públicos ou, se ele for privado, os "followers".
  if (options.profileUserId) {
    q = query(q, where("userId", "==", options.profileUserId));
    if (options.profileUserId !== activeUserId) {
      q = query(q, where("visibility", "==", options.profileVisibility === 'private' ? 'followers' : 'public'));
    }
    if (options.feedContext === 'profile_media') {
        q = query(q, where('hasMedia', '==', true));
    }
  } else {
    q = query(q, where("visibility", "==", "public"));
    if (isPublicFeed) {
        q = query(q, where("category", "==", "news"));
        if (options.newsCategory) {
            q = query(q, where("newsCategory", "==", options.newsCategory));
        }
    }
  }

  q = query(q, orderBy("createdAt", "desc"));
  if (cursor) {
    q = query(q, startAfter(cursor));
  }
  q = query(q, firestoreLimit(limit + 1));
  
  try {
    const snapshot = await getDocs(q);
    const fetchedDocs = snapshot.docs;

    const hasMore = fetchedDocs.length > limit;
    if (hasMore) {
      fetchedDocs.pop();
    }

    const postPromises = fetchedDocs
      .filter(doc => doc.id !== options.excludePostId) // o post fixado aparece à parte
      .map(doc => buildPostFromSnapshot(doc, activeUserId));
    const posts = (await Promise.all(postPromises)).filter((p): p is Post => !!p);

    const nextCursor = hasMore && fetchedDocs.length > 0
      ? fetchedDocs[fetchedDocs.length - 1].data().createdAt as FirestoreTimestamp
      : null;

    return {
      posts,
      nextCursor,
      hasMore,
    };
  } catch (e: any) {
    console.error("Error in fetchPaginatedPosts:", String(e));
    throw e;
  }
}

export const getPostsByUser = async (userId: string, activeUserId: string | null = getCurrentUserId()): Promise<Post[]> => {
    console.warn("getPostsByUser is deprecated. Use fetchPaginatedPosts with profileUserId option.");
    const { posts } = await fetchPaginatedPosts(null, 50, activeUserId, { profileUserId: userId, feedContext: 'profile_posts' });
    return posts as Post[];
};

export const getUserMediaPosts = async (userId: string, activeUserId: string | null = getCurrentUserId()): Promise<Post[]> => {
    console.warn("getUserMediaPosts is deprecated. Use fetchPaginatedPosts with 'profile_media' context.");
    const { posts } = await fetchPaginatedPosts(null, 50, activeUserId, { profileUserId: userId, feedContext: 'profile_media' });
    return posts as Post[];
};

export const getPostsByHashtag = async (tagName: string, activeUserId: string | null = getCurrentUserId()): Promise<Post[]> => {
    console.warn("getPostsByHashtag is deprecated. Use fetchPaginatedPosts with tagName option.");
    const { posts } = await fetchPaginatedPosts(null, 50, activeUserId, { tagName });
    return posts as Post[];
};

export const getTopPostsByHashtag = async (tagName: string, limit: number, activeUserId: string | null = getCurrentUserId()): Promise<(Post | Comment)[]> => {
    if (!tagName) return [];
    const searchTag = tagName.startsWith('#') ? tagName : `#${tagName}`;
    
    const POST_LIMIT = 100;
    const COMMENT_LIMIT = 100;

    const postsQuery = query(
        postsCollection,
        where("hashtags", "array-contains", searchTag),
        where("visibility", "==", "public"),
        where("isDeleted", "==", false),
        orderBy('createdAt', 'desc'),
        firestoreLimit(POST_LIMIT)
    );
    const commentsQuery = query(
        collectionGroup(db, 'comments'),
        where("hashtags", "array-contains", searchTag),
        where("postVisibility", "==", "public"),
        where("isDeleted", "==", false),
        orderBy('createdAt', 'desc'),
        firestoreLimit(COMMENT_LIMIT)
    );
    const recentPostsQuery = query(
        postsCollection,
        where("visibility", "==", "public"),
        where("isDeleted", "==", false),
        orderBy('createdAt', 'desc'),
        firestoreLimit(250)
    );
    const recentCommentsQuery = query(
        collectionGroup(db, 'comments'),
        where("postVisibility", "==", "public"),
        where("isDeleted", "==", false),
        orderBy('createdAt', 'desc'),
        firestoreLimit(200)
    );

    try {
        const [postsRes, commentsRes, recentPostsRes, recentCommentsRes] = await Promise.allSettled([
            getDocs(postsQuery),
            getDocs(commentsQuery),
            getDocs(recentPostsQuery),
            getDocs(recentCommentsQuery),
        ]);

        const postIds = new Set<string>();
        if (postsRes.status === 'fulfilled') {
            postsRes.value.docs.forEach(d => postIds.add(d.id));
        }
        if (recentPostsRes.status === 'fulfilled') {
            recentPostsRes.value.docs.forEach(d => {
                if (postIds.has(d.id)) return;
                const data = d.data();
                const tags = extractHashtagsFromString(`${data.text || ''} ${data.headline || ''}`);
                if (tags.includes(searchTag)) postIds.add(d.id);
            });
        }

        const commentKeys = new Map<string, { postId: string; commentId: string }>();
        if (commentsRes.status === 'fulfilled') {
            commentsRes.value.docs.forEach(d => {
                const postId = d.ref.parent.parent?.id;
                if (postId) commentKeys.set(`${postId}/${d.id}`, { postId, commentId: d.id });
            });
        }
        if (recentCommentsRes.status === 'fulfilled') {
            recentCommentsRes.value.docs.forEach(d => {
                const postId = d.ref.parent.parent?.id;
                if (!postId || commentKeys.has(`${postId}/${d.id}`)) return;
                const data = d.data();
                const tags = extractHashtagsFromString(data.text || '');
                if (tags.includes(searchTag)) commentKeys.set(`${postId}/${d.id}`, { postId, commentId: d.id });
            });
        }

        const postPromises = Array.from(postIds).map(id => getPostById(id, activeUserId));
        const commentPromises = Array.from(commentKeys.values()).map(({ postId, commentId }) =>
            getCommentById(postId, commentId, activeUserId)
        );

        const posts = (await Promise.all(postPromises)).filter((p): p is Post => !!p);
        const comments = (await Promise.all(commentPromises)).filter((c): c is Comment => !!c);

        const combined = [...posts, ...comments];

        // Sort by engagement (likes) for 'top'
        combined.sort((a, b) => (b.likes || 0) - (a.likes || 0));

        return combined.slice(0, limit);
    } catch (error) {
        console.error(`Error fetching top posts for hashtag ${tagName}:`, error);
        return [];
    }
};

export const getTopNews = async (limitParam: number = 5, activeUserId: string | null = getCurrentUserId()): Promise<Post[]> => {
    console.warn("getTopNews is deprecated. Use fetchPaginatedPosts with 'articles' context.");
    const { posts } = await fetchPaginatedPosts(null, limitParam, activeUserId, { feedContext: 'articles' });
    return posts as Post[];
};

export const getTotalPostsCount = async (): Promise<number> => {
    try {
      const snapshot = await getDocs(query(postsCollection));
      return snapshot.size;
    } catch (error: any) { console.error("Error getting total posts count:", String(error)); return 0;}
};

export const subscribeToTotalPostsCount = (callback: (count: number) => void): (() => void) => {
  const q = query(postsCollection);

  const unsubscribe = onSnapshot(q, (snapshot) => {
    callback(snapshot.size);
  }, (error) => {
    console.error("Error subscribing to total posts count:", error);
    callback(0); // Report 0 on error
  });

  return unsubscribe;
};

export const searchComments = async (
  searchQuery: string,
  activeUserId: string | null = getCurrentUserId()
): Promise<Comment[]> => {
    if (!searchQuery.trim() || searchQuery.length < 2) return [];
    
    const lowerQuery = searchQuery.toLowerCase();
    const keywords = lowerQuery.split(' ').filter(k => k.length > 1);

    const commentsQuery = query(
        collectionGroup(db, 'comments'),
        where("postVisibility", "==", "public"),
        where("isDeleted", "==", false),
        orderBy("createdAt", "desc"),
        firestoreLimit(200) // Fetch a pool of recent comments to search through
    );
    
    try {
        const snapshot = await getDocs(commentsQuery);
        if (snapshot.empty) return [];

        const commentPromises = snapshot.docs.map(async (doc) => {
            const postId = doc.ref.parent.parent?.id;
            if (!postId) return null;
            return getCommentById(postId, doc.id, activeUserId);
        });

        const allComments = (await Promise.all(commentPromises)).filter((c): c is Comment => !!c);

        // Client-side filtering
        const filteredComments = allComments.filter(comment => {
            if (comment.isDeleted) return false;
            
            const content = `${comment.text || ''} ${comment.user?.name || ''} ${comment.user?.username || ''}`.toLowerCase();
            const hashtags = comment.hashtags || [];
            
            const textMatch = keywords.some(keyword => content.includes(keyword));
            const hashtagMatch = hashtags.some(h => h.includes(lowerQuery));

            return textMatch || hashtagMatch;
        });

        return filteredComments;

    } catch (error) {
        console.error("Error searching comments:", error);
        return [];
    }
};

export const searchPosts = async (
  searchQuery: string,
  activeUserId: string | null = getCurrentUserId(),
  searchType: 'top' | 'latest' | 'articles' = 'top'
): Promise<Post[]> => {
    if (!searchQuery.trim() || searchQuery.length < 2) return [];
    
    const lowerQuery = searchQuery.toLowerCase();
    const keywords = lowerQuery.split(' ').filter(k => k.length > 1);
    
    const matchingUsers = await serverSearchUsers(searchQuery, activeUserId);
    const matchingUserIds = matchingUsers.map(u => u.id);

    let baseQuery;

    if (searchType === 'articles') {
        baseQuery = query(postsCollection, where("category", "==", "news"), where("visibility", "==", "public"), where("isDeleted", "==", false));
    } else {
        baseQuery = query(postsCollection, where("visibility", "==", "public"), where("isDeleted", "==", false));
    }
    
    if (searchType === 'top') {
        baseQuery = query(baseQuery, orderBy('likes', 'desc'), orderBy('createdAt', 'desc'), firestoreLimit(200));
    } else { // 'latest' or 'articles'
        baseQuery = query(baseQuery, orderBy('createdAt', 'desc'), firestoreLimit(200));
    }

    try {
        const snapshot = await getDocs(baseQuery);
        if (snapshot.empty) return [];

        const postPromises = snapshot.docs.map(doc => getPostById(doc.id, activeUserId));
        const allPosts = (await Promise.all(postPromises)).filter((p): p is Post => !!p);
        
        // Comprehensive client-side filtering
        const filteredPosts = allPosts.filter(post => {
            const content = `${post.text || ''} ${post.headline || ''} ${post.user?.name || ''} ${post.user?.username || ''}`.toLowerCase();
            const hashtags = post.hashtags || [];

            // Check if any keyword is present in the content
            const textMatch = keywords.some(keyword => content.includes(keyword));

            // Check if there's a hashtag match
            const hashtagMatch = hashtags.some(h => h.includes(lowerQuery));
            
            // Check if author matches
            const authorMatch = matchingUserIds.includes(post.userId);

            return textMatch || hashtagMatch || authorMatch;
        });
        
        if (searchType === 'top') {
          filteredPosts.sort((a,b) => (b.likes || 0) - (a.likes || 0));
        }

        return filteredPosts;

    } catch (error) {
        console.error("Error searching posts:", error);
        return [];
    }
};


export const getUsersWhoLikedPost = async (postId: string, activeUserId: string | null): Promise<User[]> => {
  const likesColRef = collection(db, `posts/${postId}/likes`);
  const q = query(likesColRef, orderBy('createdAt', 'desc'));
  
  try {
    const snapshot = await getDocs(q);
    if (snapshot.empty) return [];
    const userIds = snapshot.docs.map(doc => doc.id);
    const userPromises = userIds.map(id => getUser(id, activeUserId));
    const users = (await Promise.all(userPromises)).filter((u): u is User => !!u);
    return users;
  } catch (error) {
    console.error(`Error fetching users who liked post ${postId}:`, error);
    return [];
  }
};

export const getUsersWhoRepostedPost = async (postId: string, activeUserId: string | null): Promise<User[]> => {
  const repostsColRef = collection(db, `posts/${postId}/reposts`);
  const q = query(repostsColRef, orderBy('createdAt', 'desc'));
  
  try {
    const snapshot = await getDocs(q);
    if (snapshot.empty) return [];
    const userIds = snapshot.docs.map(doc => doc.id); // The user ID is the document ID
    const userPromises = userIds.map(id => getUser(id, activeUserId));
    const users = (await Promise.all(userPromises)).filter((u): u is User => !!u);
    return users;
  } catch (error) {
    console.error(`Error fetching users who reposted post ${postId}:`, error);
    return [];
  }
};

export const getUsersWhoQuotedPost = async (postId: string, activeUserId: string | null): Promise<Post[]> => {
  // Só as citações públicas (as de perfis privados ficam para os seguidores deles).
  const q = query(
    postsCollection,
    where('type', '==', 'quote'),
    where('originalPostDetails.id', '==', postId),
    where('visibility', '==', 'public'),
    orderBy('createdAt', 'desc')
  );

  try {
    const snapshot = await getDocs(q);
    if (snapshot.empty) return [];
    const postPromises = snapshot.docs.map(doc => getPostById(doc.id, activeUserId));
    const posts = (await Promise.all(postPromises)).filter((p): p is Post => !!p);
    return posts;
  } catch (error: any) {
    console.error(`Error fetching users who quoted post ${postId}:`, String(error));
    return [];
  }
};
