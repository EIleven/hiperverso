// scripts/publicar-apk.mjs
// Publica um APK assinado no site: copia para public/downloads/, calcula o SHA-256 e escreve latest.json (lido pela
// pagina /download). Depois e so fazer o deploy do site (firebase deploy --only apphosting:studio).
//
// Uso:  node scripts/publicar-apk.mjs <caminho-do-apk> ["nota 1" "nota 2" ...]
//
// Recusa o arquivo se: o pacote nao for app.hiperverso, a assinatura nao verificar, o certificado nao for o da keystore
// do projeto (o mesmo do APK 1.0.0: sem isso o Android nao atualiza o app por cima) ou o versionCode nao subir.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const PACKAGE = 'app.hiperverso';
// SHA-256 do certificado de assinatura do projeto (publico; identifica a chave, nao a revela).
const CERT_SHA256 = '87d26afdfca967382d74c13dc1de13b342a427435576567593efb6fd68119c7a';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [apkArg, ...notes] = process.argv.slice(2);
if (!apkArg) {
  console.error('Uso: node scripts/publicar-apk.mjs <caminho-do-apk> ["nota 1" "nota 2" ...]');
  process.exit(2);
}
const apk = path.resolve(apkArg);
if (!fs.existsSync(apk)) fail(`Arquivo nao encontrado: ${apk}`);

function fail(msg) {
  console.error(`ERRO: ${msg}`);
  process.exit(1);
}

// Ferramentas do Android SDK (build-tools mais recente), pelo sdk.dir do android/local.properties.
function sdkTool(name) {
  const props = fs.readFileSync(path.join(root, 'android', 'local.properties'), 'utf8');
  const sdk = props.match(/^sdk\.dir=(.*)$/m)?.[1].replace(/\\\\/g, '\\').replace(/\\:/g, ':').trim();
  if (!sdk) fail('sdk.dir nao encontrado em android/local.properties');
  const versions = fs.readdirSync(path.join(sdk, 'build-tools')).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const dir = path.join(sdk, 'build-tools', versions[versions.length - 1]);
  return path.join(dir, process.platform === 'win32' ? `${name}${name === 'apksigner' ? '.bat' : '.exe'}` : name);
}
function run(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', shell: process.platform === 'win32' });
  return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

const badging = run(sdkTool('aapt2'), ['dump', 'badging', apk]).out;
const pkg = badging.match(/package: name='([^']+)' versionCode='(\d+)' versionName='([^']+)'/);
if (!pkg) fail('Nao foi possivel ler o pacote do APK (aapt2).');
const [, name, versionCodeStr, versionName] = pkg;
const versionCode = Number(versionCodeStr);
if (name !== PACKAGE) fail(`Pacote ${name} (esperado ${PACKAGE}).`);

const sig = run(sdkTool('apksigner'), ['verify', '--print-certs', apk]);
if (sig.code !== 0) fail(`Assinatura invalida:\n${sig.out}`);
const cert = sig.out.match(/Signer #1 certificate SHA-256 digest: ([0-9a-f]+)/i)?.[1]?.toLowerCase();
if (cert !== CERT_SHA256) {
  fail(`Certificado ${cert ?? '(nao lido)'} difere do esperado ${CERT_SHA256}. APK de outra chave nao atualiza o app instalado.`);
}

const dir = path.join(root, 'public', 'downloads');
fs.mkdirSync(dir, { recursive: true });
const jsonPath = path.join(dir, 'latest.json');
if (fs.existsSync(jsonPath)) {
  const prev = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  if (versionCode <= prev.versionCode) fail(`versionCode ${versionCode} precisa ser maior que o publicado (${prev.versionCode}).`);
}

const fileName = `HiperVerso-${versionName}.apk`;
for (const f of fs.readdirSync(dir)) if (f.endsWith('.apk')) fs.rmSync(path.join(dir, f)); // so a versao atual fica no site
const destApkPath = path.join(dir, fileName);
fs.copyFileSync(apk, destApkPath);
const apkBuffer = fs.readFileSync(destApkPath);
const sha256 = crypto.createHash('sha256').update(apkBuffer).digest('hex');

const release = {
  packageName: PACKAGE,
  versionName,
  versionCode,
  minSupportedVersionCode: versionCode,
  apkUrl: `/downloads/${fileName}`,
  fileSizeBytes: apkBuffer.length,
  sha256,
  signingCertSha256: CERT_SHA256,
  releasedAt: new Date().toISOString(),
  reproducibleBuild: {
    command: 'npm run apk:lancar',
    gradleVersion: '8.11.1',
    verifyCmd: `apksigner verify --print-certs ${fileName}`,
  },
  releaseNotes: notes.length ? notes : [`Versao ${versionName}.`],
};
fs.writeFileSync(jsonPath, `${JSON.stringify(release, null, 2)}\n`);

console.log(`APK ${fileName} (versionCode ${versionCode}) publicado em public/downloads/`);
console.log(`SHA-256: ${sha256}`);
console.log('Proximo passo: commit e deploy do site (firebase deploy --only apphosting:studio --project echo-b5aw9).');
