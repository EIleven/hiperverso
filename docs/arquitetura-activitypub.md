# Arquitetura ActivityPub (Fediverso)

> **Estado: implementado, desligado por padrão.** O que está descrito aqui existe no código e é coberto por testes
> (ver seção 12). A federação só passa a funcionar em produção quando a administração liga a chave da plataforma
> (`config/federation`) e cada pessoa decide, por conta própria, ativá-la. O roteiro de publicação por portões está em
> `docs/implantacao-federacao.md`.
>
> **O que esta versão faz:** ser encontrado e seguido no Fediverso, entregar posts escolhidos a quem segue, propagar
> edição e exclusão, moderar (seguidores, bloqueios, regras por servidor) e sair.
> **O que esta versão NÃO faz:** seguir contas de outros servidores, mostrar uma linha do tempo do Fediverso, receber
> respostas, curtidas ou compartilhamentos de fora, federar enquetes, citações e notícias, e oferecer na interface a
> migração (`Move`). O construtor do `Move` existe; a ação ainda não. **`alsoKnownAs` foi retirado do actor público**
> (ver §10): ele entregava, a quem lesse o ator sem autenticação, o mapa das outras identidades da mesma pessoa.

## 1. O que a federação muda, em uma frase

Hoje a rede controla 100% das cópias do conteúdo. Com federação, **outro servidor passa a guardar cópia** do que
seus usuários publicam, e nós deixamos de poder apagá-la. Toda a arquitetura abaixo existe para que essa troca seja
**escolhida, explicada e reversível no que for possível**, e não sofrida.

## 2. Três camadas de consentimento

Todas precisam estar ligadas para um objeto sair. A decisão é **reavaliada no momento do envio**, não só ao
enfileirar: entre uma coisa e outra podem passar horas, e a entrega que sai tem de ser autorizada agora.

| Camada | Onde vive | Padrão | Quem muda |
|---|---|---|---|
| 1. Plataforma | `config/federation` (`enabled`, `killSwitch`, `mode`) | **desligada** (sem o documento, vale desligada) | administração, pelo painel |
| 2. Conta | `users/{uid}/private/federation` (`enabled`, `paused`, `eligibleSince`) | desligada | a própria pessoa, nas configurações |
| 3. Publicação | campo `federation` do post: `local`, `public`, `unlisted`, `followers` | `local` | a pessoa, post a post; **fixo depois de criado** |

Regras que valem sempre:

- **Religar não federa o passado.** Cada ativação e cada retomada regravam `eligibleSince`; posts anteriores nunca
  saem. O que se publica durante uma pausa também não sai depois.
- **Pausa é interrupção, não atraso.** Uma entrega que estava na fila quando a pessoa pausou é **cancelada**, nunca
  enviada depois.
- **Apagar é exceção declarada.** O `Delete` de algo que já saiu continua valendo com a conta pausada ou desligada,
  porque impedi-lo prenderia a pessoa a uma cópia que ela quer retirar. Só o botão de emergência da plataforma o para
  (a fila fica intacta e retoma quando a plataforma volta).
- **O alcance de fora nunca é maior que o de dentro.** `public` e `unlisted` exigem perfil público; `followers` serve
  aos dois. Só post original do tipo eco e sem enquete: o resto a v1 não sabe representar.
- **O botão de emergência vale na hora.** Com ele ligado, a descoberta, o actor e a caixa de entrada respondem 404 e o
  worker não entrega nada.
- **O handle é reservado para sempre.** Desligar, trocar de `@` ou apagar a conta não libera `usuario@exercitodolula.app`:
  reaproveitá-lo permitiria a outra pessoa se passar por quem já tinha seguidores lá.
- **E-mail confirmado** é exigido para ativar (a mesma regra de postar, comentar e seguir).

## 3. O que NUNCA federa

| Dado | Por quê |
|---|---|
| Mensagens diretas | Comunicação privada. ActivityPub não oferece ponta a ponta. |
| Posts com alcance `local` (o padrão) | A pessoa não escolheu. |
| E-mail, data de nascimento, preferências, telefone | Moram em `users/{uid}/private/`; o actor só projeta nome, usuário, bio, avatar, capa, site e local. |
| Arquivos pessoais e mídia privada | A mídia federada só pode apontar para `media.exercitodolula.app/m/` (mídia pública). |
| Denúncias, moderação, dados de incidente | Sigilo do denunciante e da vítima. |
| Métricas e registros de acesso | Não interessam a terceiro. |
| Enquetes, citações e notícias | Ficam só aqui; o compositor avisa. |

**Sobre "só seguidores".** É entregue apenas à caixa de entrada de quem segue, e a `Note` correspondente responde
**404** a quem pedir de fora (o protocolo não nos dá como provar quem pede). Mas o ActivityPub **não impõe** a
restrição ao servidor que recebe: um servidor mal-comportado pode exibi-la a mais gente. A interface diz isso.

## 4. Superfície do protocolo

| Endpoint | Método | Para quê |
|---|---|---|
| `/.well-known/webfinger?resource=acct:usuario@exercitodolula.app` | GET | Descoberta: endereço → actor. Também aceita a URL do actor. Só responde por contas **ativas deste host** e pelo ator da **instância** (`acct:exercitodolula.app@exercitodolula.app` → `/ap/actor`), que o Mastodon em busca autorizada consulta para confirmar a chave com que assinamos as buscas. |
| `/.well-known/host-meta` | GET | Aponta para o WebFinger. |
| `/.well-known/nodeinfo` e `/nodeinfo/2.1` | GET | Metadados da instância (software, protocolo, contagens). Sem inscrições abertas anunciadas. |
| `/ap/users/{usuario}` | GET | `Person` com a chave pública. Navegador (sem `Accept` de ActivityPub) é mandado ao perfil (302). Conta desligada ou removida responde **410 com `Tombstone`**. |
| `/ap/users/{usuario}/inbox` e `/ap/inbox` | POST | Recebe atividades. **Assinatura obrigatória.** |
| `/ap/users/{usuario}/outbox` | GET | Só o alcance **público**, paginado por `before` (inteiro; qualquer outra coisa dá 400). |
| `/ap/users/{usuario}/followers` e `following` | GET | **Só a contagem.** A lista de seguidores nunca é publicada. |
| `/ap/notes/{id}` | GET | `Note` de um post já entregue, público ou não listado. Só-seguidores: 404. Apagado: 410. |
| `/ap/actor` | GET | O ator da **instância** (`Application`, `preferredUsername` = o domínio): a chave pública com que o servidor assina as buscas (GET) que faz em outros servidores. Não é uma pessoa e ninguém publica nele. Plataforma desligada: 404; sem `AP_MASTER_KEY`: 503. |

Gestão (exige ID token do Firebase no cabeçalho `Authorization`; cookie não serve):

| Endpoint | Para quê |
|---|---|
| `/api/ap/account` | Estado da federação da conta; ativar, pausar, retomar, desligar. |
| `/api/ap/deliveries` | O que foi enviado e o que aconteceu; "tentar de novo". Nunca o corpo nem a URL completa do destino. |
| `/api/ap/followers` | Lista (só para a dona) e remoção, com `Reject` ao servidor do seguidor. |
| `/api/ap/blocks` | Bloquear ator ou servidor inteiro (inclui subdomínios). Bloquear servidor **não o contata**. |
| `/api/ap/admin` | Painel: chave da plataforma, botão de emergência, regras por servidor, fila e contadores. Para quem não é administrador responde **404**. |
| `/api/ap/worker` | O motor de entrega. Só o Cloud Scheduler, com token OIDC de conta de serviço própria. Qualquer outro recebe **404**. |

**Perfis locais seguem independentes.** O actor é uma *projeção* do perfil: `users/{uid}` continua mandando. Se a
federação for desligada, o perfil local não muda em nada.

## 5. Modelo de dados

Toda coleção `ap_*` que acumula nasce com `expireAt` e política de TTL declarada em `firestore.indexes.json`.

| Coleção | O que guarda | Retenção |
|---|---|---|
| `config/federation` | chave da plataforma | até alterar |
| `ap_instance_policy/{domínio}` | regra da casa: `allow`, `silence` ou `suspend` | até alterar |
| `ap_handles/{handle}` | reserva do handle e chave pública | **para sempre** (de propósito) |
| `users/{uid}/private/federation` | escolha da pessoa; só ela lê, e ela **não** pode apagar | até desligar/apagar a conta |
| `ap_keys/{uid}` | chave privada **cifrada** (AES-256-GCM, AAD = uid) | destruída até 3 dias após apagar a conta |
| `ap_objects`, `ap_outbox/{uid}/items` | posts já entregues e o índice público | até desligar/apagar a conta |
| `ap_followers/{uid}__{sha}` | seguidores remotos e o `Follow` original | até remover/desligar |
| `ap_user_blocks/{uid}__{sha}` | bloqueios da pessoa (até 500) | até desbloquear/desligar |
| `ap_remote_actors/{sha}` | cache de ator remoto | 14 dias (2 se removido) |
| `ap_seen/{sha}` | idempotência de entrada (anti-replay) | 7 dias |
| `ap_outbound/{id}` | fila de tarefas de saída | 7 dias depois de concluída |
| `ap_deliveries/{id}` | uma entrega por destino, com o corpo exato | 30 dias depois do estado final |
| `ap_domain_health/{domínio}` | disjuntor por servidor | 7 dias |
| `ap_audit` | decisões (tipo, domínio, motivo, quem), **sem corpo de terceiros** | 180 dias |
| `ap_stats/{yyyymmdd}` | contadores | 400 dias |
| `ap_flags` | denúncias recebidas de fora (sinal, nunca ação automática) | 90 dias |

Os clientes **não** leem nem escrevem nenhuma coleção `ap_*`: tudo passa pelo servidor.

### Identidade do conteúdo remoto (`src/lib/activitypub/remoteIdentity.ts`)

Um perfil ou post de **fora** vira um documento local com id derivado, e esse cálculo existe em **um só lugar**:

| Documento | Id | Derivação |
|---|---|---|
| `users/{id}` (ator remoto) | `ap_` + 24 hex | `sha256(actorId)` |
| `posts/{id}` e `…/comments/{id}` (conteúdo remoto) | `ap_` + 24 hex | `sha256(objectId)`; o id vem do `uri` do objeto (o `url` da página só entra como id antigo, reconhecido para não duplicar) |
| `ap_following/{uid}/actors/{id}` | 32 hex | `sha256(actorId)` |

Regras que valem para toda entrada (inbox, perfil remoto, sincronização, busca):

- **O domínio próprio nunca vira `ap_`.** `@Breno@exercitodolula.app` é o UID local de quem tem o `usernames/breno` ou o
  `ap_handles/breno`; um ator, post ou comentário do nosso host é resolvido pelas coleções locais (`ownPostRef`,
  `ownActorHandle`), e a rota de perfil remoto devolve 409 `perfil-local` com o `localUserId`.
- **Ator buscado só vale se for de quem dissemos** (`validateFetchedActor`): `id` igual à URL pedida, `preferredUsername`
  igual ao usuário do handle, host igual (ou subdomínio) ao do handle, `inbox` e `sharedInbox` no mesmo host e nunca o nosso.
  Um servidor não grava dados no cache de outro ator.
- **Post de terceiro** (original de um repost, post-pai de uma resposta) só é materializado depois de buscado no servidor
  do autor, com `attributedTo`, host e endereçamento público conferidos; quem já existe é atualizado só pelo **mesmo** ator.
- Guarda: `npm run e2e:ap-identidade` falha se algum arquivo montar `ap_${hash}` fora desse módulo.

## 6. Fluxo de saída

```
post criado/editado/apagado  ──►  a Function apPostFederation só ENFILEIRA (ap_outbound). Publicar nunca espera a rede.
                                   │
                                   ▼
Cloud Scheduler (a cada minuto)  ──►  POST /api/ap/worker  (OIDC; 404 para qualquer outro)
                                   │
      A. EXPANDIR   cada tarefa vira UMA entrega por servidor de destino (caixa compartilhada quando existe)
      B. ENTREGAR   o portão roda DE NOVO; assina (HTTP Signatures + Digest) e envia o corpo exato gravado
      C. LIMPAR     destrói chaves de contas removidas cujo prazo venceu
```

- **Idempotência:** o id da entrega é determinístico (`uid + operação + objeto + destino`). Repetir o gatilho, retomar
  depois de queda ou reexecutar o worker não duplica nada. O corpo é gravado uma vez e reenviado byte a byte, então o
  `Digest` e a idempotência no destino se mantêm.
- **Posse temporária (lease):** quem pega uma entrega a reserva por uma transação com prazo; se o worker cair, outra
  execução assume depois que o prazo vence.
- **Retentativas:** 60 s, 5 min, 20 min, 1 h, 3 h, 8 h, 24 h, com ±15% de jitter, até **8 tentativas (cerca de 1,5
  dia)**; respeita `Retry-After`. Depois disso a entrega vai a **dead-letter** (`dead`), visível para a pessoa, que
  pode mandar tentar de novo.
- **Falha permanente** (4xx do destino, exceto 408/429) não repete. Falha de infraestrutura (rede, 5xx, 429, 408) conta
  para o **disjuntor por servidor**: servidor que vem falhando espera, sem gastar tentativa; as entregas do mesmo
  domínio rodam em sequência para o disjuntor não perder contagem.
- **Cancelamento:** pausa, post que deixou de ser elegível, servidor que passou a ser recusado pela casa ou pela
  pessoa, seguidor que se desfez (para o `Accept`) ou que voltou (para o `Reject`) cancelam a entrega com o motivo.

## 7. Fluxo de entrada

`POST /ap/users/{usuario}/inbox` (ou `/ap/inbox`) passa por estas etapas, **da mais barata à mais cara**, e nada
de rede acontece antes de a estrutura estar válida:

1. Plataforma desligada ou botão de emergência → **404**.
2. Método diferente de POST → **405**; corpo acima de **1 MB** → **413** (lido em fluxo, com teto, sem confiar em
   `Content-Length`); tipo de conteúdo que não é ActivityPub → **415**.
3. Caixa pessoal de conta que não existe ou não está ativa → **404**.
4. Cabeçalho `Signature` bem formado (algoritmo `rsa-sha256`/`hs2019`, `host`, `date` e `digest` assinados),
   `Date` dentro de ±5 min e `Digest` do corpo conferindo → senão **401**. Sem nenhuma consulta de rede ainda.
5. Política da casa para o domínio da chave (suspenso, ou fora da lista permitida) → **202** e descarta, sem dar
   retorno de que foi bloqueado.
6. Limite por domínio (240/min) → **429**.
7. Busca a chave do ator (cache de 24 h; **uma** atualização forçada por 5 min se a assinatura falhar, para absorver
   rotação sem virar amplificador) e confere a assinatura → senão **401**.
8. JSON válido e estrutura: o ator da atividade tem de ser o dono da chave, o id do objeto tem de ser do mesmo host,
   profundidade e quantidade de nós limitadas → senão **4xx**.
9. Limite por ator (90/min) e **anti-replay** (`ap_seen`, 7 dias) → atividade repetida: **202** sem efeito.
10. Despacha por tipo: `Follow` (aceita e enfileira `Accept`), `Undo`, `Block`, `Delete` (do ator, de post e de comentário
    remotos: vira túmulo, fora dos feeds), `Flag` (vira sinal, limitado a 5/h), `Create` (resposta a post nosso, post público de quem seguimos, mensagem direta),
    `Update` (edição de post ou comentário, **só pelo autor**), `Like` e `Announce` (em post **ou comentário**: curtir ou
    repostar um comentário conta no comentário, e o portão é o do autor dele), `Accept`/`Reject` (fecham o nosso `Follow`
    a uma conta remota: o vínculo gravado por antecipação vira aceito ou é desfeito). `Announce` busca o objeto no servidor do
    autor e exige `id` igual ao pedido e mesmo host. O resto (`Move`) é **202 ignorado**.

Defesas específicas: o algoritmo da assinatura é fixo (sem confusão com HMAC); chave RSA de 2048 a 8192 bits; todo
`fetch` de saída passa pelo módulo de busca segura (resolve o DNS antes, recusa IP privado, só `https`, redirecionamento
limitado e validado, timeout e teto de corpo).

## 8. Chaves de assinatura

Cada conta que ativa a federação ganha um par RSA (2048 bits). A pública vai no actor e na reserva do handle. A
**privada nunca fica em claro**: é cifrada com **AES-256-GCM**, com o `uid` como dado autenticado adicional (AAD), e só
então gravada em `ap_keys/{uid}`. Uma chave cifrada de uma pessoa **não abre** se trocada para o documento de outra.

A chave que cifra tudo isso (o *chaveiro*, `AP_MASTER_KEY`) vive no **Secret Manager** e é injetada no ambiente do app,
no formato `kid:base64,kid2:base64`. A primeira entrada cifra; qualquer uma decifra. **Rotação sem migração:**
acrescenta-se uma chave nova na frente, e o que estava cifrado com a antiga continua abrindo; a rotina `rewrapSecret`
recifra sem tocar na chave privada. Comprometer só o banco **não** entrega as chaves de assinatura.

**A casa também tem uma chave, só dela** (`ap_keys/@instance`, AAD `@instance`, criada na primeira chamada e única mesmo
com criação simultânea: `saveSealedKeyIfAbsent`). Ela assina as **buscas** (GET) em servidores com busca autorizada
(*authorized fetch*), no lugar da chave de uma pessoa: antes as buscas saíam assinadas pelo primeiro handle ativo, e todo
servidor as via como sendo dele. O fetcher só assina **depois** de um 401/403 e tenta uma vez; servidor aberto não recebe
identidade nenhuma.

Ao apagar a conta, o handle passa a `deleting` (nunca mais reativável) e a chave privada é destruída em até **3 dias**:
tempo para o `Delete` do actor ser entregue e retentado, e nenhum a mais.

## 9. Moderação permanece nossa

A federação **não importa a moderação de ninguém**. Decisões de outra instância não nos obrigam, e as nossas não
dependem de concordância alheia. Três níveis, todos já implementados:

| Quem decide | O quê | Efeito |
|---|---|---|
| A pessoa | Remover seguidor | Tira o vínculo e envia `Reject` ao servidor dele. |
| A pessoa | Bloquear ator | O mesmo, e descarta tudo o que vier dele. |
| A pessoa | Bloquear servidor | Remove os seguidores do domínio **e subdomínios**, **sem contatá-lo**, e descarta o que vier de lá. |
| A administração | `silence`, `suspend` ou `allow` por domínio; modo `open` ou `allowlist` | `suspend` (ou fora da lista) recusa a entrada e **cancela a saída já enfileirada**. |
| A administração | Botão de emergência | Para tudo na hora; a fila fica intacta. |

`Flag` recebido de fora entra como **sinal** (`ap_flags`), nunca como ação automática. Toda mudança de política deixa
rastro (quem, quando, o quê) em `ap_audit`.

## 10. Portabilidade e saída

- **Sair (implementado):** desligar a federação enfileira o `Delete` do actor a quem seguia, remove os vínculos e apaga
  o que a federação guardava da pessoa (objetos, outbox, bloqueios). O perfil local continua intacto. O endereço
  continua reservado. Religar depois reaparece como **conta nova**: quem seguia precisa seguir de novo.
- **Garantia honesta:** o `Delete` e o `Update` são enviados em melhor esforço. **Servidores remotos podem não obedecer**
  e cópias já guardadas podem continuar existindo. A interface e a Política de Privacidade dizem isso.
- **Migrar para outro servidor (`Move`):** o construtor da atividade existe, mas a **ação na interface ainda não
  existe**. Não prometemos migração até existir.
- **`alsoKnownAs` NÃO é publicado (decisão de 2026-11-17, após apontamento de outra instância).** Declarar no actor as
  outras contas da mesma pessoa deixava um mapa de identidades cruzadas aberto a qualquer leitor, e cada URI ali custava
  mais uma resolução de ator para toda instância que lesse o documento. O campo saiu do `@context`, do construtor e da
  API; não há mais como gravá-lo (`set-aliases` responde `410 alias-desativado`). O que já estava gravado continua
  legível no banco, mas **nunca sai no actor**. Quem migrar para cá declara o vínculo no servidor de ORIGEM, que é o
  lado consultado pela migração.
- **Exportar:** a exportação de dados da conta **ainda não inclui** os dados da federação. Pendente.

## 11. Auditoria sem exposição

Registra-se: atividade recebida (tipo, domínio, decisão, motivo), entrega (destino, tentativas, estado final) e mudança
de política (quem, quando, o quê), mais contadores diários. **Não** se registra o corpo de atividade de terceiro nem o
conteúdo de objeto remoto: é dado pessoal de alguém que não é nosso usuário. A pessoa vê as próprias entregas, sem
corpo e sem a URL completa do destino.

## 12. Ameaças e o que prova cada mitigação

| # | Ameaça | Mitigação implementada | Onde é provada |
|---|---|---|---|
| T1 | **SSRF** (ator com `inbox` em IP interno, redirecionamento perigoso) | Busca segura: DNS resolvido antes, IP privado/loopback/link-local recusado, só `https`, redirecionamentos validados, timeout e teto de corpo; POST só recusa como "inseguro" quando o motivo é `forbidden` | `e2e:safe-fetch`, `e2e:ap-core`, `e2e:ap-servicos` |
| T2 | **Replay** | Janela de `Date` de ±5 min + `activity.id` em `ap_seen` (7 dias) | `e2e:ap-core`, `e2e:ap-servicos`, fumaça |
| T3 | **Falsificação de ator** | Dono da chave = ator da atividade; `id` do objeto no mesmo host; assinatura de outro ator rejeitada | `e2e:ap-core`, fumaça (impostor com chave própria) |
| T4 | **Flood/spam** | Limite por domínio (240/min) e por ator (90/min), `silence`/`suspend`, modo `allowlist` | `e2e:ap-servicos`, `e2e:ap-moderacao` |
| T5 | **Amplificação** | Fila com teto por destino, disjuntor por servidor, nunca buscar URL arbitrária vinda de atividade além do ator | `e2e:ap-servicos` |
| T6 | **Vazamento de privado** | Portão de três níveis **reavaliado no envio**; regras do Firestore impedem alcance sem opt-in; só `media.exercitodolula.app/m/` entra em mídia | `e2e:ap-core` (enumeração de estados), `e2e:ap-regras`, `e2e:ap-funcoes` |
| T7 | **Enumeração de seguidores** | Coleções só com contagem; lista só para a dona; remover seguidor alheio responde "não encontrado" | `e2e:ap-moderacao`, fumaça |
| T8 | **Mídia maliciosa** | Mídia remota nunca é servida do nosso domínio; nada de mídia remota é buscado | `e2e:ap-core` |
| T9 | **Chave privada exposta** | Cifra envelope AES-256-GCM com AAD = `uid`; chaveiro no Secret Manager; clientes sem acesso a `ap_*` | `e2e:ap-core` (cifra, AAD, rotação), `e2e:ap-regras` |
| T10 | **Exclusão não propagada** | `Delete`/`Update` em melhor esforço + transparência; sem prometer o que o protocolo não garante | `e2e:ap-servicos`, fumaça, fluxo de navegador |
| T11 | **Administração indevida** | Painel e worker respondem 404 a quem não deve ver; token OIDC com conta de serviço e audiência exatas | fumaça, 3 mutantes de autorização mortos |
| T12 | **Corpo gigante/lento** | Leitura em fluxo com teto de 1 MB, sem confiar em `Content-Length` | fumaça (413) |

**Como se verifica:** `npm run e2e:ap-core` (456), `e2e:ap-servicos` (189), `e2e:ap-moderacao` (81), `e2e:ap-contrato`
(162, memória e Firestore no emulador), `e2e:ap-regras` (70), `e2e:ap-funcoes` (73), `e2e:ap-fumaca` (130, app real) e
a seção `fediverso` do fluxo de navegador (17). Os testes de segurança foram submetidos a **teste de mutação**: defeitos
injetados de propósito (assinatura sem conferir, portão removido, autorização aberta etc.) precisam derrubar a suíte.

O que os emuladores **não** provam: **índices** (o único composto necessário é `ap_deliveries(uid, createdAtMs)`) e a
**interoperabilidade com servidores de terceiros**. O primeiro é conferido em produção na publicação; o segundo exige um
servidor de terceiros de verdade e está na lista de pendências.

## 13. Decisões (ADRs)

**ADR-AP-1 — Desligada por padrão, em três níveis.** *Aceita e implementada.* Ligada com opt-out publicaria fora sem
escolha.

**ADR-AP-2 — Modo `allowlist` e regras por servidor.** *Aceita e implementada.* A plataforma abre em `open` ou
`allowlist`; `suspend`/`silence`/`allow` por domínio, com subdomínios herdando a regra mais específica.

**ADR-AP-3 — Mensagens diretas nunca federam.** *Aceita.* ActivityPub não tem ponta a ponta.

**ADR-AP-4 — Fila no Firestore com worker no Next, em vez de Cloud Tasks.** *Aceita e implementada.* A interface precisa
mostrar estado, falha e "tentar de novo"; Cloud Tasks esconde isso. O pacote `functions/` não compartilha código com o
app (o App Hosting o exclui do build), então as Functions só **enfileiram**; assinar e entregar mora no Next.

**ADR-AP-5 (revisada) — Cifra envelope no lugar de um segredo por usuário.** *Aceita e implementada.* Um segredo por
conta não escala. A chave de cada conta é cifrada com AES-256-GCM (AAD = `uid`) e só o chaveiro vive no Secret Manager.
Mantém a separação de confiança: o banco sozinho não expõe chave de assinatura. Rotação sem migração.

**ADR-AP-6 — Religar não federa o passado.** *Aceita e implementada* (`eligibleSince`).

**ADR-AP-7 — Handle = `@` atual em minúsculas, imutável e reservado para sempre.** *Aceita e implementada.*

**ADR-AP-8 — Bloquear servidor não o contata.** *Aceita e implementada.* Quem foi bloqueado não recebe nem um `Reject`.

**ADR-AP-9 — Gestão só por ID token no cabeçalho.** *Aceita e implementada.* Ação que muda estado não depende de cookie.

**ADR-AP-10 — Limites declarados:** 500 bloqueios por pessoa (o conjunto é lido a cada atividade e o adaptador lê até
1000), 1 MB por corpo de entrada, 8 tentativas por entrega.

## 14. Estado e pendências

| Item | Estado |
|---|---|
| Descoberta, ator, outbox, coleções, `Note`, caixas de entrada | Implementado e testado |
| `Follow`/`Undo`/`Block`/`Delete`/`Flag` recebidos; `Accept`/`Reject` enviados | Implementado e testado |
| `Create`/`Update`/`Delete` de posts e `Delete` do actor | Implementado e testado |
| Interface: ativar com consentimento, pausar, desligar, entregas, seguidores, bloqueios, alcance no compositor, selo no post | Implementado e testado no navegador |
| Painel administrativo (API) | Implementado; **sem interface** (hoje só pela API) |
| Publicação em produção | Etapa A (tudo desligado) em `docs/implantacao-federacao.md`; etapa B (ligar) depende dos itens abaixo |
| Textos legais (Política de Privacidade, Termos, Cookies, retenção, matriz de tratamentos) | **Pendente**: só devem mudar quando a plataforma for ligada, descrevendo o que está implementado |
| Teste de interoperabilidade com um servidor real (Mastodon/Pleroma) | **Pendente**: exige uma conta de terceiros |
| Busca **assinada** (GET) do actor remoto | **No ar** (2026-11-14): ator da instância em `/ap/actor` + WebFinger próprio, assina só depois de um 401/403 (`e2e:ap-instancia`, 33). Falta conferir de ponta a ponta com um servidor real em modo de busca autorizada (os primeiros pedidos de confirmação já chegam nos logs) |
| `Move` na interface; exportação com dados da federação | **Pendente** (construtor existe) |
| `alsoKnownAs` no actor público | **Removido** (2026-11-17): identidades cruzadas abertas a raspagem e amplificação de resolução entre instâncias. Leitura do legado preservada no banco |
| Seguir contas remotas, linha do tempo do Fediverso, respostas e curtidas de fora | **Fora desta versão** |
| Parecer jurídico sobre transferência internacional por federação | **Pendente** (a cópia vai para servidor em país que não escolhemos) |
