'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { Globe, Loader2, Play, RefreshCw, ShieldAlert, Trash2 } from 'lucide-react';
import { useCurrentUser } from '@/contexts/CurrentUserContext';
import { useToast } from '@/hooks/use-toast';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { invalidateFederationAvailability } from '@/lib/federation/useFederationAvailability';
import type { AdminOverview } from '@/lib/activitypub/admin';
import type { InstanceAction } from '@/lib/activitypub/gate';

const RULE_LABELS: Record<InstanceAction, { label: string; variant: 'secondary' | 'outline' | 'destructive' }> = {
  allow: { label: 'Permitida', variant: 'secondary' },
  silence: { label: 'Silenciada', variant: 'outline' },
  suspend: { label: 'Suspensa', variant: 'destructive' },
};

type BlockedDomainEntry = {
  domain: string;
  deadCount: number;
  lastError: string | null;
  likelyBlocked: boolean;
};

type LinhaDeSaude = {
  domain: string;
  recusas: number;
  pausaAte: number | null;
  falhas: number;
  semDns: boolean;
  ultimaFalhaMs: number;
};

type FediverseOverviewWithFailures = AdminOverview & {
  blockedOrFailingDomains?: BlockedDomainEntry[];
  saudeDosDominios?: { recusando: LinhaDeSaude[]; mortos: LinhaDeSaude[] };
};

type ResumoDaPurga = {
  domains: string[];
  counts: Record<string, number>;
  falhas: { passo: string; erro: string }[];
  completo: boolean;
};

const ROTULOS_DA_PURGA: Record<string, string> = {
  users: 'perfis',
  posts: 'posts',
  comments: 'comentários',
  ap_remote_comments: 'comentários remotos',
  ap_remote_actors: 'atores em cache',
  ap_followers: 'seguidores',
  ap_following: 'seguindo',
  ap_handles: 'handles',
  fontes: 'fontes',
  ap_deliveries: 'entregas na fila',
};

const resumoDaContagem = (counts: Record<string, number>) =>
  Object.entries(counts)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${n} ${ROTULOS_DA_PURGA[k] ?? k}`)
    .join(', ');

export default function FediverseAdminPanel() {
  const { firebaseUser } = useCurrentUser();
  const { toast } = useToast();
  const [overview, setOverview] = useState<FediverseOverviewWithFailures | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [domainInput, setDomainInput] = useState('');
  const [ruleAction, setRuleAction] = useState<InstanceAction>('suspend');

  const authFetch = useCallback(
    async (init?: RequestInit) => {
      if (!firebaseUser) throw new Error('not-authenticated');
      const token = await firebaseUser.getIdToken();
      const headers = new Headers(init?.headers);
      headers.set('Authorization', `Bearer ${token}`);
      if (init?.body && !headers.has('Content-Type')) {
        headers.set('Content-Type', 'application/json');
      }
      const res = await fetch('/api/ap/admin', { ...init, headers, cache: 'no-store' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(typeof data?.error === 'string' ? data.error : `http-${res.status}`);
      }
      return data;
    },
    [firebaseUser],
  );

  const loadOverview = useCallback(async () => {
    if (!firebaseUser) return;
    setLoading(true);
    try {
      const data = (await authFetch()) as FediverseOverviewWithFailures;
      setOverview(data);
    } catch (err) {
      toast({
        title: 'Erro ao carregar painel do Fediverso',
        description: err instanceof Error ? err.message : 'Tente novamente.',
        variant: 'destructive',
      });
    } finally {
      setLoading(false);
    }
  }, [firebaseUser, authFetch, toast]);

  useEffect(() => {
    void loadOverview();
  }, [loadOverview]);

  const updatePlatform = async (patch: { enabled?: boolean; killSwitch?: boolean; mode?: 'open' | 'allowlist' }) => {
    setBusy('platform');
    try {
      await authFetch({
        method: 'POST',
        body: JSON.stringify({ action: 'platform', ...patch }),
      });
      invalidateFederationAvailability();
      toast({ title: 'Configuração do Fediverso atualizada.' });
      await loadOverview();
    } catch (err) {
      toast({
        title: 'Falha ao atualizar Fediverso',
        description: err instanceof Error ? err.message : 'Erro desconhecido.',
        variant: 'destructive',
      });
    } finally {
      setBusy(null);
    }
  };

  /**
   * Suspender + purgar em dois tempos: primeiro o ENSAIO (o servidor conta o que sairia sem tocar em nada), depois a
   * confirmação com os números na frente de quem decide. Remoção física não tem volta.
   */
  const handleSuspendAndPurge = async (domain: string) => {
    const clean = domain.trim().toLowerCase();
    if (!clean) return;
    setBusy(`purge:${clean}`);
    try {
      const ensaio = (await authFetch({
        method: 'POST',
        body: JSON.stringify({ action: 'suspend-and-purge', domain: clean }),
      })) as ResumoDaPurga;
      const total = Object.values(ensaio.counts || {}).reduce((a, n) => a + (Number(n) || 0), 0);
      const detalhe = resumoDaContagem(ensaio.counts || {}) || 'nenhum registro guardado';
      const ok = window.confirm(
        `Suspender ${clean} e apagar ${total} registro(s) dele?\n\n${detalhe}.\n\nA federação com esse domínio para na hora. A remoção não pode ser desfeita.`,
      );
      if (!ok) return;
      const feito = (await authFetch({
        method: 'POST',
        body: JSON.stringify({ action: 'suspend-and-purge', domain: clean, confirmar: true }),
      })) as ResumoDaPurga;
      toast({
        title: feito.completo ? `${clean} suspenso e purgado.` : `${clean} suspenso; a purga NÃO terminou.`,
        description: feito.completo
          ? resumoDaContagem(feito.counts || {}) || 'Nada a remover.'
          : `Falhou: ${feito.falhas.map((f) => f.passo).join(', ')}. Rode de novo para completar.`,
        variant: feito.completo ? undefined : 'destructive',
      });
      await loadOverview();
    } catch (err) {
      toast({
        title: 'Falha ao suspender e purgar',
        description: err instanceof Error ? err.message : 'Erro desconhecido.',
        variant: 'destructive',
      });
    } finally {
      setBusy(null);
    }
  };

  const handleSetRule = async (domain: string, rule: InstanceAction | null) => {
    const clean = domain.trim().toLowerCase();
    if (!clean) return;
    setBusy(`rule:${clean}`);
    try {
      await authFetch({
        method: 'POST',
        body: JSON.stringify({ action: 'instance', domain: clean, rule }),
      });
      if (rule !== null) setDomainInput('');
      toast({ title: rule === null ? `Regra removida para ${clean}.` : `Regra aplicada em ${clean}.` });
      await loadOverview();
    } catch (err) {
      toast({
        title: 'Falha ao atualizar regra de instância',
        description: err instanceof Error ? err.message : 'Erro desconhecido.',
        variant: 'destructive',
      });
    } finally {
      setBusy(null);
    }
  };

  const handleRunWorker = async () => {
    setBusy('worker');
    try {
      const res = (await authFetch({
        method: 'POST',
        body: JSON.stringify({ action: 'run-worker' }),
      })) as { ok: true; stats?: { jobs?: number; deliveries?: number; sent?: number; failed?: number } };
      toast({
        title: 'Fila do Fediverso processada',
        description: res.stats
          ? `Tarefas: ${res.stats.jobs ?? 0} · Entregas: ${res.stats.deliveries ?? 0} · Enviadas: ${res.stats.sent ?? 0}`
          : undefined,
      });
      await loadOverview();
    } catch (err) {
      toast({
        title: 'Erro ao processar fila',
        description: err instanceof Error ? err.message : 'Verifique se AP_MASTER_KEY está configurada.',
        variant: 'destructive',
      });
    } finally {
      setBusy(null);
    }
  };

  if (loading && !overview) {
    return (
      <div className="flex min-h-56 items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!overview) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center justify-center gap-3 py-10">
          <p className="text-sm text-muted-foreground">Não foi possível carregar o estado do Fediverso.</p>
          <Button variant="outline" size="sm" onClick={() => void loadOverview()}>
            Tentar novamente
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Globe className="h-5 w-5 text-primary" />
              Fediverso (ActivityPub)
            </CardTitle>
            <CardDescription>
              Controle global da federação com Mastodon, Misskey, Pleroma e demais servidores ActivityPub.
            </CardDescription>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" disabled={busy !== null} onClick={() => void loadOverview()}>
              <RefreshCw className="mr-2 h-4 w-4" />
              Atualizar
            </Button>
            <Button size="sm" disabled={busy !== null} onClick={() => void handleRunWorker()}>
              {busy === 'worker' ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Play className="mr-2 h-4 w-4" />}
              Processar fila agora
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between gap-4 rounded-lg border p-4">
            <div className="space-y-0.5">
              <Label htmlFor="ap-enabled" className="text-base font-medium">
                Federação da plataforma
              </Label>
              <p className="text-xs text-muted-foreground">
                Quando ligada, usuários com e-mail verificado podem ativar seu endereço @usuario@hiperverso.social.
              </p>
            </div>
            <Switch
              id="ap-enabled"
              checked={overview.platform.enabled}
              disabled={busy !== null}
              onCheckedChange={(checked) => void updatePlatform({ enabled: checked })}
            />
          </div>

          <div className="flex items-center justify-between gap-4 rounded-lg border border-destructive/30 p-4">
            <div className="space-y-0.5">
              <Label htmlFor="ap-killswitch" className="flex items-center gap-2 text-base font-medium text-destructive">
                <ShieldAlert className="h-4 w-4" />
                Botão de emergência (Kill Switch)
              </Label>
              <p className="text-xs text-muted-foreground">
                Interrompe imediatamente toda entrada e saída do Fediverso sem apagar configurações das contas.
              </p>
            </div>
            <Switch
              id="ap-killswitch"
              checked={Boolean(overview.platform.killSwitch)}
              disabled={busy !== null}
              onCheckedChange={(checked) => void updatePlatform({ killSwitch: checked })}
            />
          </div>

          <div className="flex flex-col gap-2 rounded-lg border p-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="space-y-0.5">
              <Label className="text-base font-medium">Modo de comunicação entre servidores</Label>
              <p className="text-xs text-muted-foreground">
                Aberto aceita qualquer instância não suspensa; Lista permitida restringe às instâncias aprovadas.
              </p>
            </div>
            <Select
              value={overview.platform.mode}
              disabled={busy !== null}
              onValueChange={(value: 'open' | 'allowlist') => void updatePlatform({ mode: value })}
            >
              <SelectTrigger className="w-full sm:w-52">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="open">Aberto (Open)</SelectItem>
                <SelectItem value="allowlist">Lista permitida (Allowlist)</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-4 grid-cols-2 sm:grid-cols-5">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-xs font-medium text-muted-foreground">Contas Federadas</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{overview.counts.accounts}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-xs font-medium text-muted-foreground">Objetos Públicos</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{overview.counts.publicObjects}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-xs font-medium text-muted-foreground">Tarefas na Fila</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{overview.queue.jobs}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-xs font-medium text-muted-foreground">Entregas Pendentes</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{overview.queue.deliveries}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-xs font-medium text-muted-foreground">Entregas Falhas (Dead)</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-destructive">{overview.queue.dead}</div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Contadores de Hoje (UTC)</CardTitle>
          <CardDescription>
            Eventos de entrada, saída e recusas registrados hoje no Fediverso.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {Object.keys(overview.counters.today).length === 0 ? (
            <p className="text-sm text-muted-foreground">Nenhum evento registrado hoje.</p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {Object.entries(overview.counters.today)
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([key, val]) => (
                  <Badge key={key} variant={key.includes('recusada') || key.includes('falha') ? 'destructive' : 'secondary'} className="font-mono text-xs">
                    {key}: {val}
                  </Badge>
                ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Regras por Instância</CardTitle>
          <CardDescription>
            Permita, silencie ou suspenda domínios remotos do Fediverso.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input
              placeholder="Ex: mastodon.social"
              value={domainInput}
              onChange={(e) => setDomainInput(e.target.value)}
              disabled={busy !== null}
              className="flex-1"
            />
            <Select value={ruleAction} onValueChange={(v: InstanceAction) => setRuleAction(v)} disabled={busy !== null}>
              <SelectTrigger className="w-full sm:w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="allow">Permitir</SelectItem>
                <SelectItem value="silence">Silenciar</SelectItem>
                <SelectItem value="suspend">Suspender</SelectItem>
              </SelectContent>
            </Select>
            <Button
              disabled={busy !== null || !domainInput.trim()}
              onClick={() => void handleSetRule(domainInput, ruleAction)}
            >
              Aplicar regra
            </Button>
          </div>

          {overview.rules.length === 0 ? (
            <p className="py-4 text-center text-sm text-muted-foreground">
              Nenhuma regra de instância configurada.
            </p>
          ) : (
            <ul className="divide-y rounded-md border">
              {overview.rules.map((r) => (
                <li key={r.domain} className="flex items-center justify-between gap-3 p-3">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="truncate font-mono text-sm">{r.domain}</span>
                    <Badge variant={RULE_LABELS[r.action].variant}>{RULE_LABELS[r.action].label}</Badge>
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    disabled={busy !== null}
                    onClick={() => void handleSetRule(r.domain, null)}
                    title="Remover regra"
                  >
                    <Trash2 className="h-4 w-4 text-muted-foreground" />
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ShieldAlert className="h-4 w-4 text-destructive" />
            Instâncias com Falha ou Bloqueio (Entregas Dead)
          </CardTitle>
          <CardDescription>
            Domínios que retornaram erro definitivo nas últimas entregas (`ap_deliveries`), como HTTP 403/410 ou falha de rede.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {!overview.blockedOrFailingDomains || overview.blockedOrFailingDomains.length === 0 ? (
            <p className="py-4 text-center text-sm text-muted-foreground">
              Nenhum domínio com entregas dead registradas no momento.
            </p>
          ) : (
            <ul className="divide-y rounded-md border">
              {overview.blockedOrFailingDomains.map((item) => (
                <li key={item.domain} className="flex flex-col gap-2 p-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0 space-y-0.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="truncate font-mono text-sm font-medium">{item.domain}</span>
                      <Badge variant={item.likelyBlocked ? 'destructive' : 'outline'} className="text-[10px]">
                        {item.likelyBlocked ? 'Possível bloqueio (401/403/410)' : 'Falha de entrega'}
                      </Badge>
                      <Badge variant="secondary" className="text-[10px]">
                        {item.deadCount} {item.deadCount === 1 ? 'falha' : 'falhas'}
                      </Badge>
                    </div>
                    {item.lastError && (
                      <p className="truncate text-xs text-muted-foreground">{item.lastError}</p>
                    )}
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5">
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={busy !== null}
                      onClick={() => void handleSetRule(item.domain, 'silence')}
                    >
                      Silenciar
                    </Button>
                    <Button
                      variant="destructive"
                      size="sm"
                      disabled={busy !== null}
                      onClick={() => void handleSetRule(item.domain, 'suspend')}
                    >
                      Suspender
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Trash2 className="h-4 w-4 text-destructive" />
            Domínios que nos recusam ou sumiram
          </CardTitle>
          <CardDescription>
            Recusa (403) pausa a entrega e a leitura sozinha, com prazo. Suspender é decisão sua: o botão primeiro mostra
            quanto seria apagado.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {(['recusando', 'mortos'] as const).map((grupo) => {
            const linhas = overview.saudeDosDominios?.[grupo] ?? [];
            return (
              <div key={grupo} className="space-y-2">
                <p className="text-xs font-medium text-muted-foreground">
                  {grupo === 'recusando' ? 'Recusando (403)' : 'Mortos (falha repetida)'} · {linhas.length}
                </p>
                {linhas.length === 0 ? (
                  <p className="text-sm text-muted-foreground">Nenhum.</p>
                ) : (
                  <ul className="divide-y rounded-md border">
                    {linhas.map((l) => (
                      <li key={`${grupo}:${l.domain}`} className="flex flex-col gap-2 p-3 sm:flex-row sm:items-center sm:justify-between">
                        <div className="flex min-w-0 flex-wrap items-center gap-2">
                          <span className="truncate font-mono text-sm font-medium">{l.domain}</span>
                          {grupo === 'recusando' ? (
                            <>
                              <Badge variant="secondary" className="text-[10px]">{l.recusas} recusa(s) seguida(s)</Badge>
                              {l.pausaAte !== null && (
                                <Badge variant="destructive" className="text-[10px]">
                                  em pausa até {new Date(l.pausaAte).toLocaleDateString('pt-BR')}
                                </Badge>
                              )}
                            </>
                          ) : (
                            <>
                              <Badge variant="secondary" className="text-[10px]">{l.falhas} falhas seguidas</Badge>
                              {l.semDns && <Badge variant="destructive" className="text-[10px]">DNS não resolve</Badge>}
                            </>
                          )}
                        </div>
                        <Button
                          variant="destructive"
                          size="sm"
                          className="shrink-0"
                          disabled={busy !== null}
                          onClick={() => void handleSuspendAndPurge(l.domain)}
                        >
                          {busy === `purge:${l.domain}` ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : 'Suspender + purgar'}
                        </Button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            );
          })}
        </CardContent>
      </Card>
    </div>
  );
}

