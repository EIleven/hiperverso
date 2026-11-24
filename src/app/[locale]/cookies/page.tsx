// src/app/[locale]/cookies/page.tsx
// Política de Cookies com inventário real. Os nomes abaixo foram levantados do código (grep por localStorage,
// sessionStorage e middleware), não de modelo: inventário inventado é pior que inventário ausente.
'use client';

import Link from 'next/link';
import { useLocale } from 'next-intl';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import BackButton from '@/components/shared/BackButton';
import ContactEmail from '@/components/shared/ContactEmail';
import PrivacyPreferencesButton from '@/components/consent/PrivacyPreferencesButton';

type Linha = {
  nome: string;
  tipo: string;
  finalidade: string;
  categoria: 'Necessário' | 'Medição';
  duracao: string;
};

const NOSSOS: Linha[] = [
  {
    nome: 'NEXT_LOCALE',
    tipo: 'Cookie',
    finalidade: 'Lembrar o idioma escolhido (pt-BR ou en).',
    categoria: 'Necessário',
    duracao: 'Até expirar ou você limpar os cookies',
  },
  {
    nome: 'Sessão de login (Firebase Authentication)',
    tipo: 'Armazenamento do navegador',
    finalidade: 'Manter você conectado entre páginas e visitas.',
    categoria: 'Necessário',
    duracao: 'Até você sair da conta',
  },
  {
    nome: 'soberan_consent',
    tipo: 'localStorage',
    finalidade: 'Guardar a sua decisão sobre cookies, a versão do aviso e a data — é o que nos permite respeitá-la e demonstrá-la.',
    categoria: 'Necessário',
    duracao: 'Até você limpar os dados do site, ou até o aviso mudar de versão',
  },
  {
    nome: 'theme',
    tipo: 'localStorage',
    finalidade: 'Lembrar tema claro ou escuro.',
    categoria: 'Necessário',
    duracao: 'Até você limpar os dados do site',
  },
  {
    nome: 'soberan_comment_settings',
    tipo: 'localStorage',
    finalidade: 'Lembrar como você prefere ver comentários (ordem e formato).',
    categoria: 'Necessário',
    duracao: 'Até você limpar os dados do site',
  },
  {
    nome: 'soberan-active-feed-tab',
    tipo: 'localStorage',
    finalidade: 'Lembrar em qual aba do feed você estava.',
    categoria: 'Necessário',
    duracao: 'Até você limpar os dados do site',
  },
  {
    nome: 'searchHistory',
    tipo: 'localStorage',
    finalidade: 'Guardar suas buscas recentes, só no seu aparelho, para repetir com um toque.',
    categoria: 'Necessário',
    duracao: 'Até você limpar os dados do site',
  },
  {
    nome: 'exelula:haptics',
    tipo: 'localStorage',
    finalidade: 'Lembrar se você quer vibração ao interagir.',
    categoria: 'Necessário',
    duracao: 'Até você limpar os dados do site',
  },
  {
    nome: 'viewed_posts_persistent · profile_clicks_persistent',
    tipo: 'localStorage',
    finalidade: 'Evitar contar a mesma visualização várias vezes. Fica só no seu aparelho e guarda apenas identificadores de publicação, não de pessoas.',
    categoria: 'Necessário',
    duracao: '30 dias por publicação',
  },
  {
    nome: 'soberan_hidden_posts',
    tipo: 'sessionStorage',
    finalidade: 'Esconder, durante a navegação, publicações que você mandou ocultar.',
    categoria: 'Necessário',
    duracao: 'Até fechar a aba',
  },
];

const TERCEIROS: Linha[] = [
  {
    nome: '_GRECAPTCHA',
    tipo: 'Cookie de terceiro (Google)',
    finalidade: 'Distinguir pessoa de robô no cadastro e no login, contra fraude e automação.',
    categoria: 'Necessário',
    duracao: 'Definida pelo Google',
  },
  {
    nome: '_ga, _ga_* (Google Analytics)',
    tipo: 'Cookie de terceiro (Google)',
    finalidade: 'Medir uso das páginas. Só existe se você aceitar.',
    categoria: 'Medição',
    duracao: 'Definida pelo Google',
  },
];

function Tabela({ titulo, linhas }: { titulo: string; linhas: Linha[] }) {
  return (
    <div className="not-prose mt-4">
      <h3 className="mb-2 text-lg font-semibold">{titulo}</h3>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-border text-left">
              <th className="py-2 pr-3 font-semibold">Nome</th>
              <th className="py-2 pr-3 font-semibold">Tipo</th>
              <th className="py-2 pr-3 font-semibold">Para quê</th>
              <th className="py-2 pr-3 font-semibold">Categoria</th>
              <th className="py-2 font-semibold">Duração</th>
            </tr>
          </thead>
          <tbody className="align-top">
            {linhas.map((l) => (
              <tr key={l.nome} className="border-b border-border/50">
                <td className="py-2 pr-3 font-mono text-xs">{l.nome}</td>
                <td className="py-2 pr-3">{l.tipo}</td>
                <td className="py-2 pr-3">{l.finalidade}</td>
                <td className="py-2 pr-3">{l.categoria}</td>
                <td className="py-2">{l.duracao}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default function CookiePolicyPage() {
  const locale = useLocale();

  return (
    <div className="container mx-auto max-w-3xl py-8">
      <BackButton />
      <Card className="shadow-lg">
        <CardHeader className="text-center">
          <CardTitle className="text-3xl font-bold">Política de Cookies</CardTitle>
          <CardDescription>Versão 2 &middot; em vigor desde 11 de novembro de 2026</CardDescription>
        </CardHeader>
        <CardContent className="space-y-6 text-foreground/90 prose prose-invert prose-p:text-foreground/90 prose-a:text-primary prose-li:text-foreground/90">
          <section>
            <h2 className="text-xl font-semibold mt-6 mb-2">Suas opções, primeiro</h2>
            <p>
              Os cookies de <strong>medição</strong> e de <strong>publicidade</strong> ficam{' '}
              <strong>desligados até você aceitar</strong>. Enquanto você não decide, o script de medição{' '}
              <strong>não é nem baixado</strong> — não é o caso de carregar e &ldquo;não usar&rdquo;. Você pode rever
              ou revogar a escolha a qualquer momento, aqui:
            </p>
            <div className="not-prose my-3">
              <PrivacyPreferencesButton variant="outline" />
            </div>
            <p>
              Recusar custa um clique, igual a aceitar. Os <strong>estritamente necessários</strong> não dependem de
              aceite, porque sem eles você não consegue entrar na conta nem usar a rede — e, por isso, não há
              interruptor para eles.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold mt-6 mb-2">Uma observação honesta sobre nomenclatura</h2>
            <p>
              Quase tudo que a rede guarda no seu navegador <strong>não é cookie</strong>: é{' '}
              <em>localStorage</em> e <em>sessionStorage</em>, que ficam só no seu aparelho e{' '}
              <strong>não são enviados ao servidor a cada requisição</strong>. Chamamos esta página de &ldquo;Política
              de Cookies&rdquo; porque é o nome que as pessoas procuram, mas o inventário abaixo diz o tipo real de
              cada item.
            </p>
            <p>
              <strong>A rede não usa cookie próprio de rastreamento.</strong> Houve um, de sessão, que registrava
              visitas; foi removido, e hoje a contagem de acessos não guarda IP nem vínculo com sua conta (ver a{' '}
              <Link href={`/${locale}/privacy`} className="text-primary hover:underline">
                Política de Privacidade
              </Link>
              ).
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold mt-6 mb-2">Inventário</h2>
            <Tabela titulo="Nossos (primeira parte)" linhas={NOSSOS} />
            <Tabela titulo="De terceiros" linhas={TERCEIROS} />
            <p className="mt-4 text-sm">
              Itens de terceiro são definidos pelo Google e a duração é controlada por ele, não por nós. O{' '}
              <code>_GRECAPTCHA</code> entra na categoria necessária porque é proteção contra fraude e automação na
              entrada da rede, sem a qual o cadastro fica aberto a robôs.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold mt-6 mb-2">Pelo navegador</h2>
            <p>
              Você também pode bloquear ou apagar cookies e dados de site nas configurações do seu navegador. Isso
              funciona, mas é mais bruto: apagar os necessários desconecta sua conta e faz a rede esquecer idioma,
              tema e preferências — inclusive a sua decisão sobre cookies, e então o aviso reaparece.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold mt-6 mb-2">Alterações</h2>
            <ul>
              <li>
                <strong>Versão 2 — 11 de novembro de 2026:</strong> inventário com nome, tipo, finalidade, categoria e
                duração; controle real de consentimento em lugar de &ldquo;configure seu navegador&rdquo;; distinção
                entre cookie e armazenamento local.
              </li>
              <li>
                <strong>Versão 1 — 4 de agosto de 2025:</strong> texto genérico, sem listar um único item, e sem
                oferecer escolha.
              </li>
            </ul>
          </section>

          <section>
            <h2 className="text-xl font-semibold mt-6 mb-2">Contato</h2>
            <p>
              Dúvidas sobre cookies:{' '}
              <ContactEmail channel="privacy" className="text-primary hover:underline" fallback={null} />.
            </p>
          </section>
        </CardContent>
      </Card>
    </div>
  );
}
