// src/app/[locale]/about/page.tsx
'use client';

import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import BackButton from '@/components/shared/BackButton';

export default function AboutPage() {
  return (
    <div className="container mx-auto max-w-3xl py-8">
      <BackButton />
      <Card className="shadow-lg">
        <CardHeader className="text-center">
          <CardTitle className="text-3xl font-bold">Sobre o HiperVerso</CardTitle>
          <CardDescription className="text-lg text-muted-foreground">
            Onde vozes brasileiras ressoam e ideias se conectam.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6 text-foreground/90">
          <section>
            <h2 className="text-2xl font-semibold mb-3 text-primary">Nossa Missão</h2>
            <p>
              Em um mundo digital globalizado, o HiperVerso nasce com um propósito claro: ser a primeira rede social inteiramente brasileira, pensada, desenvolvida e hospedada no Brasil. Nossa missão é criar um espaço seguro e soberano para o diálogo construtivo, assegurando a proteção de dados dos nossos usuários em conformidade com as leis brasileiras. Através de um sistema de moderação moderno e ativo, nos comprometemos a cultivar uma comunidade baseada no respeito, na troca de ideias e na construção de conexões duradouras.
            </p>
          </section>
          <section>
            <h2 className="text-2xl font-semibold mb-3 text-primary">O Que Defendemos</h2>
            <ul className="list-disc list-inside space-y-3">
              <li>
                <strong>Soberania e Segurança:</strong> Seus dados são protegidos por leis brasileiras. Estamos comprometidos com a soberania digital, garantindo que suas informações sejam tratadas com o máximo de segurança e privacidade, longe de interferências externas.
              </li>
              <li>
                <strong>Combate à Desinformação:</strong> Temos uma política de tolerância zero com a disseminação de notícias falsas. Nossa moderação ativa e a colaboração da comunidade são pilares para garantir um ambiente informacional mais saudável e confiável.
              </li>
               <li>
                <strong>Promoção do Conhecimento:</strong> Acreditamos no poder da tecnologia e da ciência para transformar o futuro. O HiperVerso é um espaço para ampliar o acesso a esses conhecimentos, conectando brasileiros com os mesmos interesses e fomentando a inovação.
              </li>
              <li>
                <strong>Autenticidade e Respeito:</strong> Incentivamos a expressão genuína e o diálogo aberto. A discordância construtiva é bem-vinda, mas o desrespeito não. Temos uma política rigorosa contra assédio e discurso de ódio.
              </li>
              <li>
                <strong>Comunidade:</strong> Mais do que uma plataforma, o HiperVerso é uma comunidade. Estamos empenhados em promover um ambiente de apoio e inclusivo, onde cada brasileiro se sinta bem-vindo para participar e contribuir.
              </li>
            </ul>
          </section>
          <section>
            <h2 className="text-2xl font-semibold mb-3 text-primary">Transparência Técnica, Código &amp; Federação</h2>
            <ul className="list-disc list-inside space-y-2.5 text-sm sm:text-base">
              <li>
                <strong>Iniciativa comunitária independente:</strong> O HiperVerso é um projeto brasileiro independente mantido por <strong>Breno Ramos</strong> (<code className="text-xs">@breno@hiperverso.social</code>), sem vínculo institucional oficial com partido político ou governo e sem caráter de paródia.
              </li>
              <li>
                <strong>Tecnologia própria (não é fork de Misskey/Mastodon):</strong> A plataforma é desenvolvida em código próprio com TypeScript, Next.js, Firebase, comunicação P2P direta via WebRTC + criptografia ponta a ponta (E2EE) e camada nativa de ActivityPub.
              </li>
              <li>
                <strong>Código aberto à auditoria e Pull Requests:</strong> A base técnica de revisão e melhorias está pública em{' '}
                <a
                  href="https://github.com/EIleven/hiperverso"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary underline underline-offset-4 hover:opacity-80"
                >
                  github.com/EIleven/hiperverso
                </a>{' '}
                e pelo portal{' '}
                <a href="/pt-BR/dev" className="text-primary underline underline-offset-4 hover:opacity-80">
                  /pt-BR/dev
                </a>.
              </li>
              <li>
                <strong>Contato técnico e moderação:</strong> Reportes de vulnerabilidades, dúvidas de administradores do Fediverso ou solicitações de auditoria podem ser enviados para{' '}
                <a
                  href="mailto:brenobarros11@hotmail.com"
                  className="text-primary underline underline-offset-4 hover:opacity-80"
                >
                  brenobarros11@hotmail.com
                </a>{' '}
                ou diretamente para <code className="text-xs">@breno@hiperverso.social</code>.
              </li>
            </ul>
          </section>
          <section>
            <h2 className="text-2xl font-semibold mb-3 text-primary">Junte-se à Conversa</h2>
            <p>
              Seja você um especialista compartilhando conhecimento, um estudante aprendendo algo novo, ou simplesmente alguém buscando se conectar com outros brasileiros, sua presença é fundamental. Sua voz é uma parte vital da comunidade HiperVerso. Vamos juntos construir um futuro digital mais seguro e soberano.
            </p>
          </section>
        </CardContent>
      </Card>
    </div>
  );
}
