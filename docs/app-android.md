# App Android (Exe. Lula): build, assinatura, publicação e login com Google

Atualizado em 2026-10-24 (versão 1.2.1). O app é uma **casca do Capacitor** que abre `https://exercitodolula.app` (`server.url` em
`capacitor.config.ts`). Tudo que é tela ou texto do site muda no app **assim que o site é publicado**, sem novo APK. Só precisa
de APK novo quando muda algo **nativo**: nome ou ícone do app, splash, plugins, permissões, versão do Android alvo.

- Nome visível: **Exe. Lula** (`strings.xml`). O identificador `com.soberan.app` **não muda** (é o que permite atualizar por cima).
- O APK fica em `public/downloads/` e é oferecido em `/download` (flag `NEXT_PUBLIC_APK_DOWNLOAD_ENABLED=true` no `apphosting.yaml`).

## Gerar e publicar uma versão nova (automático)

1. Suba `versionCode` (e `versionName`) em `android/app/build.gradle`. Precisa ser maior que o publicado.
2. `npm run apk:lancar -- -PublicarSite "nota 1" "nota 2"`: copia a config do Capacitor, compila o release (Gradle 8.11.1),
   alinha, **assina com a keystore do projeto**, confere e publica no `/download` (o passo 4 abaixo) e faz o deploy do site.
   `-SemPublicar` só gera e assina (`android/app/build/outputs/apk/release/app-release.apk`), para testar antes.
3. Depois, commit de `public/downloads/` (o APK e o `latest.json`).

APK já assinado no Android Studio (caminho manual abaixo): `npm run apk:lancar -- -ApkPronto
android\app\release\app-release.apk -PublicarSite "nota"` faz só a conferência, a publicação no `/download` e o deploy.

**Configuração, uma vez por computador:** `scripts\apk-configurar-assinatura.cmd` (dois cliques ou no terminal). Pede o
alias (Enter aceita `soberan_key`) e as senhas da keystore `E:\Soberan\keystores\soberan-keystore.jks` (os mesmos da tela do Android Studio), confere contra
a keystore e grava em `E:\Soberan\keystores\assinatura.dpapi.xml`, **criptografado pelo Windows (DPAPI)**: só este usuário
neste computador consegue usar. A senha não passa por linha de comando, tela, log ou Git (o `apksigner` a lê de uma variável de
ambiente só durante a assinatura). Para trocar a senha, rode de novo; para desligar a automação, apague o `.xml`. O risco é o
mesmo do Android Studio "lembrar a senha": quem usar esta conta do Windows consegue assinar. Guarde uma cópia da keystore e da
senha fora deste computador: sem elas não há como atualizar o app já instalado nos celulares.

### Pelo Android Studio (manual)

1. `npx cap sync android`, se mudou o `capacitor.config.ts`.
2. File > Sync Project with Gradle Files.
3. **Build > Generate Signed App Bundle / APK > APK > release**, com a mesma keystore. O resultado sai em
   `android/app/release/app-release.apk`.
4. `npm run apk:publicar -- android/app/release/app-release.apk "nota 1" "nota 2"`. O comando **recusa** o arquivo se o pacote
   não for `com.soberan.app`, se a assinatura não bater com a chave do projeto (SHA-256 do certificado
   `87d26afdfca967382d74c13dc1de13b342a427435576567593efb6fd68119c7a`) ou se o `versionCode` não subiu. Ele copia o APK para
   `public/downloads/`, apaga o anterior e grava `latest.json` com o SHA-256 real.
5. Publique o site: `firebase deploy --only apphosting:studio --project echo-b5aw9` (o `.gitignore` tem a exceção
   `!public/downloads/*.apk`, senão o APK não iria no envio).

Conferir antes de assinar, sem a senha: `aapt2 dump badging` (pacote, versão, nome) e `apksigner verify --print-certs`.

### Gradle: não use o `./gradlew` do projeto
O wrapper foi atualizado fora do Git para o Gradle 9.7.1, que **não combina** com o plugin do Android 8.7.2. Para compilar sem
assinatura (conferência), use o Gradle 8.11.1 do cache, apontando a saída para fora do projeto (o Android Studio aberto trava
arquivos de `app/build`):
`gradle-8.11.1\bin\gradle.bat --no-daemon --init-script E:\Soberan\tools\gradle-init-build-isolado.gradle assembleRelease`
(saída em `E:\Soberan\tools\apk-build\_app\outputs\apk\release\`). No Studio, use Settings > Build Tools > Gradle > Specified
location apontando para o mesmo 8.11.1.

## Notificações (push) e vibração no app (versão 1.3.0)

Plugins nativos novos, então **precisa de APK novo** (o site sozinho não basta): `@capacitor/push-notifications` (avisos),
`@capacitor/haptics` (vibração) e `@capacitor/app` (reservado para o botão voltar). O que o APK ganha, e onde está:

- **Permissão** `POST_NOTIFICATIONS` no `AndroidManifest.xml` (Android 13+ só pergunta se ela estiver declarada).
- **Ícone e cor do aviso:** `res/drawable-*/ic_stat_notify.png` (silhueta branca da lula, gerada por
  `MARCA_SO=notificacao npm run marca:gerar`, que **não** reescreve os outros ativos) e `res/values/notificacao.xml`
  (`#D61F26`); o manifesto aponta para eles em `com.google.firebase.messaging.default_notification_icon/color`.
- **Canal** `exelula_default` (criado pelo app em `pushNotificationService.ts`; o servidor manda o mesmo id) e canal padrão no
  manifesto, para o aviso nunca cair no canal genérico do FCM.
- O toque num aviso abre o destino certo (`PushBridge`): post, comentário (`#comment-id`), perfil ou conversa.
- **APK antigo (até a 1.2.1):** a tela de notificações funciona; ligar o push mostra um erro claro (o plugin não existe) e a
  vibração cai na Vibration API do WebView. Nada quebra.

Depois do `cap sync` o Android enxerga os 5 plugins (`npx cap sync android`; **não** use `npm run android:sync`: o `mkdir -p`
do cmd cria uma pasta chamada `-p` na raiz). Texto e destino dos avisos: `docs/notificacoes-e-vibracao.md`.

## Login com Google no app

O popup do Firebase (`signInWithPopup`) **não funciona dentro do WebView**: o Google bloqueia OAuth em WebView e o `window.open`
é cancelado (`auth/cancelled-popup-request`). No app o login usa o seletor de contas **nativo**:

- `src/lib/services/googleSignIn.ts`: no app (`isNativeApp()`, de `src/lib/nativeApp.ts`) chama
  `@capacitor-firebase/authentication` (config `skipNativeAuth: true` em `capacitor.config.ts`), pega o `idToken` e entra com
  `signInWithCredential`. No navegador continua o popup.
- `android/variables.gradle` precisa de `rgcfaIncludeGoogle = true` (senão o Google Sign-In nativo fica fora do APK).
- O app Android está registrado no Firebase: `1:710006061811:android:7da908bfd14f59fe379586` (`com.soberan.app`), com o SHA-1
  `26fc864aaa1d00a8afc1dd1e6a91b5a525567070` e o SHA-256 acima. Isso cria o cliente OAuth do Android.
- `android/app/google-services.json` **não vai para o Git**. Para refazer: console do Firebase > Configurações do projeto >
  app Android, ou REST `GET firebase.googleapis.com/v1beta1/projects/echo-b5aw9/androidApps/<appId>/config` (base64).
- Erro `DEVELOPER_ERROR` (código 10) = o APK foi assinado com uma chave cujo SHA-1 não está cadastrado. APK de depuração
  (chave debug) também cai aqui; só o APK assinado com a keystore do projeto faz o login.

## Marca (logo, ícones, splash, imagem de compartilhamento)

`npm run marca:gerar` refaz tudo a partir de **um** desenho (`scripts/gerar-marca.mjs`): `public/brand/*.svg`, favicon,
`apple-touch-icon`, ícones do PWA (`/icons`), `exe-lula-og.png` e os recursos do Android. Precisa do Chrome e do
`playwright-core` (`E2E_NODE_MODULES`, `E2E_BROWSER`). Depois: `npx cap sync android` e um APK novo.

- **Ícone adaptativo (Android 8+)**: três camadas de 108dp em `mipmap-*` (`ic_launcher_background` com o brilho vermelho,
  `ic_launcher_foreground` com a lula e `ic_launcher_monochrome` para os ícones temáticos do Android 13+). Cada launcher recorta
  num formato (círculo, squircle da Samsung, gota...) e só os 66dp do centro aparecem em todos: a lula fica num raio de ~26dp.
- O gerador **mede** a lula em cada ícone e se recusa a gravar o que passar da zona segura (adaptativo, maskable do PWA, ícones
  antigos e o da abertura). Até a 1.1.0 o app saiu com o ícone **padrão do Capacitor** (o "X" azul); a 1.2.0 tinha a lula
  encostando na borda do círculo.
- **Abertura**: `windowSplashScreenBackground` + `windowSplashScreenAnimatedIcon` (`drawable-*/splash_icone.png`, 288dp, dentro
  do círculo de 192dp que o Android 12+ mostra). Não há mais imagem de tela inteira (ela era esticada e deformava).

## Barras do sistema, abertura e teclado (`MainActivity.java`)

Com `targetSdk 35`, o Android 15 desenha o app por baixo da barra de status e da barra de gestos, e o Capacitor 6 não compensa:
o relógio cobria o cabeçalho do site e a barra de gestos a navegação de baixo. A `MainActivity`:

- dá ao conteúdo o espaço das barras, do recorte da câmera e do teclado como margem (`windowSoftInputMode="adjustResize"` no
  manifesto), com as barras na cor da marca e ícones claros, igual em todas as versões do Android;
- chama `installSplashScreen()` (sem isso, no Android 11 e anteriores a abertura era só a cor de fundo) e mantém a abertura até o
  site carregar, no máximo 4 s;
- o WebView usa `backgroundColor` do `capacitor.config.ts` (a cor da marca) enquanto carrega.

Ao atualizar o Capacitor para a 7 ou superior, confira se ele passou a tratar as barras (opção `adjustMarginsForEdgeToEdge`)
para não reservar o espaço duas vezes.

## Testar no emulador (sem celular)

AVD `Medium_Phone_API_35` (Android 15, Google Play). Feche os emuladores do Firebase e o `next start` antes: o emulador precisa de
~2 GB de memória "commit" livre. Para o teste local assine com a chave de depuração (`~/.android/debug.keystore`, senha
`android`), `adb install -r`, `adb shell am start -n com.soberan.app/.MainActivity`, `adb shell screencap -p` + `adb pull`
(não redirecione binário pelo PowerShell). O login com Google **não** completa no emulador com chave de depuração.

## Dois apps do mesmo projeto: HiperVerso e HV Mensagens

Desde 2026-11-17 o `android/` produz **dois aplicativos**, por *product flavors* do Gradle:

| Sabor | `applicationId` | Nome no aparelho | Abre em |
|---|---|---|---|
| `principal` | `com.soberan.app` | HiperVerso | a rede inteira |
| `mensagens` | `com.soberan.app.mensagens` | HV Mensagens | `/pt-BR/messages` |

São dois ícones e duas entradas no launcher, instaláveis lado a lado, **com o mesmo backend, as mesmas contas, as mesmas
conversas em tempo real e todos os métodos de login e registro da plataforma** — a casca é outra, o site é o mesmo.

**O `applicationId` do principal não muda.** Trocá-lo criaria outro app na Play Store e quem já tem o nosso instalado nunca
receberia a atualização. Por isso `principal` herda `com.soberan.app` do `defaultConfig` e só o `mensagens` declara o seu.

O que pertence a cada sabor vive em `android/app/src/<sabor>/`: `res/values/strings.xml` (nome e `custom_url_scheme`),
`res/mipmap-*` (ícone) e, no caso do `mensagens`, `assets/capacitor.config.json` (é ele que faz o app abrir direto nas
conversas). O `npx cap copy` só escreve em `src/main/assets/`, então a configuração do sabor sobrevive a cada sincronização.

### Pré-requisito: registrar o segundo app no Firebase

O `mensagens` **não compila** enquanto o pacote novo não existir no projeto Firebase. O erro é exatamente este:

```
Execution failed for task ':app:processMensagensReleaseGoogleServices'.
> No matching client found for package name 'com.soberan.app.mensagens' in android/app/google-services.json
```

No Console do Firebase, projeto `echo-b5aw9` → **Configurações do projeto → Seus apps → Adicionar app → Android**:

1. Nome do pacote: `com.soberan.app.mensagens`
2. Apelido: `HV Mensagens`
3. **SHA-1 de release:** `26fc864aaa1d00a8afc1dd1e6a91b5a525567070`
   **SHA-256 de release:** `87:D2:6A:FD:FC:A9:67:38:2D:74:C1:3D:C1:DE:13:B3:42:A4:27:43:55:76:56:75:93:EF:B6:FD:68:11:9C:7A`
   (são os mesmos do app principal — veja "Uma keystore, um alias" abaixo)
4. Baixe o `google-services.json` novo e substitua `android/app/google-services.json`. O arquivo passa a ter **os dois**
   pacotes; o app principal continua funcionando igual.

Sem o SHA cadastrado, o login com Google falha com `DEVELOPER_ERROR` (código 10), o App Check recusa e o push não chega.

### Uma keystore, um alias — para os dois apps

**Melhor prática aqui: a MESMA keystore e o MESMO alias (`soberan_key`) para os dois apps.** Não crie alias separado.

- A impressão digital passa a ser **idêntica** nos dois: um par SHA-1/SHA-256 para cadastrar, um `assetlinks.json` coerente,
  um certificado para conferir.
- É **uma** chave para guardar e proteger. Perder a chave de um app publicado significa nunca mais poder atualizá-lo:
  duplicar chaves duplica esse risco sem dar nada em troca.
- Alias separado só faria sentido se os apps precisassem de identidades de assinatura distintas (por exemplo, para serem
  mantidos por equipes diferentes). Não é o caso: é o mesmo produto, o mesmo time, o mesmo backend.

A keystore é `E:\Soberan\keystores\soberan-keystore.jks` e a senha fica guardada pelo DPAPI do Windows — veja
"Gerar e publicar uma versão nova" no começo deste documento. Nada de senha no Gradle, em `keystore.properties` ou no Git:
o `apksigner` recebe a senha por variável de ambiente, que só existe durante a assinatura.

Conferir a keystore e extrair as impressões digitais (pede a senha, não grava nada):

```powershell
$jdk = 'E:\Arquivos de Programas\Android\Android Studio\jbr'
& "$jdk\bin\keytool" -list -v -keystore E:\Soberan\keystores\soberan-keystore.jks -alias soberan_key
```

A saída traz `SHA1:` e `SHA256:` — são esses valores que vão para o Firebase e para o `assetlinks.json`.

### Gerar os APKs assinados

O mesmo comando de sempre, agora com `-App`:

```powershell
# App principal (HiperVerso) — gera, assina, confere e publica em /download
npm run apk:lancar -- -PublicarSite "o que mudou nesta versao"

# App de mensagens (HV Mensagens) — gera, assina e confere; NÃO publica em /download
npm run apk:lancar -- -App mensagens -SemPublicar
```

O APK de cada um sai em `android\app\build\outputs\apk\<sabor>\release\app-<sabor>-release.apk`.

O `mensagens` não entra na página `/download` de propósito: essa página oferece o app principal. O HV Mensagens é
distribuído pelo link do Beta. (O `publicar-apk.mjs` continua aceitando **só** `com.soberan.app`, e isso é uma proteção:
impede publicar o app errado na página de download por engano.)

### Conferir antes de soltar o link do Beta

```powershell
$bt = "$env:LOCALAPPDATA\Android\Sdk\build-tools\35.0.0"   # ajuste se a sua versao for outra
$apk = 'android\app\build\outputs\apk\mensagens\release\app-mensagens-release.apk'

& "$bt\apksigner.bat" verify --print-certs $apk   # assinatura valida + SHA-1/SHA-256 do certificado
& "$bt\aapt2.exe" dump badging $apk | Select-String 'package:|application-label:'
```

Confira três coisas: `package: name='com.soberan.app.mensagens'`, `application-label:'HV Mensagens'` e o SHA-256 do
certificado igual ao do app principal. Depois instale nos dois aparelhos de teste, lado a lado com o principal:

```powershell
adb install -r android\app\build\outputs\apk\mensagens\release\app-mensagens-release.apk
adb shell am start -n com.soberan.app.mensagens/com.soberan.app.MainActivity
```

Teste, antes de liberar: entrar por cada método de login, abrir uma conversa, enviar e **receber** mensagem em tempo real
com o site aberto na outra ponta, e sair e voltar (a sessão tem de continuar).

### App Links (`assetlinks.json`)

`public/.well-known/assetlinks.json` precisa de uma entrada para **cada** pacote. Como a chave é a mesma, o
`sha256_cert_fingerprints` se repete:

```json
[
  { "relation": ["delegate_permission/common.handle_all_urls", "delegate_permission/common.get_login_creds"],
    "target": { "namespace": "android_app", "package_name": "com.soberan.app",
                "sha256_cert_fingerprints": ["87:D2:...:9C:7A"] } },
  { "relation": ["delegate_permission/common.handle_all_urls", "delegate_permission/common.get_login_creds"],
    "target": { "namespace": "android_app", "package_name": "com.soberan.app.mensagens",
                "sha256_cert_fingerprints": ["87:D2:...:9C:7A"] } }
]
```

Depois de publicar o site, confira em
`https://digitalassetlinks.googleapis.com/v1/statements:list?source.web.site=https://exercitodolula.app&relation=delegate_permission/common.handle_all_urls`.

### AAB para a loja (ainda não automatizado)

O `apk:lancar` gera **APK**, que é o formato do Beta por download direto. A Play Store exige **AAB**, e o `apksigner`
não assina AAB (ele é um `.zip` de módulos, não um APK). O caminho é o `jarsigner`:

```powershell
$jdk = 'E:\Arquivos de Programas\Android\Android Studio\jbr'
cd android
.\gradlew bundlePrincipalRelease      # ou bundleMensagensRelease
cd ..

$aab = 'android\app\build\outputs\bundle\principalRelease\app-principal-release.aab'
& "$jdk\bin\jarsigner" -keystore E:\Soberan\keystores\soberan-keystore.jks `
    -sigalg SHA256withRSA -digestalg SHA-256 $aab soberan_key
& "$jdk\bin\jarsigner" -verify -verbose:summary $aab
```

O `jarsigner` **pergunta a senha** e ela aparece na tela: por isso este passo é manual e fica fora do script automatizado.
Se o AAB virar rotina, o certo é estender o `apk-lancar.ps1` para ler a senha do DPAPI e passá-la ao `jarsigner` por
`-storepass:env`, como já é feito com o `apksigner`.

Na Play Store, com **Play App Signing** ligado (o padrão), a chave acima é só a de *upload*: o Google reassina com a chave
dele, e o SHA-1 que vale para o Google Sign-In em produção é o que aparece em **Configuração → Integridade do app**. Esse
SHA-1 também precisa estar cadastrado no Firebase, nos dois apps.
