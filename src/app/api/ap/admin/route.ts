// src/app/api/ap/admin/route.ts
// O painel de quem administra a rede. Só administrador (users/{uid}.isAdmin, lido pelo servidor); para os demais a rota
// responde 404, como se não existisse.
import { adminOverview, adminSetInstanceRule, adminSetPlatform } from '@/lib/activitypub/admin';
import type { AdminFailure } from '@/lib/activitypub/admin';
import { runWorker } from '@/lib/activitypub/worker';
import { configError, federation, json, readJsonObject, requireAdmin } from '@/lib/server/federation';
import { adminFirestore } from '@/lib/server/firebaseAdmin';
import { siteConfig } from '@/config/site';
import { normalizeHandle } from '@/lib/activitypub/identity';
import { purgeSuspendedDomainsFromFirestore } from '@/lib/server/purgeSuspended';
import { estadoDoDominio } from '@/lib/activitypub/consentimentoDeDominio';
import { decideInstance } from '@/lib/activitypub/gate';
import { isSuspendedFediverseHost } from '@/lib/federation/suspendedDomains';

export const dynamic = 'force-dynamic';

const STATUS_DA_FALHA: Record<AdminFailure, number> = {
  'nada-a-mudar': 400, 'valor-invalido': 422, 'dominio-invalido': 422, 'proprio-dominio': 422,
};

export async function GET(request: Request) {
  const quem = await requireAdmin(request, 'admin-get', 30);
  if (quem instanceof Response) return quem;

  const [overview, deadSnap] = await Promise.all([
    adminOverview(federation().admin),
    adminFirestore()
      .collection('ap_deliveries')
      .where('status', '==', 'dead')
      .limit(250)
      .get()
      .catch(() => null),
  ]);

  const byDomain = new Map<string, { domain: string; deadCount: number; lastError: string | null; likelyBlocked: boolean }>();
  if (deadSnap) {
    for (const docSnap of deadSnap.docs) {
      const d = docSnap.data();
      let domain = typeof d.domain === 'string' ? d.domain.trim().toLowerCase() : '';
      if (!domain && typeof d.inbox === 'string') {
        try {
          domain = new URL(d.inbox).hostname.toLowerCase();
        } catch {
          domain = '';
        }
      }
      if (!domain && typeof d.inboxUrl === 'string') {
        try {
          domain = new URL(d.inboxUrl).hostname.toLowerCase();
        } catch {
          domain = '';
        }
      }
      if (!domain) continue;

      const rawError =
        typeof d.lastError === 'string'
          ? d.lastError
          : typeof d.detail === 'string'
            ? d.detail
            : typeof d.statusCode === 'number'
              ? `HTTP ${d.statusCode}`
              : null;
      const likelyBlocked = Boolean(rawError && /\b(401|403|410|forbidden|blocked|suspended)\b/i.test(rawError));

      const existing = byDomain.get(domain);
      if (existing) {
        existing.deadCount += 1;
        if (!existing.lastError && rawError) existing.lastError = rawError;
        if (likelyBlocked) existing.likelyBlocked = true;
      } else {
        byDomain.set(domain, {
          domain,
          deadCount: 1,
          lastError: rawError,
          likelyBlocked,
        });
      }
    }
  }

  const blockedOrFailingDomains = Array.from(byDomain.values()).sort((a, b) => {
    if (a.likelyBlocked !== b.likelyBlocked) return a.likelyBlocked ? -1 : 1;
    return b.deadCount - a.deadCount;
  });

  return json(200, { ...overview, blockedOrFailingDomains, saudeDosDominios: await saudeDosDominios() });
}

type LinhaDeSaude = {
  domain: string;
  recusas: number;
  pausaAte: number | null;
  falhas: number;
  semDns: boolean;
  ultimaFalhaMs: number;
};

/**
 * Domínios que nos RECUSAM (403, com ou sem pausa ativa) e domínios MORTOS (falha de infraestrutura repetida, com o DNS
 * separado), lidos de `ap_domain_health`. Quem já está suspenso sai da lista: a decisão já foi tomada.
 *
 * O painel só MOSTRA. Suspender continua sendo decisão de uma pessoa: heurística não bane ninguém sozinha.
 */
async function saudeDosDominios(): Promise<{ recusando: LinhaDeSaude[]; mortos: LinhaDeSaude[] }> {
  const f = federation();
  const [snap, politica] = await Promise.all([
    adminFirestore().collection('ap_domain_health').limit(500).get().catch(() => null),
    f.store.getInstancePolicy().catch(() => null),
  ]);
  const recusando: LinhaDeSaude[] = [];
  const mortos: LinhaDeSaude[] = [];
  if (!snap) return { recusando, mortos };
  const agora = Date.now();
  for (const docSnap of snap.docs) {
    const dominio = docSnap.id.toLowerCase();
    if (isSuspendedFediverseHost(dominio)) continue;
    if (politica && decideInstance(dominio, politica, f.ownHost).decision === 'reject') continue;
    const d = docSnap.data();
    const saude = {
      consecutiveFailures: Number(d.consecutiveFailures) || 0,
      consecutiveRefusals: Number(d.consecutiveRefusals) || 0,
      refusedUntilMs: Number(d.refusedUntilMs) || 0,
      lastFailureClass: typeof d.lastFailureClass === 'string' ? d.lastFailureClass : undefined,
    };
    const estado = estadoDoDominio(saude, agora);
    const linha: LinhaDeSaude = {
      domain: dominio,
      recusas: saude.consecutiveRefusals,
      pausaAte: estado.pausaAte,
      falhas: saude.consecutiveFailures,
      semDns: estado.semDns,
      ultimaFalhaMs: Number(d.lastFailureMs) || 0,
    };
    if (estado.recusando || estado.emPausa) recusando.push(linha);
    if (estado.morto) mortos.push(linha);
  }
  recusando.sort((a, b) => Number(b.pausaAte !== null) - Number(a.pausaAte !== null) || b.recusas - a.recusas);
  mortos.sort((a, b) => Number(b.semDns) - Number(a.semDns) || b.falhas - a.falhas);
  return { recusando, mortos };
}

export async function POST(request: Request) {
  const quem = await requireAdmin(request, 'admin-post', 30);
  if (quem instanceof Response) return quem;
  const corpo = await readJsonObject(request);
  if (!corpo) return json(400, { error: 'corpo-invalido' });

  const deps = federation().admin;
  if (corpo.action === 'platform') {
    const r = await adminSetPlatform(deps, quem.uid, { enabled: corpo.enabled, killSwitch: corpo.killSwitch, mode: corpo.mode });
    if (!r.ok) return json(STATUS_DA_FALHA[r.reason], { error: r.reason });
    return json(200, { ok: true, platform: r.platform });
  }
  if (corpo.action === 'instance') {
    // A regra precisa vir EXPLÍCITA (null remove): campo omitido não pode apagar uma regra por engano.
    if (!('rule' in corpo)) return json(400, { error: 'corpo-invalido' });
    const r = await adminSetInstanceRule(deps, quem.uid, corpo.domain, corpo.rule);
    if (!r.ok) return json(STATUS_DA_FALHA[r.reason], { error: r.reason });
    return json(200, { ok: true });
  }
  if (corpo.action === 'run-worker') {
    let workerDeps;
    try {
      workerDeps = federation().worker();
    } catch {
      return configError();
    }
    const stats = await runWorker(workerDeps);
    return json(200, { ok: true, stats });
  }
  /**
   * Avisa quem segue uma conta pelo endereço ANTIGO que ela se mudou para o canônico (`Move`).
   *
   * UMA conta por chamada, de propósito: é um aviso que sai para a caixa de cada seguidor em outro servidor e não tem
   * como ser desfeito. Quem decide se move o follow é o servidor de lá, depois de conferir que o ator novo declara
   * `alsoKnownAs` apontando para o antigo (ver siteConfig.migrationAliasEnabled). Os vínculos daqui não são apagados.
   */
  if (corpo.action === 'migrate') {
    const handle = normalizeHandle(typeof corpo.handle === 'string' ? corpo.handle : '');
    if (!handle) return json(422, { error: 'handle-invalido' });

    const pedido = typeof corpo.legacyHost === 'string' ? corpo.legacyHost.trim().toLowerCase() : siteConfig.legacyFederationHosts[0];
    const antigo = siteConfig.legacyFederationHosts.find((h) => h === pedido);
    if (!antigo) return json(422, { error: 'host-antigo-desconhecido' });

    const f = federation();
    const reserva = await f.store.getHandle(handle);
    if (!reserva || reserva.state !== 'active') return json(404, { error: 'conta-nao-encontrada' });
    const conta = await f.store.getAccount(reserva.uid);
    if (!conta?.enabled) return json(409, { error: 'federacao-nao-ativada' });

    const agora = Date.now();
    await f.store.enqueueJob({
      id: `move-${reserva.uid}-${agora}`,
      op: 'move',
      uid: reserva.uid,
      postId: null,
      targets: null,
      createdAtMs: agora,
      nextAttemptAt: agora,
      attempts: 0,
      state: 'pending',
      // O worker lê daqui de QUAL endereço o Move fala (é o ator que quem segue conhece).
      note: `https://${antigo.replace(/^www\./, '')}`,
    });
    return json(200, { ok: true, handle: reserva.handle, de: `https://${antigo.replace(/^www\./, '')}`, para: f.origin });
  }
  // Suspender + purgar UM domínio. Em dois tempos, de propósito: sem `confirmar: true` é ENSAIO (conta o que sairia e
  // não toca em nada), e a tela mostra os números antes de alguém apertar de novo. Remoção física não se desfaz.
  if (corpo.action === 'suspend-and-purge') {
    const dominio = typeof corpo.domain === 'string' ? corpo.domain.trim().toLowerCase() : '';
    if (corpo.confirmar !== true) {
      const ensaio = await purgeSuspendedDomainsFromFirestore({ dominios: [dominio], ensaio: true });
      if (ensaio.domains.length === 0) return json(422, { error: 'dominio-invalido' });
      return json(200, { ok: true, ...ensaio });
    }
    // A regra vem PRIMEIRO: ela valida o domínio (inclusive recusa o nosso) e corta a federação na hora. Só então apaga.
    const regra = await adminSetInstanceRule(deps, quem.uid, dominio, 'suspend');
    if (!regra.ok) return json(STATUS_DA_FALHA[regra.reason], { error: regra.reason });
    const resumo = await purgeSuspendedDomainsFromFirestore({ dominios: [dominio] });
    return json(200, { ok: true, ...resumo });
  }
  if (corpo.action === 'purge-suspended') {
    const summary = await purgeSuspendedDomainsFromFirestore();
    return json(200, { ok: true, ...summary });
  }
  return json(400, { error: 'acao-invalida' });
}
