// src/lib/server/cicloDeVidaRemoto.ts
// Aplica à cópia local o que a origem respondeu sobre um post ou comentário remoto (410 apaga; 404 oculta e só apaga
// confirmado; 200 depois de um 404 restaura). A decisão é pura e testada em cicloDeVida.ts; aqui só se grava.
import { FieldValue, type DocumentReference } from 'firebase-admin/firestore';
import { CONFIRMACAO_DE_404_MS, decidirCiclo, type AcaoDoCiclo } from '@/lib/activitypub/cicloDeVida';
import { classificarLeitura, type LeituraAp } from '@/lib/activitypub/colecoes';
import { TUMULO_DE_POST_REMOTO } from '@/lib/activitypub/firestoreStore';
import { ACTIVITY_ACCEPT } from '@/lib/activitypub/remote';
import { remotePostIdOf } from '@/lib/activitypub/remoteIdentity';
import { adminFirestore } from '@/lib/server/firebaseAdmin';
import { federation } from '@/lib/server/federation';
import { podeLerDoDominio } from '@/lib/server/leituraRemota';

/**
 * Aplica o ciclo a UM documento (post ou comentário). Só mexe em cópia REMOTA: um documento sem `isRemoteFediverse`
 * nunca é tocado aqui, por mais que alguém consiga fazer uma URL apontar para ele.
 */
export async function aplicarCicloAoDocumento(
  ref: DocumentReference,
  leitura: LeituraAp,
  agora: number = Date.now(),
): Promise<AcaoDoCiclo> {
  if (leitura !== 'apagado' && leitura !== 'sumiu' && leitura !== 'ok') return 'manter';
  const snap = await ref.get();
  if (!snap.exists) return 'manter';
  const d = snap.data() as { isRemoteFediverse?: unknown; isDeleted?: unknown; remoteGoneAtMs?: unknown };
  if (d.isRemoteFediverse !== true) return 'manter';
  const acao = decidirCiclo(
    leitura,
    { isDeleted: d.isDeleted === true, remoteGoneAtMs: typeof d.remoteGoneAtMs === 'number' ? d.remoteGoneAtMs : null },
    agora,
  );
  if (acao === 'ocultar') {
    // Oculta sem apagar o texto: se a origem voltar a responder, a cópia volta inteira.
    await ref.update({ isDeleted: true, remoteGoneAtMs: agora });
  } else if (acao === 'restaurar') {
    await ref.update({ isDeleted: false, remoteGoneAtMs: FieldValue.delete() });
  } else if (acao === 'apagar') {
    // O mesmo túmulo do `Delete` recebido pelo inbox: texto e mídia saem, o documento fica para o post não ressuscitar
    // por um boost de terceiro.
    await ref.update({ ...TUMULO_DE_POST_REMOTO, remoteGoneAtMs: FieldValue.delete(), remoteGoneConfirmedAtMs: agora });
  }
  return acao;
}

/** Atalho para o post remoto cujo objeto AP é `objectUri`. */
export function aplicarCicloAoPost(objectUri: string, leitura: LeituraAp): Promise<AcaoDoCiclo> {
  return aplicarCicloAoDocumento(adminFirestore().collection('posts').doc(remotePostIdOf(objectUri)), leitura);
}

let ultimaConfirmacaoMs = 0;

/**
 * Confere de novo, na origem, alguns posts que ocultamos por 404 há mais de 6 h: apaga se o 404 se confirma, restaura se
 * o objeto voltou. Sem isto o 404 em duas etapas não fecharia nunca -- post oculto não aparece no feed, então ninguém
 * pediria a revalidação dele.
 *
 * É uma checagem limitada do que JÁ GUARDAMOS e JÁ respondeu 404, não uma varredura: no máximo `limite` objetos, no máximo
 * uma rodada por minuto por instância, e domínio suspenso ou em pausa não é consultado (o post só fica oculto).
 */
export async function confirmarRemocoesPendentes(limite = 3): Promise<number> {
  const agora = Date.now();
  if (agora - ultimaConfirmacaoMs < 60_000) return 0;
  ultimaConfirmacaoMs = agora;
  const snap = await adminFirestore()
    .collection('posts')
    .where('remoteGoneAtMs', '<=', agora - CONFIRMACAO_DE_404_MS)
    .limit(limite)
    .get()
    .catch(() => null);
  if (!snap) return 0;
  let mudou = 0;
  for (const docSnap of snap.docs) {
    const dados = docSnap.data() as Record<string, unknown>;
    const uri = [dados.remoteObjectId, dados.apObjectId, dados.remoteUrl].find(
      (u): u is string => typeof u === 'string' && u.startsWith('https://'),
    );
    if (!uri) continue;
    let dominio = '';
    try {
      dominio = new URL(uri).hostname.toLowerCase();
    } catch {
      continue;
    }
    if (!(await podeLerDoDominio(dominio)).pode) continue;
    let leitura: LeituraAp = 'falha';
    try {
      const r = await federation().inbox.fetcher.get(uri, { accept: ACTIVITY_ACCEPT });
      leitura = classificarLeitura(r.status, r.json);
    } catch {
      leitura = 'falha';
    }
    if ((await aplicarCicloAoDocumento(docSnap.ref, leitura, agora)) !== 'manter') mudou++;
  }
  return mudou;
}
