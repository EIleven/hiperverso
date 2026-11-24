'use client';

// Cliente do navegador para a API de gestão da federação (/api/ap/*). Autentica com o ID token do Firebase no
// cabeçalho Authorization: a API não aceita cookie, porque ação que muda estado não pode depender dele.
import type { User as FirebaseUser } from 'firebase/auth';

export type FederationStatus = {
  platformEnabled: boolean;
  enabled: boolean;
  paused: boolean;
  handle: string | null;
  acct: string | null;
  eligibleSince: number | null;
  followers: number;
  movedTo: string | null;
};

export type DeliveryItem = {
  id: string;
  op: string;
  domain: string;
  status: 'pending' | 'sent' | 'failed' | 'dead' | 'cancelled';
  attempts: number;
  detail: string | null;
  createdAtMs: number;
  sentAtMs: number | null;
};

export type FollowerItem = { actorId: string; handle: string | null; name: string | null; domain: string; sinceMs: number };
export type BlockItem = { scope: 'actor' | 'domain'; value: string };

/** Erro da API com o código estável (ex.: "email-nao-confirmado"), que a interface traduz. */
export class FederationApiError extends Error {
  code: string;
  status: number;
  constructor(code: string, status: number) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

async function chamar<T>(firebaseUser: FirebaseUser, metodo: 'GET' | 'POST', caminho: string, corpo?: unknown): Promise<T> {
  const token = await firebaseUser.getIdToken();
  const headers = new Headers({ Authorization: `Bearer ${token}` });
  if (corpo !== undefined) headers.set('Content-Type', 'application/json');
  const resposta = await fetch(caminho, {
    method: metodo, headers, cache: 'no-store',
    ...(corpo !== undefined ? { body: JSON.stringify(corpo) } : {}),
  });
  const json = await resposta.json().catch(() => ({}));
  if (!resposta.ok) throw new FederationApiError(typeof json?.error === 'string' ? json.error : 'erro-desconhecido', resposta.status);
  return json as T;
}

export const getFederationStatus = (u: FirebaseUser) => chamar<FederationStatus>(u, 'GET', '/api/ap/account');
export const changeFederation = (u: FirebaseUser, action: 'enable' | 'pause' | 'resume' | 'disable') =>
  chamar<FederationStatus>(u, 'POST', '/api/ap/account', { action });

export const getDeliveries = async (u: FirebaseUser) => (await chamar<{ items: DeliveryItem[] }>(u, 'GET', '/api/ap/deliveries')).items;
export const retryDelivery = (u: FirebaseUser, id: string) => chamar<{ ok: true }>(u, 'POST', '/api/ap/deliveries', { action: 'retry', id });

const autoFederationSyncs = new Map<string, Promise<void>>();

/**
 * Garante de forma idempotente e dedupada que a federação esteja habilitada na sessão
 * apenas quando a plataforma suportar/habilitar federação (evita POST 503 em dev local).
 */
export function ensureFederationEnabledForSession(firebaseUser: FirebaseUser): Promise<void> {
  if (!firebaseUser.emailVerified && firebaseUser.email) {
    return Promise.resolve();
  }
  const existing = autoFederationSyncs.get(firebaseUser.uid);
  if (existing) return existing;

  const task = (async () => {
    try {
      const status = await getFederationStatus(firebaseUser);
      if (status.platformEnabled && !status.enabled) {
        await changeFederation(firebaseUser, 'enable');
      }
    } catch {
      // Silencioso: federação opcional não deve quebrar ou poluir a sessão.
    }
  })();

  autoFederationSyncs.set(firebaseUser.uid, task);
  return task;
}

export const getFollowers = (u: FirebaseUser, after?: string | null) =>
  chamar<{ items: FollowerItem[]; next: string | null }>(u, 'GET', `/api/ap/followers${after ? `?after=${encodeURIComponent(after)}` : ''}`);
export const removeFollower = (u: FirebaseUser, actorId: string) => chamar<{ ok: true }>(u, 'POST', '/api/ap/followers', { action: 'remove', actorId });

export const getBlocks = async (u: FirebaseUser) => (await chamar<{ items: BlockItem[] }>(u, 'GET', '/api/ap/blocks')).items;
export const addBlock = (u: FirebaseUser, scope: BlockItem['scope'], value: string) =>
  chamar<{ ok: true; removedFollowers: number }>(u, 'POST', '/api/ap/blocks', { action: 'add', scope, value });
export const removeBlock = (u: FirebaseUser, scope: BlockItem['scope'], value: string) =>
  chamar<{ ok: true }>(u, 'POST', '/api/ap/blocks', { action: 'remove', scope, value });
