/**
 * @fileOverview Mensagens de push (FCM) das notificações.
 *
 * Cada notificação criada vira UMA mensagem por idioma dos aparelhos de quem
 * recebe. O texto depende do tipo (curtiu, respondeu, mencionou...), o toque
 * abre o destino exato (o post, o comentário, o perfil, a conversa) e o `tag`
 * agrupa avisos do mesmo assunto em vez de empilhar. As regras de montagem
 * ficam aqui, sem Firebase, para poderem ser testadas sozinhas.
 */
import type {MulticastMessage} from "firebase-admin/messaging";

export type PushLocale = "pt-BR" | "en";

export type PushNotification = {
  type: string;
  actors?: Array<{ userId?: string; name?: string; username?: string }>;
  count?: number;
  previewText?: string | null;
  entityId?: string | null;
  entityParentId?: string | null;
  entityType?: string | null;
  newPostId?: string | null;
};

export type PushToken = {
  token: string;
  locale: PushLocale;
  platform: "web" | "android" | "ios";
};

export type PushContent = {
  title: string;
  body: string;
  /** Caminho com idioma (ex.: /pt-BR/post/abc#comment-xyz). */
  path: string;
  /** Agrupa avisos do mesmo assunto (o mais novo substitui o anterior). */
  tag: string;
};

/**
 * Canais de notificações do Android
 * (criados pelo app; veja AndroidManifest e pushNotificationService).
 */
export const ANDROID_CHANNEL_ID = "exelula_default";
export const ANDROID_CHANNELS = {
  default: ANDROID_CHANNEL_ID,
  messages: "exelula_messages",
  mentions: "exelula_mentions",
  security: "exelula_security",
} as const;

const PREVIEW_MAX = 90;
const URGENT_TYPES = new Set([
  "new_message",
  "mention_in_post",
  "mention_in_comment",
  "reply_to_comment",
  "alt_text_request",
  "login_request",
  "security_alert",
]);

const channelForType = (type: string): string => {
  if (type === "new_message") return ANDROID_CHANNELS.messages;
  if (type === "login_request" || type === "security_alert") {
    return ANDROID_CHANNELS.security;
  }
  if (
    type === "mention_in_post" ||
    type === "mention_in_comment" ||
    type === "reply_to_comment" ||
    type === "alt_text_request"
  ) {
    return ANDROID_CHANNELS.mentions;
  }
  return ANDROID_CHANNEL_ID;
};

/**
 * "Nova conversa" não vira push: a conversa nasce quando alguém ABRE o chat
 * (antes de escrever) e a primeira mensagem já avisa com "new_message". Um
 * push por abrir a tela avisaria a pessoa sem ter o que mostrar.
 */
const NO_PUSH_TYPES = new Set(["new_conversation"]);

/**
 * Quantidades (de curtidas, reposts...) que reenviam o aviso de uma
 * notificação AGREGADA. A primeira curtida avisa na hora (a notificação
 * nasce); as seguintes, na janela de agregação, só atualizam o contador, e
 * um push por curtida viraria spam. Nestas marcas vale a pena avisar de novo.
 */
const MILESTONES = [5, 10, 25, 50, 100, 250, 500, 1000, 5000, 10000];

/**
 * Este tipo de notificação gera push quando é criada?
 * @param {string} type Tipo da notificação.
 * @return {boolean} false para os tipos que não avisam.
 */
export const wantsPush = (type: string): boolean => !NO_PUSH_TYPES.has(type);

/**
 * Uma notificação já existente foi agregada (count subiu): reenvia o aviso?
 * Mensagem direta SEMPRE avisa (cada mensagem nova é um aviso; o `tag` faz a
 * nova substituir a anterior). Os demais só ao cruzar uma marca de MILESTONES.
 * @param {string} type Tipo da notificação.
 * @param {number} before Contador antes da atualização.
 * @param {number} after Contador depois da atualização.
 * @return {boolean} true se deve enviar push.
 */
export const shouldPushOnUpdate = (
  type: string,
  before: number,
  after: number
): boolean => {
  if (!wantsPush(type) || !(after > before)) {
    return false;
  }
  if (type === "new_message") {
    return true;
  }
  return MILESTONES.some((mark) => before < mark && after >= mark);
};

/**
 * Normaliza o idioma guardado no aparelho.
 * @param {unknown} value Valor lido do documento do token.
 * @return {PushLocale} pt-BR (padrão) ou en.
 */
export const normalizeLocale = (value: unknown): PushLocale =>
  typeof value === "string" && value.toLowerCase().startsWith("en") ?
    "en" :
    "pt-BR";

/**
 * Aparelho conhecido (qualquer outro vale como web).
 * @param {unknown} value Valor lido do documento do token.
 * @return {PushToken["platform"]} Plataforma.
 */
export const normalizePlatform = (value: unknown): PushToken["platform"] =>
  value === "android" || value === "ios" ? value : "web";

/**
 * Recorta o trecho mostrado no aviso (sem quebras de linha).
 * @param {string|null|undefined} text Texto original.
 * @return {string} Trecho curto, com reticências se foi cortado.
 */
const preview = (text: string | null | undefined): string => {
  const flat = (text ?? "").replace(/\s+/g, " ").trim();
  if (!flat) {
    return "";
  }
  return flat.length > PREVIEW_MAX ?
    `${flat.slice(0, PREVIEW_MAX - 1).trimEnd()}…` :
    flat;
};

type Strings = {
  actorFallback: string;
  /** "Ana" ou "Ana e outras 3 pessoas". */
  withOthers: (actor: string, others: number) => string;
  titles: Record<string, string>;
  /** Frase depois do ator, por tipo. */
  verbs: Record<string, (isComment: boolean, count: number) => string>;
  generic: { title: string; body: string };
};

const PT: Strings = {
  actorFallback: "Alguém",
  withOthers: (actor, others) =>
    others > 0 ?
      `${actor} e outras ${others} ${others === 1 ? "pessoa" : "pessoas"}` :
      actor,
  titles: {
    like_post: "Nova curtida",
    like_comment: "Nova curtida",
    repost: "Novo repost",
    quote: "Nova citação",
    comment_on_post: "Novo comentário",
    reply_to_comment: "Nova resposta",
    new_follower: "Novo seguidor",
    mention_in_post: "Você foi mencionado(a)",
    mention_in_comment: "Você foi mencionado(a)",
    new_post_from_user: "Nova publicação",
    alt_text_request: "Pedido de Alt Text · Acessibilidade",
    login_request: "Pedido de acesso · Segurança",
    welcome: "Exe. Lula",
  },
  verbs: {
    like_post: (_c, n) =>
      `${n > 1 ? "curtiram" : "curtiu"} sua publicação.`,
    like_comment: (_c, n) =>
      `${n > 1 ? "curtiram" : "curtiu"} seu comentário.`,
    repost: (isComment, n) =>
      `${n > 1 ? "repostaram" : "repostou"} ${
        isComment ? "seu comentário" : "sua publicação"}.`,
    quote: (isComment, n) =>
      `${n > 1 ? "citaram" : "citou"} ${
        isComment ? "seu comentário" : "sua publicação"}.`,
    comment_on_post: () => "comentou na sua publicação.",
    reply_to_comment: () => "respondeu ao seu comentário.",
    new_follower: (_c, n) =>
      n > 1 ? "começaram a seguir você." : "começou a seguir você.",
    mention_in_post: () => "mencionou você numa publicação.",
    mention_in_comment: () => "mencionou você num comentário.",
    new_post_from_user: () => "publicou.",
    alt_text_request: () => "pediu descrição (Alt Text) em uma imagem sua.",
    login_request: () => "solicitou aprovação para entrar.",
    welcome: () => "Bem-vindo(a) ao Exe. Lula!",
  },
  generic: {
    title: "Exe. Lula",
    body: "Você tem uma nova atualização.",
  },
};

const EN: Strings = {
  actorFallback: "Someone",
  withOthers: (actor, others) =>
    others > 0 ?
      `${actor} and ${others} other ${others === 1 ? "person" : "people"}` :
      actor,
  titles: {
    like_post: "New like",
    like_comment: "New like",
    repost: "New repost",
    quote: "New quote",
    comment_on_post: "New comment",
    reply_to_comment: "New reply",
    new_follower: "New follower",
    mention_in_post: "You were mentioned",
    mention_in_comment: "You were mentioned",
    new_post_from_user: "New post",
    alt_text_request: "Alt Text request · Accessibility",
    login_request: "Sign-in request · Security",
    welcome: "Exe. Lula",
  },
  verbs: {
    like_post: () => "liked your post.",
    like_comment: () => "liked your comment.",
    repost: (isComment) => `reposted your ${isComment ? "comment" : "post"}.`,
    quote: (isComment) => `quoted your ${isComment ? "comment" : "post"}.`,
    comment_on_post: () => "commented on your post.",
    reply_to_comment: () => "replied to your comment.",
    new_follower: () => "started following you.",
    mention_in_post: () => "mentioned you in a post.",
    mention_in_comment: () => "mentioned you in a comment.",
    new_post_from_user: () => "posted.",
    alt_text_request: () => "requested Alt Text on an image in your post.",
    login_request: () => "requested sign-in approval.",
    welcome: () => "Welcome to Exe. Lula!",
  },
  generic: {
    title: "Exe. Lula",
    body: "You have a new update.",
  },
};

/**
 * Caminho (com idioma) que o toque no aviso abre.
 * @param {PushNotification} n Notificação.
 * @param {string} locale Idioma do aparelho.
 * @return {string} Caminho começando por /.
 */
const pathFor = (n: PushNotification, locale: PushLocale): string => {
  const base = `/${locale}`;
  const actorId = n.actors?.[0]?.userId;
  const isComment = n.entityType === "comment";
  switch (n.type) {
  case "like_post":
  case "comment_on_post":
  case "mention_in_post":
    return n.entityId ? `${base}/post/${n.entityId}` : `${base}/notifications`;
  case "quote":
    // O toque abre a CITAÇÃO (o que a pessoa escreveu), como na lista do app.
    if (n.newPostId) {
      return `${base}/post/${n.newPostId}`;
    }
    if (isComment && n.entityParentId && n.entityId) {
      return `${base}/post/${n.entityParentId}#comment-${n.entityId}`;
    }
    return n.entityId ? `${base}/post/${n.entityId}` : `${base}/notifications`;
  case "repost":
  case "like_comment":
  case "reply_to_comment":
  case "mention_in_comment":
    if (isComment && n.entityParentId && n.entityId) {
      return `${base}/post/${n.entityParentId}#comment-${n.entityId}`;
    }
    return n.entityId ? `${base}/post/${n.entityId}` : `${base}/notifications`;
  case "new_follower":
    return actorId ? `${base}/profile/${actorId}` : `${base}/notifications`;
  case "new_post_from_user": {
    const postId = n.newPostId ?? n.entityId;
    return postId ? `${base}/post/${postId}` : `${base}/notifications`;
  }
  case "alt_text_request":
    return n.entityId ?
      `${base}/post/${n.entityId}?addAlt=1` :
      `${base}/notifications`;
  case "new_message":
    if (n.entityType === "group" && n.entityId) {
      return `${base}/messages/group/${n.entityId}`;
    }
    return actorId ? `${base}/messages/user/${actorId}` : `${base}/messages`;
  case "login_request":
  case "security_alert":
    return `${base}/keys`;
  default:
    return `${base}/notifications`;
  }
};

/**
 * Título, texto e destino do aviso, no idioma pedido.
 * Mensagem direta mostra o REMETENTE no título e nunca o conteúdo da
 * mensagem (ele apareceria na tela bloqueada e passaria por serviços do
 * Google): quem quiser ler abre o app.
 * @param {PushNotification} n Notificação criada.
 * @param {string} notificationId Id do documento da notificação.
 * @param {PushLocale} locale Idioma do aparelho.
 * @return {PushContent} Conteúdo do aviso.
 */
export const buildPushContent = (
  n: PushNotification,
  notificationId: string,
  locale: PushLocale
): PushContent => {
  const s = locale === "en" ? EN : PT;
  const actor = (n.actors?.[0]?.name || "").trim() || s.actorFallback;
  const count = Math.max(1, Number(n.count) || 1);
  const isComment = n.entityType === "comment";
  const tag = `${n.type}:${n.entityId ?? notificationId}`.slice(0, 120);
  const path = pathFor(n, locale);

  if (n.type === "new_message") {
    const many = count > 1;
    const body = locale === "en" ?
      (many ? `${count} new messages` : "Sent you a message") :
      (many ? `${count} novas mensagens` : "Enviou uma mensagem para você");
    return {title: actor, body, path, tag};
  }

  const verb = s.verbs[n.type];
  if (!verb) {
    return {title: s.generic.title, body: s.generic.body, path, tag};
  }
  const subject = n.type === "welcome" ?
    "" :
    `${s.withOthers(actor, count - 1)} `;
  const quote = preview(n.previewText);
  const showQuote = quote &&
    ["comment_on_post", "reply_to_comment", "mention_in_post",
      "mention_in_comment", "quote", "new_post_from_user",
      "like_comment"].includes(n.type);
  const sentence = `${subject}${verb(isComment, count)}`.trim();
  const body = showQuote ? `${sentence} “${quote}”` : sentence;
  return {title: s.titles[n.type] ?? s.generic.title, body, path, tag};
};

/**
 * Mensagem FCM para um grupo de aparelhos do mesmo idioma.
 * `notification` serve o Android (a bandeja do sistema mostra sozinha, com o
 * app fechado) e o navegador; `data` leva o destino para o toque; `android` e
 * `webpush` ajustam prioridade, canal, agrupamento e validade.
 * @param {PushContent} content Conteúdo do aviso.
 * @param {string[]} tokens Tokens de aparelhos (todos do mesmo idioma).
 * @param {string} siteUrl Endereço do site (sem barra final).
 * @param {{type: string, notificationId: string}} meta Tipo e id.
 * @return {MulticastMessage} Mensagem pronta para sendEachForMulticast.
 */
export const buildMulticast = (
  content: PushContent,
  tokens: string[],
  siteUrl: string,
  meta: { type: string; notificationId: string }
): MulticastMessage => {
  const link = `${siteUrl}${content.path}`;
  const isUrgent = URGENT_TYPES.has(meta.type);
  const isPrivate =
    meta.type === "new_message" ||
    meta.type === "login_request" ||
    meta.type === "security_alert";
  return {
    tokens,
    notification: {title: content.title, body: content.body},
    data: {
      url: link,
      path: content.path,
      type: meta.type,
      notificationId: meta.notificationId,
      tag: content.tag,
    },
    android: {
      priority: "high",
      collapseKey: content.tag.slice(0, 64),
      notification: {
        channelId: channelForType(meta.type),
        tag: content.tag,
        sound: "default",
        defaultVibrateTimings: isUrgent,
        visibility: isPrivate ? "private" : "public",
        priority: isUrgent ? "high" : "default",
        ticker: `${content.title}: ${content.body}`,
        icon: "ic_stat_notify",
        color: "#D61F26",
      },
    },
    webpush: {
      // Mensagem, menção e segurança pedem entrega imediata; curtidas podem
      // esperar o aparelho acordar sem prejuízo.
      headers: {
        Urgency: isUrgent ? "high" : "normal",
        TTL: "86400",
      },
      notification: {
        icon: `${siteUrl}/icons/icon-192.png`,
        badge: `${siteUrl}/icons/icon-192.png`,
        tag: content.tag,
        renotify: true,
      },
      fcmOptions: {link},
    },
  };
};

/**
 * Agrupa os aparelhos por idioma e monta uma mensagem para cada grupo.
 * @param {PushNotification} n Notificação criada.
 * @param {string} notificationId Id do documento da notificação.
 * @param {PushToken[]} tokens Aparelhos de quem recebe.
 * @param {string} siteUrl Endereço do site (sem barra final).
 * @return {MulticastMessage[]} Mensagens, uma por idioma.
 */
export const buildPushMessages = (
  n: PushNotification,
  notificationId: string,
  tokens: PushToken[],
  siteUrl: string
): MulticastMessage[] => {
  const byLocale = new Map<PushLocale, string[]>();
  for (const t of tokens) {
    const list = byLocale.get(t.locale) ?? [];
    list.push(t.token);
    byLocale.set(t.locale, list);
  }
  return [...byLocale.entries()].map(([locale, list]) =>
    buildMulticast(
      buildPushContent(n, notificationId, locale),
      list,
      siteUrl,
      {type: n.type, notificationId}
    )
  );
};
