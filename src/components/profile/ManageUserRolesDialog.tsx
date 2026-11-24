// src/components/profile/ManageUserRolesDialog.tsx
'use client';
import React, { useState, useEffect } from 'react';
import type { User } from '@/lib/types';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Loader2, ShieldCheck, Shield, Trash2 } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { useToast } from '@/hooks/use-toast';
import { useCurrentUser } from '@/contexts/CurrentUserContext';

interface ManageUserRolesDialogProps {
  user: User;
  onOpenChange: (open: boolean) => void;
  onUserUpdated: (user: Partial<User>) => void;
  onUserDeleted?: (userId: string) => void;
}

export default function ManageUserRolesDialog({
  user,
  onOpenChange,
  onUserUpdated,
  onUserDeleted,
}: ManageUserRolesDialogProps) {
  const [isAdmin, setIsAdmin] = useState(user.isAdmin || false);
  const [isModerator, setIsModerator] = useState(user.isModerator || false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [confirmUsername, setConfirmUsername] = useState('');
  const [isDeleting, setIsDeleting] = useState(false);
  const { toast } = useToast();
  const { firebaseUser } = useCurrentUser();

  useEffect(() => {
    setIsAdmin(Boolean(user.isAdmin));
    setIsModerator(Boolean(user.isModerator));
    setConfirmingDelete(false);
    setConfirmUsername('');
  }, [user.id, user.isAdmin, user.isModerator]);

  const hasChanges = isAdmin !== Boolean(user.isAdmin) || isModerator !== Boolean(user.isModerator);
  const isExternalAccount = user.id.startsWith('ap_') || user.id.startsWith('bsky_');
  const isSelf = firebaseUser?.uid === user.id;
  const isProtectedAdmin = Boolean(user.isAdmin);
  const canDelete = !isSelf && !isProtectedAdmin && !isSubmitting && !isDeleting;
  const normalizedExpected = user.username.trim().toLowerCase();
  const isConfirmMatch =
    normalizedExpected.length > 0 && confirmUsername.trim().replace(/^@/, '').toLowerCase() === normalizedExpected;

  const handleSave = async () => {
    if (!firebaseUser) {
      toast({ title: 'Sessão inválida', description: 'Faça login novamente.', variant: 'destructive' });
      return;
    }
    setIsSubmitting(true);
    try {
      const token = await firebaseUser.getIdToken();
      const res = await fetch('/api/admin/roles', {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          targetUserId: user.id,
          isAdmin,
          isModerator,
        }),
      });
      const json = (await res.json().catch(() => null)) as { error?: string; user?: Partial<User> } | null;
      if (!res.ok) {
        throw new Error(json?.error || 'Falha ao atualizar as funções do usuário.');
      }
      toast({ title: 'Funções Atualizadas', description: `As funções para @${user.username} foram salvas.` });
      onUserUpdated({ id: user.id, isAdmin, isModerator });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Falha ao atualizar as funções do usuário.';
      toast({ title: 'Erro', description: message, variant: 'destructive' });
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleDeleteUser = async () => {
    if (!firebaseUser) {
      toast({ title: 'Sessão inválida', description: 'Faça login novamente.', variant: 'destructive' });
      return;
    }
    if (!isConfirmMatch) return;

    setIsDeleting(true);
    try {
      const token = await firebaseUser.getIdToken();
      const res = await fetch('/api/admin/users', {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ targetUserId: user.id }),
      });
      const json = (await res.json().catch(() => null)) as { error?: string } | null;
      if (!res.ok) {
        throw new Error(json?.error || 'Falha ao remover o usuário.');
      }
      toast({
        title: 'Usuário Removido',
        description: `A conta @${user.username} foi removida permanentemente.`,
      });
      onUserDeleted?.(user.id);
      onOpenChange(false);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Falha ao remover o usuário.';
      toast({ title: 'Erro', description: message, variant: 'destructive' });
    } finally {
      setIsDeleting(false);
    }
  };

  return (
    <Dialog open={true} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Gerenciar Funções para @{user.username}</DialogTitle>
          <DialogDescription>
            Atribua ou revogue privilégios administrativos e de moderação. As alterações entram em vigor imediatamente.
          </DialogDescription>
        </DialogHeader>
        <div className="py-4 space-y-4">
          {isExternalAccount && (
            <p className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
              Contas externas federadas não podem receber cargos administrativos locais no HiperVerso.
            </p>
          )}
          <div className="flex items-center justify-between rounded-lg border p-4">
            <div className="space-y-0.5">
              <Label htmlFor="admin-switch" className="text-base flex items-center"><ShieldCheck className="mr-2 h-4 w-4 text-destructive" /> Administrador</Label>
              <p className="text-sm text-muted-foreground">Concede acesso total a todos os painéis e recursos de administração.</p>
            </div>
            <Switch id="admin-switch" checked={isAdmin} onCheckedChange={setIsAdmin} disabled={isExternalAccount || isDeleting} />
          </div>
          <div className="flex items-center justify-between rounded-lg border p-4">
            <div className="space-y-0.5">
              <Label htmlFor="moderator-switch" className="text-base flex items-center"><Shield className="mr-2 h-4 w-4 text-primary" /> Moderador</Label>
              <p className="text-sm text-muted-foreground">Concede acesso às ferramentas de moderação de conteúdo.</p>
            </div>
            <Switch id="moderator-switch" checked={isModerator} onCheckedChange={setIsModerator} disabled={isExternalAccount || isDeleting} />
          </div>

          <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-4 space-y-3">
            <div className="flex items-start justify-between gap-3">
              <div className="space-y-0.5">
                <p className="text-sm font-semibold text-destructive flex items-center">
                  <Trash2 className="mr-2 h-4 w-4" />
                  Remover Usuário
                </p>
                <p className="text-xs text-muted-foreground">
                  {isSelf
                    ? 'Você não pode remover a própria conta por este painel.'
                    : isProtectedAdmin
                      ? 'Revogue o cargo de administrador antes de remover esta conta.'
                      : `Exclui permanentemente a conta @${user.username} e revoga o acesso imediatamente.`}
                </p>
              </div>
              {!confirmingDelete && (
                <Button
                  type="button"
                  variant="destructive"
                  size="sm"
                  disabled={!canDelete}
                  onClick={() => setConfirmingDelete(true)}
                >
                  Remover
                </Button>
              )}
            </div>

            {confirmingDelete && (
              <div className="space-y-2.5 pt-1 border-t border-destructive/20">
                <Label htmlFor="confirm-delete-username" className="text-xs text-muted-foreground block">
                  Digite <span className="font-mono font-semibold text-foreground">{user.username}</span> para confirmar a remoção permanente:
                </Label>
                <Input
                  id="confirm-delete-username"
                  value={confirmUsername}
                  onChange={(e) => setConfirmUsername(e.target.value)}
                  placeholder={user.username}
                  disabled={isDeleting}
                  autoComplete="off"
                />
                <div className="flex items-center justify-end gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={isDeleting}
                    onClick={() => {
                      setConfirmingDelete(false);
                      setConfirmUsername('');
                    }}
                  >
                    Cancelar
                  </Button>
                  <Button
                    type="button"
                    variant="destructive"
                    size="sm"
                    disabled={!isConfirmMatch || isDeleting}
                    onClick={handleDeleteUser}
                  >
                    {isDeleting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                    Confirmar Remoção
                  </Button>
                </div>
              </div>
            )}
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isDeleting}>Cancelar</Button>
          <Button onClick={handleSave} disabled={!hasChanges || isSubmitting || isExternalAccount || isDeleting}>
            {isSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Salvar Alterações
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
