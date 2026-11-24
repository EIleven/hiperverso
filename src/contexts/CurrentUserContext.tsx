// src/contexts/CurrentUserContext.tsx
'use client';

import type { User as AppUserType } from '@/lib/types';
import React, { createContext, useContext, useEffect, useRef, useSyncExternalStore } from 'react';
import { onAuthStateChanged, type User as FirebaseUser } from 'firebase/auth';
import { doc, onSnapshot } from 'firebase/firestore';
import { auth, db } from '@/lib/firebase';
import { getUser, invalidateUserCache } from '@/lib/services/userService';
import { clearViewerActions } from '@/lib/services/viewerActions';
import { privateAccountRef, reconcilePrivateEmail } from '@/lib/services/userPrivate';
import { initializePresence, goOffline, initializeGuestPresence, goOfflineGuest } from '@/lib/services/presenceService';
import { usePathname } from 'next/navigation';
import { logAccessEvent } from '@/lib/services/telemetryService';
import { ensureMembershipToken } from '@/lib/services/membership';

// Define a custom event for profile updates
const PROFILE_UPDATE_EVENT = 'profileUpdated';
export const dispatchProfileUpdateEvent = (user: AppUserType) => {
  window.dispatchEvent(new CustomEvent(PROFILE_UPDATE_EVENT, { detail: user }));
};

interface CurrentUserContextType {
  currentUser: AppUserType | null;
  firebaseUser: FirebaseUser | null;
  isLoading: boolean;
  refreshCurrentUser: () => Promise<void>;
  logout: () => void; // Added logout function
}

type Listener = () => void;

/** O que um cartão do feed mostra de quem está logado (avatar e nome ao comentar). Muda só quando um destes valores muda. */
export type ViewerSummary = Pick<AppUserType, 'id' | 'name' | 'username' | 'avatarUrl' | 'data-ai-hint'>;

const toViewerSummary = (user: AppUserType | null): ViewerSummary | null => user
  ? { id: user.id, name: user.name, username: user.username, avatarUrl: user.avatarUrl, 'data-ai-hint': user['data-ai-hint'] }
  : null;

const sameViewerSummary = (a: ViewerSummary | null, b: ViewerSummary | null): boolean => (
  a === b || (!!a && !!b
    && a.id === b.id && a.name === b.name && a.username === b.username
    && a.avatarUrl === b.avatarUrl && a['data-ai-hint'] === b['data-ai-hint'])
);

/**
 * Quem está logado, FORA do React. Antes isto era estado do provedor com o valor do contexto recriado a cada renderização:
 * qualquer mudança no perfil (um seguidor novo, uma mensagem não lida, uma preferência) redesenhava TODO componente que
 * lê o usuário, isto é, cada cartão do feed e tudo dentro dele. Agora:
 *  - `useCurrentUser()` continua devolvendo o mesmo objeto de antes (e redesenha a cada mudança, como antes);
 *  - `useCurrentUserId()` e `useCurrentUserSelector()` assinam só o pedaço que o componente usa: o cartão do feed
 *    não é redesenhado por um seguidor novo;
 *  - as funções `refreshCurrentUser` e `logout` têm identidade fixa;
 *  - gravar um perfil igual ao que já está guardado não avisa ninguém.
 */
class CurrentUserStore {
  private listeners = new Set<Listener>();
  private userJson: string | null = null;
  private privateJson: string | null = null;
  private snapshot: CurrentUserContextType;
  private summary: ViewerSummary | null = null;

  constructor() {
    this.snapshot = {
      currentUser: null,
      firebaseUser: null,
      isLoading: true,
      refreshCurrentUser: this.refreshCurrentUser,
      logout: this.logout,
    };
  }

  getSnapshot = (): CurrentUserContextType => this.snapshot;

  /** O resumo de quem está logado: o MESMO objeto enquanto id, nome, usuário e avatar não mudam. */
  getViewerSummary = (): ViewerSummary | null => this.summary;

  /** Lido na hora de agir (um toque num botão), sem assinar nada: não redesenha quem o usa. */
  getCurrentUser = (): AppUserType | null => this.snapshot.currentUser;

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  /** Troca parte do estado e avisa uma vez só. */
  patch = (partial: Partial<Pick<CurrentUserContextType, 'currentUser' | 'firebaseUser' | 'isLoading'>>): void => {
    const next = { ...this.snapshot, ...partial };
    if (
      next.currentUser === this.snapshot.currentUser &&
      next.firebaseUser === this.snapshot.firebaseUser &&
      next.isLoading === this.snapshot.isLoading
    ) return;
    this.snapshot = next;
    const summary = toViewerSummary(next.currentUser);
    if (!sameViewerSummary(summary, this.summary)) this.summary = summary;
    this.listeners.forEach((listener) => listener());
  };

  /** Grava o perfil; um perfil idêntico ao guardado mantém o objeto antigo (ninguém é redesenhado à toa). */
  setUser = (user: AppUserType | null, extra?: Partial<Pick<CurrentUserContextType, 'isLoading'>>): void => {
    const json = user ? JSON.stringify(user) : null;
    if (json === this.userJson && user !== null && this.snapshot.currentUser !== null) {
      this.patch(extra ?? {});
      return;
    }
    this.userJson = json;
    this.patch({ currentUser: user, ...extra });
  };

  /** Dados pessoais (não lidas, preferências...) vindos de private/account, somados ao perfil. */
  mergePrivate = (uid: string, privateData: Record<string, unknown>): void => {
    const json = JSON.stringify(privateData);
    if (json === this.privateJson) return;
    this.privateJson = json;
    const prev = this.snapshot.currentUser;
    if (!prev || prev.id !== uid) return;
    const merged = { ...prev, ...privateData } as AppUserType;
    this.userJson = JSON.stringify(merged);
    this.patch({ currentUser: merged });
  };

  resetPrivate = (): void => { this.privateJson = null; };

  refreshCurrentUser = async (): Promise<void> => {
    const firebaseUser = this.snapshot.firebaseUser;
    if (!firebaseUser) return;
    this.patch({ isLoading: true });
    try {
      const user = await getUser(firebaseUser.uid, firebaseUser.uid, { fresh: true });
      this.setUser(user || null);
      if (user) {
        dispatchProfileUpdateEvent(user);
      }
    } catch (error) {
      console.error("Failed to manually refresh current user:", error);
    } finally {
      this.patch({ isLoading: false });
    }
  };

  logout = (): void => {
    this.userJson = null;
    this.privateJson = null;
    this.patch({ currentUser: null, firebaseUser: null });
  };

  /** Mesmo objeto a vida toda: quem só chama as ações não é redesenhado por nada. */
  readonly actions = { refreshCurrentUser: this.refreshCurrentUser, logout: this.logout };
}

const CurrentUserStoreContext = createContext<CurrentUserStore | undefined>(undefined);

/** Uma visita por troca de página, de quem está logado e de visitante (sem identificar ninguém). */
function AccessLogger() {
  const { currentUser, isLoading } = useCurrentUser();
  const pathname = usePathname();
  const isLoggedIn = !!currentUser;
  useEffect(() => {
    if (isLoading) return;
    logAccessEvent({ path: pathname, audienceType: isLoggedIn ? 'auth' : 'guest' });
  }, [pathname, isLoggedIn, isLoading]);
  return null;
}

export const CurrentUserProvider = ({ children }: { children: React.ReactNode }) => {
  const storeRef = useRef<CurrentUserStore>();
  if (!storeRef.current) storeRef.current = new CurrentUserStore();
  const store = storeRef.current;

  useEffect(() => {
    let firestoreUnsubscribe: (() => void) | null = null;
    let privateUnsubscribe: (() => void) | null = null;
    let lastKnownUserId: string | null = null;

    const authUnsubscribe = onAuthStateChanged(auth, (fbUser) => {
      // Clean up previous listener if the user changes
      if (firestoreUnsubscribe) {
        firestoreUnsubscribe();
        firestoreUnsubscribe = null;
      }
      if (privateUnsubscribe) {
        privateUnsubscribe();
        privateUnsubscribe = null;
      }

      if (lastKnownUserId) {
        goOffline(lastKnownUserId);
        lastKnownUserId = null;
      }

      store.patch({ firebaseUser: fbUser });
      store.resetPrivate();
      // Troca de conta (ou saída): nada do que foi lido pela sessão anterior fica em memória.
      invalidateUserCache();
      clearViewerActions();

      if (fbUser) {
        // User is signed in.
        goOfflineGuest(); // Make sure to clean up guest presence

        lastKnownUserId = fbUser.uid;
        store.patch({ isLoading: true });

        // Uma troca feita pelo link pode ter acontecido em outro aparelho. O Auth já sabe o e-mail novo; este reparo
        // idempotente alinha o registro privado no próximo login, sem impedir a sessão se a rede estiver offline.
        void reconcilePrivateEmail();
        // Sessao antiga pode ter sido criada antes da claim de membro existir.
        // A Function so a concede se perfil e vaga realmente existirem.
        void ensureMembershipToken(fbUser).catch(() => undefined);

        // Garante automaticamente o @handle quando a federação da plataforma estiver ativa (idempotente e sem 503 local).
        void import('@/lib/federation/client').then(({ ensureFederationEnabledForSession }) =>
          ensureFederationEnabledForSession(fbUser),
        );

        const userDocRef = doc(db, 'users', fbUser.uid);

        firestoreUnsubscribe = onSnapshot(userDocRef, async (userDoc) => {
          if (userDoc.exists()) {
            // O próprio documento mudou: lê sem o cache de sessão do getUser.
            const fullUserProfile = await getUser(fbUser.uid, fbUser.uid, { fresh: true });
            store.setUser(fullUserProfile || null, { isLoading: false });
          } else {
            console.warn(`User document not found for authenticated user ${fbUser.uid}`);
            store.setUser(null, { isLoading: false });
          }
        }, (error) => {
          console.error(`Error listening to user document ${fbUser.uid}:`, error);
          store.setUser(null, { isLoading: false });
        });

        // Dados pessoais (não lidas, preferências...) ficam em private/account e também são acompanhados ao vivo.
        privateUnsubscribe = onSnapshot(privateAccountRef(fbUser.uid), (privateDoc) => {
          if (!privateDoc.exists()) return;
          store.mergePrivate(fbUser.uid, privateDoc.data());
        }, (error) => {
          console.error(`Error listening to private account of ${fbUser.uid}:`, error);
        });

        initializePresence(fbUser.uid);

      } else {
        // User is signed out.
        store.setUser(null, { isLoading: false });
        initializeGuestPresence(); // Initialize guest presence
      }
    });

    return () => {
      authUnsubscribe();
      if (firestoreUnsubscribe) {
        firestoreUnsubscribe();
      }
      if (privateUnsubscribe) {
        privateUnsubscribe();
      }
      if(lastKnownUserId) {
         goOffline(lastKnownUserId);
      }
      goOfflineGuest(); // Cleanup guest presence on component unmount
    };
  }, [store]);

  return (
    <CurrentUserStoreContext.Provider value={store}>
      <AccessLogger />
      {children}
    </CurrentUserStoreContext.Provider>
  );
};

function useStore(): CurrentUserStore {
  const store = useContext(CurrentUserStoreContext);
  if (store === undefined) {
    throw new Error('useCurrentUser must be used within a CurrentUserProvider');
  }
  return store;
}

/** O usuário inteiro, como sempre foi. Redesenha a cada mudança do perfil: prefira os ganchos abaixo em componentes de lista. */
export const useCurrentUser = (): CurrentUserContextType => {
  const store = useStore();
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
};

/**
 * Um pedaço do usuário. Redesenha só quando o valor escolhido muda (comparado por `Object.is`: devolva um texto, número,
 * booleano ou um objeto que já exista no estado, nunca um novo a cada chamada).
 */
export function useCurrentUserSelector<T>(select: (state: CurrentUserContextType) => T): T {
  const store = useStore();
  return useSyncExternalStore(
    store.subscribe,
    () => select(store.getSnapshot()),
    () => select(store.getSnapshot()),
  );
}

/** Só o id de quem está logado (ou null): não é redesenhado por seguidores, contadores ou preferências. */
export const useCurrentUserId = (): string | null => useCurrentUserSelector((state) => state.currentUser?.id ?? null);

/** Id, nome, usuário e avatar de quem está logado: o objeto só muda quando um destes valores muda. */
export function useViewerSummary(): ViewerSummary | null {
  const store = useStore();
  return useSyncExternalStore(store.subscribe, store.getViewerSummary, store.getViewerSummary);
}

/** `refreshCurrentUser` e `logout`: funções de identidade fixa, sem assinar o perfil. */
export function useCurrentUserActions(): Pick<CurrentUserContextType, 'refreshCurrentUser' | 'logout'> {
  return useStore().actions;
}

/** Função de identidade fixa que devolve o usuário de AGORA (para ler dentro de um toque, sem assinar o perfil). */
export function useGetCurrentUser(): () => AppUserType | null {
  return useStore().getCurrentUser;
}
