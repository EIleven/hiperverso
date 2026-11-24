
// src/lib/services/authService.ts
import { auth, db, functions } from '../firebase'; // Adjusted path
import {
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged,
  verifyBeforeUpdateEmail,
  updatePassword,
  reauthenticateWithCredential,
  EmailAuthProvider,
  setPersistence,
  browserLocalPersistence,
  browserSessionPersistence,
} from 'firebase/auth';
import {
  doc,
  getDoc,
  collection,
} from 'firebase/firestore';
import type { User } from '../types'; // Adjusted path
import { getUser } from './userService';
import { signInWithGoogleAccount, isGoogleSignInCancelled, reauthenticateWithGoogleAccount } from './googleSignIn';
import { goOffline } from './presenceService';
import { clearServerSession } from './serverSession';
import { isMultiFactorRequired } from './accountSecurity';
import { httpsCallable } from 'firebase/functions';
import { isSignupClosed, signupClosedLimit, SignupClosedError, isAppCheckRequired, HumanCheckError } from './signupLimit';
import { buildActionCodeSettings, localeFromPath, normalizeLocale } from '@/lib/auth/actionLinks';
import { siteConfig } from '@/config/site';
import { checkPassword, normalizeEmail } from '@/lib/auth/password';
import { ensureMembershipToken } from './membership';

const usersCollection = collection(db, 'users');
// Cria o perfil do primeiro acesso com o Google no servidor (limite de cadastro, @ único, dados pessoais).
const claimGoogleProfile = httpsCallable<unknown, { status: 'created' | 'exists' }>(functions, 'claimGoogleProfile');
const updateBirthDate = httpsCallable<{ dateOfBirth: string }, { status: 'ok' }>(functions, 'updateUserBirthDate');

// O primeiro acesso com o Google termina na tela "Finalize seu Perfil" (escolher o @ e informar o nascimento). Quem decide
// mostrá-la é este marcador na sessão da aba, e não o estado da tela de login: ao entrar, a sessão carrega e o layout troca
// a página por um esqueleto, então a tela de login é desmontada e remontada com o estado zerado, e o aviso de "conta
// nova" se perdia no caminho (a pessoa ficava logada, sem ver o diálogo, com o @ provisório).
const PROFILE_COMPLETION_KEY = 'exelula:complete-profile';
export const markProfileCompletionPending = (uid: string): void => {
  try { sessionStorage.setItem(PROFILE_COMPLETION_KEY, uid); } catch { /* sem sessionStorage: segue sem o marcador */ }
};
export const isProfileCompletionPending = (uid: string): boolean => {
  try { return sessionStorage.getItem(PROFILE_COMPLETION_KEY) === uid; } catch { return false; }
};
export const clearProfileCompletionPending = (): void => {
  try { sessionStorage.removeItem(PROFILE_COMPLETION_KEY); } catch { /* idem */ }
};

export const onAuthUserChanged = (callback: (user: User | null) => void): (() => void) => {
  const unsubscribe = onAuthStateChanged(auth, async (firebaseUser) => {
    if (firebaseUser) {
      const user = await getUser(firebaseUser.uid, firebaseUser.uid);
      callback(user);
    } else {
      callback(null);
    }
  });
  return unsubscribe;
};

export const loginWithGoogle = async (): Promise<{ user: User; isNewUser: boolean; }> => {
    try {
        const firebaseUser = await signInWithGoogleAccount();
        const { uid } = firebaseUser;

        const userDocRef = doc(usersCollection, uid);
        const userDocSnap = await getDoc(userDocRef);

        if (userDocSnap.exists()) {
            await ensureMembershipToken(firebaseUser);
            const existingUser = await getUser(uid, uid);
            if (!existingUser) throw new Error("Falha ao recuperar o perfil de usuário existente.");
            return { user: existingUser, isNewUser: false };
        } else {
            // Conta nova. O Firebase Auth mantém UMA conta por e-mail: quem já tinha conta com senha e entra com o Google
            // do mesmo e-mail cai no MESMO uid (perfil existente, ramo acima). Antes o app procurava o e-mail no perfil
            // público de todo mundo, o que exigia expor e-mails.
            // --- Conta nova: o PERFIL NASCE NO SERVIDOR ---
            // A Function claimGoogleProfile reserva a vaga entre as primeiras (limite de cadastro), gera um @ provisório
            // único e grava perfil, @ e dados pessoais numa transação só. O cliente não escreve mais nada disso (as
            // regras do Firestore recusam). Não recebe dado nenhum daqui: nome, e-mail e foto vêm da conta no Auth.
            // O marcador do "Finalize seu Perfil" é gravado ANTES de o perfil existir: assim que a sessão enxerga o perfil
            // novo, a tela de login (remontada) já encontra o marcador. Qualquer falha ou "já existia" o desfaz.
            let claimStatus: 'created' | 'exists' = 'created';
            markProfileCompletionPending(uid);
            try {
                claimStatus = (await claimGoogleProfile()).data.status;
                await firebaseUser.getIdToken(true);
                if (claimStatus !== 'created') clearProfileCompletionPending();
            } catch (claimError: unknown) {
                clearProfileCompletionPending();
                if (isSignupClosed(claimError)) {
                    // Vagas preenchidas: o servidor já removeu a conta que o Google acabou de criar. Só sai da sessão local.
                    await signOut(auth).catch(() => {});
                    throw new SignupClosedError(signupClosedLimit(claimError));
                }
                if (isAppCheckRequired(claimError)) {
                    // Sem o token anti-robô o servidor não criou perfil nem gastou vaga: sai da sessão (a conta do Google
                    // fica sem perfil) e a tela pede para tentar de novo.
                    await signOut(auth).catch(() => {});
                    throw new HumanCheckError();
                }
                throw claimError;
            }

            const createdUser = await getUser(uid, uid, { fresh: true });
            if (!createdUser) throw new Error("Falha ao criar e recuperar o novo perfil de usuário.");
            // "exists": outra aba criou o perfil no meio do caminho; quem já tinha perfil não precisa finalizar nada.
            return { user: createdUser, isNewUser: claimStatus === 'created' };
        }

    } catch (error: any) {
        if (isMultiFactorRequired(error)) throw error; // a tela pede o código do app autenticador
        if (error instanceof SignupClosedError) throw error; // a tela mostra o aviso de vagas preenchidas
        if (error instanceof HumanCheckError) throw error; // a tela pede para tentar de novo (anti-robô)
        if (isGoogleSignInCancelled(error)) {
            throw new Error('O processo de login foi cancelado.');
        }
        console.error("Google login error:", String(error));
        // Re-throw specific, user-friendly errors
        if (error.message.includes("Uma conta já existe")) {
            throw error;
        }
        throw new Error(error.message || "O login com o Google falhou. Por favor, tente novamente.");
    }
};


export const loginUser = async (email?: string, password?: string, rememberMe: boolean = false): Promise<User> => {
  if (!email || !password) throw new Error("Email and password are required for login.");
  try {
    // Set persistence before signing in
    const persistence = rememberMe ? browserLocalPersistence : browserSessionPersistence;
    await setPersistence(auth, persistence);

    const userCredential = await signInWithEmailAndPassword(auth, email, password);
    const firebaseUser = userCredential.user;
    await ensureMembershipToken(firebaseUser);
    const user = await getUser(firebaseUser.uid, firebaseUser.uid);
    
    if (user) {
      return user;
    } else {
      await signOut(auth); 
      throw new Error("Your user profile could not be found. Please register again or contact support.");
    }
  } catch (error: any) {
    // Conta com app autenticador: o erro original segue intacto (a tela pede o código com ele).
    if (isMultiFactorRequired(error)) throw error;
    if (error.code === 'auth/invalid-credential' || error.code === 'auth/user-not-found' || error.code === 'auth/wrong-password') {
         throw new Error('E-mail ou senha inválidos.');
    }
    if (error.code === 'auth/too-many-requests') {
      throw new Error('Muitas tentativas seguidas. Aguarde alguns minutos ou redefina a senha.');
    }
    if (error.code === 'auth/user-disabled') {
      throw new Error('Esta conta está desativada.');
    }
    console.error("Login error:", String(error));
    throw new Error(error.message || "Não foi possível entrar. Tente de novo.");
  }
};

/** Depois de entrar com o código do app autenticador: carrega o perfil (ou sai, se ele não existir). */
export const loadProfileAfterSignIn = async (uid: string): Promise<User> => {
  if (auth.currentUser?.uid === uid) {
    const currentAuthUser = auth.currentUser;
    await ensureMembershipToken(currentAuthUser);
    void import('@/lib/federation/client').then(({ ensureFederationEnabledForSession }) =>
      ensureFederationEnabledForSession(currentAuthUser),
    );
  }
  const user = await getUser(uid, uid, { fresh: true });
  if (user) return user;
  await signOut(auth);
  throw new Error("Seu perfil não foi encontrado. Cadastre-se de novo ou fale com o suporte.");
};


export const logoutUser = async (): Promise<void> => {
  try {
    // Offline ANTES de sair: depois do signOut a escrita na presença é negada e a pessoa ficava online para sempre.
    await goOffline(auth.currentUser?.uid);
    // Encerra a sessão de servidor ANTES do signOut: depois dele não há mais ID token para identificar a chamada.
    await clearServerSession();
    await signOut(auth);
  } catch (error: any) {
    console.error("Firebase Logout Error:", String(error));
    throw error;
  }
};

export const getCurrentUserId = (): string | null => {
  return auth.currentUser ? auth.currentUser.uid : null;
};

export const getCurrentUser = async (): Promise<User | null> => {
  if (auth.currentUser) {
    return getUser(auth.currentUser.uid, auth.currentUser.uid);
  }
  return null;
};

export const updateUserEmail = async (
  newEmail: string,
  currentPassword?: string,
  locale?: string,
): Promise<void> => {
  const firebaseUser = auth.currentUser;
  if (!firebaseUser) {
    throw new Error("Usuário não está autenticado.");
  }

  const normalizedEmail = normalizeEmail(newEmail);
  if (!normalizedEmail || normalizedEmail === normalizeEmail(firebaseUser.email ?? '')) {
    throw new Error('Informe um e-mail novo e valido.');
  }

  // If a password is provided (for email/password users), re-authenticate with it.
  if (currentPassword && firebaseUser.email) {
      try {
        const credential = EmailAuthProvider.credential(firebaseUser.email, currentPassword);
        await reauthenticateWithCredential(firebaseUser, credential);
      } catch (error: any) {
          console.error("Falha na reautenticação por senha:", error);
          if (error.code === 'auth/invalid-credential' || error.code === 'auth/wrong-password') {
            throw new Error('A senha atual está incorreta.');
          }
          throw new Error('Falha na reautenticação.');
      }
  } else {
    await reauthenticateWithGoogleAccount(firebaseUser);
  }

  try {
    // `verifyBeforeUpdateEmail`, e NÃO `updateEmail`. Antes a troca era imediata: quem digitasse o endereço errado
    // ficava trancado fora da própria conta, e dava para apontar a conta para o e-mail de outra pessoa. Agora o
    // Firebase manda um link para o endereço NOVO e a troca só acontece quando ele é clicado.
    //
    // E por isso aqui NÃO se grava nada em users/{uid}/private/account: enquanto a confirmação não acontece, o
    // e-mail da conta continua sendo o antigo. A regra `isValidPrivateAccount` exige que o e-mail gravado seja igual
    // ao do token, então gravar agora seria recusado — e deveria ser. A reconciliação acontece no próximo login,
    // em `reconcilePrivateEmail`, porque o link pode ser aberto em outro navegador ou aparelho.
    await verifyBeforeUpdateEmail(
      firebaseUser,
      normalizedEmail,
      // Sempre a origem OFICIAL: `baseUrl` pode apontar para localhost em desenvolvimento.
      buildActionCodeSettings(
        normalizeLocale(locale ?? localeFromPath()),
        'settings-account',
        siteConfig.officialOrigin,
      ),
    );
  } catch (error: any) {
    console.error("Erro ao atualizar e-mail:", error);
    if (error.code === 'auth/email-already-in-use') {
      throw new Error('Este endereço de e-mail já está em uso por outra conta.');
    }
    // This error code is crucial for forcing re-auth on the client.
    if (error.code === 'auth/requires-recent-login') {
        throw new Error('Esta operação é sensível e requer autenticação recente. Por favor, reautentique e tente novamente.');
    }
    throw new Error('Ocorreu um erro ao atualizar seu e-mail.');
  }
};

export const updateUserPassword = async (currentPassword?: string, newPassword?: string): Promise<void> => {
  const firebaseUser = auth.currentUser;
  if (!firebaseUser || !firebaseUser.email || !currentPassword || !newPassword) {
    throw new Error("A senha atual e a nova são necessárias.");
  }

  if (!checkPassword(newPassword, firebaseUser.email ?? undefined).ok) {
    throw new Error('Use uma senha mais forte, com pelo menos 8 caracteres.');
  }

  try {
    const credential = EmailAuthProvider.credential(firebaseUser.email, currentPassword);
    await reauthenticateWithCredential(firebaseUser, credential);
    await updatePassword(firebaseUser, newPassword);
  } catch (error: any) {
    console.error("Erro ao atualizar senha:", error);
    if (error.code === 'auth/invalid-credential' || error.code === 'auth/wrong-password') {
      throw new Error('A senha atual está incorreta.');
    }
    if (error.code === 'auth/weak-password') {
      throw new Error('Use uma senha mais forte, com pelo menos 8 caracteres.');
    }
    throw new Error('Ocorreu um erro ao atualizar sua senha.');
  }
};

/** Atualiza a data declarada pelo canal validado no servidor. */
export const updateUserBirthDate = async (dateOfBirth: string): Promise<void> => {
  await updateBirthDate({dateOfBirth});
};

