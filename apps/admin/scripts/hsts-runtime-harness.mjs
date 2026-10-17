#!/usr/bin/env node
/**
 * Real-HTTP admin HSTS harness (CLASS: TRUTH).
 *
 * Proves that Strict-Transport-Security follows the RUNTIME environment, not the build: `next build` ONCE (with a decoy
 * HSTS_MAX_AGE_SECONDS in the build environment, to catch any inlining), then `next start` that same build three times:
 *
 *   A. no HSTS variables            -> `max-age=86400`
 *   B. APP_ENV=staging, 604800 + includeSubDomains on a leaf ADMIN_ORIGIN -> `max-age=604800; includeSubDomains`
 *   C. HSTS_MAX_AGE_SECONDS=63072001 -> the process exits 1 with `config.hsts_invalid` and never listens
 *
 * It also asserts the built routes manifest has no Strict-Transport-Security rule and the decoy is nowhere in the build output.
 * Each server is a unique free port (never 3100 or any stack port) and only the pid this script spawned is stopped.
 * Run: `pnpm --filter @intafaced/admin test:hsts-runtime`.
 */
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

const HOST = '127.0.0.1';
const FORBIDDEN_PORTS = new Set([3100, 3197, 3210, 4400, 4401, 14232, 15460, ...Array.from({ length: 11 }, (_, i) => 18080 + i)]);
const READY_TIMEOUT_MS = 180_000;
const POLL_MS = 500;
const DECOY = '777777';

const ADMIN_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = join(ADMIN_DIR, '..', '..');
const NEXT_CLI = join(ADMIN_DIR, 'node_modules', 'next', 'dist', 'bin', 'next');
const ADMIN_DEP_DISTS = ['config', 'contracts', 'i18n', 'ui'].map((name) => join(REPO_ROOT, 'packages', name, 'dist', 'index.js'));

function fail(msg) {
  throw new Error(msg);
}

function buildAdminWorkspaceDeps() {
  if (ADMIN_DEP_DISTS.every((p) => existsSync(p))) return;
  console.log('[hsts-runtime-harness] building @intafaced/admin workspace deps (Next resolves package exports to dist/)');
  execFileSync('pnpm', ['--filter', '@intafaced/admin^...', 'build'], { cwd: REPO_ROOT, env: process.env, stdio: 'inherit' });
  const missing = ADMIN_DEP_DISTS.filter((p) => !existsSync(p));
  if (missing.length) fail(`workspace dist still missing after build: ${missing.join(', ')}`);
}

function allocateFreePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, HOST, () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      server.close((err) => (err ? reject(err) : resolvePort(port)));
    });
  });
}

async function uniquePort() {
  for (let i = 0; i < 16; i++) {
    const port = await allocateFreePort();
    if (port > 0 && !FORBIDDEN_PORTS.has(port)) return port;
  }
  return fail('could not allocate a free port outside the forbidden set');
}

/** A clean child environment: nothing from the caller's shell that could change posture or HSTS. */
function cleanEnv(extra = {}) {
  const env = { ...process.env, NEXT_TELEMETRY_DISABLED: '1' };
  for (const key of Object.keys(env)) {
    if (key.startsWith('HSTS_') || key.startsWith('ADMIN_') || key === 'APP_ENV' || key === 'NODE_ENV') delete env[key];
  }
  return { ...env, ...extra };
}

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* walk(path);
    else yield path;
  }
}

function assertBuildHasNoHsts() {
  const manifest = JSON.parse(readFileSync(join(ADMIN_DIR, '.next', 'routes-manifest.json'), 'utf8'));
  const keys = (manifest.headers ?? []).flatMap((rule) => (rule.headers ?? []).map((h) => String(h.key).toLowerCase()));
  if (keys.includes('strict-transport-security')) fail('routes-manifest.json still bakes a Strict-Transport-Security rule');
  if (!keys.includes('x-content-type-options'))
    fail('routes-manifest.json lost the static security headers (test is not looking at the right file)');
  for (const file of walk(join(ADMIN_DIR, '.next', 'server'))) {
    if (!/\.(?:js|json|mjs)$/.test(file)) continue;
    if (readFileSync(file, 'utf8').includes(DECOY)) fail(`the build-time HSTS decoy ${DECOY} was inlined into ${file}`);
  }
  console.log('[hsts-runtime-harness] ok: routes-manifest has no Strict-Transport-Security; build-time decoy is not inlined');
}

function startNext(port, env) {
  const stdout = [];
  const stderr = [];
  const child = spawn(process.execPath, [NEXT_CLI, 'start', '--port', String(port), '--hostname', HOST], {
    cwd: ADMIN_DIR,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
  });
  if (!child.pid) fail('next spawn produced no pid');
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (c) => stdout.push(c));
  child.stderr.on('data', (c) => stderr.push(c));
  const exited = new Promise((resolve) => child.once('exit', (code) => resolve(code)));
  const logs = () => `--- stdout ---\n${stdout.join('').slice(-3000)}\n--- stderr ---\n${stderr.join('').slice(-3000)}`;
  return { child, exited, logs, stderrText: () => stderr.join('') + stdout.join('') };
}

async function stop({ child, exited }) {
  if (child.exitCode !== null) return;
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    child.kill('SIGTERM');
  }
  const killer = setTimeout(() => {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      /* gone */
    }
  }, 5_000);
  await Promise.race([exited, sleep(6_000)]);
  clearTimeout(killer);
}

async function waitForHttp(base, run) {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  let last = 'down';
  while (Date.now() < deadline) {
    if (run.child.exitCode !== null) fail(`next exited ${run.child.exitCode} before HTTP\n${run.logs()}`);
    try {
      const res = await fetch(`${base}/`, { redirect: 'manual', signal: AbortSignal.timeout(15_000) });
      await res.text();
      if (res.status === 200) return;
      last = `HTTP ${res.status}`;
    } catch (err) {
      last = err instanceof Error ? err.message : String(err);
    }
    await sleep(POLL_MS);
  }
  return fail(`no HTTP from ${base} within ${READY_TIMEOUT_MS}ms (${last})\n${run.logs()}`);
}

async function stsOn(base, path) {
  const res = await fetch(`${base}${path}`, { redirect: 'manual', headers: { accept: 'text/html' }, signal: AbortSignal.timeout(30_000) });
  await res.text();
  return { status: res.status, sts: res.headers.get('strict-transport-security') };
}

async function runServer(label, extraEnv, expected) {
  const port = await uniquePort();
  const run = startNext(port, cleanEnv(extraEnv));
  const base = `http://${HOST}:${port}`;
  try {
    console.log(`[hsts-runtime-harness] ${label}: pid ${run.child.pid} on ${base}`);
    await waitForHttp(base, run);
    for (const path of ['/', '/this-operator-route-does-not-exist', '/api/session']) {
      const { status, sts } = await stsOn(base, path);
      if (sts !== expected)
        fail(`${label}: GET ${path} -> ${status}, Strict-Transport-Security ${JSON.stringify(sts)}, expected ${JSON.stringify(expected)}`);
      if (/preload/i.test(sts)) fail(`${label}: header contains preload`);
    }
    console.log(`[hsts-runtime-harness] ok: ${label} -> ${expected}`);
  } catch (err) {
    console.error(run.logs());
    throw err;
  } finally {
    await stop(run);
  }
}

async function runRefusal(label, extraEnv, code) {
  const port = await uniquePort();
  const run = startNext(port, cleanEnv(extraEnv));
  try {
    const exitCode = await Promise.race([run.exited, sleep(READY_TIMEOUT_MS).then(() => 'timeout')]);
    if (exitCode !== 1) fail(`${label}: expected exit code 1, got ${exitCode}\n${run.logs()}`);
    if (!run.stderrText().includes(code)) fail(`${label}: output lacks ${code}\n${run.logs()}`);
    console.log(`[hsts-runtime-harness] ok: ${label} -> exit 1 with ${code}`);
  } finally {
    await stop(run);
  }
}

async function main() {
  if (!existsSync(NEXT_CLI)) fail(`next CLI missing at ${NEXT_CLI} (pnpm install in this worktree)`);
  buildAdminWorkspaceDeps();
  console.log(`[hsts-runtime-harness] next build once (decoy HSTS_MAX_AGE_SECONDS=${DECOY} in the BUILD env only)`);
  execFileSync(process.execPath, [NEXT_CLI, 'build'], {
    cwd: ADMIN_DIR,
    env: cleanEnv({ HSTS_MAX_AGE_SECONDS: DECOY, HSTS_INCLUDE_SUBDOMAINS: 'true' }),
    stdio: 'inherit',
  });
  assertBuildHasNoHsts();

  await runServer('start A (no HSTS variables)', {}, 'max-age=86400');
  await runServer(
    'start B (staged, same build)',
    {
      APP_ENV: 'staging',
      HSTS_MAX_AGE_SECONDS: '604800',
      HSTS_INCLUDE_SUBDOMAINS: 'true',
      ADMIN_ORIGIN: 'https://admin.hsts-harness.example',
    },
    'max-age=604800; includeSubDomains',
  );
  await runRefusal('start C (max-age above the limit)', { HSTS_MAX_AGE_SECONDS: '63072001' }, 'config.hsts_invalid');
  console.log('[hsts-runtime-harness] PASS');
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
