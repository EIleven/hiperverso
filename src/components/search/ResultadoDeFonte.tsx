// src/components/search/ResultadoDeFonte.tsx
'use client';

import React from 'react';
import { ExternalLink } from 'lucide-react';
import type { ResultadoDaBusca } from '@/app/api/search/route';

/**
 * Um resultado da aba Fontes: uma página de fora que a rede citou.
 *
 * Três decisões, e nenhuma é estética:
 *
 * 1. O LINK VAI DIRETO AO SITE. Sem passar por rota nossa, sem `/redirect?url=`, sem parâmetro acrescentado. Um
 *    redirecionador registraria quem clicou em quê — construir isso seria montar, dentro de uma rede que promete
 *    não rastrear, exatamente a peça que rastreia. O `href` é o endereço real, e o navegador vai nele.
 *
 * 2. O DOMÍNIO APARECE ANTES DO TÍTULO. Quem lê precisa saber de onde vem antes de decidir clicar; título bonito
 *    de fonte duvidosa é o mecanismo mais barato de desinformação que existe.
 *
 * 3. O DESTAQUE DOS TERMOS VEM COMO PARES DE ÍNDICES, nunca como HTML montado no servidor. Este texto foi escrito
 *    por terceiros: não existe caminho em que ele vire marcação dentro desta página.
 */
export default function ResultadoDeFonte({ resultado }: { resultado: ResultadoDaBusca }) {
  const href = resultado.url;
  if (!href) return null;

  const pedacos: React.ReactNode[] = [];
  let cursor = 0;
  for (const [de, ate] of resultado.marcas) {
    if (de < cursor || ate > resultado.trecho.length) continue;
    if (de > cursor) pedacos.push(resultado.trecho.slice(cursor, de));
    pedacos.push(
      <mark key={`${de}-${ate}`} className="rounded bg-primary/20 px-0.5 text-foreground">
        {resultado.trecho.slice(de, ate)}
      </mark>,
    );
    cursor = ate;
  }
  if (cursor < resultado.trecho.length) pedacos.push(resultado.trecho.slice(cursor));

  const data = resultado.criadoEm
    ? new Date(resultado.criadoEm).toLocaleDateString('pt-BR', { day: '2-digit', month: 'short', year: 'numeric' })
    : null;

  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="flex gap-3 rounded-xl border border-border/70 p-3 transition-colors hover:bg-muted/40 focus-visible:bg-muted/40"
    >
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
          {/* O endereço real, sem maquiagem: é o que diz se vale a pena clicar. */}
          <span className="truncate font-medium">{resultado.dominio}</span>
          <ExternalLink className="h-3 w-3 shrink-0" />
          {data && <span className="shrink-0">· {data}</span>}
        </div>

        <h3 className="line-clamp-2 text-sm font-semibold leading-snug text-foreground">{resultado.titulo}</h3>

        {resultado.trecho && (
          <p className="line-clamp-2 text-xs leading-snug text-muted-foreground">{pedacos}</p>
        )}
      </div>

      {resultado.imagem && (
        // Capa aberta que o próprio site publicou (og:image). Sem referência de origem: pedir a imagem não precisa
        // contar ao site de onde o pedido veio.
        <img
          src={resultado.imagem}
          alt=""
          loading="lazy"
          referrerPolicy="no-referrer"
          className="h-16 w-24 shrink-0 rounded-lg object-cover sm:h-20 sm:w-32"
        />
      )}
    </a>
  );
}
