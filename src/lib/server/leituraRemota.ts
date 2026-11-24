// src/lib/server/leituraRemota.ts
// UM lugar para responder "podemos ler deste domínio agora?". Junta o que antes cada busca conferia (ou esquecia) do seu
// jeito: plataforma ligada, suspensão (a lista fixa do código E a política do banco) e pausa de consentimento.
//
// A decisão em si é pura e testada (`podeLerDe`, em consentimentoDeDominio.ts). Aqui só se reúnem as entradas.
import { podeLerDe, type DecisaoDeLeitura } from '@/lib/activitypub/consentimentoDeDominio';
import { decideInstance } from '@/lib/activitypub/gate';
import { normalizeHostname } from '@/lib/activitypub/identity';
import { isSuspendedFediverseHost } from '@/lib/federation/suspendedDomains';
import { federation } from '@/lib/server/federation';

export async function podeLerDoDominio(dominioBruto: string): Promise<DecisaoDeLeitura> {
  const dominio = normalizeHostname(dominioBruto);
  if (!dominio) return { pode: false, motivo: 'suspenso' };
  const f = federation();
  const [plataforma, politica, saude] = await Promise.all([
    f.store.getPlatform(),
    f.store.getInstancePolicy(),
    f.store.getDomainHealth(dominio).catch(() => null),
  ]);
  return podeLerDe({
    plataformaLigada: plataforma.enabled && !plataforma.killSwitch,
    suspenso: isSuspendedFediverseHost(dominio) || decideInstance(dominio, politica, f.ownHost).decision === 'reject',
    saude,
    agora: Date.now(),
  });
}
