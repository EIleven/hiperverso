// src/app/api/auth/fediverse/callback/route.ts
import { createHash } from 'node:crypto';
import { NextResponse } from 'next/server';
import { loginErrorUrl } from '@/lib/auth/loginErrors';
import { safeFetchText } from '@/lib/security/safe-fetch';
import { federation } from '@/lib/server/federation';
import {
  createLoginTicket,
  FederatedSignupClosedError,
  isFediverseDomainBlockedForLogin,
  provisionOrLoginFederatedUser,
} from '@/lib/server/federatedAuth';
import { normalizeFederatedConsent, syncMastodonData, type FederatedSyncConsent } from '@/lib/server/federatedSync';
import { adminFirestore } from '@/lib/server/firebaseAdmin';
import { stripHtml } from '@/lib/server/remoteProfile';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const f = federation();
  let locale = 'pt-BR';
  const reqUrl = new URL(request.url);
  const code = reqUrl.searchParams.get('code') ?? '';
  const state = reqUrl.searchParams.get('state') ?? '';

  if (!code || !state) {
    return NextResponse.redirect(`${f.origin}/${locale}/login?auth_error=fediverse_missing_params`);
  }

  try {
    const db = adminFirestore();
    const stateHash = createHash('sha256').update(state).digest('hex');
    const stateRef = db.collection('fediverse_auth_states').doc(stateHash);
    const stateData = await db.runTransaction(async (tx) => {
      const snap = await tx.get(stateRef);
      if (!snap.exists) return null;
      tx.delete(stateRef);
      const d = snap.data() as { domain?: string; locale?: string; expiresAt?: number; consent?: FederatedSyncConsent };
      if (!d.domain || (d.expiresAt ?? 0) < Date.now()) return null;
      return d;
    });

    if (!stateData?.domain) {
      return NextResponse.redirect(`${f.origin}/${locale}/login?auth_error=fediverse_invalid_state`);
    }
    locale = stateData.locale === 'en' ? 'en' : 'pt-BR';
    const domain = stateData.domain;

    if (await isFediverseDomainBlockedForLogin(domain)) {
      return NextResponse.redirect(`${f.origin}/${locale}/login?auth_error=fediverse_domain_blocked`);
    }

    const appSnap = await db.collection('fediverse_oauth_apps').doc(domain).get();
    const appData = appSnap.data() as { clientId?: string; clientSecret?: string; redirectUri?: string } | undefined;
    if (!appData?.clientId || !appData?.clientSecret || !appData?.redirectUri) {
      return NextResponse.redirect(`${f.origin}/${locale}/login?auth_error=fediverse_app_missing`);
    }

    const tokenRes = await safeFetchText(`https://${domain}/oauth/token`, {
      method: 'POST',
      timeoutMs: 8000,
      maxBytes: 64_000,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'User-Agent': `HiperVerso/1.0 (+${f.origin})`,
      },
      body: JSON.stringify({
        client_id: appData.clientId,
        client_secret: appData.clientSecret,
        redirect_uri: appData.redirectUri,
        grant_type: 'authorization_code',
        code,
        scope: 'read:accounts',
      }),
      allowedContentTypes: /^application\/json/i,
    });

    if (!tokenRes.ok) {
      return NextResponse.redirect(`${f.origin}/${locale}/login?auth_error=fediverse_token_failed`);
    }

    const tokenJson = JSON.parse(tokenRes.text) as { access_token?: string };
    if (!tokenJson.access_token) {
      return NextResponse.redirect(`${f.origin}/${locale}/login?auth_error=fediverse_token_failed`);
    }

    const verifyRes = await safeFetchText(`https://${domain}/api/v1/accounts/verify_credentials`, {
      timeoutMs: 8000,
      maxBytes: 128_000,
      headers: {
        Authorization: `Bearer ${tokenJson.access_token}`,
        Accept: 'application/json',
        'User-Agent': `HiperVerso/1.0 (+${f.origin})`,
      },
      allowedContentTypes: /^application\/json/i,
    });

    if (!verifyRes.ok) {
      return NextResponse.redirect(`${f.origin}/${locale}/login?auth_error=fediverse_profile_failed`);
    }

    const acct = JSON.parse(verifyRes.text) as {
      id?: string;
      username?: string;
      display_name?: string;
      note?: string;
      avatar?: string;
      header?: string;
      url?: string;
      uri?: string;
    };

    if (!acct.id || !acct.username) {
      return NextResponse.redirect(`${f.origin}/${locale}/login?auth_error=fediverse_profile_failed`);
    }

    const consent = normalizeFederatedConsent(stateData.consent);

    const provisioned = await provisionOrLoginFederatedUser({
      provider: 'fediverse',
      externalId: `${domain}:${acct.id}`,
      handle: `${acct.username}@${domain}`,
      name: (acct.display_name || '').trim() || acct.username,
      bio: typeof acct.note === 'string' ? stripHtml(acct.note) : '',
      avatarUrl: typeof acct.avatar === 'string' && acct.avatar.startsWith('https://') && !acct.avatar.includes('missing.png') ? acct.avatar : '',
      coverImageUrl: typeof acct.header === 'string' && acct.header.startsWith('https://') && !acct.header.includes('missing.png') ? acct.header : '',
      website: typeof acct.url === 'string' && acct.url.startsWith('https://') ? acct.url : '',
      actorId: typeof acct.uri === 'string' && acct.uri.startsWith('https://') ? acct.uri : acct.url,
      locale,
      consent,
    });

    if (consent.syncFollowing || consent.syncPosts) {
      await syncMastodonData({
        uid: provisioned.uid,
        domain,
        accountId: acct.id,
        accessToken: tokenJson.access_token,
        consent,
        origin: f.origin,
      }).catch((err) => console.warn('Mastodon sync warning:', err instanceof Error ? err.message : String(err)));
    }

    const ticket = await createLoginTicket(provisioned);
    return NextResponse.redirect(`${f.origin}/${locale}/login?ticket=${encodeURIComponent(ticket)}`);
  } catch (err) {
    if (err instanceof FederatedSignupClosedError) {
      return NextResponse.redirect(`${f.origin}/${locale}/login?auth_error=signup_closed`);
    }
    // O texto do erro fica só no log; a URL leva um CÓDIGO conhecido (loginErrors.ts), nunca a mensagem interna.
    console.error('Fediverse OAuth callback failed:', err instanceof Error ? err.message : String(err));
    return NextResponse.redirect(loginErrorUrl(f.origin, locale, 'fediverse_error', err));
  }
}

