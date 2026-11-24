// src/lib/server/firebaseAdmin.ts
// Firebase Admin para as rotas de API (servidor). Em produção usa a conta de serviço do App Hosting; com os emuladores
// ligados (NEXT_PUBLIC_USE_EMULATORS), aponta Auth e Firestore para eles. Nunca importar em código do navegador.
import { getApps, initializeApp, type App } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
import { getDatabase } from 'firebase-admin/database';
import { getMessaging } from 'firebase-admin/messaging';
import { getStorage } from 'firebase-admin/storage';

function adminApp(): App {
  const useEmulators = process.env.NEXT_PUBLIC_USE_EMULATORS === 'true';
  if (useEmulators) {
    process.env.FIREBASE_AUTH_EMULATOR_HOST ||= '127.0.0.1:9099';
    process.env.FIRESTORE_EMULATOR_HOST ||= '127.0.0.1:8080';
    process.env.FIREBASE_DATABASE_EMULATOR_HOST ||= '127.0.0.1:9000';
    process.env.FIREBASE_STORAGE_EMULATOR_HOST ||= '127.0.0.1:9199';
  }
  const projectId = process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID;
  const databaseURL =
    process.env.NEXT_PUBLIC_FIREBASE_DATABASE_URL ||
    (useEmulators && projectId
      ? `http://127.0.0.1:9000/?ns=${projectId}-default-rtdb`
      : projectId
        ? `https://${projectId}-default-rtdb.firebaseio.com`
        : undefined);
  return getApps()[0] ?? initializeApp({
    projectId,
    storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
    ...(databaseURL ? { databaseURL } : {}),
  });
}

export const adminAuth = () => getAuth(adminApp());

/** Firestore do banco nomeado do app (o mesmo do cliente). */
export const adminFirestore = () =>
  getFirestore(adminApp(), process.env.NEXT_PUBLIC_FIRESTORE_DATABASE_ID || '(default)');

/**
 * Bucket do Storage, pelo Admin SDK. Usado pela rota /m/[id] para ler bytes SEM token de download: é o que permite a
 * URL pública não carregar credencial nenhuma. Nunca importar em código do navegador.
 */
export const adminBucket = () => getStorage(adminApp()).bucket();

/** Realtime Database pelo Admin SDK (usado para notificar dispositivos conectados em tempo real). */
export const adminDatabase = () => getDatabase(adminApp());

/** Cloud Messaging pelo Admin SDK (alertas de segurança/login e notificações push). */
export const adminMessaging = () => getMessaging(adminApp());
