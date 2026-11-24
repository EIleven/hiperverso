// src/lib/activitypub/worker.ts
// O motor de saída. Três fases por execução, nesta ordem:
//
//   A. EXPANDIR  — cada tarefa de `ap_outbound` (uma mudança num post) vira uma entrega por DESTINO;
//   B. ENTREGAR  — cada entrega vencida é conferida de novo, assinada e enviada;
//   C. LIMPAR    — chaves de contas removidas cujo prazo venceu são destruídas.
//
// O PORTÃO RODA DE NOVO EM CADA ENTREGA (ameaça T6). Entre enfileirar e enviar podem passar horas: a pessoa pausa, o
// post vira privado, a plataforma é desligada. A entrega que sai tem de ser autorizada AGORA, não quando foi pedida.
// Uma entrega que ficou esperando durante uma pausa é CANCELADA, nunca enviada depois — é o que impede a pausa de
// virar um atraso em vez de uma interrupção.
//
// Apagar é exceção declarada: `Delete` de algo que já saiu continua valendo com a conta pausada ou desligada, porque
// impedi-lo prenderia a pessoa a uma cópia que ela quer retirar. Só o botão de emergência da plataforma o para.
import { loadPrivateKey } from './account.ts';
import type { AccountDeps } from './account.ts';
import { buildAnnounce, buildCreate, buildDelete, buildDeleteActor, buildLike, buildMove, buildUndo, buildUpdate } from './activity.ts';
import { classifyDelivery, deliveryId, domainCooldownSeconds, failureClassOf, groupTargets, nextStep } from './delivery.ts';
import type { FailureClass } from './delivery.ts';
import { aposEntregaAceita, aposRecusa, classeDaFalhaDeInfra, ehRecusaDeConsentimento, pausaDeConsentimento } from './consentimentoDeDominio.ts';
import { addressingFor, decideInstance, evaluateGate } from './gate.ts';
import type { FederationScope } from './gate.ts';
import type { GateOp, PostForGate } from './gate.ts';
import { actorUrl, activityUrl, followersUrl, keyIdUrl, noteUrl } from './identity.ts';
import { commentNoteFor, commentNoteUrl, noteFor } from './render.ts';
import type { RenderDeps } from './render.ts';
import type { Fetcher } from './remote.ts';
import type {
  AccountRecord, DeliveryRecord, FederatedObject, FollowerRecord, LocalPost, OutboundJob,
} from './store.ts';
import { AS_PUBLIC } from './gate.ts';

/**
 * O que o worker REGISTRA além dos contadores e da auditoria, para virar linha de log estruturada (Cloud Logging) e, dali,
 * métrica e alerta. Antes uma entrega que falhava 8 vezes e morria deixava só um contador; um post pulado pelo portão (ou que
 * saiu sem a imagem) não deixava nada que alguém lesse. O `event` é um nome ESTÁVEL: é por ele que se filtra.
 */
export type WorkerLogEvent = {
  level: 'info' | 'warn' | 'error';
  event: 'ap.delivery.failed' | 'ap.delivery.dead' | 'ap.job.skipped' | 'ap.media.omitted';
  uid?: string;
  postId?: string;
  op?: string;
  domain?: string;
  /** HTTP da resposta, ou `null` se o servidor nem respondeu. */
  status?: number | null;
  failureClass?: FailureClass;
  attempts?: number;
  /** Quando a próxima tentativa vai acontecer (só em `ap.delivery.failed`). */
  retryInSeconds?: number;
  reason?: string;
  detail?: string;
  count?: number;
};

export type WorkerDeps = AccountDeps & RenderDeps & { fetcher: Fetcher; log?: (evento: WorkerLogEvent) => void };

export type WorkerOptions = {
  /** Tempo máximo desta execução. A execução seguinte (o agendador roda a cada minuto) continua de onde parou. */
  budgetMs: number;
  maxJobs: number;
  deliveryBatch: number;
};

export type WorkerStats = {
  jobs: number;
  expanded: number;
  skipped: number;
  sent: number;
  retried: number;
  dead: number;
  cancelled: number;
  deferred: number;
  keysDestroyed: number;
  durationMs: number;
};

const LEASE_MS = 90_000;

/** Motivos de o portão pular uma tarefa que NÃO merecem registro: nada a retirar, já apagado, post só daqui. */
const PULOS_SEM_REGISTRO: ReadonlySet<string> = new Set(['nao-federado-antes', 'post-apagado', 'post-local']);

export const DEFAULT_WORKER_OPTIONS: WorkerOptions = { budgetMs: 40_000, maxJobs: 25, deliveryBatch: 8 };

export async function runWorker(deps: WorkerDeps, opcoes: WorkerOptions = DEFAULT_WORKER_OPTIONS): Promise<WorkerStats> {
  const inicio = deps.now();
  const stats: WorkerStats = { jobs: 0, expanded: 0, skipped: 0, sent: 0, retried: 0, dead: 0, cancelled: 0, deferred: 0, keysDestroyed: 0, durationMs: 0 };

  // Botão de emergência / plataforma desligada: nada sai, e a fila FICA como está (não é descartada).
  const plataforma = await deps.store.getPlatform();
  if (!plataforma.enabled || plataforma.killSwitch) {
    stats.durationMs = deps.now() - inicio;
    return stats;
  }

  // A. Expandir
  const tarefas = await deps.store.claimDueJobs(deps.now(), opcoes.maxJobs, LEASE_MS);
  for (const tarefa of tarefas) {
    stats.jobs++;
    try {
      const n = await expandirTarefa(deps, tarefa);
      if (n === null) stats.skipped++;
      else stats.expanded += n;
    } catch (erro) {
      // Falha inesperada: a tarefa fica reclamável quando o prazo de posse vencer, e tenta de novo.
      await deps.store.audit({ atMs: deps.now(), kind: 'worker', decision: 'erro-expandir', reason: String((erro as Error)?.message ?? erro).slice(0, 200), uid: tarefa.uid });
    }
  }

  // B. Entregar
  const chaves = new Map<string, string | null>();
  while (deps.now() - inicio < opcoes.budgetMs) {
    const lote = await deps.store.claimDueDeliveries(deps.now(), opcoes.deliveryBatch, LEASE_MS);
    if (lote.length === 0) break;
    // As entregas de um MESMO domínio andam em sequência; domínios diferentes, em paralelo. Não é só gentileza com o
    // destino: o disjuntor lê a saúde do domínio antes de enviar e a grava depois. Em paralelo, quatro falhas seguidas
    // liam todas "0 falhas" e gravavam todas "1" (atualização perdida) — e o disjuntor nunca abria justamente quando
    // um domínio inteiro cai, que é o caso para o qual ele existe.
    const porDominio = new Map<string, DeliveryRecord[]>();
    for (const e of lote) porDominio.set(e.domain, [...(porDominio.get(e.domain) ?? []), e]);
    const grupos = await Promise.all(
      [...porDominio.values()].map(async (grupo) => {
        const saidas: Resultado[] = [];
        for (const e of grupo) saidas.push(await entregarUma(deps, e, chaves));
        return saidas;
      }),
    );
    for (const r of grupos.flat()) stats[r] = (stats[r] ?? 0) + 1;
  }

  // C. Limpar chaves vencidas
  const vencidas = await deps.store.listHandlesWithKeyDue(deps.now(), 10);
  for (const reserva of vencidas) {
    await deps.store.deleteKey(reserva.uid);
    await deps.store.putHandle({ ...reserva, state: 'deleted', keyDeleteAfterMs: null });
    await deps.store.audit({ atMs: deps.now(), kind: 'worker', decision: 'chave-destruida', uid: reserva.uid });
    stats.keysDestroyed++;
  }

  stats.durationMs = deps.now() - inicio;
  await deps.store.bump('worker.execucoes');
  return stats;
}

// ───────────────────────── A. Expandir ─────────────────────────

async function todosOsSeguidores(deps: WorkerDeps, uid: string): Promise<FollowerRecord[]> {
  const todos: FollowerRecord[] = [];
  let depois: string | null = null;
  for (let pagina = 0; pagina < 200; pagina++) {
    const lote = await deps.store.listFollowers(uid, 500, depois);
    todos.push(...lote);
    if (lote.length < 500) break;
    depois = lote[lote.length - 1].actorId;
  }
  return todos;
}

/**
 * Destinos de uma conta, já sem as instâncias que a política recusa.
 *
 * `escopo` decide o agrupamento: público e não listado vão pelo inbox COMPARTILHADO (uma entrega por servidor); só-seguidores
 * vai pelo inbox PESSOAL de cada seguidor (ver groupTargets). Sem `escopo`, o padrão é agrupar — é o caso do `Delete` do
 * próprio ator, que é para todo mundo que seguia.
 */
async function destinosDe(deps: WorkerDeps, seguidores: readonly FollowerRecord[], escopo?: FederationScope) {
  const politica = await deps.store.getInstancePolicy();
  const alvos = groupTargets(seguidores, { allowSharedInbox: escopo !== 'followers' });
  return alvos.filter((d) => decideInstance(d.domain, politica, deps.ownHost).decision !== 'reject');
}

/**
 * Soma aos destinos as caixas de quem foi MENCIONADO na nota. Sem isto a tag `Mention` ia no corpo e não chegava a ninguém:
 * quem foi mencionado quase nunca segue a pessoa, e os destinos saíam só da lista de seguidores.
 *
 * Vai sempre na caixa PESSOAL (a menção é para aquela pessoa, não para o servidor) e nunca repete uma caixa que já estava na
 * lista. Instância recusada pela política continua fora.
 */
async function comMencionados(
  deps: WorkerDeps,
  destinos: { inbox: string; domain: string; followers: number }[],
  atividade: unknown,
) {
  const objeto = (atividade as { object?: { tag?: unknown } } | null)?.object;
  const tags = Array.isArray(objeto?.tag) ? (objeto.tag as { type?: unknown; href?: unknown }[]) : [];
  const alvos = tags.filter((x) => x?.type === 'Mention' && typeof x.href === 'string').map((x) => x.href as string);
  if (alvos.length === 0) return destinos;
  const politica = await deps.store.getInstancePolicy();
  const jaTem = new Set(destinos.map((d) => d.inbox));
  const saida = [...destinos];
  for (const actorId of alvos.slice(0, 20)) {
    const ator = await deps.store.getRemoteActor(actorId).catch(() => null);
    if (!ator?.inbox || jaTem.has(ator.inbox)) continue;
    if (decideInstance(ator.domain, politica, deps.ownHost).decision === 'reject') continue;
    jaTem.add(ator.inbox);
    saida.push({ inbox: ator.inbox, domain: ator.domain, followers: 0 });
  }
  return saida;
}

function postParaPortao(post: LocalPost | null, objeto: FederatedObject | null, uid: string): PostForGate {
  if (post) {
    return {
      userId: post.userId,
      visibility: post.visibility,
      federation: post.federation,
      type: post.type,
      category: post.category,
      createdAtMs: post.createdAtMs,
      isDeleted: post.isDeleted,
      hasPoll: post.hasPoll,
      apObjectId: objeto?.objectId ?? null,
    };
  }
  // Post apagado de vez: só sobra o registro do que saiu. Serve para o `Delete`.
  return {
    userId: uid,
    visibility: 'public',
    federation: objeto?.scope ?? 'local',
    createdAtMs: objeto?.createdAtMs ?? 0,
    isDeleted: true,
    apObjectId: objeto?.objectId ?? null,
  };
}

function contaParaPortao(conta: AccountRecord | null) {
  return {
    enabled: Boolean(conta?.enabled),
    paused: Boolean(conta?.paused),
    eligibleSince: conta?.eligibleSince ?? Number.MAX_SAFE_INTEGER,
    handle: conta?.handle ?? null,
  };
}

/**
 * A nota saiu com MENOS anexos do que o post tem? `nossaMidia` só deixa passar a mídia pública da casa e o Fediverso leva até
 * 8: o resto é descartado ao montar a nota, e o post saía só com texto sem que ninguém soubesse. Aqui fica o rastro (contador,
 * auditoria e log); o post continua saindo, porque o texto é o que o autor quis publicar.
 */
async function avisarMidiaOmitida(deps: WorkerDeps, tarefa: OutboundJob, post: LocalPost, anexosNaNota: number): Promise<void> {
  const omitidas = post.media.length - anexosNaNota;
  if (omitidas <= 0) return;
  await deps.store.bump('worker.midia-omitida', omitidas);
  await deps.store.audit({ atMs: deps.now(), kind: 'worker', decision: 'midia-omitida', reason: `${tarefa.op}:${omitidas} de ${post.media.length}`, uid: tarefa.uid });
  deps.log?.({ level: 'warn', event: 'ap.media.omitted', uid: tarefa.uid, postId: post.id, op: tarefa.op, count: omitidas, detail: `${post.media.length} anexo(s) no post, ${anexosNaNota} na nota` });
}

/** Devolve quantas entregas criou, ou `null` se a tarefa foi pulada. */
async function expandirTarefa(deps: WorkerDeps, tarefa: OutboundJob): Promise<number | null> {
  const { store } = deps;
  const agora = deps.now();

  if (tarefa.op === 'move') return expandirMove(deps, tarefa);
  if (tarefa.op === 'delete-actor') return expandirDeleteActor(deps, tarefa);
  if (tarefa.op === 'comment-create' || tarefa.op === 'comment-delete') return expandirComentario(deps, tarefa);
  if (tarefa.op === 'local-boost' || tarefa.op === 'local-unboost') return expandirBoostLocal(deps, tarefa);
  if (
    tarefa.op === 'remote-like'
    || tarefa.op === 'remote-unlike'
    || tarefa.op === 'remote-boost'
    || tarefa.op === 'remote-unboost'
    || tarefa.op === 'remote-reply'
  ) {
    return expandirInteracaoRemota(deps, tarefa);
  }

  if (!tarefa.postId) {
    await store.finishJob(tarefa.id, 'skipped', 'sem-post');
    return null;
  }

  const [plataforma, conta, post, objeto] = await Promise.all([
    store.getPlatform(),
    store.getAccount(tarefa.uid),
    store.getPost(tarefa.postId),
    store.getObject(tarefa.postId),
  ]);
  const op = tarefa.op as GateOp;
  const decisao = evaluateGate({ op, platform: plataforma, account: contaParaPortao(conta), post: postParaPortao(post, objeto, tarefa.uid) });
  if (!decisao.allowed) {
    await store.finishJob(tarefa.id, 'skipped', decisao.reason);
    await store.bump(`worker.pulada.${decisao.reason}`);
    // Pular é o desfecho SILENCIOSO por excelência: o post existe, ninguém errou, e ele simplesmente não sai. Só o que é
    // esperado e inofensivo (nada a retirar, post já apagado, post local) passa sem registro.
    if (!PULOS_SEM_REGISTRO.has(decisao.reason)) {
      await store.audit({ atMs: agora, kind: 'worker', decision: 'pulada', reason: `${op}:${decisao.reason}`, uid: tarefa.uid });
      deps.log?.({ level: 'warn', event: 'ap.job.skipped', uid: tarefa.uid, postId: tarefa.postId, op, reason: decisao.reason });
    }
    return null;
  }
  if (!conta?.handle) {
    await store.finishJob(tarefa.id, 'skipped', 'sem-handle');
    deps.log?.({ level: 'error', event: 'ap.job.skipped', uid: tarefa.uid, postId: tarefa.postId, op, reason: 'sem-handle' });
    return null;
  }

  // Create duplicado (gatilho disparado duas vezes, retomada): o que já saiu não sai de novo.
  if (op === 'create' && objeto?.state === 'federated') {
    await store.finishJob(tarefa.id, 'skipped', 'ja-federado');
    return null;
  }

  const handle = conta.handle;
  const ator = actorUrl(deps.origin, handle);
  const escopo = decisao.scope;
  const seguidores = await todosOsSeguidores(deps, tarefa.uid);
  const destinos = await destinosDe(deps, seguidores, escopo);

  let atividade: unknown;
  let objectId: string;
  let activityId: string;
  if (op === 'create' && post) {
    if (post.type === 'repost' && post.quotedPostId) {
      const alvoObj = await store.getObject(post.quotedPostId);
      if (!alvoObj || alvoObj.state !== 'federated') {
        await store.finishJob(tarefa.id, 'skipped', 'alvo-nao-federado');
        return null;
      }
      const { to, cc } = addressingFor(escopo, followersUrl(deps.origin, handle));
      activityId = activityUrl(deps.origin, handle, `announce-${post.id}`);
      atividade = buildAnnounce(activityId, ator, alvoObj.objectId, to, cc, new Date(post.createdAtMs).toISOString());
      objectId = post.id;
    } else {
      const nota = await noteFor(deps, handle, post, escopo);
      await avisarMidiaOmitida(deps, tarefa, post, nota.attachment.length);
      activityId = activityUrl(deps.origin, handle, `create-${post.id}`);
      atividade = buildCreate(activityId, ator, nota);
      objectId = post.id;
    }
  } else if (op === 'update' && post) {
    const nota = await noteFor(deps, handle, post, escopo);
    await avisarMidiaOmitida(deps, tarefa, post, nota.attachment.length);
    const quando = post.updatedAtMs ?? agora;
    activityId = activityUrl(deps.origin, handle, `update-${post.id}-${quando}`);
    atividade = buildUpdate(activityId, ator, nota, new Date(quando).toISOString());
    // Cada edição é uma entrega nova: o id inclui o instante, senão a segunda edição seria tomada por repetição.
    objectId = `${post.id}@${quando}`;
  } else if (op === 'delete') {
    const idNota = noteUrl(deps.origin, tarefa.postId);
    const { to, cc } = escopo === 'public' ? { to: [AS_PUBLIC], cc: [followersUrl(deps.origin, handle)] } : { to: [followersUrl(deps.origin, handle)], cc: [] };
    if (post?.type === 'repost' && post.quotedPostId) {
      activityId = activityUrl(deps.origin, handle, `undo-announce-${tarefa.postId}`);
      atividade = buildUndo(activityId, ator, {
        id: activityUrl(deps.origin, handle, `announce-${tarefa.postId}`),
        type: 'Announce',
        actor: ator,
        object: noteUrl(deps.origin, post.quotedPostId),
      });
    } else {
      activityId = activityUrl(deps.origin, handle, `delete-${tarefa.postId}`);
      atividade = buildDelete(activityId, ator, idNota, to, cc);
    }
    objectId = tarefa.postId;
  } else {
    await store.finishJob(tarefa.id, 'skipped', 'sem-conteudo');
    return null;
  }

  const corpo = JSON.stringify(atividade);
  const destinosFinais = await comMencionados(deps, destinos, atividade);
  let criadas = 0;
  for (const destino of destinosFinais) {
    const id = deliveryId({ uid: tarefa.uid, op, objectId, targetInbox: destino.inbox });
    const registro: DeliveryRecord = {
      id, uid: tarefa.uid, op, objectId, activityId, targetInbox: destino.inbox, domain: destino.domain, body: corpo,
      status: 'pending', attempts: 0, nextAttemptAt: agora, lastDetail: null, lastOutcome: null, createdAtMs: agora, sentAtMs: null,
    };
    if (await store.putDeliveryIfAbsent(registro)) criadas++;
  }

  // O registro de "isto saiu" é gravado DEPOIS das entregas: uma queda no meio refaz a expansão (as entregas são
  // idempotentes) em vez de deixar um post marcado como federado sem ter entrega nenhuma.
  if (op === 'create') {
    await store.putObject({ postId: tarefa.postId, uid: tarefa.uid, objectId: noteUrl(deps.origin, tarefa.postId), scope: escopo, createdAtMs: post?.createdAtMs ?? agora, state: 'federated', lastActivityAtMs: agora });
  } else if (op === 'update' && objeto) {
    await store.putObject({ ...objeto, lastActivityAtMs: agora });
  } else if (op === 'delete' && objeto) {
    await store.putObject({ ...objeto, state: 'deleted', lastActivityAtMs: agora });
  }
  await store.finishJob(tarefa.id, 'done', destinos.length === 0 ? 'sem-destinos' : null);
  await store.bump('worker.expandidas', criadas);
  return criadas;
}

async function expandirComentario(deps: WorkerDeps, tarefa: OutboundJob): Promise<number | null> {
  const { store } = deps;
  const agora = deps.now();
  const postId = tarefa.postId;
  const commentId = tarefa.commentId;
  if (!postId || !commentId) {
    await store.finishJob(tarefa.id, 'skipped', 'sem-comentario');
    return null;
  }

  const [plataforma, conta, objeto] = await Promise.all([
    store.getPlatform(),
    store.getAccount(tarefa.uid),
    store.getObject(postId),
  ]);
  if (!plataforma.enabled || plataforma.killSwitch) {
    await store.finishJob(tarefa.id, 'skipped', 'plataforma-desligada');
    return null;
  }
  if (!objeto || objeto.state !== 'federated') {
    await store.finishJob(tarefa.id, 'skipped', 'post-nao-federado');
    return null;
  }
  if (!conta?.handle || !conta.enabled || (tarefa.op === 'comment-create' && conta.paused)) {
    await store.finishJob(tarefa.id, 'skipped', conta?.paused ? 'conta-pausada' : 'conta-nao-optou');
    return null;
  }

  const handle = conta.handle;
  const ator = actorUrl(deps.origin, handle);
  const escopo = objeto.scope;
  let atividade: unknown;
  let activityId: string;
  let objectId: string;

  if (tarefa.op === 'comment-create') {
    const comentario = await store.getComment?.(postId, commentId);
    if (!comentario || comentario.isDeleted || comentario.isRemoteFediverse) {
      await store.finishJob(tarefa.id, 'skipped', 'sem-conteudo');
      return null;
    }
    const nota = commentNoteFor(deps, handle, comentario, escopo);
    activityId = activityUrl(deps.origin, handle, `comment-create-${commentId}`);
    atividade = buildCreate(activityId, ator, nota);
    objectId = `comment:${postId}:${commentId}`;
  } else {
    const idNota = commentNoteUrl(deps.origin, postId, commentId);
    const { to, cc } = escopo === 'public'
      ? { to: [AS_PUBLIC], cc: [followersUrl(deps.origin, handle)] }
      : { to: [followersUrl(deps.origin, handle)], cc: [] };
    activityId = activityUrl(deps.origin, handle, `comment-delete-${commentId}`);
    atividade = buildDelete(activityId, ator, idNota, to, cc);
    objectId = `comment-del:${postId}:${commentId}`;
  }

  const [segAutorComentario, segAutorPost] = await Promise.all([
    todosOsSeguidores(deps, tarefa.uid),
    objeto.uid !== tarefa.uid ? todosOsSeguidores(deps, objeto.uid) : Promise.resolve([]),
  ]);
  const destinos = await destinosDe(deps, [...segAutorComentario, ...segAutorPost], escopo);
  const corpo = JSON.stringify(atividade);
  let criadas = 0;
  for (const destino of destinos) {
    const id = deliveryId({ uid: tarefa.uid, op: tarefa.op, objectId, targetInbox: destino.inbox });
    const registro: DeliveryRecord = {
      id, uid: tarefa.uid, op: tarefa.op, objectId, activityId, targetInbox: destino.inbox, domain: destino.domain, body: corpo,
      status: 'pending', attempts: 0, nextAttemptAt: agora, lastDetail: null, lastOutcome: null, createdAtMs: agora, sentAtMs: null,
    };
    if (await store.putDeliveryIfAbsent(registro)) criadas++;
  }
  await store.finishJob(tarefa.id, 'done', destinos.length === 0 ? 'sem-destinos' : null);
  await store.bump('worker.expandidas', criadas);
  return criadas;
}

async function expandirInteracaoRemota(deps: WorkerDeps, tarefa: OutboundJob): Promise<number | null> {
  const { store } = deps;
  const agora = deps.now();
  if (!tarefa.postId) {
    await store.finishJob(tarefa.id, 'skipped', 'sem-post');
    return null;
  }

  const [plataforma, conta, meta, politica] = await Promise.all([
    store.getPlatform(),
    store.getAccount(tarefa.uid),
    store.getRemotePostMeta?.(tarefa.postId) ?? Promise.resolve(null),
    store.getInstancePolicy(),
  ]);
  if (!plataforma.enabled || plataforma.killSwitch) {
    await store.finishJob(tarefa.id, 'skipped', 'plataforma-desligada');
    return null;
  }
  if (!conta?.enabled || conta.paused || !conta.handle) {
    await store.finishJob(tarefa.id, 'skipped', conta?.paused ? 'conta-pausada' : 'conta-nao-optou');
    return null;
  }
  if (!meta) {
    await store.finishJob(tarefa.id, 'skipped', 'sem-alvo');
    return null;
  }

  const domain = new URL(meta.remoteInbox).hostname.toLowerCase();
  if (decideInstance(domain, politica, deps.ownHost).decision === 'reject') {
    await store.finishJob(tarefa.id, 'skipped', 'instancia-bloqueada');
    return null;
  }

  const handle = conta.handle;
  const ator = actorUrl(deps.origin, handle);
  let atividade: unknown;
  let activityId: string;
  let objectId: string;

  if (tarefa.op === 'remote-like') {
    activityId = activityUrl(deps.origin, handle, `like-${tarefa.postId}`);
    atividade = buildLike(activityId, ator, meta.remoteObjectId);
    objectId = `rlike:${tarefa.postId}`;
  } else if (tarefa.op === 'remote-unlike') {
    activityId = activityUrl(deps.origin, handle, `unlike-${tarefa.postId}-${agora}`);
    atividade = buildUndo(activityId, ator, {
      id: activityUrl(deps.origin, handle, `like-${tarefa.postId}`),
      type: 'Like',
      actor: ator,
      object: meta.remoteObjectId,
    });
    objectId = `runlike:${tarefa.postId}:${agora}`;
  } else if (tarefa.op === 'remote-boost') {
    activityId = activityUrl(deps.origin, handle, `boost-${tarefa.postId}`);
    atividade = buildAnnounce(activityId, ator, meta.remoteObjectId, [AS_PUBLIC], [followersUrl(deps.origin, handle)], new Date(agora).toISOString());
    objectId = `rboost:${tarefa.postId}`;
  } else if (tarefa.op === 'remote-unboost') {
    activityId = activityUrl(deps.origin, handle, `unboost-${tarefa.postId}-${agora}`);
    atividade = buildUndo(activityId, ator, {
      id: activityUrl(deps.origin, handle, `boost-${tarefa.postId}`),
      type: 'Announce',
      actor: ator,
      object: meta.remoteObjectId,
    });
    objectId = `runboost:${tarefa.postId}:${agora}`;
  } else {
    if (!tarefa.commentId) {
      await store.finishJob(tarefa.id, 'skipped', 'sem-comentario');
      return null;
    }
    const comentario = await store.getComment?.(tarefa.postId, tarefa.commentId);
    if (!comentario || comentario.isDeleted || comentario.isRemoteFediverse) {
      await store.finishJob(tarefa.id, 'skipped', 'sem-conteudo');
      return null;
    }
    const nota = commentNoteFor(deps, handle, comentario, 'public');
    nota.inReplyTo = meta.remoteObjectId;
    if (meta.remoteActorId && !nota.cc.includes(meta.remoteActorId)) {
      nota.cc = [...nota.cc, meta.remoteActorId];
    }
    activityId = activityUrl(deps.origin, handle, `rreply-${tarefa.commentId}`);
    atividade = buildCreate(activityId, ator, nota);
    objectId = `rreply:${tarefa.postId}:${tarefa.commentId}`;
  }

  const corpo = JSON.stringify(atividade);
  const destinos: { inbox: string; domain: string }[] = [{ inbox: meta.remoteInbox, domain }];
  if (tarefa.op === 'remote-boost' || tarefa.op === 'remote-unboost') {
    const seguidores = await todosOsSeguidores(deps, tarefa.uid);
    const seenInbox = new Set<string>([meta.remoteInbox]);
    for (const d of groupTargets(seguidores)) {
      if (!seenInbox.has(d.inbox)) {
        seenInbox.add(d.inbox);
        destinos.push(d);
      }
    }
  }

  let criadas = 0;
  for (const destino of destinos) {
    const id = deliveryId({ uid: tarefa.uid, op: tarefa.op, objectId, targetInbox: destino.inbox });
    const registro: DeliveryRecord = {
      id, uid: tarefa.uid, op: tarefa.op, objectId, activityId, targetInbox: destino.inbox, domain: destino.domain, body: corpo,
      status: 'pending', attempts: 0, nextAttemptAt: agora, lastDetail: null, lastOutcome: null, createdAtMs: agora, sentAtMs: null,
    };
    if (await store.putDeliveryIfAbsent(registro)) criadas++;
  }
  await store.finishJob(tarefa.id, 'done', null);
  await store.bump('worker.expandidas', criadas);
  return criadas;
}

async function expandirBoostLocal(deps: WorkerDeps, tarefa: OutboundJob): Promise<number | null> {
  const { store } = deps;
  const agora = deps.now();
  if (!tarefa.postId) {
    await store.finishJob(tarefa.id, 'skipped', 'sem-post');
    return null;
  }

  const [plataforma, conta, reserva, post, objeto] = await Promise.all([
    store.getPlatform(),
    store.getAccount(tarefa.uid),
    store.findHandleByUid(tarefa.uid),
    store.getPost(tarefa.postId),
    store.getObject(tarefa.postId),
  ]);

  if (!plataforma.enabled || plataforma.killSwitch) {
    await store.finishJob(tarefa.id, 'skipped', 'plataforma-desligada');
    return null;
  }
  if (!conta?.enabled || !reserva || reserva.state !== 'active' || !conta.handle) {
    await store.finishJob(tarefa.id, 'skipped', 'conta-nao-optou');
    return null;
  }
  if (tarefa.op === 'local-boost' && conta.paused) {
    await store.finishJob(tarefa.id, 'skipped', 'conta-pausada');
    return null;
  }
  const ehFederado = objeto?.state === 'federated' || (post?.federation && post.federation !== 'local');
  if (!post || post.isDeleted || post.visibility !== 'public' || !ehFederado) {
    await store.finishJob(tarefa.id, 'skipped', 'post-nao-federado');
    return null;
  }

  const ator = actorUrl(deps.origin, conta.handle);
  const objectUrl = noteUrl(deps.origin, tarefa.postId);
  const activityId = tarefa.op === 'local-boost'
    ? activityUrl(deps.origin, conta.handle, `boost-${tarefa.postId}`)
    : activityUrl(deps.origin, conta.handle, `unboost-${tarefa.postId}-${agora}`);
  const atividade = tarefa.op === 'local-boost'
    ? buildAnnounce(activityId, ator, objectUrl, [AS_PUBLIC], [followersUrl(deps.origin, conta.handle)], new Date(agora).toISOString())
    : buildUndo(activityId, ator, {
        id: activityUrl(deps.origin, conta.handle, `boost-${tarefa.postId}`),
        type: 'Announce',
        actor: ator,
        object: objectUrl,
      });

  const objectId = tarefa.op === 'local-boost'
    ? `lboost:${tarefa.postId}`
    : `lunboost:${tarefa.postId}:${agora}`;
  const corpo = JSON.stringify(atividade);
  const seguidores = await todosOsSeguidores(deps, tarefa.uid);
  const destinos = groupTargets(seguidores);

  let criadas = 0;
  for (const destino of destinos) {
    const id = deliveryId({ uid: tarefa.uid, op: tarefa.op, objectId, targetInbox: destino.inbox });
    const registro: DeliveryRecord = {
      id, uid: tarefa.uid, op: tarefa.op, objectId, activityId, targetInbox: destino.inbox, domain: destino.domain, body: corpo,
      status: 'pending', attempts: 0, nextAttemptAt: agora, lastDetail: null, lastOutcome: null, createdAtMs: agora, sentAtMs: null,
    };
    if (await store.putDeliveryIfAbsent(registro)) criadas++;
  }

  await store.finishJob(tarefa.id, 'done', null);
  await store.bump('worker.expandidas', criadas);
  return criadas;
}

/**
 * `Move`: a conta mudou de domínio.
 *
 * Sai assinado pelo ator ANTIGO — quem segue conhece a conta por ele, e um `Move` vindo de um ator que o seguidor não
 * conhece é descartado. O destino é o ator canônico, que declara `alsoKnownAs` apontando de volta: é esse par que o
 * Mastodon confere antes de mover o follow. Os vínculos NÃO são apagados aqui: quem decide se migra é o servidor de lá,
 * e apagar antes deixaria a pessoa sem seguidores dos dois lados.
 */
async function expandirMove(deps: WorkerDeps, tarefa: OutboundJob): Promise<number> {
  const { store } = deps;
  const agora = deps.now();
  const reserva = await store.findHandleByUid(tarefa.uid);
  if (!reserva) {
    await store.finishJob(tarefa.id, 'skipped', 'sem-handle');
    return 0;
  }
  // `note` carrega a origem ANTIGA (ex.: https://exercitodolula.app): é de lá que o Move fala.
  const origemAntiga = (tarefa.note ?? '').trim().replace(/\/+$/, '');
  if (!/^https:\/\/[a-z0-9.-]+$/i.test(origemAntiga)) {
    await store.finishJob(tarefa.id, 'skipped', 'origem-antiga-invalida');
    return 0;
  }
  const seguidores = await todosOsSeguidores(deps, tarefa.uid);
  const destinos = await destinosDe(deps, seguidores);
  const atorAntigo = actorUrl(origemAntiga, reserva.handle);
  const atorNovo = actorUrl(deps.origin, reserva.handle);
  const activityId = activityUrl(origemAntiga, reserva.handle, `move-${deps.randomId()}`);
  const corpo = JSON.stringify(buildMove(activityId, atorAntigo, atorNovo));

  let criadas = 0;
  for (const destino of destinos) {
    const registro: DeliveryRecord = {
      id: deliveryId({ uid: tarefa.uid, op: 'move', objectId: atorNovo, targetInbox: destino.inbox }),
      uid: tarefa.uid, op: 'move', objectId: atorNovo, activityId, targetInbox: destino.inbox, domain: destino.domain,
      body: corpo, status: 'pending', attempts: 0, nextAttemptAt: agora, lastDetail: null, lastOutcome: null, createdAtMs: agora, sentAtMs: null,
    };
    if (await store.putDeliveryIfAbsent(registro)) criadas++;
  }
  await store.finishJob(tarefa.id, 'done', null);
  return criadas;
}

async function expandirDeleteActor(deps: WorkerDeps, tarefa: OutboundJob): Promise<number> {
  const { store } = deps;
  const agora = deps.now();
  const reserva = await store.findHandleByUid(tarefa.uid);
  if (!reserva) {
    await store.finishJob(tarefa.id, 'skipped', 'sem-handle');
    return 0;
  }
  const seguidores = await todosOsSeguidores(deps, tarefa.uid);
  const destinos = await destinosDe(deps, seguidores);
  const ator = actorUrl(deps.origin, reserva.handle);
  const activityId = activityUrl(deps.origin, reserva.handle, `delete-actor-${deps.randomId()}`);
  const corpo = JSON.stringify(buildDeleteActor(activityId, ator));

  let criadas = 0;
  for (const destino of destinos) {
    const registro: DeliveryRecord = {
      id: deliveryId({ uid: tarefa.uid, op: 'delete-actor', objectId: reserva.handle, targetInbox: destino.inbox }),
      uid: tarefa.uid, op: 'delete-actor', objectId: reserva.handle, activityId, targetInbox: destino.inbox, domain: destino.domain,
      body: corpo, status: 'pending', attempts: 0, nextAttemptAt: agora, lastDetail: null, lastOutcome: null, createdAtMs: agora, sentAtMs: null,
    };
    if (await store.putDeliveryIfAbsent(registro)) criadas++;
  }
  // Os vínculos saem depois de os destinos virarem entregas: sem eles a pessoa não é mais "seguida" por ninguém.
  for (const s of seguidores) await store.deleteFollower(tarefa.uid, s.actorId);
  // E o resto do que a federação guarda dela: objetos, outbox e bloqueios. O handle fica reservado e a chave tem prazo.
  await store.purgeUserData(tarefa.uid);
  await store.finishJob(tarefa.id, 'done', null);
  return criadas;
}

// ───────────────────────── B. Entregar ─────────────────────────

type Resultado = 'sent' | 'retried' | 'dead' | 'cancelled' | 'deferred';

async function entregarUma(deps: WorkerDeps, entrega: DeliveryRecord, chaves: Map<string, string | null>): Promise<Resultado> {
  const { store } = deps;
  const agora = deps.now();

  const cancelar = async (motivo: string): Promise<Resultado> => {
    await store.updateDelivery(entrega.id, { status: 'cancelled', nextAttemptAt: null, lastDetail: motivo });
    await store.bump(`entrega.cancelada.${motivo}`);
    await store.audit({ atMs: agora, kind: 'delivery', domain: entrega.domain, decision: 'cancelada', reason: motivo, uid: entrega.uid });
    return 'cancelled';
  };

  // Plataforma: o botão de emergência vale até aqui.
  const plataforma = await store.getPlatform();
  if (!plataforma.enabled || plataforma.killSwitch) {
    await store.updateDelivery(entrega.id, { nextAttemptAt: agora + 60_000 });
    return 'deferred';
  }

  // Política da instância mudou desde que a entrega foi criada?
  const politica = await store.getInstancePolicy();
  if (decideInstance(entrega.domain, politica, deps.ownHost).decision === 'reject') return cancelar('dominio-recusado');

  // Disjuntor: domínio que vem falhando espera, sem gastar tentativa desta entrega.
  const saude = await store.getDomainHealth(entrega.domain);

  // RECUSA é diferente de QUEDA. O cooldown abaixo é para servidor fora do ar; este freio é para servidor que não
  // nos quer. Depois de recusas seguidas, a entrega para aquele domínio para de sair -- insistir contra quem nos
  // desfederou é desrespeito, não resiliência. A pausa tem prazo e cresce, então um engano se corrige sozinho.
  const consentimento = pausaDeConsentimento(saude, agora);
  if (consentimento.pausado) {
    await store.updateDelivery(entrega.id, {
      status: 'dead',
      attempts: entrega.attempts,
      nextAttemptAt: null,
      lastDetail: `dominio recusou ${consentimento.recusas}x seguidas`,
      lastOutcome: 'permanent',
    });
    await store.bump('entrega.morta.dominio-recusou');
    await store.audit({
      atMs: agora,
      kind: 'delivery',
      domain: entrega.domain,
      decision: 'nao-entregue',
      reason: `consentimento: ${consentimento.recusas} recusas seguidas, pausado ate ${new Date(consentimento.ate).toISOString()}`,
      uid: entrega.uid,
    });
    deps.log?.({ level: 'warn', event: 'ap.delivery.dead', uid: entrega.uid, op: entrega.op, domain: entrega.domain, attempts: entrega.attempts, reason: 'dominio-recusou' });
    return 'dead';
  }

  if (saude && saude.cooldownUntilMs > agora) {
    await store.updateDelivery(entrega.id, { nextAttemptAt: saude.cooldownUntilMs });
    return 'deferred';
  }

  // O PORTÃO, de novo, valendo.
  const conta = await store.getAccount(entrega.uid);
  const motivoNegado = await portaoDaEntrega(deps, entrega, conta);
  if (motivoNegado) return cancelar(motivoNegado);

  // Chave: decifrada uma vez por pessoa por execução.
  if (!chaves.has(entrega.uid)) {
    try {
      chaves.set(entrega.uid, await loadPrivateKey(deps, entrega.uid));
    } catch {
      chaves.set(entrega.uid, null);
    }
  }
  const privateKeyPem = chaves.get(entrega.uid) ?? null;
  const handle = conta?.handle ?? (await store.findHandleByUid(entrega.uid))?.handle ?? null;
  if (!privateKeyPem || !handle) {
    await store.updateDelivery(entrega.id, { status: 'dead', nextAttemptAt: null, lastDetail: 'sem-chave', lastOutcome: 'permanent' });
    await store.bump('entrega.morta.sem-chave');
    deps.log?.({ level: 'error', event: 'ap.delivery.dead', uid: entrega.uid, op: entrega.op, domain: entrega.domain, attempts: entrega.attempts, reason: 'sem-chave' });
    return 'dead';
  }

  const resposta = await deps.fetcher.post(entrega.targetInbox, entrega.body, { privateKeyPem, keyId: keyIdUrl(deps.origin, handle) });
  const resultado = classifyDelivery(
    { status: resposta.status, unsafe: resposta.unsafe, errorDetail: resposta.errorDetail, retryAfter: resposta.retryAfter },
    agora,
  );
  const tentativas = entrega.attempts + 1;

  if (resultado.outcome === 'sent') {
    await store.updateDelivery(entrega.id, { status: 'sent', attempts: tentativas, nextAttemptAt: null, sentAtMs: agora, lastDetail: resultado.detail, lastOutcome: 'sent' });
    // Entrega aceita zera TAMBEM as recusas: e isto que impede uma pessoa que nos bloqueou de pausar um servidor
    // inteiro onde o resto continua nos recebendo.
    await store.setDomainHealth({
      domain: entrega.domain,
      consecutiveFailures: 0,
      cooldownUntilMs: 0,
      lastFailureMs: saude?.lastFailureMs ?? 0,
      ...aposEntregaAceita(),
    });
    await store.bump('entrega.enviada');
    return 'sent';
  }

  // Só falha de INFRAESTRUTURA do destino conta para o disjuntor; um 404 ou 403 é recusa dele, não fora do ar.
  const infra = resposta.status === null || resposta.status >= 500 || resposta.status === 429 || resposta.status === 408;
  if (infra) {
    const falhas = (saude?.consecutiveFailures ?? 0) + 1;
    await store.setDomainHealth({
      domain: entrega.domain,
      consecutiveFailures: falhas,
      cooldownUntilMs: agora + domainCooldownSeconds(falhas) * 1000,
      lastFailureMs: agora,
      consecutiveRefusals: saude?.consecutiveRefusals ?? 0,
      refusedUntilMs: saude?.refusedUntilMs ?? 0,
      // DNS que não resolve separa a instância que SUMIU (domínio expirou, servidor fechou) da que está fora do ar por um
      // tempo. É o que o painel usa para listar domínios mortos; ninguém é suspenso por isto sem decisão humana.
      lastFailureClass: classeDaFalhaDeInfra(resposta.status, resposta.errorDetail),
    });
  } else if (ehRecusaDeConsentimento(resposta.status)) {
    // 403: o servidor nos conhece e recusou. Conta como recusa de consentimento, nao como queda.
    await store.setDomainHealth({
      domain: entrega.domain,
      consecutiveFailures: saude?.consecutiveFailures ?? 0,
      cooldownUntilMs: saude?.cooldownUntilMs ?? 0,
      lastFailureMs: agora,
      ...(saude?.lastFailureClass ? { lastFailureClass: saude.lastFailureClass } : {}),
      ...aposRecusa(saude, agora),
    });
  }

  const passo = nextStep(resultado, tentativas, agora);
  // A CLASSE da falha (assinatura recusada, bloqueio, rede, servidor fora do ar...) vai para contador e log. "Reagendada"
  // sozinho não dizia se era um servidor caído ou a nossa chave sendo recusada em todo lugar.
  const classe = failureClassOf(resposta.status, resultado.outcome);
  await store.bump(`entrega.falha.${classe}`);
  const base = { uid: entrega.uid, op: entrega.op, domain: entrega.domain, status: resposta.status, failureClass: classe, attempts: tentativas, detail: resultado.detail };
  if (passo.kind === 'retry') {
    await store.updateDelivery(entrega.id, { attempts: tentativas, nextAttemptAt: passo.at, lastDetail: resultado.detail, lastOutcome: resultado.outcome });
    await store.bump('entrega.reagendada');
    // 401 é o sinal de assinatura recusada: erro mesmo na primeira vez, porque quase sempre é problema NOSSO (chave, relógio).
    deps.log?.({ level: classe === 'assinatura' ? 'error' : 'warn', event: 'ap.delivery.failed', ...base, retryInSeconds: passo.delaySeconds });
    return 'retried';
  }
  await store.updateDelivery(entrega.id, { status: 'dead', attempts: tentativas, nextAttemptAt: null, lastDetail: `${resultado.detail} (${passo.reason})`, lastOutcome: resultado.outcome });
  await store.bump(`entrega.morta.${passo.reason}`);
  await store.bump(`entrega.morta-classe.${classe}`);
  // O motivo da morte leva o que o destino respondeu: "tentativas-esgotadas" sozinho não separava 401 de 503.
  await store.audit({ atMs: agora, kind: 'delivery', domain: entrega.domain, decision: 'morta', reason: `${passo.reason} (${resultado.detail})`, uid: entrega.uid });
  deps.log?.({ level: 'error', event: 'ap.delivery.dead', ...base, reason: passo.reason });
  return 'dead';
}

/** Devolve o motivo da recusa, ou `null` se a entrega pode sair. */
async function portaoDaEntrega(deps: WorkerDeps, e: DeliveryRecord, conta: AccountRecord | null): Promise<string | null> {
  const { store } = deps;

  if (e.op === 'delete-actor') return null; // só a plataforma importa, e já foi conferida

  if (e.op === 'accept' || e.op === 'reject') {
    // Resposta a um seguidor: a conta precisa estar viva.
    if (!conta?.enabled || conta.paused) return 'conta-inativa';
    const seguidor = (JSON.parse(e.body) as { object?: { actor?: unknown } }).object?.actor;
    if (typeof seguidor !== 'string') return 'seguidor-desfeito';
    const existe = Boolean(await store.getFollower(e.uid, seguidor));
    // Accept: o seguidor ainda precisa existir (se desfez antes de respondermos, não respondemos).
    if (e.op === 'accept' && !existe) return 'seguidor-desfeito';
    // Reject: sai DEPOIS de a pessoa remover o seguidor, então ele não pode existir. Se existe de novo, a pessoa o
    // aceitou outra vez no intervalo, e um Reject atrasado desfaria um vínculo legítimo.
    if (e.op === 'reject' && existe) return 'seguidor-refeito';
    return null;
  }

  if (e.op === 'local-boost' || e.op === 'local-unboost') {
    if (!conta?.enabled || !conta.handle || (e.op === 'local-boost' && conta.paused)) {
      return conta?.paused ? 'conta-pausada' : 'conta-nao-optou';
    }
    const localPostId = e.objectId.split(':')[1];
    if (!localPostId) return 'sem-alvo';
    const post = await store.getPost(localPostId);
    return post && !post.isDeleted ? null : 'post-apagado';
  }

  if (
    e.op === 'remote-like'
    || e.op === 'remote-unlike'
    || e.op === 'remote-boost'
    || e.op === 'remote-unboost'
    || e.op === 'remote-reply'
  ) {
    if (!conta?.enabled || conta.paused || !conta.handle) {
      return conta?.paused ? 'conta-pausada' : 'conta-nao-optou';
    }
    const remotePostId = e.objectId.split(':')[1];
    if (!remotePostId) return 'sem-alvo';
    const meta = await store.getRemotePostMeta?.(remotePostId);
    return meta ? null : 'sem-alvo';
  }

  const postId = e.op === 'create' ? e.objectId : e.objectId.split('@')[0];
  const [plataforma, post, objeto] = await Promise.all([store.getPlatform(), store.getPost(postId), store.getObject(postId)]);
  const op = e.op as GateOp;
  // Num create, o objeto só passa a existir DEPOIS das entregas serem criadas (é gravado pelo expansor ao final): se
  // ele já existe e é deste post, é a própria expansão. O portão do create não olha `apObjectId`.
  const decisao = evaluateGate({ op, platform: plataforma, account: contaParaPortao(conta), post: postParaPortao(post, objeto, e.uid) });
  return decisao.allowed ? null : decisao.reason;
}

// ───────────────────────── Para a interface ─────────────────────────

export type DeliveryView = {
  id: string;
  op: string;
  domain: string;
  status: DeliveryRecord['status'];
  attempts: number;
  detail: string | null;
  createdAtMs: number;
  sentAtMs: number | null;
};

/** O que a pessoa vê: destino, estado e motivo. Nunca o corpo nem a URL completa do inbox. */
export async function listDeliveriesForUser(deps: Pick<WorkerDeps, 'store'>, uid: string, limite = 50): Promise<DeliveryView[]> {
  const lista = await deps.store.listDeliveries(uid, limite);
  return lista.map((e) => ({
    id: e.id, op: e.op, domain: e.domain, status: e.status, attempts: e.attempts, detail: e.lastDetail,
    createdAtMs: e.createdAtMs, sentAtMs: e.sentAtMs,
  }));
}

export type DeliveryHealth = {
  total: number;
  byStatus: Record<string, number>;
  /** As que morreram, as mais recentes primeiro: é a fila de "o que precisa de alguém" (cada uma pode ser reagendada). */
  dead: { id: string; domain: string; op: string; attempts: number; detail: string | null; createdAtMs: number }[];
  /** Entregas que não foram (nem estão indo) porque o destino respondeu 401: a assinatura não foi aceita. */
  signatureRejected: number;
  /** Servidores com entrega morta ou falha, do pior para o melhor. */
  domainsWithTrouble: { domain: string; failing: number }[];
};

/** O estado de saúde das entregas de uma conta, para o painel de quem opera. Puro: recebe a lista que a pessoa já enxerga. */
export function summarizeDeliveries(views: readonly DeliveryView[], maxDead = 10): DeliveryHealth {
  const byStatus: Record<string, number> = {};
  const porDominio = new Map<string, number>();
  let signatureRejected = 0;
  for (const v of views) {
    byStatus[v.status] = (byStatus[v.status] ?? 0) + 1;
    const falhou = v.status === 'dead' || v.status === 'failed';
    if (falhou) porDominio.set(v.domain, (porDominio.get(v.domain) ?? 0) + 1);
    if (v.status !== 'sent' && v.status !== 'cancelled' && v.detail?.startsWith('HTTP 401')) signatureRejected++;
  }
  const dead = views
    .filter((v) => v.status === 'dead')
    .sort((a, b) => b.createdAtMs - a.createdAtMs)
    .slice(0, maxDead)
    .map((v) => ({ id: v.id, domain: v.domain, op: v.op, attempts: v.attempts, detail: v.detail, createdAtMs: v.createdAtMs }));
  const domainsWithTrouble = [...porDominio.entries()].map(([domain, failing]) => ({ domain, failing })).sort((a, b) => b.failing - a.failing).slice(0, 5);
  return { total: views.length, byStatus, dead, signatureRejected, domainsWithTrouble };
}

/** "Tentar de novo": só para a PRÓPRIA entrega, e só se morreu ou falhou. O portão roda de novo no envio. */
export async function retryDeliveryForUser(deps: Pick<WorkerDeps, 'store' | 'now'>, uid: string, id: string): Promise<'reagendada' | 'inexistente' | 'nao-permitido'> {
  const e = await deps.store.getDelivery(id);
  if (!e || e.uid !== uid) return 'inexistente'; // não revela que existe para outra pessoa
  if (e.status !== 'dead' && e.status !== 'failed') return 'nao-permitido';
  await deps.store.updateDelivery(id, { status: 'pending', attempts: 0, nextAttemptAt: deps.now(), lastDetail: 'reagendada pela pessoa' });
  await deps.store.bump('entrega.reagendada-manual');
  return 'reagendada';
}
