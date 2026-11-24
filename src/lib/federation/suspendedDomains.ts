// src/lib/federation/suspendedDomains.ts
// Lista centralizada de domínios do Fediverso suspensos pela plataforma (corte de comunicação e ocultação na leitura).

export const SUSPENDED_FEDIVERSE_DOMAINS = [
  'bolha.one',
  'bolha.us',
  'ursal.zone',
  'alquimidia.social.br',
  'comuna.social.br',
  'social.groselhas.com.br',
  'marte.city',
  'organica.social',
  'masto.donte.com.br',
  'infosec.exchange',
  'mastodon.com.br',
  'bantu.social',
  'social.desescritorio.art.br',
  'catodon.rocks',
  'social.coletivos.org',
] as const;

export function isSuspendedFediverseHost(host: string | null | undefined): boolean {
  if (typeof host !== 'string' || !host.trim()) return false;
  const normalized = host.trim().toLowerCase().replace(/\.$/, '');
  return SUSPENDED_FEDIVERSE_DOMAINS.some(
    (domain) => normalized === domain || normalized.endsWith(`.${domain}`),
  );
}

export function isFromSuspendedFediverseDomain(value: {
  username?: string | null;
  remoteUrl?: string | null;
  remoteActorId?: string | null;
  remoteDomain?: string | null;
  apActorUri?: string | null;
  website?: string | null;
  authorDetails?: { username?: string | null } | null;
} | null | undefined): boolean {
  if (!value) return false;
  if (isSuspendedFediverseHost(value.remoteDomain)) return true;

  for (const handle of [value.username, value.authorDetails?.username]) {
    if (typeof handle === 'string' && handle.includes('@')) {
      const domain = handle.split('@').pop();
      if (isSuspendedFediverseHost(domain)) return true;
    }
  }

  for (const urlField of [value.remoteUrl, value.remoteActorId, value.apActorUri, value.website]) {
    if (typeof urlField === 'string' && urlField.startsWith('http')) {
      try {
        if (isSuspendedFediverseHost(new URL(urlField).hostname)) return true;
      } catch {
        // ignora URL malformada
      }
    }
  }

  return false;
}
