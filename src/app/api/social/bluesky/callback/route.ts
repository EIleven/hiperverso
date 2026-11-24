import { Agent } from '@atproto/api';
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { siteConfig } from '@/config/site';
import { loginErrorUrl } from '@/lib/auth/loginErrors';
import { getBlueskyOAuthClient } from '@/lib/server/blueskyOAuth';
import { createLoginTicket, FederatedSignupClosedError, provisionOrLoginFederatedUser } from '@/lib/server/federatedAuth';
import { normalizeFederatedConsent, syncBlueskyData } from '@/lib/server/federatedSync';
import { consumeLinkState, peekLinkState, saveConnection } from '@/lib/server/socialStore';
import { socialOrigin, socialSettingsUrl } from '@/lib/server/socialConfig';

export async function GET(request: Request) {
  let locale = 'pt-BR';
  let isLoginFlow = false;
  const url = new URL(request.url);
  const stateParam = url.searchParams.get('state') || '';

  try {
    if (stateParam) {
      const peeked = await peekLinkState(stateParam, 'bluesky').catch(() => null);
      if (peeked) {
        locale = peeked.locale === 'en' ? 'en' : 'pt-BR';
        isLoginFlow = peeked.uid === '__login__';
      }
    }

    const oauthError = url.searchParams.get('error_description') || url.searchParams.get('error');
    if (oauthError) {
      throw new Error(oauthError);
    }

    const client = await getBlueskyOAuthClient();
    const { session, state } = await client.callback(url.searchParams);
    if (!state) throw new Error('missing application state');
    const link = await consumeLinkState(state, 'bluesky');
    if (!link) {
      await client.revoke(session.did).catch(() => undefined);
      throw new Error('invalid or expired application state');
    }
    locale = link.locale === 'en' ? 'en' : 'pt-BR';
    isLoginFlow = link.uid === '__login__';
    const agent = new Agent(session);
    const profile = await agent.getProfile({ actor: session.did });

    if (isLoginFlow) {
      const consent = normalizeFederatedConsent(link.consent);
      const provisioned = await provisionOrLoginFederatedUser({
        provider: 'bluesky',
        externalId: session.did,
        handle: profile.data.handle,
        name: profile.data.displayName || profile.data.handle,
        bio: profile.data.description || '',
        avatarUrl: profile.data.avatar || '',
        coverImageUrl: profile.data.banner || '',
        website: `https://bsky.app/profile/${profile.data.handle}`,
        did: session.did,
        locale,
        consent,
      });

      if (consent.syncFollowing || consent.syncPosts) {
        await syncBlueskyData({
          uid: provisioned.uid,
          agent,
          did: session.did,
          consent,
        }).catch((err) => console.warn('Bluesky sync warning:', err instanceof Error ? err.message : String(err)));
      }

      await saveConnection({
        uid: provisioned.uid,
        provider: 'bluesky',
        connected: true,
        did: session.did,
        handle: profile.data.handle,
        displayName: profile.data.displayName,
        avatarUrl: profile.data.avatar,
        connectedAt: new Date().toISOString(),
      });

      const ticket = await createLoginTicket(provisioned);
      const origin = siteConfig.baseUrl.replace(/\/+$/, '');
      return NextResponse.redirect(`${origin}/${locale}/login?ticket=${encodeURIComponent(ticket)}`);
    }

    await saveConnection({
      uid: link.uid,
      provider: 'bluesky',
      connected: true,
      did: session.did,
      handle: profile.data.handle,
      displayName: profile.data.displayName,
      avatarUrl: profile.data.avatar,
      connectedAt: new Date().toISOString(),
    });
    return NextResponse.redirect(socialSettingsUrl(locale, 'connected', 'bluesky'));
  } catch (error) {
    if (error instanceof FederatedSignupClosedError) {
      return NextResponse.redirect(`${socialOrigin()}/${locale}/login?auth_error=signup_closed`);
    }
    const reason = error instanceof Error ? error.message : String(error);
    console.error('Bluesky OAuth callback failed:', reason);
    const cookieStore = await cookies().catch(() => null);
    const hasSession = Boolean(cookieStore?.get('__session')?.value);
    if (isLoginFlow || !hasSession) {
      // Só o CÓDIGO vai para a URL (loginErrors.ts); o texto do erro, que pode citar conta de serviço e projeto, fica no log.
      return NextResponse.redirect(loginErrorUrl(socialOrigin(), locale, 'bluesky', error));
    }
    return NextResponse.redirect(socialSettingsUrl(locale, 'error', 'bluesky'));
  }
}
