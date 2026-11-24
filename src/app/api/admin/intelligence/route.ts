// src/app/api/admin/intelligence/route.ts
// Inteligência estratégica e governança da rede HiperVerso / HiperVerso.
// Apenas administradores autenticados (users/{uid}.isAdmin === true).
// Zero exposição de dados privados (sem IPs, sem e-mails privados, sem mensagens diretas).

import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { NextRequest } from 'next/server';
import { json, readJsonObject, requireCaller } from '@/lib/server/federation';
import { adminFirestore } from '@/lib/server/firebaseAdmin';

export const dynamic = 'force-dynamic';

async function requireAdmin(request: NextRequest, key: string) {
  const caller = await requireCaller(request, key, 60);
  if (caller instanceof Response) return caller;
  const db = adminFirestore();
  const userSnap = await db.collection('users').doc(caller.uid).get();
  if (!userSnap.exists || userSnap.data()?.isAdmin !== true) {
    return json(403, { error: 'apenas-administrador' });
  }
  return { uid: caller.uid, db };
}

function toMs(val: unknown): number {
  if (!val) return 0;
  if (val instanceof Timestamp) return val.toMillis();
  if (
    typeof val === 'object' &&
    val !== null &&
    'toDate' in val &&
    typeof (val as { toDate: () => Date }).toDate === 'function'
  ) {
    return (val as { toDate: () => Date }).toDate().getTime();
  }
  if (typeof val === 'string' || typeof val === 'number') {
    const ms = new Date(val).getTime();
    return Number.isNaN(ms) ? 0 : ms;
  }
  return 0;
}

function toIso(val: unknown): string {
  const ms = toMs(val);
  return ms > 0 ? new Date(ms).toISOString() : new Date(0).toISOString();
}

export async function GET(request: NextRequest) {
  const admin = await requireAdmin(request, 'admin-intelligence-get');
  if (admin instanceof Response) return admin;
  const { db } = admin;

  const rangeParam = request.nextUrl.searchParams.get('range');
  const days = rangeParam === '90d' ? 90 : rangeParam === '30d' ? 30 : 7;

  const todayDate = new Date();
  // Ajusta para o dia civil de Brasília (UTC-3) ao calcular "hoje" e "ontem"
  const brtNow = new Date(todayDate.getTime() - 3 * 60 * 60 * 1000);
  const todayIso = brtNow.toISOString().split('T')[0];
  const brtYesterday = new Date(brtNow);
  brtYesterday.setUTCDate(brtNow.getUTCDate() - 1);
  const yesterdayIso = brtYesterday.toISOString().split('T')[0];
  const accessStart = new Date(brtNow);
  accessStart.setUTCDate(brtNow.getUTCDate() - (days - 1));
  const accessStartIso = accessStart.toISOString().split('T')[0];
  const accessStartTimestamp = Timestamp.fromDate(
    new Date(Date.now() - days * 24 * 60 * 60 * 1000),
  );

  const [
    usersSnap,
    postsSnap,
    groupsSnap,
    apAccountsSnap,
    signupControlSnap,
    systemConfigSnap,
    accessAggSnap,
    accessEventsSnap,
  ] = await Promise.all([
    db.collection('users').get(),
    db.collection('posts').where('isDeleted', '==', false).get(),
    db.collection('conversations').where('isGroup', '==', true).get().catch(() => null),
    db.collection('ap_accounts').where('enabled', '==', true).get().catch(() => null),
    db.collection('_signup').doc('control').get().catch(() => null),
    db.collection('_system').doc('config').get().catch(() => null),
    db
      .collection('access_agg_daily')
      .where('date', '>=', accessStartIso)
      .where('date', '<=', todayIso)
      .get()
      .catch(() => null),
    db
      .collection('access_events')
      .where('serverTimestamp', '>=', accessStartTimestamp)
      .limit(5000)
      .get()
      .catch(() => null),
  ]);

  let localUsersCount = 0;
  let federatedActorsCount = 0;
  let adminsCount = 0;
  let moderatorsCount = 0;
  let nativeOwnTotal = 0;
  let inSiteBluesky = 0;
  let inSiteFediverse = 0;
  let externalInteractingActors = 0;

  const domainStats = new Map<string, { domain: string; actorsCount: number; postsCount: number }>();
  const localUsersList: Array<{
    id: string;
    name: string;
    username: string;
    avatarUrl: string;
    postsCount: number;
    followersCount: number;
    followingCount: number;
    isAdmin: boolean;
    isModerator: boolean;
    createdAt: string;
    createdAtMs: number;
  }> = [];

  const usersById = new Map<
    string,
    { id: string; name: string; username: string; avatarUrl: string; isRemote: boolean }
  >();

  for (const doc of usersSnap.docs) {
    if (doc.id === 'adminUserSoberan') continue;
    const d = doc.data();
    const isRemote = doc.id.startsWith('ap_') || d.isRemoteFediverse === true;
    const fedProvider =
      d.federatedLoginProvider === 'bluesky' || d.federatedLoginProvider === 'fediverse'
        ? d.federatedLoginProvider
        : null;
    const name = typeof d.name === 'string' && d.name.trim() ? d.name.trim() : d.username || doc.id;
    const username = typeof d.username === 'string' ? d.username : doc.id;
    const avatarUrl = typeof d.avatarUrl === 'string' ? d.avatarUrl : '';

    usersById.set(doc.id, { id: doc.id, name, username, avatarUrl, isRemote });

    if (fedProvider === 'bluesky') inSiteBluesky++;
    else if (fedProvider === 'fediverse') inSiteFediverse++;
    else if (!isRemote) nativeOwnTotal++;
    else externalInteractingActors++;

    if (isRemote) {
      federatedActorsCount++;
      const domain =
        (typeof d.remoteDomain === 'string' && d.remoteDomain.trim().toLowerCase()) ||
        (username.includes('@') ? username.split('@').pop()?.toLowerCase() : '') ||
        'fediverso';
      const cur = domainStats.get(domain) || { domain, actorsCount: 0, postsCount: 0 };
      cur.actorsCount += 1;
      domainStats.set(domain, cur);
    } else {
      localUsersCount++;
      if (d.isAdmin === true) adminsCount++;
      if (d.isModerator === true) moderatorsCount++;
      localUsersList.push({
        id: doc.id,
        name,
        username,
        avatarUrl,
        postsCount: typeof d.postsCount === 'number' ? d.postsCount : 0,
        followersCount: typeof d.followersCount === 'number' ? d.followersCount : 0,
        followingCount: typeof d.followingCount === 'number' ? d.followingCount : 0,
        isAdmin: d.isAdmin === true,
        isModerator: d.isModerator === true,
        createdAt: toIso(d.createdAt),
        createdAtMs: toMs(d.createdAt),
      });
    }
  }

  // Inicializa mapa diário para a série temporal
  const now = new Date();
  const startDate = new Date(now);
  startDate.setDate(now.getDate() - (days - 1));
  startDate.setHours(0, 0, 0, 0);

  const dailyMap = new Map<
    string,
    {
      date: string;
      isoDate: string;
      newLocalUsers: number;
      newFederatedActors: number;
      newLocalPosts: number;
      newFederatedPosts: number;
      engagements: number;
    }
  >();

  for (let i = 0; i < days; i++) {
    const d = new Date(startDate);
    d.setDate(startDate.getDate() + i);
    const isoDate = d.toISOString().split('T')[0];
    const label = d.toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' });
    dailyMap.set(isoDate, {
      date: label,
      isoDate,
      newLocalUsers: 0,
      newFederatedActors: 0,
      newLocalPosts: 0,
      newFederatedPosts: 0,
      engagements: 0,
    });
  }

  for (const doc of usersSnap.docs) {
    if (doc.id === 'adminUserSoberan') continue;
    const d = doc.data();
    const ms = toMs(d.createdAt);
    if (ms >= startDate.getTime()) {
      const isoDate = new Date(ms).toISOString().split('T')[0];
      const slot = dailyMap.get(isoDate);
      if (slot) {
        const isRemote = doc.id.startsWith('ap_') || d.isRemoteFediverse === true;
        if (isRemote) slot.newFederatedActors += 1;
        else slot.newLocalUsers += 1;
      }
    }
  }

  let localPostsCount = 0;
  let federatedPostsCount = 0;
  let echoPostsCount = 0;
  let newsPostsCount = 0;
  let mediaPostsCount = 0;
  let pollPostsCount = 0;
  let totalLikes = 0;
  let totalComments = 0;
  let totalReposts = 0;
  let totalQuotes = 0;
  let totalViews = 0;

  const hashtagStats = new Map<string, { tag: string; count: number; engagements: number }>();
  const allPostsSummary: Array<{
    id: string;
    text: string;
    headline: string | null;
    userId: string;
    authorName: string;
    authorUsername: string;
    authorAvatarUrl: string;
    isRemoteFediverse: boolean;
    likes: number;
    commentsCount: number;
    reposts: number;
    quotesCount: number;
    views: number;
    totalEngagements: number;
    createdAt: string;
    createdAtMs: number;
  }> = [];

  for (const doc of postsSnap.docs) {
    const d = doc.data();
    const isRemote = d.isRemoteFediverse === true || String(d.userId || '').startsWith('ap_');
    const likes = typeof d.likes === 'number' ? d.likes : 0;
    const commentsCount = typeof d.commentsCount === 'number' ? d.commentsCount : 0;
    const reposts = typeof d.reposts === 'number' ? d.reposts : 0;
    const quotesCount = typeof d.quotesCount === 'number' ? d.quotesCount : 0;
    const views = typeof d.views === 'number' ? d.views : 0;
    const engagements = likes + commentsCount + reposts + quotesCount;

    totalLikes += likes;
    totalComments += commentsCount;
    totalReposts += reposts;
    totalQuotes += quotesCount;
    totalViews += views;

    if (isRemote) {
      federatedPostsCount++;
      const authorUser = usersById.get(String(d.userId || ''));
      const uname = authorUser?.username || d.authorDetails?.username || '';
      if (uname.includes('@')) {
        const dom = uname.split('@').pop()?.toLowerCase() || 'fediverso';
        const cur = domainStats.get(dom) || { domain: dom, actorsCount: 0, postsCount: 0 };
        cur.postsCount += 1;
        domainStats.set(dom, cur);
      }
    } else {
      localPostsCount++;
      if (d.category === 'news') newsPostsCount++;
      else echoPostsCount++;
    }

    if (d.hasMedia === true || (Array.isArray(d.media) && d.media.length > 0)) {
      mediaPostsCount++;
    }
    if (d.poll && typeof d.poll === 'object') {
      pollPostsCount++;
    }

    if (Array.isArray(d.hashtags)) {
      for (const rawTag of d.hashtags) {
        if (typeof rawTag === 'string' && rawTag.trim()) {
          const clean = rawTag.trim().toLowerCase();
          const cur = hashtagStats.get(clean) || { tag: clean, count: 0, engagements: 0 };
          cur.count += 1;
          cur.engagements += engagements;
          hashtagStats.set(clean, cur);
        }
      }
    }

    const ms = toMs(d.createdAt);
    if (ms >= startDate.getTime()) {
      const isoDate = new Date(ms).toISOString().split('T')[0];
      const slot = dailyMap.get(isoDate);
      if (slot) {
        if (isRemote) slot.newFederatedPosts += 1;
        else slot.newLocalPosts += 1;
        slot.engagements += engagements;
      }
    }

    const author = usersById.get(String(d.userId || ''));
    allPostsSummary.push({
      id: doc.id,
      text: typeof d.text === 'string' ? d.text : '',
      headline: typeof d.headline === 'string' ? d.headline : null,
      userId: String(d.userId || ''),
      authorName: author?.name || d.authorDetails?.name || 'Usuário',
      authorUsername: author?.username || d.authorDetails?.username || 'usuario',
      authorAvatarUrl: author?.avatarUrl || d.authorDetails?.avatarUrl || '',
      isRemoteFediverse: isRemote,
      likes,
      commentsCount,
      reposts,
      quotesCount,
      views,
      totalEngagements: engagements,
      createdAt: toIso(d.createdAt),
      createdAtMs: ms,
    });
  }

  let groupsCount = 0;
  let totalGroupMemberships = 0;
  const topGroups: Array<{ id: string; name: string; membersCount: number }> = [];
  if (groupsSnap) {
    for (const doc of groupsSnap.docs) {
      const gd = doc.data();
      const pids = Array.isArray(gd.participantIds) ? gd.participantIds.length : 0;
      groupsCount++;
      totalGroupMemberships += pids;
      topGroups.push({
        id: doc.id,
        name: typeof gd.groupName === 'string' && gd.groupName.trim() ? gd.groupName.trim() : 'Grupo',
        membersCount: pids,
      });
    }
    topGroups.sort((a, b) => b.membersCount - a.membersCount);
  }

  const totalPostsCount = localPostsCount + federatedPostsCount;
  const totalEngagements = totalLikes + totalComments + totalReposts + totalQuotes;

  const signupData = signupControlSnap?.exists ? signupControlSnap.data() : null;
  const signupLimit = typeof signupData?.limit === 'number' ? signupData.limit : 500;
  const signupUsed = typeof signupData?.used === 'number' ? signupData.used : localUsersCount;
  const signupIssued = typeof signupData?.issued === 'number' ? signupData.issued : signupUsed;
  const requireAppCheck = signupData?.requireAppCheck === true;

  const sysData = systemConfigSnap?.exists ? systemConfigSnap.data() : null;
  const systemConfig = {
    strictAntiBotMode: sysData?.strictAntiBotMode !== false,
    allowPublicExploreForGuests: sysData?.allowPublicExploreForGuests !== false,
    p2pDefaultEnabled: sysData?.p2pDefaultEnabled !== false,
    maxGroupParticipants:
      typeof sysData?.maxGroupParticipants === 'number' ? sysData.maxGroupParticipants : 1000,
    defaultFeedMode: sysData?.defaultFeedMode === 'local' ? 'local' : 'federated',
  };

  const topLikedPosts = [...allPostsSummary]
    .filter((p) => p.likes > 0)
    .sort((a, b) => b.likes - a.likes || b.createdAtMs - a.createdAtMs)
    .slice(0, 8);

  const topCommentedPosts = [...allPostsSummary]
    .filter((p) => p.commentsCount > 0)
    .sort((a, b) => b.commentsCount - a.commentsCount || b.createdAtMs - a.createdAtMs)
    .slice(0, 8);

  const topRepostedPosts = [...allPostsSummary]
    .filter((p) => p.reposts > 0)
    .sort((a, b) => b.reposts - a.reposts || b.createdAtMs - a.createdAtMs)
    .slice(0, 8);

  const topViewedPosts = [...allPostsSummary]
    .filter((p) => p.views > 0 || p.totalEngagements > 0)
    .sort((a, b) => b.views - a.views || b.totalEngagements - a.totalEngagements)
    .slice(0, 8);

  const mostActiveLocalUsers = [...localUsersList]
    .sort((a, b) => b.postsCount - a.postsCount || b.followersCount - a.followersCount)
    .slice(0, 8);

  const topFollowedLocalUsers = [...localUsersList]
    .sort((a, b) => b.followersCount - a.followersCount || b.postsCount - a.postsCount)
    .slice(0, 8);

  const recentLocalUsers = [...localUsersList]
    .sort((a, b) => b.createdAtMs - a.createdAtMs)
    .slice(0, 15);

  const topFediverseDomains = Array.from(domainStats.values())
    .sort((a, b) => b.actorsCount + b.postsCount - (a.actorsCount + a.postsCount))
    .slice(0, 10);

  const topHashtags = Array.from(hashtagStats.values())
    .sort((a, b) => b.count - a.count || b.engagements - a.engagements)
    .slice(0, 14);

  const federationEnabledLocalCount = apAccountsSnap ? apAccountsSnap.size : 0;
  const nativeFederatedBridge = Math.min(nativeOwnTotal, federationEnabledLocalCount);
  const nativeLocalOnly = Math.max(0, nativeOwnTotal - nativeFederatedBridge);
  const inSiteOtherProvidersTotal = inSiteBluesky + inSiteFediverse;

  // Agregação real e sem PII de acessos diários por seção e páginas mais visitadas
  let todayAuth = 0;
  let todayGuests = 0;
  let yesterdayTotal = 0;
  let periodAuth = 0;
  let periodGuests = 0;
  let uniqueSiteGuests = 0;
  let uniqueSiteAuth = 0;
  let uniqueSearchGuests = 0;
  let uniqueSearchAuth = 0;
  const sectionMap = new Map<string, { section: string; authViews: number; guestViews: number; totalViews: number }>();
  const pageMap = new Map<string, { path: string; section: string; authViews: number; guestViews: number; totalViews: number }>();

  const classifyRouteSection = (rawPath: string): { cleanPath: string; section: string } => {
    const cleanPath = (rawPath || '/').replace(/^\/(?:pt-BR|en)(?=\/|$)/, '') || '/';
    if (cleanPath === '/' || cleanPath.startsWith('/feed')) return { cleanPath, section: 'Feed Principal' };
    if (cleanPath.startsWith('/profile')) return { cleanPath, section: 'Perfis' };
    if (cleanPath.startsWith('/post')) return { cleanPath, section: 'Posts & Artigos' };
    if (cleanPath.startsWith('/explore') || cleanPath.startsWith('/search')) return { cleanPath, section: 'Explorar & Busca' };
    if (cleanPath.startsWith('/tag') || cleanPath.startsWith('/trending') || cleanPath.startsWith('/breaknews')) return { cleanPath, section: 'Tags & Tendências' };
    if (cleanPath.startsWith('/fediverse')) return { cleanPath, section: 'Fediverso' };
    if (cleanPath.startsWith('/messages')) return { cleanPath, section: 'Mensagens & Grupos' };
    if (cleanPath.startsWith('/login') || cleanPath.startsWith('/register') || cleanPath.startsWith('/auth')) return { cleanPath, section: 'Login & Cadastro' };
    return { cleanPath, section: 'Institucional & Outros' };
  };

  if (accessAggSnap) {
    for (const doc of accessAggSnap.docs) {
      const ad = doc.data();
      const dateStr = typeof ad.date === 'string' ? ad.date : '';
      const rawPath = typeof ad.path === 'string' ? ad.path : '/';
      const audience = ad.audienceType === 'auth' ? 'auth' : 'guest';

      if (rawPath === '__site_unique__' && typeof ad.uniqueCount === 'number') {
        if (audience === 'auth') uniqueSiteAuth += ad.uniqueCount;
        else uniqueSiteGuests += ad.uniqueCount;
        continue;
      }
      if (rawPath === '__search_unique__' && typeof ad.uniqueCount === 'number') {
        if (audience === 'auth') uniqueSearchAuth += ad.uniqueCount;
        else uniqueSearchGuests += ad.uniqueCount;
        continue;
      }

      const count = typeof ad.count === 'number' ? ad.count : 0;
      const { cleanPath, section } = classifyRouteSection(rawPath);

      if (audience === 'auth') periodAuth += count;
      else periodGuests += count;

      if (dateStr === todayIso) {
        if (audience === 'auth') todayAuth += count;
        else todayGuests += count;
      } else if (dateStr === yesterdayIso) {
        yesterdayTotal += count;
      }

      const secCur = sectionMap.get(section) || { section, authViews: 0, guestViews: 0, totalViews: 0 };
      if (audience === 'auth') secCur.authViews += count;
      else secCur.guestViews += count;
      secCur.totalViews += count;
      sectionMap.set(section, secCur);

      const pageCur = pageMap.get(cleanPath) || { path: cleanPath, section, authViews: 0, guestViews: 0, totalViews: 0 };
      if (audience === 'auth') pageCur.authViews += count;
      else pageCur.guestViews += count;
      pageCur.totalViews += count;
      pageMap.set(cleanPath, pageCur);
    }
  }

  // Eventos em tempo real ainda não agregados pela rotina diária (ex.: acessos de hoje)
  if (accessEventsSnap) {
    for (const doc of accessEventsSnap.docs) {
      const ev = doc.data();
      const tsMs = toMs(ev.serverTimestamp);
      if (!tsMs) continue;
      const evBrt = new Date(tsMs - 3 * 60 * 60 * 1000).toISOString().split('T')[0];
      if (evBrt < accessStartIso || evBrt > todayIso) continue;

      const audience = ev.audienceType === 'auth' ? 'auth' : 'guest';
      const { cleanPath, section } = classifyRouteSection(typeof ev.path === 'string' ? ev.path : '/');

      if (audience === 'auth') periodAuth += 1;
      else periodGuests += 1;

      if (evBrt === todayIso) {
        if (audience === 'auth') todayAuth += 1;
        else todayGuests += 1;
      } else if (evBrt === yesterdayIso) {
        yesterdayTotal += 1;
      }

      const secCur = sectionMap.get(section) || { section, authViews: 0, guestViews: 0, totalViews: 0 };
      if (audience === 'auth') secCur.authViews += 1;
      else secCur.guestViews += 1;
      secCur.totalViews += 1;
      sectionMap.set(section, secCur);

      const pageCur = pageMap.get(cleanPath) || { path: cleanPath, section, authViews: 0, guestViews: 0, totalViews: 0 };
      if (audience === 'auth') pageCur.authViews += 1;
      else pageCur.guestViews += 1;
      pageCur.totalViews += 1;
      pageMap.set(cleanPath, pageCur);
    }
  }

  const periodTotal = periodAuth + periodGuests;
  const sections = Array.from(sectionMap.values())
    .sort((a, b) => b.totalViews - a.totalViews)
    .map((s) => ({
      ...s,
      sharePct: Number(((s.totalViews / Math.max(1, periodTotal)) * 100).toFixed(1)),
    }));
  const topPages = Array.from(pageMap.values())
    .sort((a, b) => b.totalViews - a.totalViews)
    .slice(0, 12);

  return json(200, {
    kpis: {
      localUsersCount,
      federatedActorsCount,
      totalNetworkActors: localUsersCount + federatedActorsCount,
      adminsCount,
      moderatorsCount,
      federationEnabledLocalCount,
      localPostsCount,
      federatedPostsCount,
      totalPostsCount,
      echoPostsCount,
      newsPostsCount,
      mediaPostsCount,
      pollPostsCount,
      totalLikes,
      totalComments,
      totalReposts,
      totalQuotes,
      totalViews,
      totalEngagements,
      avgEngagementPerPost: Number(
        (totalEngagements / Math.max(1, totalPostsCount)).toFixed(2)
      ),
      engagementRatePct: Number(
        ((totalEngagements / Math.max(1, totalViews)) * 100).toFixed(1)
      ),
      groupsCount,
      totalGroupMemberships,
    },
    networkBreakdown: {
      nativeOwnTotal,
      nativeFederatedBridge,
      nativeLocalOnly,
      inSiteOtherProvidersTotal,
      inSiteBluesky,
      inSiteFediverse,
      externalInteractingActors,
    },
    accessRealtime: {
      todayTotal: todayAuth + todayGuests,
      todayAuth,
      uniqueSummary: {
        siteGuests: uniqueSiteGuests,
        siteAuth: uniqueSiteAuth,
        searchGuests: uniqueSearchGuests,
        searchAuth: uniqueSearchAuth,
      },
      todayGuests,
      yesterdayTotal,
      periodTotal,
      periodAuth,
      periodGuests,
      periodDailyAvg: Math.round(periodTotal / Math.max(1, days)),
      sections,
      topPages,
    },
    timeSeries: Array.from(dailyMap.values()),
    contentBreakdown: [
      { name: 'Echos Nativos', count: echoPostsCount },
      { name: 'Notícias / Artigos', count: newsPostsCount },
      { name: 'Posts Federados', count: federatedPostsCount },
      { name: 'Com Mídia', count: mediaPostsCount },
      { name: 'Enquetes', count: pollPostsCount },
    ],
    topFediverseDomains,
    topHashtags,
    topGroups: topGroups.slice(0, 6),
    rankings: {
      topLikedPosts,
      topCommentedPosts,
      topRepostedPosts,
      topViewedPosts,
      mostActiveLocalUsers,
      topFollowedLocalUsers,
      recentLocalUsers,
    },
    config: {
      signup: {
        limit: signupLimit,
        used: signupUsed,
        issued: signupIssued,
        requireAppCheck,
        open: signupUsed < signupLimit,
      },
      system: systemConfig,
    },
  });
}

export async function POST(request: NextRequest) {
  const admin = await requireAdmin(request, 'admin-intelligence-post');
  if (admin instanceof Response) return admin;
  const { db, uid } = admin;

  const body = await readJsonObject(request);
  if (!body) return json(400, { error: 'json-invalido' });

  if (body.section === 'signup') {
    const controlRef = db.collection('_signup').doc('control');
    const currentSnap = await controlRef.get();
    const current = currentSnap.exists ? currentSnap.data() || {} : {};
    const used = typeof current.used === 'number' ? current.used : 0;
    const issued = typeof current.issued === 'number' ? current.issued : used;

    const patch: Record<string, unknown> = {
      used,
      issued,
      updatedAt: FieldValue.serverTimestamp(),
      updatedBy: uid,
    };

    if (typeof body.limit === 'number' && Number.isInteger(body.limit) && body.limit >= 0 && body.limit <= 10_000_000) {
      patch.limit = body.limit;
    } else if (typeof current.limit === 'number') {
      patch.limit = current.limit;
    } else {
      patch.limit = 500;
    }

    if (typeof body.requireAppCheck === 'boolean') {
      patch.requireAppCheck = body.requireAppCheck;
    } else {
      patch.requireAppCheck = current.requireAppCheck === true;
    }

    await controlRef.set(patch, { merge: true });
    return json(200, { ok: true, signup: patch });
  }

  if (body.section === 'system') {
    const sysRef = db.collection('_system').doc('config');
    const patch: Record<string, unknown> = {
      updatedAt: FieldValue.serverTimestamp(),
      updatedBy: uid,
    };
    if (typeof body.strictAntiBotMode === 'boolean') {
      patch.strictAntiBotMode = body.strictAntiBotMode;
    }
    if (typeof body.allowPublicExploreForGuests === 'boolean') {
      patch.allowPublicExploreForGuests = body.allowPublicExploreForGuests;
    }
    if (typeof body.p2pDefaultEnabled === 'boolean') {
      patch.p2pDefaultEnabled = body.p2pDefaultEnabled;
    }
    if (
      typeof body.maxGroupParticipants === 'number' &&
      body.maxGroupParticipants >= 2 &&
      body.maxGroupParticipants <= 5000
    ) {
      patch.maxGroupParticipants = Math.floor(body.maxGroupParticipants);
    }
    if (body.defaultFeedMode === 'local' || body.defaultFeedMode === 'federated') {
      patch.defaultFeedMode = body.defaultFeedMode;
    }
    await sysRef.set(patch, { merge: true });
    return json(200, { ok: true, system: patch });
  }

  return json(400, { error: 'secao-invalida' });
}

