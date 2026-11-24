// src/app/api/log-access/route.ts
// Registro de acesso a páginas (contagens do painel do administrador). Grava SÓ o necessário para as contagens
// diárias (caminho, tipo de público, região aproximada e hora do servidor): nada de IP, navegador, sessão ou usuário
// (minimização de dados, LGPD). A região sai do IP em memória e o IP é descartado. A gravação é feita pelo Admin SDK:
// as regras do Firestore não deixam ninguém criar eventos direto (antes qualquer pessoa, sem login, criava eventos
// falsos, e o IP vinha do corpo da requisição, forjável).
import { NextRequest, NextResponse } from 'next/server';
import { createHash, randomBytes } from 'node:crypto';
import { FieldValue } from 'firebase-admin/firestore';
import { resolveIp } from '@/lib/services/geoService';
import { adminFirestore } from '@/lib/server/firebaseAdmin';
import { requestIp, takeRateLimit } from '@/lib/server/requestAuth';

const EVENTS_PER_WINDOW = 20;
const EVENT_WINDOW_MS = 10 * 1000;
const AUDIENCES = new Set(['auth', 'guest']);

let cachedSaltDate = '';
let cachedSaltValue = '';

async function getDailyRotatingSalt(dateIso: string): Promise<string> {
  if (cachedSaltDate === dateIso && cachedSaltValue) {
    return cachedSaltValue;
  }
  const db = adminFirestore();
  const saltRef = db.collection('_system').doc(`daily_salt_${dateIso}`);
  const snap = await saltRef.get();
  if (snap.exists && typeof snap.data()?.salt === 'string') {
    cachedSaltDate = dateIso;
    cachedSaltValue = snap.data()!.salt;
    return cachedSaltValue;
  }
  const freshSalt = randomBytes(32).toString('hex');
  try {
    await saltRef.create({
      salt: freshSalt,
      date: dateIso,
      createdAt: FieldValue.serverTimestamp(),
    });
    cachedSaltDate = dateIso;
    cachedSaltValue = freshSalt;
    return freshSalt;
  } catch {
    const retry = await saltRef.get();
    const existing = typeof retry.data()?.salt === 'string' ? retry.data()!.salt : freshSalt;
    cachedSaltDate = dateIso;
    cachedSaltValue = existing;
    return existing;
  }
}

async function recordDailyUniqueAccess(
  ip: string,
  userAgent: string,
  path: string,
  audienceType: string,
): Promise<void> {
  if (!ip) return;
  const dateIso = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const salt = await getDailyRotatingSalt(dateIso);
  const visitorHash = createHash('sha256')
    .update(`${salt}:${ip}:${userAgent.slice(0, 120)}`)
    .digest('hex')
    .slice(0, 16);

  const db = adminFirestore();

  // 1. Único diário no site inteiro
  const siteBucketId = `${dateIso}_${audienceType}_site`;
  try {
    await db
      .collection('access_uniques_daily')
      .doc(siteBucketId)
      .collection('hashes')
      .doc(visitorHash)
      .create({ at: FieldValue.serverTimestamp() });

    await db
      .collection('access_agg_daily')
      .doc(`${dateIso}_${audienceType}_site_uniques`)
      .set(
        {
          date: dateIso,
          path: '__site_unique__',
          audienceType,
          uniqueCount: FieldValue.increment(1),
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
  } catch {
    // Já contabilizado hoje para este hash anônimo
  }

  // 2. Único diário específico em /search
  const cleanRoute = path.replace(/^\/(?:pt-BR|en)(?=\/|$)/, '') || '/';
  if (cleanRoute.startsWith('/search')) {
    const searchBucketId = `${dateIso}_${audienceType}_search`;
    try {
      await db
        .collection('access_uniques_daily')
        .doc(searchBucketId)
        .collection('hashes')
        .doc(visitorHash)
        .create({ at: FieldValue.serverTimestamp() });

      await db
        .collection('access_agg_daily')
        .doc(`${dateIso}_${audienceType}_search_uniques`)
        .set(
          {
            date: dateIso,
            path: '__search_unique__',
            audienceType,
            uniqueCount: FieldValue.increment(1),
            updatedAt: FieldValue.serverTimestamp(),
          },
          { merge: true },
        );
    } catch {
      // Já contabilizado hoje para /search
    }
  }
}

export async function POST(request: NextRequest) {
  try {
    const ip = requestIp(request);
    if (!takeRateLimit(`access:${ip}`, EVENTS_PER_WINDOW, EVENT_WINDOW_MS)) {
      return NextResponse.json({ message: 'Too many requests.' }, { status: 429 });
    }

    const body = await request.json().catch(() => null);
    const rawPath = typeof body?.path === 'string' ? body.path : '';
    const path = rawPath.split(/[?#]/)[0].slice(0, 300); // sem parâmetros (podem carregar dados pessoais)
    const audienceType = typeof body?.audienceType === 'string' ? body.audienceType : '';
    if (!path.startsWith('/') || !AUDIENCES.has(audienceType)) {
      return NextResponse.json({ message: 'Invalid event data.' }, { status: 400 });
    }

    const geo = resolveIp(ip);
    const userAgent = request.headers.get('user-agent') || '';
    await Promise.all([
      adminFirestore().collection('access_events').add({
        path,
        audienceType,
        geo: {
          countryCode: geo?.countryCode ?? null,
          countryName: geo?.countryName ?? null,
          stateCode: geo?.stateCode ?? null,
          stateName: geo?.stateName ?? null,
          city: geo?.city ?? null,
        },
        serverTimestamp: FieldValue.serverTimestamp(),
      }),
      recordDailyUniqueAccess(ip, userAgent, path, audienceType).catch(() => undefined),
    ]);

    return NextResponse.json({ message: 'Event logged.' }, { status: 202 });
  } catch (error) {
    console.error('Error logging access event:', error);
    return NextResponse.json({ message: 'Internal Server Error.' }, { status: 500 });
  }
}
