// src/components/feed/SharePostDialog.tsx
'use client';

// Compartilhar um post do HiperVerso: link para as redes mais usadas no Brasil e imagem pronta (no visual da rede, com
// a lula) para o Instagram — feed e story/reels. O Instagram não aceita publicação por link de outro site, então o
// caminho honesto é a imagem: a pessoa compartilha pelo celular ou baixa e publica.
import { useState } from 'react';
import Image from 'next/image';
import { useLocale } from 'next-intl';
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { useToast } from '@/hooks/use-toast';
import { siteConfig } from '@/config/site';
import type { Post } from '@/lib/types';
import { Copy, Download, Instagram, Link2, Loader2, Send, Share2 } from 'lucide-react';

type Props = {
  post: Post;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

/** Ícones simples das redes (a lucide não traz as marcas). */
const IconeX = (props: React.SVGProps<SVGSVGElement>) => (
  <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden {...props}>
    <path d="M18.9 2H22l-7.4 8.5L23 22h-6.8l-5.3-7-6.1 7H1.7l7.9-9.1L1 2h7l4.8 6.4L18.9 2Zm-1.2 18h1.9L7.4 4H5.4l12.3 16Z" />
  </svg>
);
const IconeWhatsApp = (props: React.SVGProps<SVGSVGElement>) => (
  <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden {...props}>
    <path d="M12 2a10 10 0 0 0-8.7 15l-1.3 4.7 4.8-1.3A10 10 0 1 0 12 2Zm5.8 14.2c-.2.7-1.4 1.3-2 1.4-.5.1-1.1.1-1.8-.1-.4-.1-1-.3-1.7-.6-3-1.3-5-4.4-5.1-4.6-.2-.2-1.2-1.6-1.2-3s.7-2.1 1-2.4c.2-.3.6-.4.8-.4h.6c.2 0 .4 0 .7.5l.9 2.2c.1.2.1.4 0 .6l-.4.6-.3.3c-.1.1-.3.3-.1.6.2.3.8 1.3 1.7 2.1 1.2 1 2.1 1.4 2.4 1.5.3.1.5.1.6 0l.9-1.1c.2-.2.4-.2.6-.1l2.1 1c.3.1.4.2.5.3.1.2.1.7-.2 1.2Z" />
  </svg>
);
const IconeBluesky = (props: React.SVGProps<SVGSVGElement>) => (
  <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden {...props}>
    <path d="M12 10.8C10.9 8.6 7.9 4.5 5.1 2.6 2.4.8 1.4 1.1.8 1.4.1 1.7 0 2.8 0 3.5c0 .7.4 5.5.6 6.3.8 2.7 3.6 3.6 6.2 3.3h.4c-2.6.4-4.9 1.4-1.9 4.8 3.3 3.5 4.5-.8 5.2-2.9l1.5-2.5v-1.7Zm0 0c1.1-2.2 4.1-6.3 6.9-8.2 2.7-1.8 3.7-1.5 4.3-1.2.7.3.8 1.4.8 2.1 0 .7-.4 5.5-.6 6.3-.8 2.7-3.6 3.6-6.2 3.3h-.4c2.6.4 4.9 1.4 1.9 4.8-3.3 3.5-4.5-.8-5.2-2.9l-1.5-2.5v-1.7Z" />
  </svg>
);
const IconeTelegram = (props: React.SVGProps<SVGSVGElement>) => (
  <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden {...props}>
    <path d="M21.9 4.3 18.8 19c-.2 1-.9 1.3-1.7.8l-4.7-3.5-2.3 2.2c-.3.3-.5.5-1 .5l.4-5 9-8.1c.4-.4-.1-.6-.6-.2L6.8 12.3 2 10.8c-1-.3-1-1 .2-1.5l18.3-7c.9-.3 1.6.2 1.4 2Z" />
  </svg>
);
const IconeFacebook = (props: React.SVGProps<SVGSVGElement>) => (
  <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden {...props}>
    <path d="M22 12a10 10 0 1 0-11.6 9.9v-7H7.9V12h2.5V9.8c0-2.5 1.5-3.9 3.8-3.9 1.1 0 2.2.2 2.2.2v2.5h-1.3c-1.2 0-1.6.8-1.6 1.6V12h2.8l-.4 2.9h-2.3v7A10 10 0 0 0 22 12Z" />
  </svg>
);
const IconeThreads = (props: React.SVGProps<SVGSVGElement>) => (
  <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden {...props}>
    <path d="M12.2 22h-.1c-3 0-5.3-1-6.9-3C3.8 17.3 3 14.9 3 12s.8-5.3 2.3-7C6.8 3 9.1 2 12.1 2h.1c2.3 0 4.2.6 5.7 1.7 1.4 1.1 2.4 2.6 2.9 4.5l-2 .6c-.9-3.2-3.1-4.8-6.6-4.8h-.1c-2.3 0-4.1.8-5.2 2.3C5.8 7.7 5.2 9.6 5.2 12s.6 4.3 1.7 5.7c1.1 1.5 2.9 2.3 5.2 2.3h.1c2.1 0 3.5-.5 4.6-1.6 1.3-1.3 1.3-2.8 1.2-3.8-.2-1.3-1-2.4-2.3-3.1-.3 1.8-.9 3.1-1.8 4-1.1 1.1-2.6 1.4-4.1 1-1.6-.4-2.7-1.6-2.9-3.2-.2-1.2.2-2.3 1-3.1.9-.8 2.2-1.2 3.9-1.2.6 0 1.1 0 1.6.1 0-.4-.2-.8-.4-1.1-.4-.4-1-.6-1.7-.6-.9 0-1.6.3-2 .9l-1.7-1.1c.8-1.1 2-1.7 3.7-1.7 1.3 0 2.4.4 3.2 1.2.7.8 1.1 1.9 1.1 3.3v.2c2 .9 3.3 2.5 3.6 4.5.3 2-.3 4-1.8 5.4-1.5 1.5-3.4 2.1-6 2.1Zm-1.4-10c-1 0-1.8.2-2.3.6-.3.3-.5.7-.4 1.2.1.7.6 1.2 1.3 1.4.8.2 1.5 0 2-.5.6-.6 1-1.6 1.2-3-.6-.1-1.2-.2-1.8-.2Z" />
  </svg>
);

export default function SharePostDialog({ post, open, onOpenChange }: Props) {
  const locale = useLocale();
  const { toast } = useToast();
  const [formato, setFormato] = useState<'quadrado' | 'story'>('quadrado');
  const [baixando, setBaixando] = useState(false);

  const url = `${siteConfig.baseUrl}/${locale}/post/${post.id}`;
  const autor = post.user?.username ? `@${post.user.username}` : 'alguém';
  const titulo = post.headline || `Post de ${autor} no HiperVerso`;
  const textoCurto = `${titulo} — ${url}`;
  const imagemUrl = `/api/post-image/${post.id}?formato=${formato}`;
  // Post só para seguidores não vira imagem nem prévia (o servidor devolve a marca): avisamos antes.
  const restrito = (post.visibility ?? 'public') !== 'public';

  const redes = [
    { nome: 'WhatsApp', Icone: IconeWhatsApp, href: `https://wa.me/?text=${encodeURIComponent(textoCurto)}` },
    { nome: 'X', Icone: IconeX, href: `https://x.com/intent/post?text=${encodeURIComponent(titulo)}&url=${encodeURIComponent(url)}` },
    { nome: 'Bluesky', Icone: IconeBluesky, href: `https://bsky.app/intent/compose?text=${encodeURIComponent(textoCurto)}` },
    { nome: 'Telegram', Icone: IconeTelegram, href: `https://t.me/share/url?url=${encodeURIComponent(url)}&text=${encodeURIComponent(titulo)}` },
    { nome: 'Facebook', Icone: IconeFacebook, href: `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(url)}` },
    { nome: 'Threads', Icone: IconeThreads, href: `https://www.threads.net/intent/post?text=${encodeURIComponent(textoCurto)}` },
  ];

  const copiarLink = async () => {
    try {
      await navigator.clipboard.writeText(url);
      toast({ title: 'Link copiado!', description: 'Agora é só colar onde você quiser.' });
    } catch {
      toast({ title: 'Não consegui copiar', description: 'Copie da barra de endereço.', variant: 'destructive' });
    }
  };

  const compartilharDoCelular = async () => {
    try {
      if (navigator.share) {
        await navigator.share({ title: titulo, text: titulo, url });
      } else {
        await copiarLink();
      }
    } catch { /* a pessoa fechou a folha de compartilhamento */ }
  };

  /** Baixa a imagem; no celular, oferece a folha de compartilhamento (onde aparece o Instagram). */
  const usarImagem = async (acao: 'compartilhar' | 'baixar') => {
    setBaixando(true);
    try {
      const resposta = await fetch(imagemUrl);
      if (!resposta.ok) throw new Error(`HTTP ${resposta.status}`);
      const blob = await resposta.blob();
      const nome = `exe-lula-${post.id}-${formato}.png`;
      const arquivo = new File([blob], nome, { type: 'image/png' });
      if (acao === 'compartilhar' && navigator.canShare?.({ files: [arquivo] })) {
        await navigator.share({ files: [arquivo], title: titulo });
        return;
      }
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = nome;
      link.click();
      URL.revokeObjectURL(link.href);
      toast({
        title: 'Imagem baixada',
        description: 'Abra o Instagram e publique no feed ou no story. O link do post vai na legenda ou no adesivo de link.',
      });
    } catch {
      toast({ title: 'Não consegui preparar a imagem', variant: 'destructive' });
    } finally {
      setBaixando(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="inset-x-auto left-1/2 top-1/2 w-[calc(100%-1.5rem)] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-border/80 p-4 shadow-2xl sm:max-w-lg sm:p-6 max-h-[88dvh] overflow-y-auto data-[state=closed]:slide-out-to-left-1/2 data-[state=closed]:slide-out-to-top-[48%] data-[state=open]:slide-in-from-left-1/2 data-[state=open]:slide-in-from-top-[48%]"
      >
        <DialogHeader className="space-y-1 pr-8 text-left">
          <DialogTitle className="text-lg font-semibold">Compartilhar</DialogTitle>
          <DialogDescription className="text-xs sm:text-sm leading-relaxed">
            {restrito
              ? 'Este post é só para seguidores: quem abrir o link sem seguir o autor não vê o conteúdo, e a imagem sai só com a marca.'
              : 'Mande o link para outra rede ou leve o post como imagem para o Instagram.'}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 pt-1">
          <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
            {redes.map(({ nome, Icone, href }) => (
              <a
                key={nome}
                href={href}
                target="_blank"
                rel="noopener noreferrer"
                className="flex flex-col items-center justify-center gap-1.5 rounded-xl border border-border/60 bg-muted/25 px-2 py-2.5 text-[11px] font-medium text-foreground/90 transition-colors hover:border-primary/40 hover:bg-primary/10"
              >
                <Icone className="h-5 w-5" />
                <span className="truncate">{nome}</span>
              </a>
            ))}
          </div>

          <div className="grid grid-cols-3 gap-2">
            <Button variant="outline" size="sm" onClick={copiarLink} className="h-9 rounded-xl px-2 text-xs">
              <Copy className="mr-1.5 h-3.5 w-3.5 shrink-0" />
              <span className="truncate">Copiar link</span>
            </Button>
            <Button variant="outline" size="sm" onClick={compartilharDoCelular} className="h-9 rounded-xl px-2 text-xs">
              <Share2 className="mr-1.5 h-3.5 w-3.5 shrink-0" />
              <span className="truncate">Mais opções</span>
            </Button>
            <Button variant="outline" size="sm" asChild className="h-9 rounded-xl px-2 text-xs">
              <a href={`mailto:?subject=${encodeURIComponent(titulo)}&body=${encodeURIComponent(url)}`}>
                <Send className="mr-1.5 h-3.5 w-3.5 shrink-0" />
                <span className="truncate">E-mail</span>
              </a>
            </Button>
          </div>

          {!restrito && (
            <div className="space-y-3 rounded-2xl border border-border/70 bg-muted/15 p-3.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2 text-sm font-medium">
                  <Instagram className="h-4 w-4 text-primary" />
                  <span>Imagem para o Instagram</span>
                </div>
                <div className="inline-flex rounded-xl border border-border/60 bg-background/70 p-0.5">
                  <Button
                    type="button"
                    variant={formato === 'quadrado' ? 'default' : 'ghost'}
                    size="sm"
                    onClick={() => setFormato('quadrado')}
                    className="h-7 rounded-lg px-2.5 text-xs"
                  >
                    Feed
                  </Button>
                  <Button
                    type="button"
                    variant={formato === 'story' ? 'default' : 'ghost'}
                    size="sm"
                    onClick={() => setFormato('story')}
                    className="h-7 rounded-lg px-2.5 text-xs"
                  >
                    Story e reels
                  </Button>
                </div>
              </div>

              <div className="flex justify-center">
                <div
                  className={
                    formato === 'story'
                      ? 'relative w-full max-w-[132px] aspect-[9/16] overflow-hidden rounded-xl border border-border/70 bg-muted'
                      : 'relative w-full max-w-[196px] aspect-square overflow-hidden rounded-xl border border-border/70 bg-muted'
                  }
                >
                  <Image
                    key={formato}
                    src={imagemUrl}
                    alt="Prévia da imagem do post"
                    width={1080}
                    height={formato === 'story' ? 1920 : 1080}
                    className="h-full w-full object-cover"
                    unoptimized
                  />
                </div>
              </div>

              <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                <Button
                  size="sm"
                  onClick={() => usarImagem('compartilhar')}
                  disabled={baixando}
                  className="h-9 w-full rounded-xl sm:flex-1"
                >
                  {baixando ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Instagram className="mr-2 h-4 w-4" />}
                  Compartilhar imagem
                </Button>
                <div className="grid grid-cols-2 gap-2 sm:flex">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => usarImagem('baixar')}
                    disabled={baixando}
                    className="h-9 rounded-xl"
                  >
                    <Download className="mr-1.5 h-4 w-4" />
                    Baixar
                  </Button>
                  <Button variant="outline" size="sm" asChild className="h-9 rounded-xl">
                    <a href={imagemUrl} target="_blank" rel="noopener noreferrer">
                      <Link2 className="mr-1.5 h-4 w-4" />
                      Abrir
                    </a>
                  </Button>
                </div>
              </div>

              <p className="text-[11px] leading-relaxed text-muted-foreground">
                O Instagram não deixa outro site publicar por você: a imagem vai pronta e você escolhe feed, story ou reels.
              </p>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
