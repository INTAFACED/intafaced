#!/usr/bin/env node
/**
 * Stage the React customer site for the existing sideload/WebView wrapper.
 * Verify the explicit deployed HTTPS origin before replacing any assets.
 *
 *   pnpm --filter mobile build
 *   node ./scripts/build-wrap.mjs --check
 */
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, renameSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import nativeOrigin from './native-origin.cjs';

const BUNDLE_ID = 'app.intafaced.mobile';
const HERE = dirname(fileURLToPath(import.meta.url));
const MOBILE = join(HERE, '..');
const ROOT = join(MOBILE, '..', '..');
const outputArgument = process.argv.indexOf('--output');
if (outputArgument !== -1 && !process.argv[outputArgument + 1]) throw new Error('--output requires a directory');
const WWW = outputArgument === -1 ? join(MOBILE, 'www') : resolve(process.argv[outputArgument + 1]);
const CONFIG = join(MOBILE, 'capacitor.config.json');
const CHECK_ONLY = process.argv.includes('--check');

function fail(msg) {
  console.error('mobile wrap:', msg);
  process.exit(1);
}

if (outputArgument !== -1 && existsSync(WWW) && !existsSync(join(WWW, 'native-stage.json'))) {
  fail('--output must be a new directory or previously generated native staging output');
}

function isCustomerDeployment(value) {
  return (
    value?.schemaVersion === 1 &&
    value.product === 'intafaced-customer' &&
    value.frontend === 'react' &&
    value.transport === 'same-origin' &&
    value.apiPath === '/api' &&
    value.websocketPath === '/ws'
  );
}

async function deployed(origin, path) {
  const response = await fetch(origin + path, {
    redirect: 'error',
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error(`${path} returned ${response.status}`);
  return response;
}

async function verifyDeployment(origin) {
  const descriptor = await (await deployed(origin, '/customer-deployment.json')).json();
  if (!isCustomerDeployment(descriptor)) throw new Error('origin is not the React customer deployment');
  const index = await (await deployed(origin, '/')).text();
  if (!/<div\s+id="root"/.test(index) || !/src="\/assets\/[^"\s]+\.js"/.test(index)) {
    throw new Error('origin does not serve the built React customer entry');
  }
  const deepLink = await (await deployed(origin, '/bank/transfers')).text();
  if (deepLink !== index) throw new Error('customer deep-link SPA fallback is missing');
}

if (!existsSync(CONFIG)) fail('capacitor.config.json missing');
const config = JSON.parse(readFileSync(CONFIG, 'utf8'));
if (config.appId !== BUNDLE_ID) fail(`appId is ${config.appId}, expected ${BUNDLE_ID}`);
if (config.appName !== 'INTAFACED') fail('appName must be INTAFACED — own name, zero attribution');
if (!existsSync(join(MOBILE, 'ios'))) fail('ios config directory missing');
if (!existsSync(join(MOBILE, 'android'))) fail('android config directory missing');

const info = readFileSync(join(MOBILE, 'ios/App/App/Info.plist'), 'utf8');
if (!info.includes(BUNDLE_ID)) fail('ios Info.plist missing bundle id');
const gradle = readFileSync(join(MOBILE, 'android/app/build.gradle'), 'utf8');
if (!gradle.includes(`applicationId "${BUNDLE_ID}"`)) fail('android applicationId missing');
const manifest = readFileSync(join(MOBILE, 'android/app/src/main/AndroidManifest.xml'), 'utf8');
if (!manifest.includes('android:usesCleartextTraffic="false"')) fail('android cleartext traffic must be disabled');

if (CHECK_ONLY) {
  console.log(`mobile wrap check: ${BUNDLE_ID} iOS/Android identifiers and configuration valid; native compilation not checked`);
  process.exit(0);
}

let origin;
if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') fail('TLS certificate verification must remain enabled for native staging');
try {
  origin = nativeOrigin.customerOrigin(process.env.MOBILE_CUSTOMER_ORIGIN);
} catch (error) {
  fail(error.message);
}

try {
  await verifyDeployment(origin);
} catch (error) {
  fail(`cannot verify HTTPS customer deployment: ${error.message}`);
}
if (process.argv.includes('--verify')) {
  console.log('mobile wrap: HTTPS React customer deployment and deep-link fallback verified');
  process.exit(0);
}

const dist = join(ROOT, 'apps/customer/dist');
if (!existsSync(join(dist, 'index.html'))) fail('build apps/customer before native staging');
let descriptor;
try {
  descriptor = JSON.parse(readFileSync(join(dist, 'customer-deployment.json'), 'utf8'));
} catch {
  fail('customer dist is missing its deployment descriptor; rebuild apps/customer');
}
if (!isCustomerDeployment(descriptor)) fail('only the React customer dist may be staged');
const index = readFileSync(join(dist, 'index.html'));
if (!/src="\/assets\/[^"\s]+\.js"/.test(index.toString())) fail('customer dist is not a production browser build');

// Stage beside the target so failed verification/copy retains the last state.
const staging = WWW + '.stage-' + process.pid;
try {
  mkdirSync(dirname(WWW), { recursive: true });
  cpSync(dist, staging, { recursive: true });
  cpSync(join(MOBILE, 'native-unavailable.html'), join(staging, 'native-unavailable.html'));
  writeFileSync(
    join(staging, 'native-stage.json'),
    JSON.stringify(
      {
        schemaVersion: 1,
        customerOrigin: origin,
        indexSha256: createHash('sha256').update(index).digest('hex'),
        verifiedAt: new Date().toISOString(),
      },
      null,
      2,
    ) + '\n',
  );
  const previous = WWW + '.previous-' + process.pid;
  if (existsSync(WWW)) renameSync(WWW, previous);
  try {
    renameSync(staging, WWW);
  } catch (error) {
    if (existsSync(previous)) renameSync(previous, WWW);
    throw error;
  }
  rmSync(previous, { recursive: true, force: true });
} catch (error) {
  rmSync(staging, { recursive: true, force: true });
  fail(`native assets were not staged: ${error.message}`);
}
console.log(`mobile wrap: React assets staged for ${BUNDLE_ID}; HTTPS same-origin sideload/WebView, not store-listed`);
