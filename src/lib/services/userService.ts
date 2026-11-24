
// src/lib/services/userService.ts
import { db, runTransaction, functions, auth } from '../firebase';
import { remotoPodeAparecerNaDescoberta } from '@/lib/activitypub/consentimentoDoAtor';
import type { User, Notification, Post, Comment, CustomFeed, TabPreferences } from '../types';
import {
  doc,
  setDoc,
  getDoc,
  collection,
  query,
  where,
  getDocs,
  updateDoc,
  serverTimestamp,
  Timestamp,
  writeBatch,
  deleteDoc,
  addDoc,
  increment,
  documentId,
  FieldValue, // Import FieldValue for serverTimestamp
  orderBy,
  limit,
  or,
  onSnapshot, // Import onSnapshot for real-time listeners
} from 'firebase/firestore';
import { isFromSuspendedFediverseDomain } from '@/lib/federation/suspendedDomains';
import { getCurrentUserId } from './authService';
// createNotification is now handled by Cloud Functions, so we remove the import and calls.
// import { createNotification } from './notificationService';
import { deepCopyUser } from '../utils/dataTransformers';
import { dispatchProfileUpdateEvent } from '@/contexts/CurrentUserContext';
import { fetchPaginatedPosts } from './postReadService';
import { fetchPaginatedUserComments } from './comments';
import { postsCollection } from './postService';
import { httpsCallable } from 'firebase/functions';
import { getPrivateAccount, savePrivateAccount, splitUserFields, stripPrivateFields } from './userPrivate';
import {
  rankUserRecommendations,
  rankRelatedProfiles,
  matchesNetworkScope,
  type UserRecommendationSignals,
} from '../recommendations/userRecommendations';
import {
  DEFAULT_RECOMMENDATION_PREFERENCES,
  normalizeRecommendationPreferences,
  readRecommendationPreferences,
} from '../recommendations/preferences';
import type { RecommendationPreferences, TranslationPreferences } from '@/lib/types';
import { dispatchFollowState } from '../events/followState';
import { followedIdsCached } from './followedIdsCache';

const usersCollection = collection(db, 'users');

// --- Firestore User Fetching ---
// Cache de sessão: um feed monta o autor de cada post com getUser (cartão + até 6 leituras de vínculo com quem vê), e o
// mesmo autor aparece em vários posts e páginas. O resultado fica 2 minutos por par (quem vê, perfil); seguir,
// silenciar, bloquear e editar o perfil limpam a entrada, e quem precisa do dado atual pede { fresh: true }.
const USER_CACHE_TTL_MS = 2 * 60 * 1000;
const USER_CACHE_MAX = 1000;
const userCache = new Map<string, { at: number; value: Promise<User | undefined> }>();
const userCacheKey = (userId: string, viewerId: string | null) => `${viewerId ?? '-'}>${userId}`;

/** Esquece o que foi guardado sobre esta pessoa (como perfil visto ou como quem vê); sem id, esquece tudo. */
export const invalidateUserCache = (userId?: string | null) => {
  if (!userId) {
    userCache.clear();
    return;
  }
  for (const key of userCache.keys()) {
    if (key.endsWith(`>${userId}`) || key.startsWith(`${userId}>`)) userCache.delete(key);
  }
};

export const getUser = async (
  userIdToFetch: string,
  activeUserId: string | null = getCurrentUserId(),
  options: { fresh?: boolean } = {},
): Promise<User | undefined> => {
  if (!userIdToFetch) return undefined;
  const key = userCacheKey(userIdToFetch, activeUserId);
  const hit = userCache.get(key);
  if (!options.fresh && hit && Date.now() - hit.at < USER_CACHE_TTL_MS) {
    return deepCopyUser(await hit.value);
  }
  if (userCache.size >= USER_CACHE_MAX) userCache.clear();
  const value = fetchUserUncached(userIdToFetch, activeUserId);
  userCache.set(key, { at: Date.now(), value });
  value.catch(() => userCache.delete(key));
  return deepCopyUser(await value);
};

const fetchUserUncached = async (userIdToFetch: string, activeUserId: string | null): Promise<User | undefined> => {
  const userDocRef = doc(usersCollection, userIdToFetch);
  try {
    const userSnap = await getDoc(userDocRef);
    if (!userSnap.exists()) return undefined;

    const firestoreData = userSnap.data();
    // Convert timestamps to ISO strings for client-side consistency
    if (firestoreData.createdAt && firestoreData.createdAt instanceof Timestamp) {
      firestoreData.createdAt = firestoreData.createdAt.toDate().toISOString();
    }
    if (firestoreData.updatedAt && firestoreData.updatedAt instanceof Timestamp) {
      firestoreData.updatedAt = firestoreData.updatedAt.toDate().toISOString();
    }

    const isOwner = !!activeUserId && activeUserId === userIdToFetch;
    let userData = { id: userSnap.id, ...firestoreData } as User;
    if (isOwner) {
      // O dono recebe os próprios dados pessoais (users/{uid}/private/account) somados ao cartão público.
      userData = { ...userData, ...(await getPrivateAccount(userIdToFetch)) } as User;
      userData.notificationSubscriptionStatus = 'none'; // Can't subscribe to yourself
    } else {
      // Outras pessoas nunca recebem dados pessoais, nem os que ainda estejam no documento público antigo.
      userData = stripPrivateFields(userData);
    }

    if (activeUserId && !isOwner) {
      const followingRef = doc(db, 'users', activeUserId, 'following', userIdToFetch);
      // Usuários remotos do Fediverso gravam em users/{activeUserId}/followers/{ap_...},
      // não em users/{ap_...}/following/{activeUserId}; checamos ambos para cobrir locais e remotos.
      const followedByFollowingRef = doc(db, 'users', userIdToFetch, 'following', activeUserId);
      const followedByFollowerRef = doc(db, 'users', activeUserId, 'followers', userIdToFetch);
      const mutedRef = doc(db, 'users', activeUserId, 'mutedUsers', userIdToFetch);
      const blockedRef = doc(db, 'users', activeUserId, 'blockedUsers', userIdToFetch);
      const notificationSubscriptionRef = doc(db, 'users', userIdToFetch, 'subscribers', activeUserId);
      const hasBlockedCurrentUserRef = doc(db, 'users', userIdToFetch, 'blockedUsers', activeUserId);

      const [followingSnap, followedByFollowingSnap, followedByFollowerSnap, mutedSnap, blockedSnap, notificationSubSnap, hasBlockedCurrentUserSnap] = await Promise.all([
        getDoc(followingRef),
        getDoc(followedByFollowingRef),
        getDoc(followedByFollowerRef),
        getDoc(mutedRef),
        getDoc(blockedRef),
        getDoc(notificationSubscriptionRef),
        getDoc(hasBlockedCurrentUserRef),
      ]);

      userData.isFollowing = followingSnap.exists();
      userData.isFollowedBy = followedByFollowerSnap.exists() || followedByFollowingSnap.exists();
      userData.isMuted = mutedSnap.exists();
      userData.isBlocked = blockedSnap.exists();
      userData.hasBlockedCurrentUser = hasBlockedCurrentUserSnap.exists();
      if (notificationSubSnap.exists()) {
        userData.notificationSubscriptionStatus = notificationSubSnap.data().preference || 'all';
      } else {
        userData.notificationSubscriptionStatus = 'none';
      }
    }

    // --- PRIVACY LAYER ---
    // Perfil privado: quem não é dono nem seguidor recebe só o cartão (nome, @, foto, bio e números),
    // mais os vínculos com quem está vendo, para poder seguir, silenciar ou bloquear.
    if (userData.profileVisibility === 'private' && !isOwner && !userData.isFollowing) {
      const publicProfileData: Partial<User> = {
        id: userData.id,
        name: userData.name,
        username: userData.username,
        avatarUrl: userData.avatarUrl,
        avatarAlt: userData.avatarAlt,
        'data-ai-hint': userData['data-ai-hint'],
        bio: userData.bio,
        followersCount: userData.followersCount,
        followingCount: userData.followingCount,
        postsCount: userData.postsCount,
        coverImageUrl: userData.coverImageUrl,
        coverImageAlt: userData.coverImageAlt,
        'cover-image-ai-hint': userData['cover-image-ai-hint'],
        profileVisibility: 'private',
        createdAt: userData.createdAt,
        isFollowing: userData.isFollowing,
        isFollowedBy: userData.isFollowedBy,
        isMuted: userData.isMuted,
        isBlocked: userData.isBlocked,
        hasBlockedCurrentUser: userData.hasBlockedCurrentUser,
        notificationSubscriptionStatus: 'none',
      };
      return deepCopyUser(publicProfileData as User);
    }

    return deepCopyUser(userData);
  } catch (error: any) {
    if (error.code === 'permission-denied') {
        // This is now an expected case for private profiles, so we just return undefined.
        console.warn(`[getUser] Permission denied for user ${userIdToFetch}. The profile may be private or inaccessible. Returning undefined.`);
        return undefined;
    }
    console.error(`Error fetching user ${userIdToFetch} from Firestore:`, String(error));
    throw error;
  }
};

export const updateNotificationSubscription = async (
  subscriberId: string,
  subscribedToId: string,
  preference: 'all' | 'news_only' | 'none'
): Promise<boolean> => {
  if (!subscriberId || !subscribedToId) return false;

  const subscriptionDocRef = doc(db, 'users', subscribedToId, 'subscribers', subscriberId);

  try {
    if (preference === 'none') {
      await deleteDoc(subscriptionDocRef);
    } else {
      await setDoc(subscriptionDocRef, { preference, createdAt: serverTimestamp() });
    }
    invalidateUserCache(subscribedToId);
    return true;
  } catch (error: any) {
    console.error(`Error updating notification subscription for ${subscribedToId} by ${subscriberId}:`, String(error));
    return false;
  }
};

export const getAllUsers = async (): Promise<User[]> => {
  try {
    const querySnapshot = await getDocs(usersCollection);
    const users = querySnapshot.docs.map(docSnap => {
      const data = docSnap.data();
      if (data.createdAt && data.createdAt instanceof Timestamp) {
        data.createdAt = data.createdAt.toDate().toISOString();
      }
      if (data.updatedAt && data.updatedAt instanceof Timestamp) {
        data.updatedAt = data.updatedAt.toDate().toISOString();
      }
      return { id: docSnap.id, ...data } as User;
    });
    return users.map(u => deepCopyUser(u!)).filter(Boolean) as User[];
  } catch (error: any) {
    console.error("Error fetching all users from Firestore:", String(error));
    return [];
  }
};


// --- User Profile Updates ---
export interface UserProfileUpdatePayload {
  name?: string;
  name_lowercase?: string;
  bio?: string | null;
  pronouns?: string | null;
  location?: string | null;
  website?: string | null;
  links?: Array<{ label?: string; url: string }> | null;
  pixKey?: string | null;
  pixCity?: string | null;
  pixDescription?: string | null;
  accentColor?: string | null;
  dateOfBirth?: string | null; // Added dateOfBirth
  avatarUrl?: string | null;
  avatarAlt?: string | null;
  "data-ai-hint"?: string | null;
  coverImageUrl?: string | null;
  coverImageAlt?: string | null;
  "cover-image-ai-hint"?: string | null;
  oldAvatarPath?: string | null;
  oldCoverPath?: string | null;
  notificationPreferences?: User['notificationPreferences'];
  dmPreference?: User['dmPreference'];
  profileVisibility?: User['profileVisibility'];
  allowTagging?: User['allowTagging'];
  displaySensitiveContent?: User['displaySensitiveContent']; // Added for media settings
  mutedWords?: string[];
  recommendationPreferences?: RecommendationPreferences;
  translationPreferences?: TranslationPreferences;
  pinnedPostId?: string | null;
  isAdmin?: boolean;
  isModerator?: boolean;
  tabPreferences?: TabPreferences;
}

export const updateUserSettings = async (userId: string, data: UserProfileUpdatePayload): Promise<User> => {
  const userRef = doc(usersCollection, userId);

  try {
    const updateData: { [key: string]: any } = { updatedAt: serverTimestamp() };

    // Prepare other fields for update.
    if (data.name !== undefined) {
      updateData.name = data.name;
      // CRITICAL: Always update name_lowercase when name is updated.
      updateData.name_lowercase = data.name.toLowerCase();
    }
    
    const nullableFields: (keyof UserProfileUpdatePayload)[] = [
      'bio', 'pronouns', 'location', 'website', 'links', 'pixKey', 'pixCity', 'pixDescription',
      'accentColor', 'dateOfBirth', 'avatarUrl', 'avatarAlt', 'data-ai-hint',
      'coverImageUrl', 'coverImageAlt', 'cover-image-ai-hint', 'pinnedPostId'
    ];
    
    nullableFields.forEach(field => {
      if (data[field] !== undefined) {
        updateData[field] = data[field];
      }
    });

    if (data.notificationPreferences) updateData.notificationPreferences = data.notificationPreferences;
    if (data.dmPreference) updateData.dmPreference = data.dmPreference;
    if (data.profileVisibility) updateData.profileVisibility = data.profileVisibility;
    if (data.allowTagging) updateData.allowTagging = data.allowTagging;
    if (data.displaySensitiveContent !== undefined) updateData.displaySensitiveContent = data.displaySensitiveContent;
    if (data.mutedWords !== undefined) updateData.mutedWords = data.mutedWords;
    if (data.recommendationPreferences !== undefined) {
      updateData.recommendationPreferences = normalizeRecommendationPreferences(data.recommendationPreferences);
      recommendationCache.delete(userId);
    }
    if (data.translationPreferences !== undefined) {
      updateData.translationPreferences = data.translationPreferences;
    }
    if (data.isAdmin !== undefined) updateData.isAdmin = data.isAdmin;
    if (data.isModerator !== undefined) updateData.isModerator = data.isModerator;
    if (data.tabPreferences) updateData.tabPreferences = data.tabPreferences;


    // Campos pessoais (data de nascimento, preferências de notificação, palavras silenciadas...) vão para
    // users/{uid}/private/account; o resto fica no cartão público.
    // Mudança só pessoal não regrava o cartão público (evita disparar onUserUpdated e o snapshot do perfil à toa).
    const { publicData, privateData } = splitUserFields(updateData);
    const hasPublicChanges = Object.keys(publicData).some(key => key !== 'updatedAt');
    await Promise.all([
      hasPublicChanges ? updateDoc(userRef, publicData) : Promise.resolve(),
      savePrivateAccount(userId, privateData),
    ]);

    invalidateUserCache(userId);
    const updatedUser = await getUser(userId, userId, { fresh: true });
    if (!updatedUser) {
        throw new Error("Failed to retrieve updated user profile after update.");
    }
    
    // If the updated user is the current user, dispatch an event for instant UI updates
    if (userId === getCurrentUserId()) {
        dispatchProfileUpdateEvent(updatedUser);
    }

    return updatedUser;

  } catch (error: any) {
    console.error("Error updating user settings in Firestore:", String(error));
    throw new Error("Failed to update user settings.");
  }
};

const updateUserUsernameCallable = httpsCallable(functions, 'updateUserUsername');
const updateUserBirthDateCallable = httpsCallable<{ dateOfBirth: string }, { status: 'ok' }>(
  functions,
  'updateUserBirthDate',
);

export const updateUserUsername = async (userId: string, newUsername: string): Promise<User> => {
  if (!userId || !newUsername) {
    throw new Error("User ID and new username are required.");
  }
  try {
    await updateUserUsernameCallable({ newUsername });
    invalidateUserCache(userId);
    const updatedUser = await getUser(userId, userId, { fresh: true }); // Refetch user to get updated data
    if (!updatedUser) throw new Error("Failed to refetch user after username update.");
    
    // Dispatch event for UI updates
    dispatchProfileUpdateEvent(updatedUser);

    return updatedUser;
  } catch (error: any) {
    console.error("Error updating username:", error);
    // Transform Firebase function error to a more user-friendly message
    if (error.code === 'functions/already-exists') {
        throw new Error("This username is already taken.");
    }
    throw new Error(error.details?.message || error.message || "Failed to update username.");
  }
};


export const completeUserProfile = async (userId: string, data: { username: string; dateOfBirth: string }): Promise<User | null> => {
    const { username, dateOfBirth } = data;
    if (!userId || !username || !dateOfBirth) {
        throw new Error("Missing required data to complete profile.");
    }

    try {
        // O @ provisório do primeiro login com Google é trocado pela Function updateUserUsername, que garante que o nome
        // é único (gravado direto pelo cliente, duas pessoas podiam ficar com o mesmo @). A data de nascimento é pessoal.
        try {
            await updateUserUsernameCallable({ newUsername: username });
        } catch (error: any) {
            if (error.code === 'functions/already-exists') throw new Error("Username is already taken.");
            throw error;
        }
        await updateUserBirthDateCallable({ dateOfBirth });
        invalidateUserCache(userId);
        return await getUser(userId, userId, { fresh: true }) ?? null;

    } catch (error: any) {
        console.error("Error completing user profile:", error);
        throw error; // Re-throw to be caught by the calling component
    }
};



// --- User Relationships (Follow, Mute, Block) ---
export const snapshotToPublicUser = (
  docSnap: { id: string; data: () => Record<string, any> | undefined },
  options?: { isFollowing?: boolean }
): User | undefined => {
  const raw = docSnap.data();
  if (!raw) return undefined;
  const firestoreData = { ...raw };
  if (firestoreData.createdAt && firestoreData.createdAt instanceof Timestamp) {
    firestoreData.createdAt = firestoreData.createdAt.toDate().toISOString();
  }
  if (firestoreData.updatedAt && firestoreData.updatedAt instanceof Timestamp) {
    firestoreData.updatedAt = firestoreData.updatedAt.toDate().toISOString();
  }
  const userData = stripPrivateFields({ id: docSnap.id, ...firestoreData }) as User;
  if (options?.isFollowing !== undefined) {
    userData.isFollowing = options.isFollowing;
  }
  if (
    userData.id.startsWith('ap_') ||
    (userData as User & { isRemoteFediverse?: boolean }).isRemoteFediverse ||
    userData.username?.includes('@')
  ) {
    if (isFromSuspendedFediverseDomain(userData as Record<string, unknown>)) {
      return undefined;
    }
    userData.dmPreference =
      userData.dmPreference && userData.dmPreference !== 'none'
        ? userData.dmPreference
        : 'everyone';
  }
  return deepCopyUser(userData);
};

export const fetchPublicUsersByIds = async (
  userIds: string[],
  activeUserId: string | null = getCurrentUserId()
): Promise<User[]> => {
  const uniqueIds = Array.from(new Set(userIds.filter(Boolean)));
  if (uniqueIds.length === 0) return [];

  const [followedIds, followerIds, blockedIds] = activeUserId
    ? await Promise.all([
        getFollowedUserIds(activeUserId).catch(() => [] as string[]),
        getDocs(collection(db, 'users', activeUserId, 'followers'))
          .then((s) => s.docs.map((d) => d.id))
          .catch(() => [] as string[]),
        getDocs(collection(db, 'users', activeUserId, 'blockedUsers'))
          .then((s) => s.docs.map((d) => d.id))
          .catch(() => [] as string[]),
      ])
    : [[] as string[], [] as string[], [] as string[]];

  const followedSet = new Set(followedIds);
  const followerSet = new Set(followerIds);
  const blockedSet = new Set(blockedIds);

  const chunks: string[][] = [];
  for (let i = 0; i < uniqueIds.length; i += 30) {
    chunks.push(uniqueIds.slice(i, i + 30));
  }

  const snapshots = await Promise.all(
    chunks.map((chunk) =>
      getDocs(query(usersCollection, where(documentId(), 'in', chunk))).catch(() => null)
    )
  );

  const byId = new Map<string, User>();
  for (const snap of snapshots) {
    if (!snap) continue;
    for (const docSnap of snap.docs) {
      const user = snapshotToPublicUser(docSnap, {
        isFollowing: followedSet.has(docSnap.id),
      });
      if (user) {
        user.isFollowedBy = followerSet.has(docSnap.id);
        user.isBlocked = blockedSet.has(docSnap.id);
        byId.set(docSnap.id, user);
      }
    }
  }

  return uniqueIds.map((id) => byId.get(id)).filter((u): u is User => Boolean(u));
};

// Lida uma vez e reaproveitada por 60 s (followedIdsCache): quem segue 1.299 contas lia a coleção inteira a cada página do feed.
export const getFollowedUserIds = async (userId: string): Promise<string[]> => {
  const followingColRef = collection(db, 'users', userId, 'following');
  try {
    return await followedIdsCached(userId, async () => (await getDocs(followingColRef)).docs.map(doc => doc.id));
  } catch (error: any) {
    console.error(`Error fetching followed user IDs for ${userId}:`, String(error));
    return [];
  }
};

export async function getFollowersOfUser(
  targetUserId: string,
  activeUserId: string | null,
  maxCount?: number
): Promise<User[]> {
  const followersColRef = collection(db, 'users', targetUserId, 'followers');
  try {
    const q = maxCount ? query(followersColRef, limit(maxCount)) : followersColRef;
    const snapshot = await getDocs(q);
    if (snapshot.empty) return [];

    const followerIds = snapshot.docs.map(doc => doc.id);
    if (followerIds.length === 0) return [];

    return await fetchPublicUsersByIds(followerIds, activeUserId);
  } catch (error: any) {
    console.error(`Error fetching followers for ${targetUserId}:`, String(error));
    return [];
  }
}

export async function getUsersFollowedBy(
  targetUserId: string,
  activeUserId: string | null,
  maxCount?: number
): Promise<User[]> {
  const followingColRef = collection(db, 'users', targetUserId, 'following');
  try {
    const followedIds =
      !maxCount && targetUserId === activeUserId
        ? await getFollowedUserIds(targetUserId)
        : (await getDocs(maxCount ? query(followingColRef, limit(maxCount)) : followingColRef)).docs.map(
            (doc) => doc.id
          );
    if (followedIds.length === 0) return [];

    const targetIds = maxCount ? followedIds.slice(0, maxCount) : followedIds;
    return await fetchPublicUsersByIds(targetIds, activeUserId);
  } catch (error: any) {
    console.error(`Error fetching users followed by ${targetUserId}:`, String(error));
    return [];
  }
}

export const toggleFollowUser = async (activeUserId: string, targetUserId: string): Promise<User | undefined> => {
  if (activeUserId === targetUserId) return undefined;
  const followingDocRef = doc(collection(db, 'users', activeUserId, 'following'), targetUserId);
  const followerDocRef = doc(collection(db, 'users', targetUserId, 'followers'), activeUserId);

  const batch = writeBatch(db);
  try {
    const [followingSnap, before] = await Promise.all([getDoc(followingDocRef), getUser(targetUserId, activeUserId, { fresh: true })]);
    const wasFollowing = followingSnap.exists();
    if (wasFollowing) {
      batch.delete(followingDocRef);
      batch.delete(followerDocRef);
    } else {
      batch.set(followingDocRef, { userId: targetUserId, createdAt: serverTimestamp() });
      batch.set(followerDocRef, { userId: activeUserId, createdAt: serverTimestamp() });
    }
    await batch.commit();
    invalidateUserCache(targetUserId);
    invalidateUserCache(activeUserId);
    invalidateRecommendationCache(activeUserId);
    dispatchFollowState({ activeUserId, targetUserId, isFollowing: !wasFollowing });
    if (!before) return undefined;
    // followersCount/followingCount são gravados pelas Functions (onUserFollowed/onUserUnfollowed) logo depois: a tela
    // recebe o estado esperado já ajustado, a partir do valor lido ANTES (sem somar duas vezes se o servidor já gravou).
    return {
      ...before,
      isFollowing: !wasFollowing,
      followersCount: Math.max(0, (before.followersCount || 0) + (wasFollowing ? -1 : 1)),
    };
  } catch (error: any) {
    console.error("Error toggling follow state:", String(error));
    return undefined;
  }
};

/**
 * Segue ou deixa de seguir, indo ao ESTADO PEDIDO (e não alternando): é o que permite à tela mudar no toque e gravar em segundo
 * plano, e repetir a gravação sem efeito colateral. As regras só deixam CRIAR (não alterar) cada documento, então só se grava o
 * que falta; os contadores dos dois perfis são das Functions (onUserFollowed/onUserUnfollowed). Lança erro se falhar.
 */
export const setFollowUser = async (activeUserId: string, targetUserId: string, follow: boolean): Promise<void> => {
  if (!activeUserId || !targetUserId || activeUserId === targetUserId) return;

  if (targetUserId.startsWith('ap_')) {
    const token = await auth.currentUser?.getIdToken().catch(() => null);
    if (!token) throw new Error('Faça login para seguir perfis do Fediverso.');
    const res = await fetch('/api/ap/follow', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        targetUserId,
        action: follow ? 'follow' : 'unfollow',
      }),
    });
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(data.error || 'Não foi possível atualizar follow no Fediverso.');
    }
    invalidateUserCache(targetUserId);
    invalidateUserCache(activeUserId);
    invalidateRecommendationCache(activeUserId);
    dispatchFollowState({ activeUserId, targetUserId, isFollowing: follow });
    return;
  }

  const followingDocRef = doc(collection(db, 'users', activeUserId, 'following'), targetUserId);
  const followerDocRef = doc(collection(db, 'users', targetUserId, 'followers'), activeUserId);
  const [followingSnap, followerSnap] = await Promise.all([getDoc(followingDocRef), getDoc(followerDocRef)]);

  const batch = writeBatch(db);
  let operations = 0;
  if (follow) {
    if (!followingSnap.exists()) { batch.set(followingDocRef, { userId: targetUserId, createdAt: serverTimestamp() }); operations++; }
    if (!followerSnap.exists()) { batch.set(followerDocRef, { userId: activeUserId, createdAt: serverTimestamp() }); operations++; }
  } else {
    if (followingSnap.exists()) { batch.delete(followingDocRef); operations++; }
    if (followerSnap.exists()) { batch.delete(followerDocRef); operations++; }
  }
  if (operations > 0) await batch.commit();
  invalidateUserCache(targetUserId);
  invalidateUserCache(activeUserId);
  invalidateRecommendationCache(activeUserId);
  dispatchFollowState({ activeUserId, targetUserId, isFollowing: follow });
};

/** Depois que o seguir de um perfil do Fediverso mudou (seguir, pedir, cancelar, deixar de seguir): os caches de quem vê deixam de valer. */
export const invalidateAfterFollowChange = (activeUserId: string, targetUserId: string): void => {
  invalidateUserCache(targetUserId);
  invalidateUserCache(activeUserId);
  invalidateRecommendationCache(activeUserId);
};

export const checkMutualFollow = async (userId1: string, userId2: string): Promise<boolean> => {
    if (userId1 === userId2) return false;
    const user1FollowsUser2Ref = doc(db, 'users', userId1, 'following', userId2);
    const user2FollowsUser1Ref = doc(db, 'users', userId2, 'following', userId1);
    try {
      const [user1FollowsUser2Snap, user2FollowsUser1Snap] = await Promise.all([
        getDoc(user1FollowsUser2Ref),
        getDoc(user2FollowsUser1Ref)
      ]);
      return user1FollowsUser2Snap.exists() && user2FollowsUser1Snap.exists();
    } catch (error: any) {
      console.error("Error checking mutual follow:", String(error));
      return false;
    }
  };

export const toggleMuteUser = async (activeUserId: string, targetUserId: string): Promise<User | undefined> => {
  const mutedUserDocRef = doc(db, 'users', activeUserId, 'mutedUsers', targetUserId);
  try {
    const docSnap = await getDoc(mutedUserDocRef);
    if (docSnap.exists()) {
      await deleteDoc(mutedUserDocRef);
    } else {
      await setDoc(mutedUserDocRef, { userId: targetUserId, createdAt: serverTimestamp() });
    }
    invalidateUserCache(targetUserId);
    invalidateRecommendationCache(activeUserId);
    return getUser(targetUserId, activeUserId, { fresh: true });
  } catch (error: any) {
    console.error("Error toggling mute state:", String(error));
    return undefined;
  }
};

export const toggleBlockUser = async (activeUserId: string, targetUserId: string): Promise<User | undefined> => {
  const blockedUserDocRef = doc(db, 'users', activeUserId, 'blockedUsers', targetUserId);
  const batch = writeBatch(db);
  try {
    const docSnap = await getDoc(blockedUserDocRef);
    if (docSnap.exists()) {
      batch.delete(blockedUserDocRef);
    } else {
      batch.set(blockedUserDocRef, { userId: targetUserId, createdAt: serverTimestamp() });
      const activeUserFollowingTargetRef = doc(db, 'users', activeUserId, 'following', targetUserId);
      const targetUserFollowerOfActiveRef = doc(db, 'users', targetUserId, 'followers', activeUserId);
      const targetUserFollowingActiveRef = doc(db, 'users', targetUserId, 'following', activeUserId);
      const activeUserFollowerByTargetRef = doc(db, 'users', activeUserId, 'followers', targetUserId);

      const [activeFollowingSnap, targetFollowingSnap] = await Promise.all([
          getDoc(activeUserFollowingTargetRef),
          getDoc(targetUserFollowingActiveRef)
      ]);

      // Bloquear desfaz o "seguir" nos dois sentidos; os contadores são devolvidos pela Function onUserUnfollowed.
      if(activeFollowingSnap.exists()){
          batch.delete(activeUserFollowingTargetRef);
          batch.delete(targetUserFollowerOfActiveRef);
      }
       if(targetFollowingSnap.exists()){
          batch.delete(targetUserFollowingActiveRef);
          batch.delete(activeUserFollowerByTargetRef);
      }
    }
    await batch.commit();
    invalidateUserCache(targetUserId);
    invalidateUserCache(activeUserId);
    invalidateRecommendationCache(activeUserId);
    return getUser(targetUserId, activeUserId, { fresh: true });
  } catch (error: any) {
    console.error("Error toggling block state:", String(error));
    return undefined;
  }
};

export const getBlockedUsers = async (blockerId: string): Promise<User[]> => {
  const blockedUsersColRef = collection(db, 'users', blockerId, 'blockedUsers');
  try {
    const snapshot = await getDocs(blockedUsersColRef);
    if (snapshot.empty) return [];
    const blockedIds = snapshot.docs.map(doc => doc.id);

    const userPromises: Promise<User | undefined>[] = [];
     for (let i = 0; i < blockedIds.length; i += 30) {
        const chunk = blockedIds.slice(i, i + 30);
        if (chunk.length > 0) {
            chunk.forEach(id => userPromises.push(getUser(id, blockerId)));
        }
    }
    const users = (await Promise.all(userPromises)).filter(u => u !== undefined) as User[];
    return users;
  } catch (error: any) {
    console.error(`Error fetching blocked users for ${blockerId}:`, String(error));
    return [];
  }
};

export const getMutedUsers = async (muterId: string): Promise<User[]> => {
  const mutedUsersColRef = collection(db, 'users', muterId, 'mutedUsers');
  try {
    const snapshot = await getDocs(mutedUsersColRef);
    if (snapshot.empty) return [];
    const mutedIds = snapshot.docs.map(doc => doc.id);

    const userPromises: Promise<User | undefined>[] = [];
     for (let i = 0; i < mutedIds.length; i += 30) {
        const chunk = mutedIds.slice(i, i + 30);
        if (chunk.length > 0) {
            chunk.forEach(id => userPromises.push(getUser(id, muterId)));
        }
    }
    const users = (await Promise.all(userPromises)).filter(u => u !== undefined) as User[];
    return users;
  } catch (error: any) {
    console.error(`Error fetching muted users for ${muterId}:`, String(error));
    return [];
  }
};

// --- Search & Data Export ---
const recentConvPartnersCache = new Map<string, { at: number; value: Promise<User[]> }>();

export const getRecentConversationPartners = async (activeUserId: string): Promise<User[]> => {
    if (!activeUserId) return [];
    const hit = recentConvPartnersCache.get(activeUserId);
    if (hit && Date.now() - hit.at < 45_000) {
        return hit.value;
    }
    const promise = (async () => {
        try {
            const convSnap = await getDocs(
                query(
                    collection(db, 'conversations'),
                    where('participantIds', 'array-contains', activeUserId),
                    limit(35)
                )
            );
            const partnerIds = new Set<string>();
            const embeddedFallback = new Map<string, User>();
            for (const d of convSnap.docs) {
                const data = d.data();
                const pids: string[] = Array.isArray(data.participantIds) ? data.participantIds : [];
                const pInfo: any[] = Array.isArray(data.participantsInfo) ? data.participantsInfo : [];
                // Prioritize 1-on-1 or small conversations for direct contacts
                if (pids.length <= 12) {
                    for (const pid of pids) {
                        if (pid && pid !== activeUserId) {
                            partnerIds.add(pid);
                        }
                    }
                    for (const info of pInfo) {
                        if (info && typeof info.id === 'string' && info.id !== activeUserId) {
                            embeddedFallback.set(info.id, {
                                id: info.id,
                                name: info.name || info.username || 'Contato',
                                username: info.username || info.id.replace(/^ap_/, ''),
                                email: '',
                                avatarUrl: info.avatarUrl || '',
                                followersCount: 0,
                                followingCount: 0,
                                postsCount: 0,
                                isAdmin: false,
                                isModerator: false,
                                dmPreference: 'everyone',
                                profileVisibility: 'public',
                                createdAt: new Date().toISOString(),
                            });
                        }
                    }
                }
            }
            const loaded = await fetchPublicUsersByIds(Array.from(partnerIds).slice(0, 60), activeUserId);
            const loadedMap = new Map(loaded.map((u) => [u.id, u]));
            for (const [id, fallback] of embeddedFallback.entries()) {
                if (!loadedMap.has(id)) {
                    loadedMap.set(id, fallback);
                }
            }
            return Array.from(loadedMap.values());
        } catch {
            return [];
        }
    })();
    recentConvPartnersCache.set(activeUserId, { at: Date.now(), value: promise });
    return promise;
};

export const searchUsers = async (searchQuery: string, activeUserId: string | null = getCurrentUserId()): Promise<User[]> => {
    const trimmedQuery = searchQuery.trim();
    if (!trimmedQuery) {
        try {
            const usersMap = new Map<string, User>();
            if (activeUserId) {
                const [recentPartners, followed] = await Promise.all([
                    getRecentConversationPartners(activeUserId).catch(() => []),
                    getUsersFollowedBy(activeUserId, activeUserId, 45).catch(() => []),
                ]);
                for (const u of [...recentPartners, ...followed]) {
                    if (u && !u.isBlocked && !u.hasBlockedCurrentUser && !usersMap.has(u.id)) {
                        usersMap.set(u.id, u);
                    }
                }
            }
            const initialSnap = await getDocs(query(usersCollection, limit(24)));
            for (const docSnap of initialSnap.docs) {
                if (!usersMap.has(docSnap.id)) {
                    const user = snapshotToPublicUser(docSnap);
                    if (user && !user.isBlocked && !user.hasBlockedCurrentUser) {
                        usersMap.set(docSnap.id, user);
                    }
                }
            }
            return Array.from(usersMap.values()).slice(0, 60);
        } catch (error) {
            console.error("Error listing initial mention users:", String(error));
            return [];
        }
    }

    const lowerQuery = trimmedQuery.toLowerCase();
    const isHashtagSearch = lowerQuery.startsWith('#');
    const cleanHandle = trimmedQuery.replace(/^@+/, '').trim();
    const lowerHandle = cleanHandle.toLowerCase();
    const capitalizedHandle = cleanHandle
        ? cleanHandle.charAt(0).toUpperCase() + cleanHandle.slice(1).toLowerCase()
        : '';
    const isFediverseHandle = /^[^@\s]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(lowerHandle);

    const nameQuery = query(
        usersCollection,
        where('name_lowercase', '>=', lowerHandle),
        where('name_lowercase', '<=', lowerHandle + '\uf8ff'),
        limit(15)
    );

    const nameCapQuery =
        capitalizedHandle
            ? query(
                  usersCollection,
                  where('name', '>=', capitalizedHandle),
                  where('name', '<=', capitalizedHandle + '\uf8ff'),
                  limit(15)
              )
            : null;

    const usernameLowerQuery = query(
        usersCollection,
        where('username', '>=', lowerHandle),
        where('username', '<=', lowerHandle + '\uf8ff'),
        limit(15)
    );

    const usernameExactCaseQuery =
        cleanHandle && cleanHandle !== lowerHandle
            ? query(
                  usersCollection,
                  where('username', '>=', cleanHandle),
                  where('username', '<=', cleanHandle + '\uf8ff'),
                  limit(10)
              )
            : null;

    const usernameCapQuery =
        capitalizedHandle && capitalizedHandle !== lowerHandle && capitalizedHandle !== cleanHandle
            ? query(
                  usersCollection,
                  where('username', '>=', capitalizedHandle),
                  where('username', '<=', capitalizedHandle + '\uf8ff'),
                  limit(10)
              )
            : null;

    const bioHashtagQuery = isHashtagSearch
        ? query(
              usersCollection,
              where('bio', '>=', lowerQuery),
              where('bio', '<=', lowerQuery + '\uf8ff'),
              limit(8)
          )
        : null;

    const remoteFediversePromise: Promise<User | null> =
        isFediverseHandle && typeof window !== 'undefined'
            ? (async () => {
                  try {
                      const token = await auth.currentUser?.getIdToken().catch(() => null);
                      const res = await fetch(
                          `/api/ap/remote-profile?handle=${encodeURIComponent(lowerHandle)}&withPosts=0`,
                          {
                              headers: token ? { Authorization: `Bearer ${token}` } : undefined,
                          }
                      );
                      if (!res.ok) return null;
                      const data = await res.json();
                      if (!data?.nativeUser?.id) return null;
                      return {
                          ...data.nativeUser,
                          dmPreference: data.nativeUser.dmPreference && data.nativeUser.dmPreference !== 'none'
                              ? data.nativeUser.dmPreference
                              : 'everyone',
                      } as User;
                  } catch {
                      return null;
                  }
              })()
            : Promise.resolve(null);

    const exactUsernameDocPromise: Promise<string | null> =
        lowerHandle && !lowerHandle.includes('/')
            ? getDoc(doc(db, 'usernames', lowerHandle))
                  .then((snap) => (snap.exists() ? (snap.data()?.userId as string) || null : null))
                  .catch(() => null)
            : Promise.resolve(null);

    try {
        const queryPromises = [getDocs(nameQuery), getDocs(usernameLowerQuery)];
        if (nameCapQuery) queryPromises.push(getDocs(nameCapQuery));
        if (usernameExactCaseQuery) queryPromises.push(getDocs(usernameExactCaseQuery));
        if (usernameCapQuery) queryPromises.push(getDocs(usernameCapQuery));
        if (bioHashtagQuery) queryPromises.push(getDocs(bioHashtagQuery));

        const [snapshots, remoteUser, exactUserId, viewerFollowedIds, recentPartners, followedSample] = await Promise.all([
            Promise.all(queryPromises),
            remoteFediversePromise,
            exactUsernameDocPromise,
            activeUserId ? getFollowedUserIds(activeUserId).catch(() => [] as string[]) : Promise.resolve([] as string[]),
            activeUserId ? getRecentConversationPartners(activeUserId).catch(() => [] as User[]) : Promise.resolve([] as User[]),
            activeUserId ? getUsersFollowedBy(activeUserId, activeUserId, 60).catch(() => [] as User[]) : Promise.resolve([] as User[]),
        ]);

        const followedSet = new Set(viewerFollowedIds);
        const usersMap = new Map<string, User>();

        if (remoteUser && !remoteUser.isBlocked && !remoteUser.hasBlockedCurrentUser) {
            remoteUser.isFollowing = followedSet.has(remoteUser.id);
            usersMap.set(remoteUser.id, remoteUser);
        }

        for (const contact of [...recentPartners, ...followedSample]) {
            if (!contact || usersMap.has(contact.id) || contact.isBlocked || contact.hasBlockedCurrentUser) continue;
            const hayName = (contact.name || '').toLowerCase();
            const hayUser = (contact.username || '').toLowerCase();
            if (hayName.includes(lowerHandle) || hayUser.includes(lowerHandle)) {
                usersMap.set(contact.id, contact);
            }
        }

        if (exactUserId && !usersMap.has(exactUserId)) {
            const exactSnap = await getDoc(doc(usersCollection, exactUserId)).catch(() => null);
            if (exactSnap && exactSnap.exists()) {
                const exactUser = snapshotToPublicUser(exactSnap, {
                    isFollowing: followedSet.has(exactSnap.id),
                });
                if (exactUser && !exactUser.isBlocked && !exactUser.hasBlockedCurrentUser) {
                    usersMap.set(exactUser.id, exactUser);
                }
            }
        }

        const bioSnapshot = bioHashtagQuery ? snapshots[snapshots.length - 1] : null;

        for (const snapshot of snapshots) {
            for (const docSnap of snapshot.docs) {
                if (!usersMap.has(docSnap.id)) {
                    const user = snapshotToPublicUser(docSnap, {
                        isFollowing: followedSet.has(docSnap.id),
                    });
                    if (user && !user.isBlocked && !user.hasBlockedCurrentUser) {
                        if (bioHashtagQuery && snapshot === bioSnapshot) {
                            if (user.bio?.toLowerCase().includes(lowerQuery)) {
                                usersMap.set(docSnap.id, user);
                            }
                        } else {
                            usersMap.set(docSnap.id, user);
                        }
                    }
                }
            }
        }

        return Array.from(usersMap.values()).slice(0, 25);
    } catch (error: any) {
        console.error("Error searching users:", String(error));
        return [];
    }
};

const RECOMMENDATION_GRAPH_SOURCES = 18;
const RECOMMENDATION_GRAPH_CONNECTIONS = 40;
const RECOMMENDATION_RECENT_POSTS = 120;
const RECOMMENDATION_CACHE_TTL_MS = 5 * 60 * 1000;
const recommendationCache = new Map<string, { at: number; count: number; value: Promise<User[]> }>();

const invalidateRecommendationCache = (activeUserId?: string | null) => {
  if (activeUserId) recommendationCache.delete(activeUserId);
  else recommendationCache.clear();
};

const idsFromSubcollection = async (
  ownerId: string,
  subcollection: 'followers' | 'following' | 'mutedUsers' | 'blockedUsers',
  count?: number,
): Promise<string[]> => {
  const reference = collection(db, 'users', ownerId, subcollection);
  const snapshot = count ? await getDocs(query(reference, limit(count))) : await getDocs(reference);
  return snapshot.docs.map((item) => item.id);
};

const recommendationTopics = (post: Record<string, unknown>): string[] => {
  const topics = new Set<string>();
  if (typeof post.newsCategory === 'string' && post.newsCategory.trim()) topics.add(post.newsCategory.trim());
  if (Array.isArray(post.hashtags)) {
    post.hashtags.forEach((hashtag) => {
      if (typeof hashtag === 'string' && hashtag.trim()) topics.add(hashtag.trim().toLowerCase());
    });
  }
  return [...topics];
};

const chunksOf = <T,>(items: T[], size: number): T[][] => {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) chunks.push(items.slice(index, index + size));
  return chunks;
};

/**
 * Sugestões pessoais e explicáveis. A ordem usa, nessa prioridade prática: reciprocidade, conexões em comum, afinidade
 * com assuntos publicados pela rede da pessoa, atividade recente e popularidade como desempate/fallback. Nenhum dado
 * pessoal é lido, e contas já seguidas, silenciadas ou bloqueadas em qualquer direção são removidas.
 */
const loadSuggestedUsers = async (
  activeUserId: string,
  requested: number,
  prefs: RecommendationPreferences = DEFAULT_RECOMMENDATION_PREFERENCES,
): Promise<User[]> => {
  if (!prefs.enabled) return [];
  const profilePoolSize = Math.min(100, Math.max(40, requested * 5));

  try {
    const recentPostsQuery = query(
      postsCollection,
      where('visibility', '==', 'public'),
      where('isDeleted', '==', false),
      orderBy('createdAt', 'desc'),
      limit(RECOMMENDATION_RECENT_POSTS),
    );
    const popularUsersQuery = query(usersCollection, orderBy('followersCount', 'desc'), limit(profilePoolSize));

    const [followed, followers, muted, blocked, recentPostsSnapshot, popularUsersSnapshot] = await Promise.all([
      getFollowedUserIds(activeUserId),
      idsFromSubcollection(activeUserId, 'followers'),
      idsFromSubcollection(activeUserId, 'mutedUsers'),
      idsFromSubcollection(activeUserId, 'blockedUsers'),
      getDocs(recentPostsQuery),
      getDocs(popularUsersQuery),
    ]);

    const followedIds = new Set(followed);
    const followerIds = new Set(followers);
    const excludedIds = new Set([activeUserId, ...followed, ...muted, ...blocked]);

    // Pessoas seguidas por quem a pessoa já segue: o sinal social mais útil depois da reciprocidade.
    const graphSnapshots = await Promise.all(
      followed.slice(0, RECOMMENDATION_GRAPH_SOURCES).map((followedId) =>
        getDocs(query(
          collection(db, 'users', followedId, 'following'),
          limit(RECOMMENDATION_GRAPH_CONNECTIONS),
        )),
      ),
    );
    const mutualCounts = new Map<string, number>();
    graphSnapshots.forEach((snapshot) => snapshot.docs.forEach((connection) => {
      if (!excludedIds.has(connection.id)) {
        mutualCounts.set(connection.id, (mutualCounts.get(connection.id) ?? 0) + 1);
      }
    }));

    // Interesses vêm do que a própria pessoa e as contas que ela escolheu seguir publicaram recentemente.
    const interestWeights = new Map<string, number>();
    const authorTopics = new Map<string, Map<string, number>>();
    const recentPostsByAuthor = new Map<string, number>();
    recentPostsSnapshot.docs.forEach((postDoc) => {
      const post = postDoc.data() as Record<string, unknown>;
      const authorId = typeof post.userId === 'string' ? post.userId : '';
      if (!authorId) return;
      const topics = recommendationTopics(post);
      recentPostsByAuthor.set(authorId, (recentPostsByAuthor.get(authorId) ?? 0) + 1);

      const interestStrength = authorId === activeUserId ? 3 : followedIds.has(authorId) ? 1 : 0;
      if (interestStrength > 0) {
        topics.forEach((topic) => interestWeights.set(topic, (interestWeights.get(topic) ?? 0) + interestStrength));
      }
      if (!authorTopics.has(authorId)) authorTopics.set(authorId, new Map());
      topics.forEach((topic) => {
        const weights = authorTopics.get(authorId)!;
        weights.set(topic, (weights.get(topic) ?? 0) + 1);
      });
    });

    const candidateIds = new Set<string>([
      ...followers,
      ...mutualCounts.keys(),
      ...recentPostsByAuthor.keys(),
      ...popularUsersSnapshot.docs.map((item) => item.id),
    ]);
    excludedIds.forEach((id) => candidateIds.delete(id));

    // Reaproveita os perfis do ranking popular e busca em lotes apenas os candidatos sociais que ainda faltam.
    const publicProfiles = new Map<string, Record<string, unknown>>();
    popularUsersSnapshot.docs.forEach((item) => publicProfiles.set(item.id, item.data()));
    const missingProfileIds = [...candidateIds].filter((id) => !publicProfiles.has(id));
    const missingSnapshots = await Promise.all(chunksOf(missingProfileIds, 30).map((ids) =>
      getDocs(query(usersCollection, where(documentId(), 'in', ids), limit(ids.length))),
    ));
    missingSnapshots.forEach((snapshot) => snapshot.docs.forEach((item) => publicProfiles.set(item.id, item.data())));

    const signals: UserRecommendationSignals[] = [];
    candidateIds.forEach((userId) => {
      const profile = publicProfiles.get(userId);
      if (!profile || typeof profile.name !== 'string' || typeof profile.username !== 'string') return;
      const candidateRecPrefs = profile.recommendationPreferences as RecommendationPreferences | undefined;
      if (candidateRecPrefs?.optOutFromSuggestions) return;
      if (!matchesNetworkScope({ id: userId, username: profile.username }, prefs.networkScope)) return;

      const affinityByTopic: Record<string, number> = {};
      if (prefs.useInterestSignals !== false) {
        authorTopics.get(userId)?.forEach((publishedCount, topic) => {
          const interest = interestWeights.get(topic) ?? 0;
          if (interest > 0) affinityByTopic[topic] = Math.min(interest * 3, 12) * Math.min(publishedCount, 3);
        });
      }

      signals.push({
        userId,
        followsViewer: prefs.useFollowingSignals !== false && followerIds.has(userId),
        mutualCount: prefs.useFollowingSignals !== false ? (mutualCounts.get(userId) ?? 0) : 0,
        affinityByTopic,
        recentPosts: prefs.useActivitySignals !== false ? (recentPostsByAuthor.get(userId) ?? 0) : 0,
        followersCount: typeof profile.followersCount === 'number' ? profile.followersCount : 0,
        postsCount: typeof profile.postsCount === 'number' ? profile.postsCount : 0,
        profileComplete: Boolean(profile.avatarUrl && profile.bio),
      });
    });

    const ranked = rankUserRecommendations(signals, signals.length, prefs);
    const suggestedUsers: User[] = [];

    // A coleção bloqueada da outra pessoa só pode ser consultada documento a documento. Fazemos isso na ordem do ranking
    // e paramos assim que a tela tem sugestões suficientes, em vez de consultar toda a base.
    for (const batch of chunksOf(ranked, 10)) {
      const reverseBlocks = await Promise.all(batch.map((candidate) =>
        getDoc(doc(db, 'users', candidate.userId, 'blockedUsers', activeUserId)),
      ));
      batch.forEach((candidate, index) => {
        if (suggestedUsers.length >= requested || reverseBlocks[index].exists()) return;
        const profile = publicProfiles.get(candidate.userId);
        if (!profile) return;

        const raw = stripPrivateFields({ id: candidate.userId, ...profile }) as User;
        if (raw.createdAt instanceof Timestamp) raw.createdAt = raw.createdAt.toDate().toISOString();
        suggestedUsers.push(deepCopyUser({
          ...raw,
          isFollowing: false,
          isFollowedBy: followerIds.has(candidate.userId),
          isMuted: false,
          isBlocked: false,
          hasBlockedCurrentUser: false,
          notificationSubscriptionStatus: 'none',
          recommendationReason: candidate.reason,
        })!);
      });
      if (suggestedUsers.length >= requested) break;
    }

    return suggestedUsers;
  } catch (error) {
    console.error('Error fetching personalized suggested users:', error);
    return [];
  }
};

/**
 * Sugestão é DESCOBERTA: perfil de outro servidor só entra se a pessoa marcou `discoverable` no próprio ator (gravado em
 * `remoteDiscoverable`). Ausente não é sim. Perfil local segue as próprias preferências daqui, não esta regra.
 */
const sugestaoPermitida = (u: User): boolean =>
  remotoPodeAparecerNaDescoberta({
    remoto: u.id.startsWith('ap_') || (u as User & { isRemoteFediverse?: boolean }).isRemoteFediverse === true || Boolean(u.username?.includes('@')),
    descobrivel: u.remoteDiscoverable === true,
  });

export const getSuggestedUsers = async (
  activeUserId: string | null,
  limitCount: number = 10,
  customPrefs?: RecommendationPreferences,
): Promise<User[]> => {
  // As regras não permitem varrer perfis sem login; para visitantes, a própria tela convida a entrar quando necessário.
  if (!activeUserId) return [];

  const prefs = customPrefs ?? readRecommendationPreferences();
  if (!prefs.enabled) return [];

  const requested = Math.max(1, Math.min(limitCount, 30));
  const collectedCount = Math.max(15, requested);
  const cacheKey = `${activeUserId}:${prefs.networkScope}:${prefs.mode}:${Number(prefs.useFollowingSignals)}:${Number(prefs.useInterestSignals)}:${Number(prefs.useActivitySignals)}`;
  const hit = recommendationCache.get(cacheKey);
  if (hit && hit.count >= collectedCount && Date.now() - hit.at < RECOMMENDATION_CACHE_TTL_MS) {
    return (await hit.value).filter(sugestaoPermitida).slice(0, requested).map((user) => deepCopyUser(user)!);
  }

  const value = loadSuggestedUsers(activeUserId, collectedCount, prefs);
  recommendationCache.set(cacheKey, { at: Date.now(), count: collectedCount, value });
  void value.then((users) => {
    if (users.length === 0 && recommendationCache.get(cacheKey)?.value === value) {
      recommendationCache.delete(cacheKey);
    }
  });
  return (await value).filter(sugestaoPermitida).slice(0, requested).map((user) => deepCopyUser(user)!);
};

export const getRelatedProfiles = async (
  targetUser: User,
  activeUserId: string | null,
  limitCount: number = 6,
  customPrefs?: RecommendationPreferences,
): Promise<User[]> => {
  if (!activeUserId) return [];
  const prefs = customPrefs ?? readRecommendationPreferences();
  if (!prefs.enabled || !prefs.showOnProfiles) return [];

  try {
    const pool = await getSuggestedUsers(activeUserId, 24, prefs);
    return rankRelatedProfiles(targetUser, pool.filter(sugestaoPermitida), prefs, limitCount);
  } catch (error) {
    console.error('Error fetching related profiles:', error);
    return [];
  }
};

export const getUsersByNewsCategory = async (
  newsCategory: string,
  activeUserId: string | null,
  limitCount: number = 10
): Promise<User[]> => {
  if (!newsCategory) return [];
  const requested = Math.max(1, Math.min(limitCount, 30));

  try {
    // Query for recent posts in the specified news category
    const postsQuery = query(
      postsCollection,
      where("category", "==", "news"),
      where("newsCategory", "==", newsCategory),
      where("visibility", "==", "public"),
      orderBy("createdAt", "desc"),
      limit(50) // Scan last 50 articles to find authors
    );

    const snapshot = await getDocs(postsQuery);
    if (snapshot.empty) return [];

    // Frequência + recência dentro do assunto: uma conta que publica consistentemente sobre o tema vem antes de quem
    // apareceu uma única vez. O índice da primeira aparição preserva a recência como desempate.
    const authors = new Map<string, { count: number; first: number }>();
    snapshot.docs.forEach((post, index) => {
      const userId = post.data().userId as string | undefined;
      if (!userId || userId === activeUserId) return;
      const previous = authors.get(userId);
      authors.set(userId, { count: (previous?.count ?? 0) + 1, first: previous?.first ?? index });
    });
    const filteredAuthorIds = [...authors.entries()]
      .sort(([, a], [, b]) => b.count - a.count || a.first - b.first)
      .map(([userId]) => userId);

    if (filteredAuthorIds.length === 0) return [];

    // Busca candidatos extras porque contas já seguidas, silenciadas ou bloqueadas não são sugestões válidas.
    const userPromises = filteredAuthorIds.slice(0, requested * 3).map(id => getUser(id, activeUserId));
    const users = (await Promise.all(userPromises))
      .filter((user): user is User => Boolean(
        user
        && user.id !== activeUserId
        && !user.isFollowing
        && !user.isMuted
        && !user.isBlocked
        && !user.hasBlockedCurrentUser,
      ))
      .slice(0, requested)
      .map((user) => ({
        ...user,
        recommendationReason: { kind: 'interest' as const, topic: newsCategory },
      }));

    return users;
  } catch (error) {
    console.error(`Error fetching users by news category "${newsCategory}":`, error);
    return [];
  }
};

export const getAllUserContentForExport = async (userId: string): Promise<object> => {
  if (!userId) {
    throw new Error("User ID is required to export data.");
  }

  try {
    const userProfile = await getUser(userId, userId);
    if (!userProfile) {
      throw new Error("User profile not found.");
    }
    
    // Fetch posts and comments in parallel
    const [postsResponse, commentsResponse] = await Promise.all([
      fetchPaginatedPosts(null, 1000, userId, { profileUserId: userId }),
      fetchPaginatedUserComments(userId, null, 1000, userId)
    ]);

    return {
      profile: userProfile,
      posts: postsResponse.posts,
      comments: commentsResponse.comments,
      exportedAt: new Date().toISOString(),
    };
  } catch (error) {
    console.error(`Error exporting data for user ${userId}:`, error);
    throw new Error("Failed to gather user data for export.");
  }
};


// --- Reporting & Admin ---
export const reportUser = async (reporterId: string, reportedUserId: string, reason: string): Promise<boolean> => {
    const reportsColRef = collection(db, 'reports');
    try {
        await addDoc(reportsColRef, {
            type: 'user',
            reporterId,
            reportedUserId,
            reason,
            createdAt: serverTimestamp(),
            status: 'pending'
        });
        return true;
    } catch (error: any) {
        console.error("Error reporting user:", String(error));
        return false;
    }
};

export const getTotalUsersCount = async (): Promise<number> => {
    try {
      const q = query(usersCollection, where("isAdmin", "!=", true));
      const snapshot = await getDocs(q);
      return snapshot.size;
    } catch (error: any) { console.error("Error getting total users count:", String(error)); return 0;}
};

export const subscribeToTotalUsersCount = (callback: (count: number) => void): (() => void) => {
  const q = query(usersCollection, where("isAdmin", "!=", true));

  const unsubscribe = onSnapshot(q, (snapshot) => {
    callback(snapshot.size);
  }, (error) => {
    console.error("Error subscribing to total users count:", error);
    callback(0); // Report 0 on error
  });

  return unsubscribe;
};

export type PresenceStats = { onlineUsers: number; onlineGuests: number };
const getPresenceStatsCallable = httpsCallable<void, PresenceStats>(functions, 'getPresenceStats');

/**
 * Quantos usuários e visitantes estão online, para o painel do administrador. A presença mora no Realtime Database,
 * que o cliente não pode listar (privacidade): a Function getPresenceStats conta com credencial de servidor e só
 * responde a administradores. Consulta a cada `intervalMs` (antes o painel lia um campo do Firestore que nunca era
 * gravado e mostrava sempre 0, e lia o nó /guests inteiro, que era público).
 */
export const subscribeToPresenceStats = (callback: (stats: PresenceStats) => void, intervalMs = 60_000): (() => void) => {
  let stopped = false;
  const load = async () => {
    try {
      const result = await getPresenceStatsCallable();
      if (!stopped) callback(result.data);
    } catch (error) {
      console.error("Error loading presence stats:", error);
      if (!stopped) callback({ onlineUsers: 0, onlineGuests: 0 });
    }
  };
  void load();
  const timer = setInterval(load, intervalMs);
  return () => {
    stopped = true;
    clearInterval(timer);
  };
};

// --- Custom Feeds and Tab Preferences ---

export const getCustomFeeds = async (userId: string): Promise<CustomFeed[]> => {
  if (!userId) return [];
  const feedsColRef = collection(db, 'users', userId, 'customFeeds');
  const q = query(feedsColRef, orderBy('createdAt', 'desc'));
  try {
    const snapshot = await getDocs(q);
    if (snapshot.empty) return [];
    return snapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data(),
      createdAt: (doc.data().createdAt as Timestamp).toDate().toISOString()
    } as CustomFeed));
  } catch (error) {
    console.error(`Error fetching custom feeds for user ${userId}:`, error);
    return [];
  }
};

export const createCustomFeed = async (userId: string, feedData: { name: string; userIds: string[] }): Promise<CustomFeed> => {
  if (!userId || !feedData.name) throw new Error("User ID and feed name are required.");
  const feedsColRef = collection(db, 'users', userId, 'customFeeds');
  const newFeedData = {
    ...feedData,
    isPinned: false, // Pinned status is managed in user's top-level preferences
    createdAt: serverTimestamp(),
  };
  const docRef = await addDoc(feedsColRef, newFeedData);
  return {
    id: docRef.id,
    ...newFeedData,
    createdAt: new Date().toISOString(), // Optimistic return
  } as CustomFeed;
};

export const updateCustomFeed = async (userId: string, feedId: string, feedData: { name: string; userIds: string[] }): Promise<void> => {
  if (!userId || !feedId) throw new Error("User ID and Feed ID are required.");
  const feedDocRef = doc(db, 'users', userId, 'customFeeds', feedId);
  await updateDoc(feedDocRef, {
    name: feedData.name,
    userIds: feedData.userIds,
  });
};

export const deleteCustomFeed = async (userId: string, feedId: string): Promise<void> => {
  if (!userId || !feedId) throw new Error("User ID and Feed ID are required.");
  const feedDocRef = doc(db, 'users', userId, 'customFeeds', feedId);
  await deleteDoc(feedDocRef);
};

export const updateTabPreferences = async (userId: string, prefs: TabPreferences): Promise<void> => {
  if (!userId) throw new Error("User ID is required.");
  // Preferência pessoal: fica em users/{uid}/private/account.
  await savePrivateAccount(userId, { tabPreferences: prefs });
};
