#!/usr/bin/env node
// Host dispatch check: do the apex, app and join hosts serve what each one claims?
// Run it against the live hosts the owner names. A host that does not answer is a typed refusal, never a pass.
//
//   INTAFACED_APEX_HOST=https://intafaced.com INTAFACED_APP_HOST=https://app.intafaced.com \
//   INTAFACED_JOIN_HOST=https://join.intafaced.com node apps/customer/deployment/host-dispatch.mjs [--out file]
//
// Only GET requests go out, to hosts the owner named. No secret is read and the receipt holds no user data.
//
// LOCAL TEST (`--local-test --out <file>`, the local test stack only): the hosts are the stack's own loopback sites,
// http://127.0.0.1:<port>, and the receipt says `test: true`. It refuses unless APP_ENV is exactly dev or test, never
// writes the deployment receipt the build publishes, and with a blank or malformed host writes nothing at all.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const RECEIPT_SCHEMA_VERSION = 1;
export const DEFAULT_RECEIPT = fileURLToPath(new URL('./host-dispatch.json', import.meta.url));
const SETTINGS = { apex: 'INTAFACED_APEX_HOST', app: 'INTAFACED_APP_HOST', join: 'INTAFACED_JOIN_HOST' };
const ROLES = ['apex', 'app', 'join'];
const PROXY_PROBE = 'host-dispatch.probe';
const TIMEOUT_MS = 10_000;

export const hostCode = (suffix) => `host.${suffix}`;
export const LOCAL_TEST_APP_ENVS = ['dev', 'test'];

/** Same rules as apps/mobile/scripts/native-origin.cjs: an HTTPS origin with no credentials, path, query or fragment. */
export function hostOrigin(role, value) {
  if (!value?.trim()) return { code: hostCode(`${role}_unset`) };
  let url;
  try {
    url = new URL(value.trim());
  } catch {
    return { code: hostCode(`${role}_invalid`) };
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    return { code: hostCode(`${role}_invalid`) };
  }
  return { origin: url.origin };
}

/** LOCAL TEST only: a loopback http origin with a port (the stack's own sites), nothing else. */
export function localTestOrigin(role, value) {
  if (!value?.trim()) return { code: hostCode(`${role}_unset`) };
  let url;
  try {
    url = new URL(value.trim());
  } catch {
    return { code: hostCode(`${role}_invalid`) };
  }
  if (
    url.protocol !== 'http:' ||
    url.hostname !== '127.0.0.1' ||
    !url.port ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  ) {
    return { code: hostCode(`${role}_invalid`) };
  }
  return { origin: url.origin };
}

const buildIdOf = (body) => createHash('sha256').update(body).digest('hex').slice(0, 16);

async function get(fetchImpl, origin, path, timeoutMs, { anyStatus = false } = {}) {
  try {
    const response = await fetchImpl(origin + path, {
      method: 'GET',
      redirect: 'manual',
      headers: { accept: '*/*' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!anyStatus && (response.status < 200 || response.status > 299)) return { failed: `answered ${response.status}` };
    return { status: response.status, body: await response.text() };
  } catch (error) {
    return { failed: error?.cause?.code || error?.name || 'no answer' };
  }
}

const notServed = (role, origin, why) => ({ role, host: origin, result: hostCode('not_served'), detail: why });

/** What the apex build publishes at APEX_DESCRIPTOR_PATH, as the customer build publishes /customer-deployment.json. */
export const APEX_DESCRIPTOR_PATH = '/apex-deployment.json';
export const APEX_PRODUCT = 'intafaced-apex';

/**
 * The apex serves its own build: its index mounts neither the customer app (#root) nor the invitation site (#app), and
 * its descriptor names the apex product. A descriptor marked `test` is the local stack's stand-in, accepted only in
 * LOCAL TEST mode.
 */
async function checkApex(fetchImpl, origin, timeoutMs, localTest) {
  const wrong = (detail) => ({ role: 'apex', host: origin, result: hostCode('apex_wrong_build'), detail });
  const index = await get(fetchImpl, origin, '/', timeoutMs);
  if (index.failed) return notServed('apex', origin, index.failed);
  if (/id=["'](root|app)["']/.test(index.body)) return wrong('the apex host is serving the customer or invitation index');
  const got = await get(fetchImpl, origin, APEX_DESCRIPTOR_PATH, timeoutMs, { anyStatus: true });
  if (got.failed) return notServed('apex', origin, got.failed);
  let descriptor;
  try {
    descriptor = got.status >= 200 && got.status <= 299 ? JSON.parse(got.body) : null;
  } catch {
    descriptor = null;
  }
  if (descriptor?.product !== APEX_PRODUCT) return wrong('the apex host publishes no apex descriptor');
  if (descriptor.test === true && !localTest) return wrong('the apex descriptor is the local test stand-in');
  return { role: 'apex', host: origin, result: 'served', buildId: buildIdOf(got.body) };
}

async function checkApp(fetchImpl, origin, timeoutMs) {
  const got = await get(fetchImpl, origin, '/customer-deployment.json', timeoutMs);
  if (got.failed) return notServed('app', origin, got.failed);
  let descriptor;
  try {
    descriptor = JSON.parse(got.body);
  } catch {
    return { role: 'app', host: origin, result: hostCode('app_wrong_build'), detail: 'descriptor is not JSON' };
  }
  if (descriptor?.product !== 'intafaced-customer' || descriptor?.frontend !== 'react') {
    return { role: 'app', host: origin, result: hostCode('app_wrong_build'), detail: 'descriptor is not the customer build' };
  }
  return { role: 'app', host: origin, result: 'served', buildId: buildIdOf(got.body) };
}

/** The invitation index mounts #app, the customer index mounts #root. */
async function checkJoin(fetchImpl, origin, timeoutMs) {
  const got = await get(fetchImpl, origin, '/join', timeoutMs);
  if (got.failed) return notServed('join', origin, got.failed);
  if (/id=["']root["']/.test(got.body) || !/id=["']app["']/.test(got.body)) {
    return {
      role: 'join',
      host: origin,
      result: hostCode('join_wrong_build'),
      detail: 'the join host is not serving the invitation index',
    };
  }
  // An unknown procedure still answers with a tRPC error that names the path the edge received.
  // A changed prefix shows up there. The answer's status is not the proof, so any status is read.
  const probe = await get(fetchImpl, origin, `/api/ops/trpc/${PROXY_PROBE}`, timeoutMs, { anyStatus: true });
  if (probe.failed) return notServed('join', origin, probe.failed);
  const procedurePath = procedurePathOf(probe.body);
  if (procedurePath === undefined) {
    return {
      role: 'join',
      host: origin,
      result: hostCode('proxy_unproven'),
      detail: 'the api path did not answer with an edge procedure error',
    };
  }
  if (procedurePath !== PROXY_PROBE) {
    return { role: 'join', host: origin, result: hostCode('proxy_prefix_changed'), detail: `edge saw path "${procedurePath}"` };
  }
  return { role: 'join', host: origin, result: 'served', buildId: buildIdOf(got.body) };
}

/** The procedure path a tRPC error body reports, or undefined when the body is not one. */
function procedurePathOf(body) {
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  const first = Array.isArray(parsed) ? parsed[0] : parsed;
  const path = first?.error?.data?.path ?? first?.error?.json?.data?.path;
  return typeof path === 'string' ? path : undefined;
}

function readPrevious(file) {
  try {
    const previous = JSON.parse(readFileSync(file, 'utf8'));
    return previous?.schemaVersion === RECEIPT_SCHEMA_VERSION ? previous : null;
  } catch {
    return null;
  }
}

/** Written to a temp name and renamed, so a reader never sees half a receipt. */
function writeReceipt(file, receipt) {
  mkdirSync(dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(receipt, null, 2)}\n`);
  renameSync(temp, file);
}

/**
 * Returns { ok, hosts, receipt, written }. `fetchImpl` is injectable so tests can point each HTTPS host at a stub server.
 * Nothing is fetched when any host setting is blank or malformed. `localTest` checks the local stack's loopback sites
 * (see the header): outside a dev or test APP_ENV it refuses with `host.local_test_refused`, and it writes a receipt
 * only when every host setting was usable, never to the deployment receipt.
 */
export async function runHostDispatch({
  env = process.env,
  fetchImpl = fetch,
  receiptFile = DEFAULT_RECEIPT,
  now = () => new Date(),
  timeoutMs = TIMEOUT_MS,
  localTest = false,
} = {}) {
  const checkedAt = now().toISOString();
  if (localTest && (!LOCAL_TEST_APP_ENVS.includes(env.APP_ENV) || resolve(receiptFile) === DEFAULT_RECEIPT)) {
    const hosts = [{ role: 'all', host: null, result: hostCode('local_test_refused') }];
    return { ok: false, hosts, receipt: null, written: false };
  }
  const refused = [];
  const origins = {};
  if (env.NODE_TLS_REJECT_UNAUTHORIZED === '0') {
    refused.push({ role: 'all', host: null, result: hostCode('tls_verification_disabled') });
  }
  for (const role of ROLES) {
    const parsed = (localTest ? localTestOrigin : hostOrigin)(role, env[SETTINGS[role]]);
    if (parsed.code) refused.push({ role, host: null, result: parsed.code });
    else origins[role] = parsed.origin;
  }
  if (localTest && refused.length > 0) return { ok: false, hosts: refused, receipt: null, written: false };
  let hosts;
  if (refused.length > 0) {
    hosts = refused;
  } else {
    hosts = await Promise.all([
      checkApex(fetchImpl, origins.apex, timeoutMs, localTest),
      checkApp(fetchImpl, origins.app, timeoutMs),
      checkJoin(fetchImpl, origins.join, timeoutMs),
    ]);
  }
  const ok = hosts.length === ROLES.length && hosts.every((host) => host.result === 'served');
  const receipt = { schemaVersion: RECEIPT_SCHEMA_VERSION, checkedAt, status: ok ? 'served' : 'refused', hosts };
  if (localTest) receipt.test = true;
  else if (!ok) {
    const previous = readPrevious(receiptFile);
    const lastGood = previous?.status === 'served' ? previous : previous?.lastGood;
    if (lastGood) receipt.lastGood = { ...lastGood, lastGood: undefined, stale: true, staleSince: lastGood.staleSince ?? checkedAt };
  }
  writeReceipt(receiptFile, receipt);
  return { ok, hosts, receipt, written: true };
}

async function main() {
  const flag = process.argv.indexOf('--out');
  const localTest = process.argv.includes('--local-test');
  const receiptFile = flag > 0 ? resolve(process.argv[flag + 1] ?? '') : DEFAULT_RECEIPT;
  const { ok, hosts, written } = await runHostDispatch({ receiptFile, localTest });
  const label = localTest ? 'host dispatch (TEST):' : 'host dispatch:';
  for (const host of hosts) {
    console.log(`${label} ${host.role} ${host.host ?? '(not checked)'} ${host.result}${host.detail ? ` (${host.detail})` : ''}`);
  }
  console.log(`${label} ${written ? `receipt ${receiptFile}` : 'no receipt written'}`);
  process.exit(ok ? 0 : hosts.some((host) => host.result === hostCode('local_test_refused')) ? 2 : 1);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
