import { NextRequest } from 'next/server';
import { json, readJsonObject, requireCaller } from '@/lib/server/federation';
import { adminAuth, adminFirestore } from '@/lib/server/firebaseAdmin';
import { cleanupSocialData, getConnection } from '@/lib/server/socialStore';
import { getBlueskyOAuthClient } from '@/lib/server/blueskyOAuth';

export const dynamic = 'force-dynamic';

async function requireAdmin(request: NextRequest, key: string) {
  const caller = await requireCaller(request, key, 30);
  if (caller instanceof Response) return caller;
  const db = adminFirestore();
  const userSnap = await db.collection('users').doc(caller.uid).get();
  if (!userSnap.exists || userSnap.data()?.isAdmin !== true) {
    return json(403, { error: 'Apenas administradores podem remover usuários.' });
  }
  return { uid: caller.uid, db };
}

export async function DELETE(request: NextRequest) {
  const auth = await requireAdmin(request, 'admin-users-delete');
  if (auth instanceof Response) return auth;

  const body = await readJsonObject(request);
  if (!body) return json(400, { error: 'Corpo JSON inválido.' });

  const targetUserId = typeof body.targetUserId === 'string' ? body.targetUserId.trim() : '';
  if (!targetUserId) {
    return json(400, { error: 'targetUserId é obrigatório.' });
  }
  if (targetUserId === auth.uid) {
    return json(400, { error: 'Você não pode remover a própria conta por este painel.' });
  }
  if (targetUserId === 'adminUserSoberan') {
    return json(403, { error: 'Esta conta protegida não pode ser removida.' });
  }

  try {
    const targetRef = auth.db.collection('users').doc(targetUserId);
    const targetSnap = await targetRef.get();
    if (!targetSnap.exists) {
      return json(404, { error: 'Usuário não encontrado.' });
    }

    const targetData = targetSnap.data() ?? {};
    if (targetData.isAdmin === true) {
      return json(400, {
        error: 'Revogue o privilégio de administrador antes de remover este usuário.',
      });
    }

    const isExternalAccount = targetUserId.startsWith('ap_') || targetUserId.startsWith('bsky_');

    if (!isExternalAccount) {
      const bluesky = await getConnection(targetUserId, 'bluesky').catch(() => null);
      if (bluesky?.did) {
        await getBlueskyOAuthClient()
          .then((client) => client.revoke(bluesky.did!))
          .catch(() => undefined);
      }
      await cleanupSocialData(targetUserId).catch(() => undefined);

      try {
        await adminAuth().revokeRefreshTokens(targetUserId);
      } catch (err: unknown) {
        const code = (err as { code?: string })?.code;
        if (code !== 'auth/user-not-found') throw err;
      }

      try {
        await adminAuth().deleteUser(targetUserId);
      } catch (err: unknown) {
        const code = (err as { code?: string })?.code;
        if (code !== 'auth/user-not-found') throw err;
      }
    }

    const username = typeof targetData.username === 'string' ? targetData.username.trim().toLowerCase() : '';
    const batch = auth.db.batch();
    if (!isExternalAccount && username) {
      batch.delete(auth.db.collection('usernames').doc(username));
    }
    batch.delete(targetRef);
    await batch.commit();

    return json(200, { ok: true, deletedUserId: targetUserId });
  } catch (err) {
    console.error('[api/admin/users DELETE]', err);
    return json(500, { error: 'Não foi possível remover o usuário.' });
  }
}
