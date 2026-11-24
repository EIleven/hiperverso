// src/components/settings/HiperChatSettingsView.tsx
// As Configurações do HiperChat. A tela é dividida em DOIS blocos, e a divisão é o ponto:
//
//   1. "Sincronizado com sua conta" — muda quem você é na rede e vale em todos os aparelhos e também no HiperVerso.
//   2. "Só neste aparelho" — conforto de uso. Fica neste celular, não sai daqui e não altera a conta.
//
// Sem essa separação a pessoa não tem como saber se desligar a prévia esconde a mensagem no celular ou avisa o mundo. Cada
// bloco diz, na própria descrição, onde o que ela mexer vai valer.
//
// Nenhum link para fora: daqui não se vai para o feed, perfis, artigos ou explorar. O HiperChat é só mensagens.

'use client';

import React, { useEffect, useState } from 'react';
import ConfirmacaoDeLeituraSwitch from './ConfirmacaoDeLeituraSwitch';
import {
  Bell,
  CheckCircle2,
  Cloud,
  Fingerprint,
  KeyRound,
  ListFilter,
  Lock,
  LogOut,
  MessageSquare,
  Palette,
  Pin,
  Shield,
  Smartphone,
  Type,
  Users,
  Volume2,
} from 'lucide-react';
import { useTheme } from 'next-themes';
import { switchThemeFluid } from '@/lib/utils/fluidTheme';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Switch } from '@/components/ui/switch';
import { useToast } from '@/hooks/use-toast';
import { updateUserSettings } from '@/lib/services/userService';
import { getE2eeStatus, type IdentityStatus } from '@/lib/crypto/e2ee';
import { lerEscolha, salvarEscolha, temDigitalCadastrada } from '@/lib/seguranca/travaDeTela';
import { siteConfig } from '@/config/site';
import { handleDeExibicao, type HiperChatFilter, type HiperChatTextSize } from '@/lib/hiperchat/preferences';
import { useHiperChatPreferences } from '@/hooks/useHiperChatPreferences';
import type { User } from '@/lib/types';

type DmPreference = NonNullable<User['dmPreference']>;

interface HiperChatSettingsViewProps {
  user: User;
  onUpdated: () => Promise<void>;
  onLogout: () => Promise<void>;
}

const FILTROS: { id: HiperChatFilter; rotulo: string; Icone: typeof MessageSquare }[] = [
  { id: 'todas', rotulo: 'Conversas', Icone: MessageSquare },
  { id: 'grupos', rotulo: 'Grupos', Icone: Users },
  { id: 'fixadas', rotulo: 'Fixadas', Icone: Pin },
];

const TAMANHOS: { id: HiperChatTextSize; rotulo: string; classe: string }[] = [
  { id: 'pequeno', rotulo: 'Pequeno', classe: 'text-[13px]' },
  { id: 'normal', rotulo: 'Normal', classe: 'text-[14px]' },
  { id: 'grande', rotulo: 'Grande', classe: 'text-[17px]' },
];

const TEMAS = [
  { id: 'dark', rotulo: 'Escuro' },
  { id: 'light', rotulo: 'Claro' },
  { id: 'system', rotulo: 'Sistema' },
];

/** O que dizer sobre a criptografia, em português e sem jargão. */
function textoDaCripto(estado: IdentityStatus | null): { titulo: string; detalhe: string; ok: boolean } {
  if (!estado) return { titulo: 'Verificando…', detalhe: 'Checando a chave desta conta neste aparelho.', ok: false };
  if (estado.status === 'ready') {
    return {
      titulo: 'Mensagens protegidas neste aparelho',
      detalhe: 'A chave desta conta está aqui. Só este aparelho abre o que chega cifrado.',
      ok: true,
    };
  }
  if (estado.status === 'needs-restore') {
    return {
      titulo: 'Falta a chave neste aparelho',
      detalhe: 'Sua conta já tem uma chave, criada em outro aparelho. Restaure o backup para ler as mensagens cifradas.',
      ok: false,
    };
  }
  if (estado.status === 'storage-unavailable') {
    return {
      titulo: 'Armazenamento bloqueado',
      detalhe: 'Sem espaço para guardar a chave neste navegador (janela privada ou dados bloqueados).',
      ok: false,
    };
  }
  return {
    titulo: 'Este aparelho não cifra',
    detalhe: 'O navegador daqui não tem o recurso de criptografia que usamos.',
    ok: false,
  };
}

export default function HiperChatSettingsView({ user, onUpdated, onLogout }: HiperChatSettingsViewProps) {
  const { toast } = useToast();
  const { theme, setTheme } = useTheme();
  const { preferencias, salvar } = useHiperChatPreferences(user.id);
  const [dmPreference, setDmPreference] = useState<DmPreference>(user.dmPreference || 'everyone');
  const [savingDm, setSavingDm] = useState(false);
  const [cripto, setCripto] = useState<IdentityStatus | null>(null);

  // A trava das mensagens vive neste aparelho e depende da digital que a tela de Chaves cadastrou.
  const [travaLigada, setTravaLigada] = useState(false);
  const [podeTrancar, setPodeTrancar] = useState(false);

  useEffect(() => {
    if (!user?.id) return;
    const armazenamento = typeof window === 'undefined' ? null : window.localStorage;
    const temDigital = temDigitalCadastrada(armazenamento, user.id);
    setPodeTrancar(temDigital);
    setTravaLigada(temDigital && lerEscolha(armazenamento, user.id) !== false);
  }, [user?.id]);

  const mudarTrava = (ligada: boolean) => {
    if (!user?.id) return;
    salvarEscolha(typeof window === 'undefined' ? null : window.localStorage, user.id, ligada);
    setTravaLigada(ligada);
    toast({
      title: ligada ? 'Mensagens trancadas' : 'Trava desligada',
      description: ligada
        ? 'Vai pedir a digital para abrir as conversas neste aparelho.'
        : 'As conversas abrem direto neste aparelho.',
    });
  };

  useEffect(() => {
    setDmPreference(user.dmPreference || 'everyone');
  }, [user.dmPreference]);

  // Leitura do mesmo estado que o envio de mensagens já consulta (a resposta vem de cache por usuário).
  useEffect(() => {
    let vivo = true;
    void getE2eeStatus(user.id)
      .then((estado) => {
        if (vivo) setCripto(estado);
      })
      .catch(() => undefined);
    return () => {
      vivo = false;
    };
  }, [user.id]);

  const identidade = handleDeExibicao(user, siteConfig.federationHost);
  const deFora = Boolean(user.federatedLoginProvider);
  const estadoCripto = textoDaCripto(cripto);

  const handleDmChange = async (value: DmPreference) => {
    const anterior = dmPreference;
    setDmPreference(value);
    setSavingDm(true);
    try {
      await updateUserSettings(user.id, { dmPreference: value });
      await onUpdated();
      toast({
        title: 'Salvo na sua conta',
        description: 'Vale também no app HiperVerso e nos seus outros aparelhos.',
      });
    } catch {
      setDmPreference(anterior);
      toast({
        title: 'Erro ao salvar',
        description: 'Não foi possível atualizar sua preferência agora.',
        variant: 'destructive',
      });
    } finally {
      setSavingDm(false);
    }
  };

  return (
    <div className="mx-auto max-w-xl px-3 sm:px-4 py-6 space-y-4">
      {/* Quem está usando */}
      <Card className="rounded-2xl border-border/80">
        <CardContent className="pt-5 flex items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <Avatar className="h-12 w-12 border border-primary/30 shrink-0">
              <AvatarImage src={user.avatarUrl || undefined} alt={user.name} />
              <AvatarFallback>{(user.name || user.username || '?')[0]?.toUpperCase()}</AvatarFallback>
            </Avatar>
            <div className="min-w-0">
              <p className="truncate text-base font-bold">{user.name}</p>
              <p className="truncate text-xs text-muted-foreground">{identidade.handle}</p>
              {deFora && (
                <p className="truncate text-[11px] text-muted-foreground/80">
                  Sua casa é {identidade.origem} — é de lá que sua identidade vem.
                </p>
              )}
            </div>
          </div>
          <Badge variant="secondary" className="shrink-0 text-[11px]">
            HiperChat
          </Badge>
        </CardContent>
      </Card>

      {/* ───────── Bloco 1: a conta ───────── */}
      <div className="flex items-center gap-2 px-1 pt-1">
        <Cloud className="h-4 w-4 text-primary" />
        <h2 className="text-sm font-bold tracking-tight">Sincronizado com sua conta</h2>
      </div>
      <p className="-mt-2 px-1 text-xs text-muted-foreground">
        Vale em todos os seus aparelhos e também no app HiperVerso.
      </p>

      <Card className="rounded-2xl border-border/80">
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Shield className="h-4 w-4 text-primary" />
            Quem pode enviar mensagens
          </CardTitle>
          <CardDescription className="text-xs">
            Vale para contatos daqui e do Fediverso, em qualquer aparelho seu.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <RadioGroup
            value={dmPreference}
            onValueChange={(v) => void handleDmChange(v as DmPreference)}
            disabled={savingDm}
            className="space-y-2.5"
          >
            <label className="flex items-start gap-3 rounded-xl border border-border/70 p-3 cursor-pointer hover:bg-muted/30">
              <RadioGroupItem value="everyone" id="hc-dm-everyone" className="mt-0.5" />
              <div className="space-y-0.5">
                <Label htmlFor="hc-dm-everyone" className="text-sm font-medium cursor-pointer">
                  Qualquer pessoa
                </Label>
                <p className="text-xs text-muted-foreground">
                  Contatos locais e usuários do Fediverso podem iniciar conversa com você.
                </p>
              </div>
            </label>
            <label className="flex items-start gap-3 rounded-xl border border-border/70 p-3 cursor-pointer hover:bg-muted/30">
              <RadioGroupItem value="following" id="hc-dm-following" className="mt-0.5" />
              <div className="space-y-0.5">
                <Label htmlFor="hc-dm-following" className="text-sm font-medium cursor-pointer">
                  Apenas quem eu sigo
                </Label>
                <p className="text-xs text-muted-foreground">Bloqueia novas mensagens de desconhecidos.</p>
              </div>
            </label>
            <label className="flex items-start gap-3 rounded-xl border border-border/70 p-3 cursor-pointer hover:bg-muted/30">
              <RadioGroupItem value="none" id="hc-dm-none" className="mt-0.5" />
              <div className="space-y-0.5">
                <Label htmlFor="hc-dm-none" className="text-sm font-medium cursor-pointer">
                  Ninguém (pausar novas DMs)
                </Label>
                <p className="text-xs text-muted-foreground">
                  Mantém apenas conversas já existentes; ninguém pode abrir novos chats.
                </p>
              </div>
            </label>
          </RadioGroup>
        </CardContent>
      </Card>

      <Card className="rounded-2xl border-border/80">
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <KeyRound className="h-4 w-4 text-primary" />
            Chaves das mensagens
          </CardTitle>
          <CardDescription className="text-xs">
            A chave pública é da sua conta; a parte secreta nunca sai deste aparelho.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex items-start gap-2.5 rounded-xl border border-border/70 p-3">
            <Lock
              className={
                estadoCripto.ok ? 'mt-0.5 h-4 w-4 shrink-0 text-primary' : 'mt-0.5 h-4 w-4 shrink-0 text-muted-foreground'
              }
            />
            <div className="min-w-0">
              <p className="text-sm font-medium">{estadoCripto.titulo}</p>
              <p className="text-xs text-muted-foreground">{estadoCripto.detalhe}</p>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* ───────── Bloco 2: o aparelho ───────── */}
      <div className="flex items-center gap-2 px-1 pt-3">
        <Smartphone className="h-4 w-4 text-primary" />
        <h2 className="text-sm font-bold tracking-tight">Só neste aparelho</h2>
      </div>
      <p className="-mt-2 px-1 text-xs text-muted-foreground">
        Fica neste celular. Não sai daqui, não muda sua conta e ninguém mais vê.
      </p>

      <Card className="rounded-2xl border-border/80">
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Bell className="h-4 w-4 text-primary" />
            Avisos e lista
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-center justify-between gap-3 rounded-xl border border-border/70 p-3">
            <div className="flex items-center gap-2.5 min-w-0">
              <Volume2 className="h-4 w-4 shrink-0 text-muted-foreground" />
              <div className="min-w-0">
                <p className="text-sm font-medium">Sons de mensagens</p>
                <p className="text-xs text-muted-foreground">Tocar alerta ao receber novas mensagens</p>
              </div>
            </div>
            <Switch
              checked={preferencias.som}
              onCheckedChange={(v) => salvar({ som: v })}
              aria-label="Sons de mensagens"
            />
          </div>

          <div className="flex items-center justify-between gap-3 rounded-xl border border-border/70 p-3">
            <div className="flex items-center gap-2.5 min-w-0">
              <MessageSquare className="h-4 w-4 shrink-0 text-muted-foreground" />
              <div className="min-w-0">
                <p className="text-sm font-medium">Prévia na lista</p>
                <p className="text-xs text-muted-foreground">Exibir trecho da última mensagem nas conversas</p>
              </div>
            </div>
            <Switch
              checked={preferencias.previa}
              onCheckedChange={(v) => salvar({ previa: v })}
              aria-label="Prévia na lista"
            />
          </div>

          <div className="flex items-center justify-between gap-3 rounded-xl border border-border/70 p-3">
            <div className="flex items-center gap-2.5 min-w-0">
              <Fingerprint className="h-4 w-4 shrink-0 text-muted-foreground" />
              <div className="min-w-0">
                <p className="text-sm font-medium">Pedir digital para abrir</p>
                <p className="text-xs text-muted-foreground">
                  {podeTrancar
                    ? 'Quem pegar este aparelho não lê suas conversas'
                    : 'Cadastre a digital nas Chaves do HiperVerso para usar isto'}
                </p>
              </div>
            </div>
            <Switch
              checked={travaLigada}
              disabled={!podeTrancar}
              onCheckedChange={mudarTrava}
              aria-label="Pedir digital para abrir as mensagens"
            />
          </div>

          <ConfirmacaoDeLeituraSwitch userId={user.id} />
        </CardContent>
      </Card>

      <Card className="rounded-2xl border-border/80">
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <ListFilter className="h-4 w-4 text-primary" />
            Abrir o HiperChat em
          </CardTitle>
          <CardDescription className="text-xs">Qual aba aparece quando você abre o app.</CardDescription>
        </CardHeader>
        <CardContent className="grid grid-cols-3 gap-2">
          {FILTROS.map(({ id, rotulo, Icone }) => (
            <Button
              key={id}
              type="button"
              variant={preferencias.filtroInicial === id ? 'default' : 'outline'}
              size="sm"
              onClick={() => salvar({ filtroInicial: id })}
              aria-pressed={preferencias.filtroInicial === id}
              className="h-auto flex-col gap-1 rounded-xl py-2.5"
            >
              <Icone className="h-4 w-4" />
              <span className="text-xs">{rotulo}</span>
            </Button>
          ))}
        </CardContent>
      </Card>

      <Card className="rounded-2xl border-border/80">
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Type className="h-4 w-4 text-primary" />
            Tamanho do texto
          </CardTitle>
          <CardDescription className="text-xs">Vale para as mensagens e a lista de conversas.</CardDescription>
        </CardHeader>
        <CardContent className="grid grid-cols-3 gap-2">
          {TAMANHOS.map(({ id, rotulo, classe }) => (
            <Button
              key={id}
              type="button"
              variant={preferencias.tamanhoDoTexto === id ? 'default' : 'outline'}
              size="sm"
              onClick={() => salvar({ tamanhoDoTexto: id })}
              aria-pressed={preferencias.tamanhoDoTexto === id}
              className="h-auto flex-col gap-0.5 rounded-xl py-2.5"
            >
              <span className={classe}>Aa</span>
              <span className="text-xs">{rotulo}</span>
            </Button>
          ))}
        </CardContent>
      </Card>

      <Card className="rounded-2xl border-border/80">
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Palette className="h-4 w-4 text-primary" />
            Aparência
          </CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-3 gap-2">
          {TEMAS.map(({ id, rotulo }) => (
            <Button
              key={id}
              type="button"
              variant={theme === id ? 'default' : 'outline'}
              size="sm"
              onClick={() => switchThemeFluid(setTheme, id)}
              aria-pressed={theme === id}
              className="rounded-xl"
            >
              {rotulo}
            </Button>
          ))}
        </CardContent>
      </Card>

      <Card className="rounded-2xl border-border/80">
        <CardContent className="pt-5 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2.5 text-xs text-muted-foreground min-w-0">
            <Lock className="h-4 w-4 shrink-0 text-primary" />
            <span className="truncate">
              {deFora ? `Sessão de ${identidade.origem} · HiperChat` : 'Sessão da sua conta · HiperChat'}
            </span>
          </div>
          <Button
            type="button"
            variant="destructive"
            size="sm"
            onClick={() => void onLogout()}
            className="rounded-full shrink-0"
          >
            <LogOut className="mr-1.5 h-3.5 w-3.5" />
            Sair
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
