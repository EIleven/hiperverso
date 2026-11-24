// src/app/api/ap/sync-counts/route.ts
// Revalidação dos contadores de posts remotos (ap_*) em segundo plano: o feed manda os ids que chegaram perto da tela (em lote,
// ver src/lib/feed/remoteCountSync.ts) e o servidor confere o número na instância de origem.
//
// Anônima, como /api/ap/remote-post-interactions (quem não entrou também vê posts do Fediverso), e por isso com freios: cada
// chamada pode custar buscas a servidores ALHEIOS. Os freios, de fora para dentro:
//   1. ritmo por IP: no máximo 10 requisições por minuto e 60 posts por minuto (cobrado por post, não por requisição);
//   2. ids estritos (`ap_` + id curto) e no máximo 15 por requisição (parseSyncIds);
//   3. no máximo 4 posts em andamento por requisição (mapWithLimit);
//   4. dentro de syncRemotePostCounts: validade por post (3 min, em memória e no documento) e freio por servidor remoto
//      (2 ao mesmo tempo, 20 por minuto, pausa no 429/503). Ver src/lib/federation/countSyncPolicy.ts.
// A resposta é só um resumo (`results`); o número novo chega ao cartão pelo ouvinte do documento do post.
import type { NextRequest } from 'next/server';
import { mapWithLimit, parseSyncIds } from '@/lib/federation/countSyncPolicy';
import { json, readJsonObject } from '@/lib/server/federation';
import { syncRemotePostCounts } from '@/lib/server/remotePostInteractions';
import { confirmarRemocoesPendentes } from '@/lib/server/cicloDeVidaRemoto';
import { requestIp, takeRateLimit } from '@/lib/server/requestAuth';

export const dynamic = 'force-dynamic';

const REQUESTS_PER_MINUTE = 10;
const POSTS_PER_MINUTE = 60;
const PARALLEL_POSTS = 4;

export async function POST(request: NextRequest) {
  const ip = requestIp(request);
  if (!takeRateLimit(`ap-sync-counts:${ip}`, REQUESTS_PER_MINUTE, 60_000)) {
    return json(429, { error: 'muitas-requisicoes' }, { 'Retry-After': '30' });
  }

  const body = await readJsonObject(request);
  if (!body) return json(400, { error: 'corpo-invalido' });

  const ids = parseSyncIds(body.postIds);
  const aceitos = ids.filter(() => takeRateLimit(`ap-sync-counts-posts:${ip}`, POSTS_PER_MINUTE, 60_000));
  const desfechos = await mapWithLimit(aceitos, PARALLEL_POSTS, (id) => syncRemotePostCounts(id));
  // Fecha, aos poucos, o 404 em duas etapas: posts ocultos há mais de 6 h são conferidos de novo na origem (no máximo 3,
  // uma vez por minuto por instância). Melhor esforço: nunca atrasa nem derruba a resposta do feed.
  await confirmarRemocoesPendentes().catch(() => 0);

  const results: Record<string, number> = {};
  for (const desfecho of desfechos) results[desfecho] = (results[desfecho] ?? 0) + 1;
  const fora = ids.length - aceitos.length;
  if (fora > 0) results.throttled = (results.throttled ?? 0) + fora;
  return json(200, { synced: results.updated ?? 0, results });
}
