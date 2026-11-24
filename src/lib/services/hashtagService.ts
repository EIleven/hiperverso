// src/lib/services/hashtagService.ts
import { db } from '../firebase';
import {
  collection,
  query,
  orderBy,
  limit as firestoreLimit,
  getDocs,
  Timestamp,
  where,
  collectionGroup,
  getCountFromServer,
} from 'firebase/firestore';
import type { User } from '../types';
import { getUser } from './userService';

const HASHTAG_REGEX = /#([a-zA-Z0-9_áéíóúÁÉÍÓÚàèìòùÀÈÌÒÙâêîôûÂÊÎÔÛãõÃÕçÇ]+)/g;

const TRENDING_CACHE_TTL_MS = 3 * 60 * 1000;
const MAX_CACHE_ENTRIES = 20;

type TrendingTopicEntry = { topic: string; count: number; topUsers: User[] };
type TopHashtagEntry = { tag: string; count: number };

const trendingTopicsCache = new Map<string, { value: TrendingTopicEntry[]; expiresAt: number }>();
const trendingTopicsInFlight = new Map<string, Promise<TrendingTopicEntry[]>>();
const topHashtagsCache = new Map<string, { value: TopHashtagEntry[]; expiresAt: number }>();
const topHashtagsInFlight = new Map<string, Promise<TopHashtagEntry[]>>();

function readTtlCache<T>(cache: Map<string, { value: T; expiresAt: number }>, key: string): T | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    cache.delete(key);
    return null;
  }
  return entry.value;
}

function writeTtlCache<T>(cache: Map<string, { value: T; expiresAt: number }>, key: string, value: T): void {
  if (cache.size >= MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, { value, expiresAt: Date.now() + TRENDING_CACHE_TTL_MS });
}

export function invalidateHashtagCache(): void {
  trendingTopicsCache.clear();
  topHashtagsCache.clear();
}

/**
 * Calculates a time-weighted score for a post.
 * More recent posts get a higher score.
 * An engagement multiplier is added to boost popular posts.
 * @param createdAt The timestamp of the post.
 * @param likes The number of likes on the post.
 * @param commentsCount The number of comments on the post.
 * @returns A relevance score for the post.
 */
const calculateRelevanceScore = (
  createdAt: Timestamp,
  likes: number = 0,
  commentsCount: number = 0
): number => {
  const now = Date.now();
  const postTime = createdAt.toMillis();
  const ageInHours = (now - postTime) / (1000 * 60 * 60);

  // Base score decays exponentially with age. A post from 24 hours ago has a very low base score.
  const timeDecayFactor = Math.exp(-0.1 * ageInHours);
  
  // Engagement score adds a bonus for interactions.
  const engagementMultiplier = 1 + (likes * 0.1) + (commentsCount * 0.2);

  // Final score is a combination of recency and engagement.
  return timeDecayFactor * engagementMultiplier;
};


export const getTrendingTopics = async (
    countLimit: number = 10,
    scanLimit: number = 200
): Promise<TrendingTopicEntry[]> => {
    const cacheKey = `${countLimit}:${scanLimit}`;
    const cached = readTtlCache(trendingTopicsCache, cacheKey);
    if (cached) return cached;

    const existing = trendingTopicsInFlight.get(cacheKey);
    if (existing) return existing;

    const task = fetchTrendingTopicsUncached(countLimit, scanLimit)
      .then((results) => {
        if (results.length > 0) writeTtlCache(trendingTopicsCache, cacheKey, results);
        return results;
      })
      .finally(() => {
        trendingTopicsInFlight.delete(cacheKey);
      });

    trendingTopicsInFlight.set(cacheKey, task);
    return task;
};

const fetchTrendingTopicsUncached = async (
    countLimit: number,
    scanLimit: number
): Promise<TrendingTopicEntry[]> => {
    const hashtagScores: { [key: string]: number } = {};
    const hashtagCounts: { [key: string]: number } = {};
    const hashtagContributors: { [key: string]: { userId: string; score: number }[] } = {};

    const processDocument = (docData: any, isPost: boolean) => {
        const textContent = isPost 
            ? (docData.text || '') + ' ' + (docData.headline || '') 
            : docData.text || '';
        
        const matches = textContent.match(HASHTAG_REGEX);
        if (!matches) return;

        const score = calculateRelevanceScore(
            docData.createdAt as Timestamp,
            docData.likes,
            isPost ? docData.commentsCount : docData.repliesCount
        );

        const uniqueHashtags = [...new Set<string>(matches)];
        
        uniqueHashtags.forEach((tag: string) => {
            hashtagScores[tag] = (hashtagScores[tag] || 0) + score;
            hashtagCounts[tag] = (hashtagCounts[tag] || 0) + 1;

            if (!hashtagContributors[tag]) {
                hashtagContributors[tag] = [];
            }
            hashtagContributors[tag].push({ userId: docData.userId, score });
        });
    };

    const postsQuery = query(
        collection(db, 'posts'),
        where("visibility", "==", "public"),
        where("isDeleted", "==", false),
        orderBy("createdAt", "desc"), 
        firestoreLimit(scanLimit)
    );
    
    const commentsQuery = query(
        collectionGroup(db, 'comments'),
        where("postVisibility", "==", "public"),
        where("isDeleted", "==", false),
        orderBy("createdAt", "desc"), 
        firestoreLimit(scanLimit)
    );

    try {
        const [postsSnapshot, commentsSnapshot] = await Promise.all([
            getDocs(postsQuery),
            getDocs(commentsQuery)
        ]);

        postsSnapshot.forEach(doc => {
            processDocument(doc.data(), true);
        });

        commentsSnapshot.forEach(doc => {
            processDocument(doc.data(), false);
        });

        const sortedHashtags = Object.keys(hashtagScores)
            .sort((a, b) => hashtagScores[b] - hashtagScores[a])
            .slice(0, countLimit);

        const results = await Promise.all(
            sortedHashtags.map(async (tag) => {
                const contributors = hashtagContributors[tag] || [];
                const sortedContributors = contributors.sort((a, b) => b.score - a.score);
                const uniqueUserIds = [...new Set(sortedContributors.map(c => c.userId))];
                const topUserIds = uniqueUserIds.slice(0, 4);

                const userPromises = topUserIds.map(userId => getUser(userId, null));
                const topUsers = (await Promise.all(userPromises)).filter((u): u is User => !!u);

                return {
                    topic: tag,
                    count: hashtagCounts[tag] || 0,
                    topUsers: topUsers,
                };
            })
        );
        
        return results;

    } catch (error: any) {
        console.error("Error fetching trending topics:", String(error));
        // Fallback to simpler count-based ranking on error
        const topHashtags = await getTopHashtags(countLimit);
        return topHashtags.map(ht => ({ ...ht, topic: ht.tag, topUsers: [] }));
    }
};


export const getTopHashtags = async (limit: number): Promise<TopHashtagEntry[]> => {
    const cacheKey = `top:${limit}`;
    const cached = readTtlCache(topHashtagsCache, cacheKey);
    if (cached) return cached;

    const existing = topHashtagsInFlight.get(cacheKey);
    if (existing) return existing;

    const task = fetchTopHashtagsUncached(limit)
      .then((results) => {
        if (results.length > 0) writeTtlCache(topHashtagsCache, cacheKey, results);
        return results;
      })
      .finally(() => {
        topHashtagsInFlight.delete(cacheKey);
      });

    topHashtagsInFlight.set(cacheKey, task);
    return task;
};

const fetchTopHashtagsUncached = async (limit: number): Promise<TopHashtagEntry[]> => {
    const hashtagCounts: { [key: string]: number } = {};
    const processedDocs = new Set<string>(); // To avoid double counting hashtags from the same post/comment

    const postsQuery = query(
        collection(db, 'posts'), 
        where("visibility", "==", "public"),
        where("isDeleted", "==", false),
        orderBy("createdAt", "desc"), 
        firestoreLimit(500)
    ); 

    const commentsQuery = query(
        collectionGroup(db, 'comments'),
        where("postVisibility", "==", "public"),
        where("isDeleted", "==", false),
        orderBy("createdAt", "desc"),
        firestoreLimit(500)
    );

    try {
        const [postsSnapshot, commentsSnapshot] = await Promise.all([
            getDocs(postsQuery),
            getDocs(commentsQuery)
        ]);

        const processSnapshot = (snapshot: any, isPost: boolean) => {
            snapshot.forEach((doc: any) => {
                const docId = doc.id;
                // Since comment and post IDs can technically overlap (though unlikely for auto-IDs),
                // we'll use a prefixed key to be safe.
                const uniqueKey = `${isPost ? 'post' : 'comment'}-${docId}`;
                if (processedDocs.has(uniqueKey)) return;
                
                const data = doc.data();
                const textContent = isPost 
                    ? (data.text || '') + ' ' + (data.headline || '')
                    : data.text || '';
                
                const plainText = textContent.replace(/<[^>]*>?/gm, ' ');
                const matches = plainText.match(HASHTAG_REGEX);
                if (!matches) return;

                const uniqueHashtagsInDoc = new Set<string>(matches);
                
                uniqueHashtagsInDoc.forEach((tag: string) => {
                    hashtagCounts[tag] = (hashtagCounts[tag] || 0) + 1;
                });
                processedDocs.add(uniqueKey);
            });
        }

        processSnapshot(postsSnapshot, true);
        processSnapshot(commentsSnapshot, false);


        const sortedHashtags = Object.entries(hashtagCounts)
            .sort(([, a], [, b]) => b - a)
            .slice(0, limit);

        return sortedHashtags.map(([tag, count]) => ({ tag, count }));
    } catch (error: any) {
        console.error("Error fetching top hashtags:", String(error));
        return [];
    }
};

export interface HashtagStats {
    postCount: number;
}

export const getHashtagStats = async (tag: string): Promise<HashtagStats> => {
    if (!tag) return { postCount: 0 };
    const exactTag = tag.startsWith('#') ? tag : `#${tag}`;

    // Só o que é público, e contado no servidor (antes baixava todos os posts e comentários da hashtag só para contar,
    // e a consulta de comentários sem filtro de visibilidade era recusada pelas regras).
    const postsQuery = query(collection(db, 'posts'), where("hashtags", "array-contains", exactTag), where("visibility", "==", "public"), where("isDeleted", "==", false));
    const commentsQuery = query(collectionGroup(db, 'comments'), where("hashtags", "array-contains", exactTag), where("postVisibility", "==", "public"), where("isDeleted", "==", false));

    try {
        const [postsCount, commentsCount] = await Promise.all([
            getCountFromServer(postsQuery),
            getCountFromServer(commentsQuery)
        ]);

        const totalCount = postsCount.data().count + commentsCount.data().count;

        return { postCount: totalCount };
    } catch (error) {
        console.error(`Error getting post count for hashtag ${tag}:`, error);
        return { postCount: 0 };
    }
};
