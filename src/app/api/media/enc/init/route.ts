// src/app/api/media/enc/init/route.ts
// Prepara o envio de um anexo CIFRADO e grande (vídeo em conversa protegida).
//
// É irmã de /api/media/video/init, com uma diferença que é o ponto inteiro: aqui NÃO existe job de FFmpeg. O
// pipeline de vídeo precisa LER os bytes para transcodificar, e nesta conversa o servidor não pode — ele recebe um
// borrão opaco e devolve o mesmo borrão. Quem abre é só quem tem a chave, no aparelho.
//
// O que o servidor ainda faz, e continua podendo fazer: dizer de quem é o arquivo, de que tamanho, e quem pode
// baixá-lo. A autorização de leitura é a mesma do resto dos anexos (/mp/<id>, refeita a cada requisição contra a
// conversa e os bloqueios) — por isso o registro aqui precisa sair com `kind: 'dm'` e `visibility: 'private'`.
import { FieldValue } from 'firebase-admin/firestore';
import { NextResponse, type NextRequest } from 'next/server';
import { generateMediaId, privateMediaPath } from '@/lib/media/mediaId';
import { LIMITE_MIDIA_PROTEGIDA, tamanhoCifrado } from '@/lib/crypto/e2eeMediaChunks';
import { encryptedMediaPath, isVideoDurationAllowed } from '@/lib/media/videoPolicy';
import { adminBucket, adminFirestore } from '@/lib/server/firebaseAdmin';
import { requestIp, takeRateLimit, verifyRequestMember } from '@/lib/server/requestAuth';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const INIT_WINDOW_MS = 10 * 60 * 1000;

/** Folga sobre o teto em claro: cada pedaço leva 16 bytes de etiqueta, e a conta já está em tamanhoCifrado(). */
const MAX_BYTES_CIFRADOS = tamanhoCifrado(LIMITE_MIDIA_PROTEGIDA);

const json = (body: Record<string, unknown>, status: number) =>
  NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } });

interface InitBody {
  /** Id devolvido pelo init: fecha o envio e APAGA o token permanente do objeto. */
  finalizar?: unknown;
  /** Tamanho do arquivo CIFRADO que será enviado. */
  size?: unknown;
  /** Duração lida no aparelho, quando o contêiner entrega. Mesmo teto do vídeo comum. */
  durationSeconds?: unknown;
  /** 'video' | 'poster': só muda o nome do objeto; os dois são opacos para o servidor. */
  papel?: unknown;
}

export async function POST(request: NextRequest) {
  const uid = await verifyRequestMember(request);
  if (!uid) return json({ error: 'unauthorized' }, 401);

  const ip = requestIp(request);
  if (
    !takeRateLimit(`enc-init:uid:${uid}`, 30, INIT_WINDOW_MS) ||
    !takeRateLimit(`enc-init:ip:${ip}`, 60, INIT_WINDOW_MS)
  ) {
    return json({ error: 'too-many-requests' }, 429);
  }

  let body: InitBody;
  try {
    body = (await request.json()) as InitBody;
  } catch {
    return json({ error: 'invalid-request' }, 400);
  }

  // ── Fechamento do envio ──
  // O SDK Web do Firebase grava `firebaseStorageDownloadTokens` no objeto NO MOMENTO DO UPLOAD, mesmo sem ninguem
  // chamar getDownloadURL(). Esse token e uma URL publica permanente que nao passa pela autorizacao do /mp e nao
  // se revoga tirando acesso -- foi exatamente o defeito que a rodada de midia de 2026-11-11 corrigiu em 19
  // objetos. O envio cifrado precisa do protocolo retomavel (sao ate 200 MB), entao o token e apagado aqui, pelo
  // servidor, assim que o upload termina.
  if (typeof body.finalizar === 'string' && body.finalizar) {
    const mediaId = body.finalizar;
    const doc = await adminFirestore().collection('media').doc(mediaId).get();
    const dados = doc.data();
    if (!doc.exists || !dados || dados.ownerUid !== uid) return json({ error: 'not-found' }, 404);
    try {
      const objeto = adminBucket().file(String(dados.storagePath));
      const [meta] = await objeto.getMetadata();
      await objeto.setMetadata({
        metadata: { ...(meta.metadata ?? {}), firebaseStorageDownloadTokens: null },
      });
      const tamanho = Number(meta.size ?? 0);
      if (Number.isFinite(tamanho) && tamanho > 0) {
        await doc.ref.update({ size: tamanho, updatedAt: FieldValue.serverTimestamp() });
      }
    } catch (error) {
      console.error('[enc init] falha ao fechar o envio:', error);
      return json({ error: 'finalize-failed' }, 500);
    }
    return json({ mediaId, finalizado: true }, 200);
  }

  const size = Number(body.size);
  const papel = body.papel === 'poster' ? 'poster' : 'video';
  const durationSeconds = body.durationSeconds == null ? null : Number(body.durationSeconds);

  if (!Number.isSafeInteger(size) || size <= 0 || size > MAX_BYTES_CIFRADOS) {
    return json({ error: 'invalid-file-size', maxBytes: MAX_BYTES_CIFRADOS }, 413);
  }
  if (papel === 'video' && !isVideoDurationAllowed(durationSeconds)) {
    return json({ error: 'video-too-long', maxDurationSeconds: 10_200 }, 422);
  }

  const mediaId = generateMediaId();
  const storagePath = encryptedMediaPath(uid, mediaId);
  const db = adminFirestore();

  try {
    await db.collection('media').doc(mediaId).create({
      storagePath,
      // Opaco de propósito: o servidor não sabe (nem pode saber) que dentro disso há um vídeo.
      contentType: 'application/octet-stream',
      size,
      ownerUid: uid,
      visibility: 'private',
      kind: 'dm',
      encrypted: true,
      encryptedRole: papel,
      // Não há etapa de processamento: o que subiu é o que será servido.
      processingStatus: 'ready',
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
  } catch (error) {
    console.error('[enc init] falha ao criar registro:', error);
    return json({ error: 'init-failed' }, 500);
  }

  return json({ mediaId, storagePath, downloadURL: privateMediaPath(mediaId) }, 201);
}
