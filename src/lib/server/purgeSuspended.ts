// src/lib/server/purgeSuspended.ts
// Remoção física paginada no Firestore de perfis, posts, comentários, vínculos e índices de domínios suspensos.
import type { DocumentData, Query, QueryDocumentSnapshot } from 'firebase-admin/firestore';
import { adminFirestore } from '@/lib/server/firebaseAdmin';
import { SUSPENDED_FEDIVERSE_DOMAINS } from '@/lib/federation/suspendedDomains';
import { hostCasaComDominios, registroEhDosDominios } from '@/lib/federation/registroDeDominio';

const PAGE_SIZE = 300;

export type OpcoesDaPurga = {
  /**
   * Domínios a remover. Sem isto, vale a lista fixa de suspensos do código. Com isto, a purga mira só esses -- é o que o
   * painel usa para atender UM servidor sem apagar o que ninguém pediu.
   */
  dominios?: string[];
  /** Ensaio: conta tudo o que seria removido e NÃO apaga nada, nem grava política ou auditoria. */
  ensaio?: boolean;
};

async function scanPaginated(
  baseQuery: Query<DocumentData>,
  onDoc: (docSnap: QueryDocumentSnapshot<DocumentData>) => Promise<void>,
): Promise<void> {
  let cursor: QueryDocumentSnapshot<DocumentData> | null = null;
  while (true) {
    let q = baseQuery.limit(PAGE_SIZE);
    if (cursor) q = q.startAfter(cursor);
    const snap = await q.get();
    if (snap.empty) break;
    for (const docSnap of snap.docs) {
      await onDoc(docSnap);
    }
    if (snap.docs.length < PAGE_SIZE) break;
    cursor = snap.docs[snap.docs.length - 1];
  }
}

/**
 * Executa UM passo da purga sem deixar que ele derrube os seguintes.
 *
 * Isto existe por um defeito real: o passo dos comentarios usa consulta de GRUPO DE COLECAO, que exige indice
 * declarado. Sem o indice, aquele `await` lancava e os passos de 4 a 9 -- ap_remote_comments, ap_remote_actors,
 * ap_followers, ap_following, ap_handles, fontes, a politica e a auditoria -- NUNCA RODAVAM. A purga parecia
 * existir e nao removia quase nada. Uma remocao prometida a alguem nao pode depender de todos os passos darem
 * certo: o que der, tem de ser feito, e o que falhar tem de aparecer no relatorio com o nome e o motivo.
 */
async function passo(
  nome: string,
  falhas: Array<{ passo: string; erro: string }>,
  executar: () => Promise<void>,
): Promise<void> {
  try {
    await executar();
  } catch (error) {
    const motivo = error instanceof Error ? error.message : String(error);
    console.error(`[purga] passo "${nome}" falhou:`, motivo);
    falhas.push({ passo: nome, erro: motivo.slice(0, 300) });
  }
}

export async function purgeSuspendedDomainsFromFirestore(opcoes: OpcoesDaPurga = {}) {
  const db = adminFirestore();
  const ensaio = opcoes.ensaio === true;
  const alvos = (opcoes.dominios ?? [])
    .map((d) => d.trim().toLowerCase().replace(/\.$/, ''))
    .filter((d) => /^[a-z0-9.-]+\.[a-z]{2,}$/.test(d));
  // PEDIDO EXPLÍCITO NUNCA CAI NO PADRÃO. Se `dominios` veio e nenhum é válido, a purga não roda: cair na lista fixa
  // inteira transformaria um domínio digitado errado no painel em remoção de todos os suspensos de uma vez.
  const dominios = opcoes.dominios !== undefined ? Array.from(new Set(alvos)) : [...SUSPENDED_FEDIVERSE_DOMAINS];
  const ehDoAlvo = (dados: Record<string, unknown> | undefined, idDoDoc?: string) =>
    registroEhDosDominios(dados, dominios, idDoDoc);
  /** Apaga de verdade só fora do ensaio. A contagem é a mesma nos dois casos: o ensaio mostra exatamente o que sairia. */
  const remover = async (apagar: () => Promise<unknown>) => {
    if (!ensaio) await apagar();
  };
  const userIds = new Set<string>();
  const falhas: Array<{ passo: string; erro: string }> = [];
  const counts = {
    users: 0,
    posts: 0,
    comments: 0,
    ap_remote_comments: 0,
    ap_remote_actors: 0,
    ap_followers: 0,
    ap_following: 0,
    ap_handles: 0,
    fontes: 0,
    ap_deliveries: 0,
  };
  if (dominios.length === 0) {
    return {
      domains: [] as string[],
      counts,
      executedAtMs: Date.now(),
      falhas: [{ passo: 'entrada', erro: 'nenhum dominio valido foi informado; nada foi feito' }],
      completo: false,
      ensaio,
    };
  }

  // 1. Usuários remotos
  await passo('users', falhas, () => scanPaginated(
    db.collection('users').where('isRemoteFediverse', '==', true),
    async (docSnap) => {
      if (ehDoAlvo(docSnap.data())) {
        userIds.add(docSnap.id);
        counts.users++;
        await remover(() => db.recursiveDelete(docSnap.ref));
      }
    },
  ));

  // 2. Posts remotos (paginado)
  await passo('posts', falhas, () => scanPaginated(
    db.collection('posts').where('isRemoteFediverse', '==', true),
    async (docSnap) => {
      const data = docSnap.data();
      if (userIds.has(String(data.userId || '')) || ehDoAlvo(data)) {
        counts.posts++;
        await remover(() => db.recursiveDelete(docSnap.ref));
      }
    },
  ));

  // 3. Comentários remotos (inclusive em posts locais). Consulta de GRUPO DE COLEÇÃO: exige o fieldOverride
  // COLLECTION_GROUP de `comments.isRemoteFediverse` em firestore.indexes.json. Sem ele, este passo lança -- e era
  // por isso que todos os seguintes nunca rodavam.
  await passo('comments', falhas, () => scanPaginated(
    db.collectionGroup('comments').where('isRemoteFediverse', '==', true),
    async (docSnap) => {
      const data = docSnap.data();
      if (userIds.has(String(data.userId || '')) || ehDoAlvo(data)) {
        counts.comments++;
        await remover(() => db.recursiveDelete(docSnap.ref));
      }
    },
  ));

  // 4. ap_remote_comments
  await passo('ap_remote_comments', falhas, () => scanPaginated(db.collection('ap_remote_comments'), async (docSnap) => {
    if (ehDoAlvo(docSnap.data())) {
      counts.ap_remote_comments++;
      await remover(() => docSnap.ref.delete());
    }
  }));

  // 5. ap_remote_actors
  await passo('ap_remote_actors', falhas, () => scanPaginated(db.collection('ap_remote_actors'), async (docSnap) => {
    if (ehDoAlvo(docSnap.data(), docSnap.id) || hostCasaComDominios(docSnap.id, dominios)) {
      counts.ap_remote_actors++;
      await remover(() => docSnap.ref.delete());
    }
  }));

  // 6. ap_followers (coleção plana: doc('${uid}__${sha(actorId)}'))
  await passo('ap_followers', falhas, () => scanPaginated(db.collection('ap_followers'), async (docSnap) => {
    if (ehDoAlvo(docSnap.data())) {
      counts.ap_followers++;
      await remover(() => docSnap.ref.delete());
    }
  }));

  // 7. ap_following/{uid}/actors
  await passo('ap_following', falhas, async () => {
    const followingParents = await db.collection('ap_following').get();
    for (const parent of followingParents.docs) {
      const actorsSnap = await parent.ref.collection('actors').get();
      for (const actorDoc of actorsSnap.docs) {
        if (ehDoAlvo(actorDoc.data())) {
          counts.ap_following++;
          await remover(() => actorDoc.ref.delete());
        }
      }
    }
  });

  // 8. ap_handles
  await passo('ap_handles', falhas, () => scanPaginated(db.collection('ap_handles'), async (docSnap) => {
    if (ehDoAlvo(docSnap.data(), docSnap.id)) {
      counts.ap_handles++;
      await remover(() => docSnap.ref.delete());
    }
  }));

  // 9. fontes (índice público da aba Fontes)
  await passo('fontes', falhas, () => scanPaginated(db.collection('fontes'), async (docSnap) => {
    if (ehDoAlvo(docSnap.data())) {
      counts.fontes++;
      await remover(() => docSnap.ref.delete());
    }
  }));

  // 9b. ap_deliveries: a fila guarda o CORPO da atividade que enviamos aquele servidor. Remocao pedida inclui isso.
  await passo('ap_deliveries', falhas, () => scanPaginated(db.collection('ap_deliveries'), async (docSnap) => {
    if (ehDoAlvo(docSnap.data())) {
      counts.ap_deliveries++;
      await remover(() => docSnap.ref.delete());
    }
  }));

  // 10. Política de instância + registro de auditoria
  const executedAtMs = Date.now();
  if (ensaio) {
    return { domains: dominios, counts, executedAtMs, falhas, completo: falhas.length === 0, ensaio: true };
  }
  for (const domain of dominios) {
    await db.collection('ap_instance_policy').doc(domain).set(
      {
        action: 'suspend',
        updatedAtMs: executedAtMs,
        reason: 'Desfederação e remoção de conteúdo atendida',
      },
      { merge: true },
    );
  }

  await db.collection('ap_audit').add({
    action: 'purge_suspended_domains',
    domains: dominios,
    counts,
    executedAtMs,
    falhas,
    completo: falhas.length === 0,
    expireAt: new Date(executedAtMs + 90 * 86_400_000),
  });

  return {
    domains: dominios,
    ensaio: false,
    counts,
    executedAtMs,
    // Um passo que falhou aparece aqui com nome e motivo. Relatorio de remocao que esconde o que nao foi feito
    // nao e relatorio: e o que faz alguem avisar "esta tudo removido" sem estar.
    falhas,
    completo: falhas.length === 0,
  };
}
