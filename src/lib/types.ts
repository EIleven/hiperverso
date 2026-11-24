// src/lib/types.ts
import type { Timestamp, FieldValue } from 'firebase/firestore';

// --- USER-RELATED TYPES ---

export interface CustomFeed {
  id: string;
  name: string;
  userIds: string[];
  isPinned: boolean;
  createdAt: Timestamp | string;
}

export interface TabPreferences {
    hidden: ('following' | 'local_network' | 'explore' | 'articles')[];
    pinnedOrder: string[]; // array of custom feed IDs
    /** Filtro estrito de idioma nos feeds ('all' ou código como 'pt', 'en', 'es', 'fr', 'de', 'it'). */
    feedLanguageFilter?: string;
}

/** Motivo calculado no cliente para explicar por que uma conta foi sugerida. Nunca é persistido no perfil. */
export type UserRecommendationReason =
  | { kind: 'follows-you' }
  | { kind: 'mutual'; count: number }
  | { kind: 'interest'; topic: string }
  | { kind: 'related-profile'; label?: string }
  | { kind: 'active' }
  | { kind: 'popular' };

export interface RecommendationPreferences {
  enabled: boolean;
  showOnProfiles: boolean;
  useFollowingSignals: boolean;
  useInterestSignals: boolean;
  useActivitySignals: boolean;
  networkScope: 'all' | 'local' | 'fediverse';
  mode: 'balanced' | 'similar' | 'discovery';
  optOutFromSuggestions?: boolean;
}

export interface TranslationPreferences {
  mode: 'button' | 'auto' | 'off';
  targetLanguage: string;
  allowAutoDetectBrowserLang: boolean;
}


export type User = {
  id: string;
  name: string;
  username: string;
  email: string;
  dateOfBirth?: string | null;
  avatarUrl?: string;
  avatarAlt?: string | null;
  coverImageUrl?: string | null;
  coverImageAlt?: string | null;
  "data-ai-hint"?: string | null;
  "cover-image-ai-hint"?: string | null;
  bio?: string;
  pronouns?: string;
  location?: string;
  website?: string;
  links?: Array<{ label?: string; url: string }>;
  pixKey?: string;
  pixCity?: string;
  pixDescription?: string;
  matrixHandle?: string | null;
  e2eePublicKey?: string | null;
  accentColor?: string | null;
  followersCount: number;
  followingCount: number;
  postsCount: number;
  dmPreference: 'everyone' | 'followed' | 'none';
  isAdmin: boolean;
  isModerator: boolean; // Added for community moderation
  totalUnreadMessages?: number;
  pinnedPostId?: string | null; // Added for pinned post
  // Dynamic fields added on the client based on the active user
  isFollowing?: boolean;
  /** Só para perfis do Fediverso: o pedido de seguir foi enviado e o perfil ainda não aceitou (o botão mostra "Solicitação enviada"). */
  followRequested?: boolean;
  /** Perfil do Fediverso que aprova seguidores manualmente (`manuallyApprovesFollowers`): seguir vira "Pedir para seguir". Ausente = não se sabe. */
  remoteManuallyApprovesFollowers?: boolean | null;
  /** Só para perfis do Fediverso: `toot:discoverable` lido do ator. Só `true` deixa aparecer em explorar, sugestões e busca de pessoas. */
  remoteDiscoverable?: boolean;
  /** Só para perfis do Fediverso: `toot:indexable` lido do ator. Só `true` deixa o texto dos posts ser achado por palavra. */
  remoteIndexable?: boolean;
  federatedLoginProvider?: 'fediverse' | 'bluesky';
  federatedLoginHandle?: string;
  isFollowedBy?: boolean;
  isBlocked?: boolean;
  hasBlockedCurrentUser?: boolean;
  isMuted?: boolean;
  notificationSubscriptionStatus?: 'all' | 'news_only' | 'none';
  // Presence fields
  isOnline?: boolean;
  lastSeen?: string | Timestamp;
  // New settings fields
  profileVisibility?: 'public' | 'private';
  allowTagging?: 'everyone' | 'followed';
  allowReposts?: boolean; // Added for interaction settings
  replyPermission?: ReplyPermission; // Added for interaction settings
  displaySensitiveContent?: boolean; // Added for media settings
  mutedWords?: string[];
  recommendationPreferences?: RecommendationPreferences;
  translationPreferences?: TranslationPreferences;
  notificationPreferences?: {
    likes?: boolean;
    comments?: boolean;
    reposts?: boolean;
    newFollowers?: boolean;
    mentions?: boolean;
    directMessages?: boolean;
  };
  tabPreferences?: TabPreferences;
  // Campo dinâmico usado somente nas superfícies de descoberta.
  recommendationReason?: UserRecommendationReason;
  createdAt: string | FieldValue; // Allow FieldValue for serverTimestamp
  name_lowercase?: string; // Add this field
};

// --- MEDIA TYPE ---
export interface Media {
  url: string;
  type: 'image' | 'video';
  alt?: string;
  'data-ai-hint'?: string;
}

// --- TRENDING TOPIC TYPE ---
export interface TrendingTopic {
    id: string;
    title: string;
    link: string;
    pubDate: string | Timestamp;
    snippet: string | null;
    source: string;
    imageUrl: string | null;
    fetchedAt: string | Timestamp;
  }
  

// --- POST-RELATED TYPES ---
export type ReplyPermission = 'everyone' | 'followed' | 'mentioned' | 'none';
export type PostType = 'original' | 'repost' | 'quote';
export type PostCategory = 'echo' | 'news';
export type PostFormat = 'standard' | 'short_video';
export type PostVisibility = 'public' | 'private' | 'followers';

/** Município escolhido na localização do post (lista do IBGE, sem GPS). */
export interface PostLocation {
  name: string;
  state: string;
  ibgeId: number;
}

export interface PollOption {
  id: string;
  text: string;
}

/** Enquete do post: opções fixas e prazo. Os votos são contados pelas Functions (pollCounts, pollTotal no post). */
export interface PostPoll {
  options: PollOption[];
  endsAt: string | Timestamp;
}

/** Estado editável da enquete enquanto ela ainda é um rascunho. */
export interface PollDraft {
  options: string[];
  durationMinutes: number;
}

export type Post = {
  id: string;
  userId: string;
  user?: User; // Optional on Post, for embedding
  authorDetails: EmbeddedUserDetails;
  type: PostType;
  text?: string | null;
  media?: Media[] | null; // Replaces imageUrl, videoUrl, etc.
  hasMedia: boolean;
  isPinned?: boolean; // Added for pinned post
  visibility: PostVisibility;
  /** Alcance no Fediverso, fixo desde a criação. Ausente = só aqui. */
  federation?: 'local' | 'public' | 'unlisted' | 'followers';
  /** Post materializado do Fediverso (id `ap_…`). Os campos `remote*` dizem de onde veio. */
  isRemoteFediverse?: boolean;
  /** Id ActivityPub (ou, nos posts antigos, a URL da página) do objeto no servidor de origem. */
  remoteObjectId?: string | null;
  /** Página do post no servidor de origem: igual nas cópias do mesmo post, mesmo com ids locais diferentes. */
  remoteUrl?: string | null;
  remoteActorId?: string | null;
  originalPostDetails?: OriginalPostDetails | null;
  quotedCommentId?: string | null; // ID of the quoted comment
  quotedComment?: Comment | null; // Full quoted comment object
  repostedComment?: Comment | null; // For displaying reposted comments in a feed
  allowReposts: boolean;
  replyPermission: ReplyPermission;
  category: PostCategory;
  newsCategory?: string | null;
  headline?: string | null;
  sourceUrl?: string | null;
  hashtags?: string[] | null;
  /** Mapa de custom emojis do Fediverso (`:shortcode:` -> URL https) recebidos no Note. */
  customEmojis?: Record<string, string> | null;
  /** Cidade do post, escolhida pelo autor. */
  location?: PostLocation | null;
  /** Conteúdo sensível: fica coberto até a pessoa tocar (ou ligar "exibir conteúdo sensível"). Vale com ou sem mídia. */
  sensitive?: boolean;
  /** O aviso que o autor escreveu (`summary`/CW do Fediverso). Aparece ANTES do texto e da mídia. */
  contentWarning?: string | null;
  /** Idioma declarado pela origem, só em post do Fediverso. Post nosso não declara (a rede é em português). */
  language?: string | null;
  poll?: PostPoll | null;
  /** IDs redundantes, mantidos no documento para as regras validarem votos sem confiar no cliente. */
  pollOptionIds?: string[] | null;
  /** Votos por opção e total (só as Functions gravam). */
  pollCounts?: Record<string, number> | null;
  pollTotal?: number | null;
  /** Só no cliente: a opção em que quem vê já votou. */
  myPollVote?: string | null;
  likes: number;
  reposts: number;
  quotesCount: number; // Added for separate quote counting
  commentsCount: number;
  views: number;
  isEdited: boolean;
  editCount: number;
  isDeleted?: boolean; // Added for tombstoning
  postFormat: PostFormat;
  createdAt: string | Timestamp;
  updatedAt?: string | null;
  comments: Comment[];
  isLiked: boolean;
  isLikedBy?: { [key: string]: boolean };
  isReposted?: boolean;
  isQuotedByCurrentUser?: boolean;
  isBookmarked?: boolean; // Added for bookmark status
  repostedBy?: EmbeddedUserDetails;
  repostedAt?: string;
  // Deprecated fields (to be removed later)
  imageUrl?: string | null;
  imageAlt?: string | null; 
  "data-ai-hint"?: string | null;
  videoUrl?: string | null;
  youtubeVideoId?: string | null;
};

export type OriginalPostDetails = Omit<
  Post,
  | 'user'
  | 'comments'
  | 'isLiked'
  | 'isLikedBy'
  | 'isReposted'
  | 'isQuotedByCurrentUser'
> & {
  authorDetails: EmbeddedUserDetails;
  parentPostId?: string; // Add for comment quotes
  parentPostAuthorDetails?: EmbeddedUserDetails | null; // For context in comment quotes
  // O original citado não pode ser mostrado a quem vê (apagado, ou de perfil privado que a pessoa não segue).
  isUnavailable?: boolean;
};

// --- COMMENT-RELATED TYPES ---
export type Comment = {
  id: string;
  userId: string;
  user: User;
  authorDetails: EmbeddedUserDetails;
  parentPostId: string;
  postAuthorId: string;
  postVisibility: PostVisibility;
  parentPostUser?: Post | null; // Can be a quoted post
  parentPostAuthorDetails?: EmbeddedUserDetails | null;
  parentPostText?: string | null;
  parentCommentId?: string | null;
  parentCommentAuthorDetails?: EmbeddedUserDetails | null;
  text: string;
  media?: Media[]; // Replaces imageUrl, videoUrl, etc.
  hasMedia: boolean;
  createdAt: string | Timestamp;
  likes: number;
  repostsCount: number;
  repliesCount: number;
  isDeleted?: boolean; // Added for tombstoning
  isLiked: boolean;
  isBookmarked?: boolean;
  isReposted?: boolean;
  isQuotedByCurrentUser?: boolean;
  isLikedBy?: { [key: string]: boolean };
  quotedPostObject?: Post | null; // New field for quoted posts in comments
  hashtags?: string[] | null;
  /** Mapa de custom emojis do Fediverso (`:shortcode:` -> URL https) recebidos no Note. */
  customEmojis?: Record<string, string> | null;
  /** Conteúdo sensível no comentário (veja Post.sensitive). */
  sensitive?: boolean;
  /** O aviso que o autor escreveu (`summary`/CW do Fediverso). */
  contentWarning?: string | null;
  // Deprecated fields
  imageUrl?: string | null;
  "data-ai-hint"?: string | null;
  youtubeVideoId?: string | null;
};

// --- NOTIFICATION-RELATED TYPES ---
export type NotificationType =
  | 'like_post'
  | 'like_repost'
  | 'repost'
  | 'repost_repost'
  | 'quote'
  | 'comment_on_post'
  | 'reply_to_comment'
  | 'new_follower'
  | 'follow_back'
  | 'like_comment'
  | 'mention_in_post'
  | 'mention_in_comment'
  | 'new_post_from_user'
  | 'new_message'
  | 'new_conversation'
  | 'alt_text_request'
  | 'welcome';

export type NotificationActor = {
  userId: string;
  name: string;
  username: string;
  avatarUrl?: string;
  "data-ai-hint"?: string | null;
};

export type PostSnapshotForNotification = {
  id: string;
  text?: string | null;
  headline?: string | null;
  category: PostCategory;
  newsCategory?: string | null;
};

export type Notification = {
  id: string;
  recipientId: string;
  type: NotificationType;
  actors: NotificationActor[];
  count: number;
  entityId?: string;
  entityParentId?: string;
  entityType?: 'post' | 'comment' | 'user' | 'conversation';
  previewText?: string | null;
  newPostId?: string;
  createdAt: string;
  readAt: string | null;
};

// --- CONVERSATION & MESSAGE TYPES ---
export type E2eeMessagePayload = {
  v: 1;
  alg: 'ECDH-P256-AES-GCM';
  senderPublicKey: string;
  recipientPublicKey?: string;
  iv: string;
  ciphertext: string;
};

export type DirectMessage = {
  id: string;
  conversationId: string;
  senderId: string;
  sender?: User;
  senderDetails?: EmbeddedUserDetails;
  text: string;
  e2ee?: E2eeMessagePayload | null;
  isP2p?: boolean;
  p2pStatus?: 'queued' | 'sent';
  fileUrl?: string;
  fileType?: 'image' | 'video' | 'audio' | 'file';
  mediaE2ee?: E2eeMessagePayload | null;
  /** Capa cifrada de anexo grande protegido (feita no aparelho de quem envia; o servidor nao ve o video). */
  posterUrl?: string | null;
  sharedPostId?: string; // Added to share posts
  sharedPost?: Post | null; // For client-side rendering
  createdAt: string;
  readAt?: string | null; // ISO string for when the message was read
  // Fields for replies
  parentMessageId?: string | null;
  parentMessageText?: string | null;
  parentMessageSenderName?: string | null;
};

export type ConversationParticipantInfo = {
  id: string;
  name: string;
  username: string;
  avatarUrl?: string;
  "data-ai-hint"?: string | null;
};

export type Conversation = {
  id: string;
  participantIds: string[];
  participantsInfo: User[];
  lastMessage: DirectMessage | null;
  unreadCounts: { [key: string]: number };
  lastMessageId?: string | null;
  lastMessageText?: string | null;
  lastMessageSenderId?: string | null;
  createdAt: string;
  lastMessageAt: string;
  userLeftAt?: { [userId: string]: string | Timestamp }; // New field
  /**
   * Confirmacao de leitura: ate quando cada pessoa ja leu ("marca d'agua"), nao um registro por mensagem.
   * So o dono da chave escreve a propria, e so com a hora do servidor (firestore.rules). Quem desliga a
   * confirmacao nao escreve a sua e nao enxerga a dos outros (src/lib/messages/recibos.ts).
   */
  lastReadAt?: { [userId: string]: string | Timestamp };
  isSelf?: boolean;
  isGroup?: boolean;
  groupName?: string | null;
  groupAvatarUrl?: string | null;
  adminIds?: string[];
  createdBy?: string;
};

// --- API & FORM-RELATED TYPES ---
export type ApiError = {
  message: string;
  details?: Record<string, any>;
};

export type FollowAction = 'follow' | 'unfollow';

export type FollowResponse = {
  success: boolean;
  newFollowersCount?: number;
  newFollowingCount?: number;
};

// --- DELETION-RELATED TYPES ---
export type DeletionResult = {
  status: 'deleted' | 'tombstoned';
  updatedPost?: Post; // The tombstoned post
  updatedComment?: Comment; // The tombstoned comment
};

export type EmbeddedUserDetails = {
  userId: string;
  name: string;
  username: string;
  avatarUrl?: string;
  "data-ai-hint"?: string | null;
  isMuted?: boolean;
  isBlocked?: boolean;
};

export type LikedItem = {
    type: 'post' | 'comment';
    content: Post | Comment;
    likedAt: string; // ISO string
};

// Draft type for local storage (IndexedDB)
export interface Draft {
  id?: string; // UUID - make optional for new drafts
  draftType: 'post' | 'news' | 'comment';
  text?: string;
  media?: Media[];
  headline?: string;
  sourceUrl?: string;
  newsCategory?: string;
  quotedPostObject?: Post | null;
  parentPostId?: string; // for comment drafts
  parentCommentId?: string; // for reply drafts
  replyPermission: ReplyPermission;
  allowReposts: boolean;
  location?: PostLocation | null;
  sensitive?: boolean;
  pollInput?: PollDraft | null;
  savedAt: number; // epoch timestamp
}

// --- TELEMETRY TYPES ---
export interface AccessEvent {
  timestamp: number;
  path: string;
  method: string;
  referrer: string | null;
  userAgent: string | null;
  sessionId: string;
  audienceType: 'guest' | 'auth';
  userId?: string | null;
  ip?: string;
  geo?: {
    countryCode: string | null;
    countryName: string | null;
    stateCode: string | null;
    stateName: string | null;
    city: string | null;
  } | null;
}
