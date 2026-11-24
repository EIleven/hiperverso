// src/components/idp2p/UniverseLensBar.tsx
'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useLocale } from 'next-intl';
import {
  ArrowLeftRight,
  Check,
  GitMerge,
  Globe2,
  Loader2,
  Plus,
  Sparkles,
  Trash2,
} from 'lucide-react';
import { auth } from '@/lib/firebase';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { useToast } from '@/hooks/use-toast';
import {
  dismissMergePrompt,
  getDeviceSavedAccounts,
  isMergePromptDismissed,
  registerCurrentAccountOnP2pDevice,
  removeDeviceSavedAccount,
  switchToDeviceAccount,
  unifyCurrentAccountIntoPrimary,
  type DeviceSavedAccount,
} from '@/lib/p2p/p2pAccountSwitch';
import { cn } from '@/lib/utils';

interface UniverseOption {
  id: string;
  label: string;
  handle: string;
  targetUid?: string;
}

interface UniverseLensBarProps {
  userId?: string;
  name?: string;
  avatarUrl?: string;
  username: string;
  federatedLoginProvider?: string;
  federatedLoginHandle?: string;
  compact?: boolean;
  controlledSwitcherOpen?: boolean;
  onControlledSwitcherOpenChange?: (open: boolean) => void;
  headless?: boolean;
}

function readLensCookie(): string {
  if (typeof document === 'undefined') return 'exercitodolula';
  const match = document.cookie.match(/(?:^|;\s*)idp2p_lens=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : 'exercitodolula';
}

const SHORT_PROVIDER: Record<string, string> = {
  exercitodolula: 'HiperVerso',
  fediverse: 'Fediverso',
  mastodon: 'Fediverso',
  bluesky: 'Bluesky',
  google: 'Google',
  github: 'GitHub',
  custom_oidc: 'OIDC',
};

export default function UniverseLensBar({
  userId,
  name,
  avatarUrl,
  username,
  federatedLoginProvider,
  federatedLoginHandle,
  compact = false,
  controlledSwitcherOpen,
  onControlledSwitcherOpenChange,
  headless = false,
}: UniverseLensBarProps) {
  const locale = useLocale();
  const router = useRouter();
  const { toast } = useToast();
  const activeUid = userId || auth.currentUser?.uid || '';

  const [activeLens, setActiveLens] = useState<string>('exercitodolula');
  const [extraUniverses, setExtraUniverses] = useState<UniverseOption[]>([]);
  const [deviceAccounts, setDeviceAccounts] = useState<DeviceSavedAccount[]>([]);
  const [internalSwitcherOpen, setInternalSwitcherOpen] = useState(false);
  const switcherOpen = controlledSwitcherOpen ?? internalSwitcherOpen;
  const setSwitcherOpen = onControlledSwitcherOpenChange ?? setInternalSwitcherOpen;
  const [autoPromptPrimary, setAutoPromptPrimary] = useState<DeviceSavedAccount | null>(null);
  const [busyUid, setBusyUid] = useState<string | null>(null);

  useEffect(() => {
    setActiveLens(readLensCookie());
  }, []);

  // Registra a conta atual no Cofre P2P do aparelho e detecta se já havia outra conta conectada
  useEffect(() => {
    if (!activeUid || !username) return;
    let cancelled = false;

    const refreshLocal = () => {
      setDeviceAccounts(getDeviceSavedAccounts());
    };

    (async () => {
      const previousAccounts = getDeviceSavedAccounts();
      const otherExisting = previousAccounts.find(
        (a) => a.uid !== activeUid && Boolean(a.switchSecret)
      );

      const updated = await registerCurrentAccountOnP2pDevice({
        id: activeUid,
        name: name || username,
        username,
        avatarUrl,
        federatedLoginProvider,
        federatedLoginHandle,
      });
      if (cancelled) return;
      setDeviceAccounts(updated);

      // Se o aparelho P2P já tinha outra conta e esta acabou de entrar via rede federada, sugere validar/unificar
      if (
        otherExisting &&
        federatedLoginProvider &&
        !isMergePromptDismissed(otherExisting.uid, activeUid)
      ) {
        setAutoPromptPrimary(otherExisting);
      }
    })();

    window.addEventListener('idp2p:device-accounts-changed', refreshLocal);
    return () => {
      cancelled = true;
      window.removeEventListener('idp2p:device-accounts-changed', refreshLocal);
    };
  }, [activeUid, name, avatarUrl, username, federatedLoginProvider, federatedLoginHandle]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const token = await auth.currentUser?.getIdToken().catch(() => null);
      if (!token || cancelled) return;
      const res = await fetch('/api/idp2p/linked-accounts', {
        headers: { Authorization: `Bearer ${token}` },
      }).catch(() => null);
      if (!res?.ok || cancelled) return;
      const data = (await res.json()) as {
        links?: Array<{ id: string; provider: string; handle: string; label?: string }>;
      };
      if (!Array.isArray(data.links) || cancelled) return;
      setExtraUniverses(
        data.links.slice(0, 4).map((item) => ({
          id: `${item.provider}:${item.handle}`,
          label: item.label || SHORT_PROVIDER[item.provider] || item.provider,
          handle: item.handle,
        }))
      );
    })();
    return () => {
      cancelled = true;
    };
  }, [username]);

  const handleSwitchAccount = async (target: DeviceSavedAccount) => {
    if (busyUid || target.uid === activeUid) return;
    setBusyUid(target.uid);
    try {
      await switchToDeviceAccount(target.uid);
      toast({
        title: `Alternado para @${target.username}`,
        description: target.federatedHandle
          ? `Conectado via ${target.federatedHandle}`
          : 'Conta ativa neste aparelho.',
      });
      setSwitcherOpen(false);
      router.refresh();
    } catch (err) {
      toast({
        title: 'Validação necessária',
        description:
          err instanceof Error
            ? err.message
            : 'Entre uma vez nesta conta para reativar a troca em 1 toque.',
        variant: 'destructive',
      });
      router.push(`/${locale}/login`);
    } finally {
      setBusyUid(null);
    }
  };

  const handleUnifyIntoPrimary = async (primary: DeviceSavedAccount) => {
    if (busyUid) return;
    setBusyUid(primary.uid);
    try {
      await unifyCurrentAccountIntoPrimary(primary.uid);
      dismissMergePrompt(primary.uid, activeUid);
      setAutoPromptPrimary(null);
      setSwitcherOpen(false);
      toast({
        title: 'Contas unificadas neste aparelho!',
        description: `Sua rede foi vinculada à conta @${primary.username}.`,
      });
      router.refresh();
    } catch (err) {
      toast({
        title: 'Erro ao unificar contas',
        description: err instanceof Error ? err.message : 'Tente novamente.',
        variant: 'destructive',
      });
    } finally {
      setBusyUid(null);
    }
  };

  if (compact && !headless) return null;

  const universes: UniverseOption[] = [
    { id: 'exercitodolula', label: `@${username}`, handle: `@${username}`, targetUid: activeUid },
  ];

  if (federatedLoginHandle) {
    const provider = federatedLoginProvider === 'bluesky' ? 'bluesky' : 'mastodon';
    const fedId = `${provider}:${federatedLoginHandle}`;
    if (!universes.some((u) => u.id === fedId)) {
      universes.push({
        id: fedId,
        label: SHORT_PROVIDER[provider],
        handle: federatedLoginHandle,
      });
    }
  }

  for (const acc of deviceAccounts) {
    if (acc.uid === activeUid) continue;
    const pillId = `device:${acc.uid}`;
    if (!universes.some((u) => u.id === pillId)) {
      universes.push({
        id: pillId,
        label: `@${acc.username}`,
        handle: acc.federatedHandle || `@${acc.username}`,
        targetUid: acc.uid,
      });
    }
  }

  for (const extra of extraUniverses) {
    if (!universes.some((u) => u.id === extra.id)) {
      universes.push(extra);
    }
  }

  const handleSelectPill = (u: UniverseOption) => {
    if (u.targetUid && u.targetUid !== activeUid) {
      const targetAcc = deviceAccounts.find((a) => a.uid === u.targetUid);
      if (targetAcc) {
        void handleSwitchAccount(targetAcc);
        return;
      }
    }
    setActiveLens(u.id);
    if (typeof document !== 'undefined') {
      document.cookie = `idp2p_lens=${encodeURIComponent(u.id)}; path=/; max-age=2592000; SameSite=Lax`;
      window.dispatchEvent(new CustomEvent('idp2p:lens-changed', { detail: u.id }));
    }
    void fetch('/api/idp2p/universe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lens: u.id }),
    }).catch(() => null);
    router.refresh();
  };

  const otherDeviceAccounts = deviceAccounts.filter((a) => a.uid !== activeUid);

  return (
    <div className={headless ? undefined : 'w-full pt-1.5'}>
      {!headless && (
        <div className="flex flex-wrap items-center justify-center gap-1 rounded-xl bg-muted/40 p-1 border border-border/50">
          {universes.slice(0, 4).map((u) => {
            const isCurrentAccount = u.targetUid === activeUid || (!u.targetUid && activeLens === u.id);
            const isSwitchingThis = Boolean(u.targetUid && busyUid === u.targetUid);
            return (
              <button
                key={u.id}
                type="button"
                title={
                  u.targetUid && u.targetUid !== activeUid
                    ? `Trocar em 1 toque para ${u.label} (${u.handle})`
                    : `${u.label} (${u.handle})`
                }
                onClick={() => handleSelectPill(u)}
                disabled={busyUid !== null}
                className={cn(
                  'inline-flex items-center gap-1 rounded-lg px-2 py-1 text-[11px] font-medium transition-all cursor-pointer',
                  isCurrentAccount
                    ? 'bg-primary text-primary-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground hover:bg-muted/70'
                )}
              >
                {isSwitchingThis ? (
                  <Loader2 className="h-3 w-3 shrink-0 animate-spin" />
                ) : u.targetUid && u.targetUid !== activeUid ? (
                  <ArrowLeftRight className="h-3 w-3 shrink-0 text-primary" />
                ) : u.id === 'exercitodolula' ? (
                  <Sparkles className="h-3 w-3 shrink-0" />
                ) : (
                  <Globe2 className="h-3 w-3 shrink-0" />
                )}
                <span className="max-w-[82px] truncate">{u.label}</span>
              </button>
            );
          })}
          <button
            type="button"
            onClick={() => setSwitcherOpen(true)}
            title="Trocar de conta ou conectar outra rede (IDP2P)"
            aria-label="Trocar de conta ou conectar outra rede (IDP2P)"
            className="inline-flex h-6 w-6 items-center justify-center rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted/70 transition-colors"
          >
            <Plus className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {/* Modal de validação automática quando o P2P detecta outra conta no mesmo aparelho */}
      <Dialog
        open={Boolean(autoPromptPrimary)}
        onOpenChange={(open) => {
          if (!open && autoPromptPrimary) {
            dismissMergePrompt(autoPromptPrimary.uid, activeUid);
            setAutoPromptPrimary(null);
          }
        }}
      >
        <DialogContent className="max-w-md rounded-2xl border-border/80">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-base font-bold">
              <GitMerge className="h-5 w-5 text-primary" />
              Conta existente detectada neste aparelho
            </DialogTitle>
            <DialogDescription className="text-xs leading-relaxed">
              O P2P identificou que este dispositivo já possui a conta{' '}
              <strong className="text-foreground">@{autoPromptPrimary?.username}</strong>. Como você
              prefere usar <strong className="text-foreground">@{username}</strong>?
            </DialogDescription>
          </DialogHeader>

          {autoPromptPrimary && (
            <div className="space-y-3 pt-1">
              <Button
                type="button"
                className="w-full justify-start rounded-xl h-auto py-2.5 px-3.5 text-left"
                disabled={busyUid !== null}
                onClick={() => void handleUnifyIntoPrimary(autoPromptPrimary)}
              >
                {busyUid === autoPromptPrimary.uid ? (
                  <Loader2 className="mr-2.5 h-4 w-4 shrink-0 animate-spin" />
                ) : (
                  <GitMerge className="mr-2.5 h-4 w-4 shrink-0" />
                )}
                <div className="min-w-0">
                  <p className="text-xs font-bold">
                    Unificar dentro de @{autoPromptPrimary.username} (Recomendado)
                  </p>
                  <p className="text-[11px] opacity-90 truncate">
                    Conecta {federatedLoginHandle || `@${username}`} direto à sua conta principal
                  </p>
                </div>
              </Button>

              <Button
                type="button"
                variant="outline"
                className="w-full justify-start rounded-xl h-auto py-2.5 px-3.5 text-left"
                onClick={() => {
                  dismissMergePrompt(autoPromptPrimary.uid, activeUid);
                  setAutoPromptPrimary(null);
                  toast({
                    title: 'Troca rápida em 1 toque ativada!',
                    description: `Use os botões abaixo da sua foto para alternar entre @${autoPromptPrimary.username} e @${username}.`,
                  });
                }}
              >
                <ArrowLeftRight className="mr-2.5 h-4 w-4 shrink-0 text-primary" />
                <div className="min-w-0">
                  <p className="text-xs font-bold">
                    Manter ambas e alternar em 1 toque
                  </p>
                  <p className="text-[11px] text-muted-foreground truncate">
                    Troque entre @{autoPromptPrimary.username} e @{username} quando quiser
                  </p>
                </div>
              </Button>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Modal de Troca Rápida e Mapeamento de Contas no Aparelho */}
      <Dialog open={switcherOpen} onOpenChange={setSwitcherOpen}>
        <DialogContent className="max-w-md rounded-2xl border-border/80">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-base font-bold">
              <ArrowLeftRight className="h-5 w-5 text-primary" />
              Suas Contas neste Aparelho (P2P)
            </DialogTitle>
            <DialogDescription className="text-xs">
              Alterne em 1 toque entre suas contas locais, do Fediverso e da Atmosfera, ou unifique-as.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-2.5">
            {deviceAccounts.map((acc) => {
              const isCurrent = acc.uid === activeUid;
              return (
                <div
                  key={acc.uid}
                  className={cn(
                    'flex items-center justify-between gap-2 rounded-xl border p-2.5',
                    isCurrent ? 'border-primary/50 bg-primary/10' : 'border-border/70 bg-muted/20'
                  )}
                >
                  <div className="flex items-center gap-2.5 min-w-0">
                    <Avatar className="h-9 w-9 shrink-0">
                      <AvatarImage src={acc.avatarUrl} alt={acc.name} />
                      <AvatarFallback>{acc.name?.slice(0, 1) || '?'}</AvatarFallback>
                    </Avatar>
                    <div className="min-w-0">
                      <p className="text-xs font-bold text-foreground truncate">{acc.name}</p>
                      <p className="text-[11px] text-muted-foreground truncate">
                        @{acc.username}
                        {acc.federatedHandle ? ` · ${acc.federatedHandle}` : ''}
                      </p>
                    </div>
                  </div>

                  <div className="flex items-center gap-1 shrink-0">
                    {isCurrent ? (
                      <span className="inline-flex items-center gap-1 rounded-full bg-primary px-2.5 py-0.5 text-[10px] font-semibold text-primary-foreground">
                        <Check className="h-3 w-3" /> Ativa
                      </span>
                    ) : (
                      <>
                        <Button
                          size="sm"
                          variant="default"
                          disabled={busyUid !== null}
                          onClick={() => void handleSwitchAccount(acc)}
                          className="h-7 rounded-full px-2.5 text-xs"
                        >
                          {busyUid === acc.uid ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          ) : (
                            'Trocar'
                          )}
                        </Button>
                        {federatedLoginProvider && (
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={busyUid !== null}
                            onClick={() => void handleUnifyIntoPrimary(acc)}
                            title={`Unificar @${username} dentro de @${acc.username}`}
                            className="h-7 rounded-full px-2 text-xs"
                          >
                            <GitMerge className="h-3.5 w-3.5" />
                          </Button>
                        )}
                        <Button
                          size="icon"
                          variant="ghost"
                          onClick={() => {
                            removeDeviceSavedAccount(acc.uid);
                            setDeviceAccounts(getDeviceSavedAccounts());
                          }}
                          className="h-7 w-7 text-muted-foreground hover:text-destructive"
                          title="Remover deste aparelho"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </>
                    )}
                  </div>
                </div>
              );
            })}

            {otherDeviceAccounts.length === 0 && (
              <p className="text-xs text-muted-foreground text-center py-2">
                Apenas @{username} está conectada neste navegador no momento.
              </p>
            )}

            <div className="flex flex-col sm:flex-row gap-2 pt-2 border-t border-border/60">
              <Button
                asChild
                variant="outline"
                size="sm"
                className="flex-1 rounded-full text-xs"
                onClick={() => setSwitcherOpen(false)}
              >
                <Link href={`/${locale}/login?addAccount=1`}>
                  <Plus className="h-3.5 w-3.5 mr-1.5" />
                  Adicionar outra conta (Fedi / Bsky / Local)
                </Link>
              </Button>
              <Button
                asChild
                variant="ghost"
                size="sm"
                className="rounded-full text-xs"
                onClick={() => setSwitcherOpen(false)}
              >
                <Link href={`/${locale}/keys`}>Passaporte IDP2P</Link>
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
