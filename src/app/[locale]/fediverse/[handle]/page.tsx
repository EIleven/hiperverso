'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import Image from 'next/image';
import { useLocale } from 'next-intl';
import { ExternalLink, Globe, Loader2 } from 'lucide-react';
import { useCurrentUser } from '@/contexts/CurrentUserContext';
import { useToast } from '@/hooks/use-toast';
import type { Post, User } from '@/lib/types';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import BackButton from '@/components/shared/BackButton';
import ProfileHeader from '@/components/profile/ProfileHeader';
import ProfilePageSkeleton from '@/components/profile/ProfilePageSkeleton';
import ProfileContentTabs from '@/components/profile/ProfileContentTabs';

interface RemoteProfileResponse {
  actorId: string;
  handle: string;
  domain: string;
  name: string;
  summary: string;
  iconUrl: string | null;
  headerUrl: string | null;
  url: string;
  nativeUser: User;
  nativePosts: Post[];
  isFollowing?: boolean;
  callerFederationEnabled?: boolean;
  /** Ninguém daqui segue: os posts não foram buscados na origem. */
  postsSoComSeguidor?: boolean;
  /** A origem recusou (401/403) a leitura dos posts. */
  postsRestritos?: boolean;
}

const REMOTE_PROFILE_CACHE_TTL_MS = 5 * 60 * 1000;

const MENSAGENS_DE_ERRO: Record<string, string> = {
  'login-obrigatorio': 'Entre na sua conta para ver perfis do Fediverso.',
  'perfil-local': 'Este perfil é daqui do HiperVerso.',
  'perfil-nao-encontrado': 'Perfil não encontrado no Fediverso.',
  'ator-invalido': 'O servidor deste perfil respondeu com dados inconsistentes, e por segurança não mostramos o perfil.',
  'instancia-bloqueada': 'Este servidor está bloqueado.',
  'plataforma-desligada': 'O Fediverso está desligado no momento.',
  'origem-recusou': 'O servidor deste perfil não permite que o HiperVerso o leia.',
  'dominio-em-pausa': 'Este servidor vem recusando o HiperVerso. Pausamos o contato com ele por um tempo.',
  'origem-indisponivel': 'O servidor deste perfil não respondeu. Tente de novo mais tarde.',
};
const remoteProfileCache = new Map<string, { payload: RemoteProfileResponse; at: number }>();

export default function RemoteFediverseProfilePage() {
  const params = useParams<{ handle: string }>();
  const locale = useLocale();
  const router = useRouter();
  const { currentUser, firebaseUser } = useCurrentUser();
  const { toast } = useToast();

  const rawHandle = decodeURIComponent(params?.handle ?? '');
  const cacheKey = rawHandle.trim().replace(/^@+/, '').toLowerCase();
  const cachedEntry = cacheKey ? remoteProfileCache.get(cacheKey) : undefined;

  const [data, setData] = useState<RemoteProfileResponse | null>(() => cachedEntry?.payload ?? null);
  const [nativeUser, setNativeUser] = useState<User | null>(() => cachedEntry?.payload.nativeUser ?? null);
  const [newlyCreatedPostForFeed, setNewlyCreatedPostForFeed] = useState<Post | null>(null);
  const [loading, setLoading] = useState(() => !cachedEntry);
  const [error, setError] = useState<string | null>(null);
  const [submittingFollow, setSubmittingFollow] = useState(false);

  const loadProfile = useCallback(async () => {
    if (!rawHandle) return;
    const existing = cacheKey ? remoteProfileCache.get(cacheKey) : undefined;
    if (existing && Date.now() - existing.at < REMOTE_PROFILE_CACHE_TTL_MS) {
      setData(existing.payload);
      setNativeUser(existing.payload.nativeUser);
      setLoading(false);
      return;
    }
    if (!existing) setLoading(true);
    setError(null);
    try {
      const headers: Record<string, string> = {};
      if (firebaseUser) {
        const token = await firebaseUser.getIdToken();
        headers.Authorization = `Bearer ${token}`;
      }
      const res = await fetch(`/api/ap/remote-profile?handle=${encodeURIComponent(rawHandle)}`, { headers });
      const json = await res.json();
      if (!res.ok) {
        // @alguem@exercitodolula.app é uma pessoa DAQUI: abre o perfil de verdade, não uma cópia do Fediverso.
        if (json?.error === 'perfil-local' && typeof json?.localUserId === 'string') {
          router.replace(`/${locale}/profile/${json.localUserId}`);
          return;
        }
        if (!existing) {
          setError(MENSAGENS_DE_ERRO[json?.error as string] ?? 'Perfil não encontrado no Fediverso.');
          setData(null);
        }
      } else {
        const payload = json as RemoteProfileResponse;
        if (cacheKey) remoteProfileCache.set(cacheKey, { payload, at: Date.now() });
        setData(payload);
        setNativeUser(payload.nativeUser);
      }
    } catch {
      if (!existing) {
        setError('Não foi possível carregar este perfil do Fediverso.');
        setData(null);
      }
    } finally {
      setLoading(false);
    }
  }, [rawHandle, cacheKey, firebaseUser, router, locale]);

  useEffect(() => {
    loadProfile();
  }, [loadProfile]);

  const handleFollowToggle = async () => {
    if (!data || !nativeUser || submittingFollow) return;
    if (!firebaseUser || !currentUser) {
      toast({
        title: 'Entre na sua conta',
        description: 'Você precisa estar conectado no HiperVerso para seguir perfis do Fediverso.',
        variant: 'destructive',
      });
      return;
    }
    if (!data.callerFederationEnabled) {
      toast({
        title: 'Ative seu Fediverso primeiro',
        description: 'Vá em Configurações → Fediverso para ativar sua identidade federada antes de seguir perfis externos.',
        variant: 'destructive',
      });
      return;
    }

    setSubmittingFollow(true);
    const nextAction = nativeUser.isFollowing ? 'unfollow' : 'follow';
    try {
      const token = await firebaseUser.getIdToken();
      const res = await fetch('/api/ap/follow', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ handle: data.handle, action: nextAction }),
      });
      const resJson = await res.json();
      if (!res.ok) {
        toast({
          title: 'Não foi possível concluir',
          description: resJson?.error === 'conta-pausada'
            ? 'Sua federação está pausada nas configurações.'
            : 'O servidor remoto não respondeu ao pedido.',
          variant: 'destructive',
        });
      } else {
        const nowFollowing = Boolean(resJson.following);
        setNativeUser((prev) => (prev ? { ...prev, isFollowing: nowFollowing } : prev));
        toast({
          title: nowFollowing ? `Seguindo @${data.handle}` : `Deixou de seguir @${data.handle}`,
          description: nowFollowing
            ? 'As publicações deste perfil aparecerão no seu feed Seguindo.'
            : 'Você deixou de seguir este perfil no Fediverso.',
        });
      }
    } catch {
      toast({
        title: 'Erro de rede',
        description: 'Tente novamente em alguns instantes.',
        variant: 'destructive',
      });
    } finally {
      setSubmittingFollow(false);
    }
  };

  if (loading) {
    return <ProfilePageSkeleton />;
  }

  if (error || !data || !nativeUser) {
    return (
      <div className="container mx-auto max-w-3xl py-8 space-y-6">
        <BackButton />
        <Card>
          <CardContent className="py-12 text-center space-y-3">
            <Globe className="mx-auto h-10 w-10 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">{error || 'Perfil não encontrado.'}</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div>
      <div className="relative h-48 bg-muted w-full">
        <BackButton className="absolute top-4 left-4 z-10 bg-black/50 hover:bg-black/70 text-white" />
        {nativeUser.coverImageUrl ? (
          <Image
            src={nativeUser.coverImageUrl}
            alt={nativeUser.coverImageAlt?.trim() || `${nativeUser.name} banner`}
            fill
            sizes="100vw"
            className="object-cover"
            priority
            unoptimized
          />
        ) : (
          <div className="h-full w-full bg-gradient-to-r from-primary to-accent" />
        )}
      </div>

      <div className="container mx-auto max-w-3xl pb-8 space-y-4">
        <div className="overflow-visible -mt-16">
          <ProfileHeader
            profileUser={nativeUser}
            activeUser={currentUser}
            isOwnProfile={false}
            isMutualFollow={false}
            externalProfileUrl={data.url}
            externalDomain={data.domain}
            onFollowToggle={handleFollowToggle}
            onMuteToggle={async () => {}}
            onBlockToggle={async () => {}}
            onReport={async () => {}}
            onMessageUser={() => {
              window.open(data.url, '_blank', 'noopener,noreferrer');
            }}
            onUpdateNotificationSubscription={async () => {}}
            onProfileUpdated={() => {}}
            requireLoginOrPrompt={() => Boolean(currentUser)}
          />
        </div>

        {submittingFollow && (
          <div className="px-6 flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Sincronizando com {data.domain}...
          </div>
        )}

        {currentUser && !data.callerFederationEnabled && (
          <div className="mx-6 rounded-lg bg-muted/60 px-3 py-2 text-xs text-muted-foreground">
            Para seguir e interagir com contas do Fediverso, ative sua identidade em{' '}
            <Link href={`/${locale}/settings/fediverse`} className="font-medium text-primary hover:underline">
              Configurações → Fediverso
            </Link>.
          </div>
        )}

        {(data.postsSoComSeguidor || data.postsRestritos) && (
          <p className="mx-6 rounded-lg bg-muted/60 px-3 py-2 text-xs text-muted-foreground">
            {data.postsRestritos
              ? 'O servidor de origem restringe a leitura das publicações.'
              : 'Siga para ver as publicações aqui.'}{' '}
            <a href={data.url} target="_blank" rel="noopener noreferrer" className="font-medium text-primary hover:underline">
              Abrir em {data.domain}
            </a>
          </p>
        )}

        <ProfileContentTabs
          profileUser={nativeUser}
          activeUser={currentUser}
          isOwnProfile={false}
          onPostCreatedFromCommentQuote={(newPost) => setNewlyCreatedPostForFeed(newPost)}
          newlyCreatedPostForFeed={newlyCreatedPostForFeed}
          onPostPrependedInFeed={() => setNewlyCreatedPostForFeed(null)}
        />
      </div>
    </div>
  );
}
