// src/app/api/auth/fediverse/start/route.ts
// Inicia OAuth com uma instância Mastodon/Pleroma/Akkoma/GoToSocial para login/cadastro no HiperVerso.
import { createHash, randomBytes } from 'node:crypto';
import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { NextResponse } from 'next/server';
import { safeFetchText } from '@/lib/security/safe-fetch';
import { federation } from '@/lib/server/federation';
import { isFediverseDomainBlockedForLogin } from '@/lib/server/federatedAuth';
import { normalizeFederatedConsent } from '@/lib/server/federatedSync';
import { adminFirestore } from '@/lib/server/firebaseAdmin';
import { requestIp, takeRateLimit } from '@/lib/server/requestAuth';

export const dynamic = 'force-dynamic';

function extractInstanceDomain(raw: string): string | null {
  let cleaned = raw.trim().toLowerCase();
  if (!cleaned) return null;
  if (cleaned.startsWith('http://') || cleaned.startsWith('https://')) {
    try {
      cleaned = new URL(cleaned).hostname.toLowerCase();
    } catch {
      return null;
    }
  } else {
    if (cleaned.startsWith('@')) cleaned = cleaned.slice(1);
    if (cleaned.includes('@')) {
      cleaned = cleaned.split('@').pop() || '';
    }
    cleaned = cleaned.split('/')[0].split(':')[0];
  }
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(cleaned)) return null;
  return cleaned;
}

export async function POST(request: Request) {
  if (!takeRateLimit(`auth-fed-start:${requestIp(request)}`, 15, 5 * 60_000)) {
    return NextResponse.json({ message: 'Muitas tentativas. Aguarde alguns minutos.' }, { status: 429 });
  }

  const body = (await request.json().catch(() => ({}))) as { instance?: unknown; locale?: unknown; consent?: unknown };
  const consent = normalizeFederatedConsent(body.consent);
  const domain = extractInstanceDomain(String(body.instance ?? ''));
  if (!domain) {
    return NextResponse.json(
      { message: 'Informe um servidor válido (ex: mastodon.social ou @voce@mastodon.social).' },
      { status: 400 },
    );
  }

  const f = federation();
  if (await isFediverseDomainBlockedForLogin(domain)) {
    return NextResponse.json({ message: 'Este servidor do Fediverso não é permitido.' }, { status: 403 });
  }

  const redirectUri = `${f.origin}/api/auth/fediverse/callback`;
  const db = adminFirestore();
  const appRef = db.collection('fediverse_oauth_apps').doc(domain);
  const appSnap = await appRef.get();

  let clientId = '';
  let clientSecret = '';
  let registeredScopes = 'read:accounts';

  if (appSnap.exists) {
    const d = appSnap.data() as { clientId?: string; clientSecret?: string; redirectUri?: string; scopes?: string };
    if (d.clientId && d.clientSecret && d.redirectUri === redirectUri) {
      clientId = d.clientId;
      clientSecret = d.clientSecret;
      registeredScopes = d.scopes || 'read:accounts';
    }
  }

  if (!clientId || !clientSecret) {
    const appRes = await safeFetchText(`https://${domain}/api/v1/apps`, {
      method: 'POST',
      timeoutMs: 8000,
      maxBytes: 64_000,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'User-Agent': `HiperVerso/1.0 (+${f.origin})`,
      },
      body: JSON.stringify({
        client_name: 'HiperVerso',
        redirect_uris: redirectUri,
        scopes: 'read:accounts read:follows read:statuses',
        website: f.origin,
      }),
      allowedContentTypes: /^application\/json/i,
    }).catch(() => null);

    if (!appRes?.ok) {
      return NextResponse.json(
        { message: 'Não foi possível conectar com esse servidor do Fediverso. Verifique o endereço.' },
        { status: 502 },
      );
    }

    try {
      const parsed = JSON.parse(appRes.text) as { client_id?: string; client_secret?: string };
      if (!parsed.client_id || !parsed.client_secret) {
        return NextResponse.json({ message: 'Resposta inválida do servidor do Fediverso.' }, { status: 502 });
      }
      clientId = parsed.client_id;
      clientSecret = parsed.client_secret;
      await appRef.set({
        domain,
        clientId,
        clientSecret,
        redirectUri,
        scopes: 'read:accounts read:follows read:statuses',
        updatedAt: FieldValue.serverTimestamp(),
      });
      registeredScopes = 'read:accounts read:follows read:statuses';
    } catch {
      return NextResponse.json({ message: 'Resposta inválida do servidor do Fediverso.' }, { status: 502 });
    }
  }

  const locale = body.locale === 'en' ? 'en' : 'pt-BR';
  const state = randomBytes(24).toString('base64url');
  const stateHash = createHash('sha256').update(state).digest('hex');

  await db.collection('fediverse_auth_states').doc(stateHash).set({
    domain,
    locale,
    consent,
    expiresAt: Date.now() + 10 * 60_000,
    expireAt: Timestamp.fromMillis(Date.now() + 10 * 60_000),
    createdAt: FieldValue.serverTimestamp(),
  });

  const authUrl = new URL(`https://${domain}/oauth/authorize`);
  authUrl.searchParams.set('client_id', clientId);
  authUrl.searchParams.set('scope', registeredScopes);
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('state', state);

  return NextResponse.json({ url: authUrl.href });
}

