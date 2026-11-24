// src/lib/services/encryptedMediaService.ts
'use client';

// Envio e abertura de anexo GRANDE em conversa protegida (Etapa 1: sobe em pedaços, abre inteiro antes de tocar).
//
// O caminho comum de anexo não serve aqui, e não é por falta de ajuste:
//   - cifrar tudo de uma vez põe o arquivo inteiro DUAS vezes na memória (claro + cifrado) e mata a WebView;
//   - o arquivo cifrado é um borrão (`application/octet-stream`), então ele some do pipeline de vídeo e cai na rota
//     comum, que corta em 5 MB — era exatamente por isso que vídeo em conversa protegida nunca saía;
//   - o pipeline de vídeo (FFmpeg) precisa LER os bytes para transcodificar, e aqui o servidor não pode. Nada de
//     transcodificação em conversa protegida: é escolha, não limitação.
//
// A memória presa é um pedaço de cada vez nos dois sentidos. O resto fica no armazenamento de blobs do navegador,
// que vai para disco quando cresce, em vez de ocupar a memória do app.

import { auth, storage } from '@/lib/firebase';
import { ref, uploadBytesResumable } from 'firebase/storage';
import { encryptDirectMessage, type E2eeEncryptedPayload } from '@/lib/crypto/e2ee';
import { bytesToBase64, base64ToBytes } from '@/lib/crypto/e2eeKeyring';
import {
  INDICE_DA_CAPA,
  LIMITE_MIDIA_PROTEGIDA,
  TAMANHO_DO_PEDACO,
  cifrarPedaco,
  decifrarPedaco,
  importarChave,
  lerDescritorV2,
  novoSegredoDeArquivo,
  planoDePedacos,
  tamanhoCifrado,
  type DescritorDeMidiaV2,
} from '@/lib/crypto/e2eeMediaChunks';
import { readVideoDuration } from './mediaUploadService';

export type ProgressoCallback = (porcentagem: number) => void;

export interface EnvioProtegido {
  fileUrl: string;
  posterUrl?: string;
  mediaE2ee: E2eeEncryptedPayload;
}

/** Erro com texto pronto para a tela: quem chama repassa, sem traduzir código de erro para a pessoa. */
export class ErroDeMidiaProtegida extends Error {}

/** Quanto da barra de progresso cabe à cifragem; o resto é a subida, que é o demorado. */
const FATIA_DA_CIFRAGEM = 12;

interface InitResposta {
  mediaId?: unknown;
  storagePath?: unknown;
  downloadURL?: unknown;
  error?: unknown;
}

async function pedirRegistro(corpo: Record<string, unknown>): Promise<{ mediaId: string; storagePath: string; downloadURL: string }> {
  const user = auth.currentUser;
  if (!user) throw new ErroDeMidiaProtegida('A sessão da conta mudou. Entre novamente para enviar o arquivo.');
  const idToken = await user.getIdToken();

  const resposta = await fetch('/api/media/enc/init', {
    method: 'POST',
    headers: { Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(corpo),
  });

  let body: InitResposta = {};
  try {
    body = (await resposta.json()) as InitResposta;
  } catch {
    // A mensagem genérica abaixo cobre proxy devolvendo HTML.
  }
  if (body.error === 'video-too-long') {
    throw new ErroDeMidiaProtegida('O vídeo ultrapassa o limite de 2 horas e 50 minutos.');
  }
  if (body.error === 'invalid-file-size') {
    throw new ErroDeMidiaProtegida('Este arquivo passa do limite de 200 MB para conversa protegida.');
  }
  if (
    resposta.status !== 201 ||
    typeof body.mediaId !== 'string' ||
    typeof body.storagePath !== 'string' ||
    typeof body.downloadURL !== 'string'
  ) {
    throw new ErroDeMidiaProtegida('Não foi possível preparar o envio. Tente novamente.');
  }
  return { mediaId: body.mediaId, storagePath: body.storagePath, downloadURL: body.downloadURL };
}

/**
 * Fecha o envio: o SERVIDOR apaga o token permanente que o SDK do Firebase grava no objeto durante o upload.
 *
 * Esse token é uma URL pública que não passa pela autorização do `/mp` e não se revoga tirando acesso — é o mesmo
 * defeito que a rodada de mídia já tinha corrigido em outros 19 objetos. O envio cifrado precisa do protocolo
 * retomável (são até 200 MB), então em vez de trocar o protocolo, apaga-se o token logo depois.
 *
 * Falhar aqui NÃO é detalhe: sem o fechamento o arquivo fica alcançável por quem tiver a URL. Por isso o erro sobe.
 */
async function fecharEnvio(mediaId: string): Promise<void> {
  const user = auth.currentUser;
  if (!user) throw new ErroDeMidiaProtegida('A sessão da conta mudou. Entre novamente.');
  const idToken = await user.getIdToken();
  const r = await fetch('/api/media/enc/init', {
    method: 'POST',
    headers: { Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ finalizar: mediaId }),
  });
  if (!r.ok) throw new ErroDeMidiaProtegida('O envio não pôde ser concluído com segurança. Tente de novo.');
}

function subir(caminho: string, dados: Blob, aoProgredir?: (fracao: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const tarefa = uploadBytesResumable(ref(storage, caminho), dados, {
      contentType: 'application/octet-stream',
      customMetadata: { pipeline: 'e2ee-v2' },
    });
    tarefa.on(
      'state_changed',
      (snap) => aoProgredir?.(snap.totalBytes > 0 ? snap.bytesTransferred / snap.totalBytes : 0),
      () => reject(new ErroDeMidiaProtegida('O envio foi interrompido. Verifique a conexão e tente de novo.')),
      () => resolve(),
    );
  });
}

/**
 * Cifra o arquivo em pedaços e devolve um Blob com tudo em sequência.
 *
 * Cada pedaço vira um Blob na hora: o navegador copia para o armazenamento de blobs (que vai a disco quando cresce)
 * e o ArrayBuffer em claro pode ser descartado. Sem isso, um vídeo de 200 MB precisaria de 400 MB de memória viva.
 */
async function cifrarEmPedacos(
  arquivo: Blob,
  segredo: { chave: Uint8Array; base: Uint8Array; fileId: string },
  aoProgredir?: (fracao: number) => void,
): Promise<{ blob: Blob; total: number }> {
  const { total } = planoDePedacos(arquivo.size, TAMANHO_DO_PEDACO);
  const chave = await importarChave(segredo.chave, ['encrypt']);
  const partes: Blob[] = [];

  for (let i = 0; i < total; i++) {
    const fatia = arquivo.slice(i * TAMANHO_DO_PEDACO, (i + 1) * TAMANHO_DO_PEDACO);
    const claro = await fatia.arrayBuffer();
    const cifrado = await cifrarPedaco(chave, segredo.base, claro, { fileId: segredo.fileId, indice: i, total });
    partes.push(new Blob([cifrado]));
    aoProgredir?.((i + 1) / total);
  }
  return { blob: new Blob(partes, { type: 'application/octet-stream' }), total };
}

/** Primeiro quadro do vídeo, feito NO APARELHO. O servidor não poderia gerar: ele não enxerga o vídeo. */
async function primeiroQuadro(arquivo: File): Promise<Blob | null> {
  if (typeof document === 'undefined') return null;
  return new Promise((resolve) => {
    const video = document.createElement('video');
    const objectUrl = URL.createObjectURL(arquivo);
    let pronto = false;
    const terminar = (valor: Blob | null) => {
      if (pronto) return;
      pronto = true;
      URL.revokeObjectURL(objectUrl);
      video.removeAttribute('src');
      video.load();
      resolve(valor);
    };
    const prazo = window.setTimeout(() => terminar(null), 15_000);

    video.preload = 'metadata';
    video.muted = true;
    video.playsInline = true;
    video.onloadeddata = () => {
      try {
        const largura = Math.min(video.videoWidth || 640, 640);
        const altura = Math.round(((video.videoHeight || 360) * largura) / (video.videoWidth || 640));
        const tela = document.createElement('canvas');
        tela.width = largura;
        tela.height = altura;
        const ctx = tela.getContext('2d');
        if (!ctx) {
          window.clearTimeout(prazo);
          terminar(null);
          return;
        }
        ctx.drawImage(video, 0, 0, largura, altura);
        tela.toBlob((b) => {
          window.clearTimeout(prazo);
          terminar(b);
        }, 'image/jpeg', 0.7);
      } catch {
        window.clearTimeout(prazo);
        terminar(null);
      }
    };
    video.onerror = () => {
      window.clearTimeout(prazo);
      terminar(null);
    };
    // Um pouco adiante do início: o primeiro quadro costuma ser preto.
    video.onloadedmetadata = () => {
      try {
        video.currentTime = Math.min(0.5, (video.duration || 1) / 10);
      } catch {
        /* alguns contêineres não deixam posicionar; fica o quadro inicial */
      }
    };
    video.src = objectUrl;
  });
}

/**
 * Envia um anexo grande numa conversa protegida.
 * Nunca cai para texto claro: se qualquer passo falhar, o erro sobe e nada é enviado.
 */
export async function enviarMidiaProtegida(params: {
  arquivo: File;
  remetenteId: string;
  chavePublicaDoDestinatario: string;
  aoProgredir?: ProgressoCallback;
}): Promise<EnvioProtegido> {
  const { arquivo, remetenteId, chavePublicaDoDestinatario, aoProgredir } = params;

  if (arquivo.size <= 0) throw new ErroDeMidiaProtegida('O arquivo está vazio.');
  if (arquivo.size > LIMITE_MIDIA_PROTEGIDA) {
    throw new ErroDeMidiaProtegida('Este arquivo passa do limite de 200 MB para conversa protegida.');
  }

  const ehVideo = arquivo.type.startsWith('video/') || /\.(?:mp4|m4v|mov|mkv|webm|avi|3gp|ts|mts|ogv)$/i.test(arquivo.name);
  const duracao = ehVideo ? await readVideoDuration(arquivo) : null;
  const segredo = novoSegredoDeArquivo();

  // 1. Cifrar.
  const { blob, total } = await cifrarEmPedacos(arquivo, segredo, (f) => aoProgredir?.(f * FATIA_DA_CIFRAGEM));
  if (blob.size !== tamanhoCifrado(arquivo.size)) {
    throw new ErroDeMidiaProtegida('A proteção do arquivo não fechou como esperado. Tente de novo.');
  }

  // 2. Registrar e subir.
  const registro = await pedirRegistro({ size: blob.size, durationSeconds: duracao, papel: 'video' });
  await subir(registro.storagePath, blob, (f) =>
    aoProgredir?.(FATIA_DA_CIFRAGEM + f * (100 - FATIA_DA_CIFRAGEM)),
  );
  await fecharEnvio(registro.mediaId);

  // 3. Capa: mesma chave, índice reservado. Falhar aqui não derruba o envio — fica sem capa.
  let posterUrl: string | undefined;
  if (ehVideo) {
    try {
      const quadro = await primeiroQuadro(arquivo);
      if (quadro) {
        const chave = await importarChave(segredo.chave, ['encrypt']);
        const capaCifrada = await cifrarPedaco(chave, segredo.base, await quadro.arrayBuffer(), {
          fileId: segredo.fileId,
          indice: INDICE_DA_CAPA,
          total,
        });
        const regCapa = await pedirRegistro({ size: capaCifrada.byteLength, papel: 'poster' });
        await subir(regCapa.storagePath, new Blob([capaCifrada]));
        await fecharEnvio(regCapa.mediaId);
        posterUrl = regCapa.downloadURL;
      }
    } catch {
      posterUrl = undefined;
    }
  }

  // 4. A chave viaja dentro da mensagem cifrada, como já era no anexo pequeno.
  const descritor: DescritorDeMidiaV2 = {
    v: 2,
    k: bytesToBase64(segredo.chave),
    ivBase: bytesToBase64(segredo.base),
    fileId: segredo.fileId,
    mime: arquivo.type || 'application/octet-stream',
    name: arquivo.name.slice(0, 120),
    size: arquivo.size,
    chunk: TAMANHO_DO_PEDACO,
    count: total,
    ...(posterUrl ? { poster: true as const } : {}),
  };
  const mediaE2ee = await encryptDirectMessage(JSON.stringify(descritor), remetenteId, chavePublicaDoDestinatario);
  if (!mediaE2ee) {
    throw new ErroDeMidiaProtegida('Não deu para proteger a chave deste arquivo neste aparelho. Tente de novo.');
  }

  aoProgredir?.(100);
  return { fileUrl: registro.downloadURL, mediaE2ee, ...(posterUrl ? { posterUrl } : {}) };
}

// ───────────────────────── Abrir ─────────────────────────

export type AberturaProtegida =
  | { ok: true; objectUrl: string; mime: string }
  | { ok: false; motivo: 'descritor' | 'rede' | 'adulterado' };

/**
 * Baixa e abre um anexo v2 (Etapa 1: inteiro antes de tocar; a Etapa 2 troca isto por MediaSource).
 * Um pedaço que não abre interrompe tudo: significa que mexeram no conteúdo, na ordem ou no tamanho.
 */
export async function abrirMidiaProtegida(
  fileUrl: string,
  descritorBruto: unknown,
  aoProgredir?: ProgressoCallback,
): Promise<AberturaProtegida> {
  const d = lerDescritorV2(descritorBruto);
  if (!d) return { ok: false, motivo: 'descritor' };

  let cifrado: Blob;
  try {
    const resposta = await fetch(fileUrl);
    if (!resposta.ok) return { ok: false, motivo: 'rede' };
    cifrado = await resposta.blob();
  } catch {
    return { ok: false, motivo: 'rede' };
  }

  try {
    const chave = await importarChave(base64ToBytes(d.k), ['decrypt']);
    const base = base64ToBytes(d.ivBase);
    const cheio = d.chunk + 16;
    const partes: Blob[] = [];

    for (let i = 0; i < d.count; i++) {
      const fatia = cifrado.slice(i * cheio, Math.min((i + 1) * cheio, cifrado.size));
      if (fatia.size === 0) return { ok: false, motivo: 'adulterado' };
      const aberto = await decifrarPedaco(chave, base, await fatia.arrayBuffer(), {
        fileId: d.fileId,
        indice: i,
        total: d.count,
      });
      partes.push(new Blob([aberto]));
      aoProgredir?.(((i + 1) / d.count) * 100);
    }

    const inteiro = new Blob(partes, { type: d.mime });
    // O tamanho tem de bater com o que o descritor prometeu: é a última defesa contra pedaço faltando no fim.
    if (inteiro.size !== d.size) return { ok: false, motivo: 'adulterado' };
    return { ok: true, objectUrl: URL.createObjectURL(inteiro), mime: d.mime };
  } catch {
    return { ok: false, motivo: 'adulterado' };
  }
}

/** A capa: um pedaço só, no índice reservado. */
export async function abrirCapaProtegida(posterUrl: string, descritorBruto: unknown): Promise<string | null> {
  const d = lerDescritorV2(descritorBruto);
  if (!d) return null;
  try {
    const resposta = await fetch(posterUrl);
    if (!resposta.ok) return null;
    const chave = await importarChave(base64ToBytes(d.k), ['decrypt']);
    const aberto = await decifrarPedaco(chave, base64ToBytes(d.ivBase), await resposta.arrayBuffer(), {
      fileId: d.fileId,
      indice: INDICE_DA_CAPA,
      total: d.count,
    });
    return URL.createObjectURL(new Blob([aberto], { type: 'image/jpeg' }));
  } catch {
    return null;
  }
}
