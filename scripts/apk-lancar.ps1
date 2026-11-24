# scripts/apk-lancar.ps1
# Gera, assina e publica uma versao nova do app Android, sem abrir o Android Studio:
#   1. copia a config do Capacitor e compila o APK de release sem assinatura (Gradle 8.11.1);
#   2. alinha (zipalign) e assina (apksigner) com a keystore do projeto e a senha guardada por apk-configurar-assinatura
#      (a senha so existe na memoria durante a assinatura, passada por variavel de ambiente: nunca na tela nem em log);
#   3. confere a assinatura e publica em public/downloads + latest.json (publicar-apk.mjs recusa chave errada, outro
#      pacote ou versionCode que nao subiu);
#   4. com -PublicarSite, publica o site (o /download passa a oferecer a versao nova).
# A versao (versionCode e versionName) vem de android/app/build.gradle: suba antes, no codigo.
#
# Uso:  npm run apk:lancar -- -PublicarSite "nota 1" "nota 2"
#       npm run apk:lancar -- -SemPublicar      (so gera e assina, para instalar e testar antes de publicar)
#       npm run apk:lancar -- -App hiperchat -SemPublicar   (gera e assina o HiperChat, para o Beta)
#       npm run apk:lancar -- -ApkPronto android\app\release\app-release.apk -PublicarSite "nota"
#                                               (APK ja assinado no Android Studio: pula os passos 1 e 2)
param(
  # Qual dos dois apps lançar. `principal` = HiperVerso (app.hiperverso); `hiperchat` = HiperChat
  # (app.hiperverso.chat), a casca que abre direto nas conversas. O padrao continua sendo o principal.
  [ValidateSet('principal', 'hiperchat')][string]$App = 'principal',
  [switch]$PublicarSite,
  [switch]$SemPublicar,
  [string]$ApkPronto,
  [string]$Keystore = 'E:\Soberan\keystores\soberan-keystore.jks',
  [string]$Segredo = 'E:\Soberan\keystores\assinatura.dpapi.xml',
  [Parameter(ValueFromRemainingArguments = $true)][string[]]$Notas = @()
)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
. (Join-Path $PSScriptRoot 'apk-ferramentas.ps1')

function Passo([string]$Texto) { Write-Host "`n== $Texto" -ForegroundColor Cyan }
function Executar([string]$Exe, [string[]]$Argumentos, [string]$Erro) {
  & $Exe @Argumentos
  if ($LASTEXITCODE -ne 0) { throw "$Erro (codigo $LASTEXITCODE)" }
}

Push-Location $root
try {
  if ($ApkPronto) {
    if (-not (Test-Path $ApkPronto)) { throw "APK nao encontrado: $ApkPronto" }
    $assinado = (Resolve-Path $ApkPronto).Path
    Write-Host "APK ja assinado: $assinado"
  } else {
    if (-not (Test-Path $Keystore)) { throw "Keystore nao encontrada: $Keystore" }
    if (-not (Test-Path $Segredo)) {
      throw 'Assinatura ainda nao configurada. Rode uma vez, no seu terminal: scripts\apk-configurar-assinatura.cmd'
    }
    $env:JAVA_HOME = Find-Jdk
    $buildTools = Find-BuildTools $root
    $gradle = Find-Gradle
    # Com dois sabores, cada um tem a sua pasta e a sua tarefa: outputs/apk/<sabor>/release e assemble<Sabor>Release.
    $sabor = $App
    $Sabor = $sabor.Substring(0,1).ToUpper() + $sabor.Substring(1)
    $saida = Join-Path $root "android\app\build\outputs\apk\$sabor\release"
    $semAssinatura = Join-Path $saida "app-$sabor-release-unsigned.apk"
    $alinhado = Join-Path $saida "app-$sabor-release-alinhado.apk"
    $assinado = Join-Path $saida "app-$sabor-release.apk"

    Passo 'Configuracao do Capacitor'
    Executar 'npx' @('cap', 'copy', 'android') 'npx cap copy android falhou'

    Passo "Compilando o APK de release do app $sabor (Gradle 8.11.1)"
    Remove-Item $semAssinatura, $alinhado, $assinado -ErrorAction SilentlyContinue
    Executar $gradle @('-p', 'android', "assemble${Sabor}Release", '--console=plain', '-q') 'A compilacao falhou'
    if (-not (Test-Path $semAssinatura)) { throw "APK nao gerado: $semAssinatura" }

    Passo 'Alinhando e assinando'
    Executar (Join-Path $buildTools 'zipalign.exe') @('-f', '-P', '16', '4', $semAssinatura, $alinhado) 'zipalign falhou'
    $dados = Import-Clixml -Path $Segredo
    try {
      $env:EXELULA_KS_PASS = ConvertFrom-Segredo $dados.SenhaKeystore
      $env:EXELULA_KEY_PASS = ConvertFrom-Segredo $dados.SenhaChave
      Executar (Join-Path $buildTools 'apksigner.bat') @(
        'sign', '--ks', $Keystore, '--ks-key-alias', $dados.Alias,
        '--ks-pass', 'env:EXELULA_KS_PASS', '--key-pass', 'env:EXELULA_KEY_PASS', '--out', $assinado, $alinhado
      ) 'A assinatura falhou (a senha mudou? rode apk-configurar-assinatura de novo)'
    } finally {
      Remove-Item Env:EXELULA_KS_PASS, Env:EXELULA_KEY_PASS -ErrorAction SilentlyContinue
    }
    Remove-Item $alinhado -ErrorAction SilentlyContinue
    # Os avisos "META-INF/... not protected by signature" sao normais (o esquema v2/v3 cobre o arquivo inteiro, e o APK do
    # Android Studio tem os mesmos): a saida so aparece se a verificacao falhar.
    $verificacao = Invoke-Nativo (Join-Path $buildTools 'apksigner.bat') @('verify', $assinado)
    if ($verificacao.Codigo -ne 0) { $verificacao.Saida | Write-Host; throw 'A assinatura do APK nao confere' }
    Write-Host "APK assinado: $assinado"
    if ($SemPublicar) { return }
    if ($sabor -ne 'principal') {
      # A pagina /download publica o app principal. O HV Mensagens e distribuido no Beta pelo link proprio.
      Write-Host "App $sabor (HiperChat) assinado. A pagina /download publica o principal: distribua este APK pelo canal do Beta."
      return
    }
  }

  Passo 'Publicando na pagina /download'
  Executar 'node' (@('scripts/publicar-apk.mjs', $assinado) + $Notas) 'A publicacao recusou o APK'

  if ($PublicarSite) {
    Passo 'Publicando o site'
    Executar 'npx' @('--yes', 'firebase-tools@15.34.0', 'deploy', '--only', 'apphosting:studio', '--project', 'echo-b5aw9', '--non-interactive') 'O deploy do site falhou'
    Write-Host "`nPronto: o /download ja oferece a versao nova. Faca o commit de public/downloads." -ForegroundColor Green
  } else {
    Write-Host "`nPublicado em public/downloads. Falta o deploy do site (-PublicarSite) e o commit de public/downloads." -ForegroundColor Yellow
  }
} finally {
  Pop-Location
}
