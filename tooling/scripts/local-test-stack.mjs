#!/usr/bin/env node
/**
 * LOCAL TEST STACK — one command, no Docker.
 *
 *   pnpm local:stack                      start (idempotent) and print a health table
 *   pnpm local:stack:stop                 stop only the processes this script started
 *   pnpm local:fund <email|userId> <ASSET> <amount>
 *                                         credit labelled TEST funds through the real ledger
 *   node tooling/scripts/local-test-stack.mjs status
 *
 * What it starts, all bound to 127.0.0.1, state in ~/.intafaced/local-test-stack/:
 *   Postgres 16 (own data dir) · NATS JetStream · svc-ledger · svc-identity ·
 *   svc-matching · svc-trade · svc-pay · svc-bank · the services behind the Customer's
 *   More door, Notifications and P2P (svc-token, -p2p, -academy, -support, -market,
 *   -notify, -agents, -blueprint, -quant, -execution) · svc-edge · a small Customer
 *   static server + reverse proxy on http://127.0.0.1:3210
 *
 *   pnpm local:stack plan                 print services, ports and Edge wiring; changes nothing
 *   pnpm local:stack --only a,b           start only the named services (plus Postgres/NATS)
 *   pnpm local:stack restart edge         stop the named services, then start (idempotent)
 *   pnpm local:stack customer-dist <abs>  serve a Customer build from another folder (never rebuilt or overwritten)
 *   pnpm local:stack customer-dist --clear   go back to this checkout's own build
 *
 * Rules this file keeps (AGENTS.md "Money"):
 *   - Value moves ONLY through the ledger (packages/ledger-client recipes -> svc-ledger).
 *   - Amounts are decimal strings on the wire and scaled bigint in memory. No JS number
 *     ever holds money in this file.
 *   - No sanctions list or other owner-published magnitude is invented. The screening
 *     env vars are passed through only when they are already set in the environment,
 *     or in the machine-local file STATE/screening.local.json (never in this repo).
 *
 * Docs: docs/LOCAL-TEST-STACK.md
 */
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { rotateAll, rotateLog } from './local-test-logs.mjs';
import { ledgerPosting, marketStatus } from './local-test-market.mjs';

// ── Paths and ports ─────────────────────────────────────────────────────────

const SCRIPT = fileURLToPath(import.meta.url);
const REPO = path.resolve(path.dirname(SCRIPT), '..', '..');
const STATE = path.join(os.homedir(), '.intafaced', 'local-test-stack');
const P = {
  marker: path.join(STATE, 'LOCAL-TEST-STACK.json'),
  secrets: path.join(STATE, 'secrets.json'),
  procs: path.join(STATE, 'run', 'processes.json'),
  run: path.join(STATE, 'run'),
  logs: path.join(STATE, 'logs'),
  data: path.join(STATE, 'data'),
  pgdata: path.join(STATE, 'data', 'postgres'),
  natsdata: path.join(STATE, 'data', 'nats'),
  bin: path.join(STATE, 'bin'),
  nats: path.join(STATE, 'bin', 'nats-server'),
  natsConf: path.join(STATE, 'nats.conf'),
  natsVerified: path.join(STATE, 'nats-verified.json'),
  buildStamp: path.join(STATE, 'build-stamp.json'),
  customerDist: path.join(REPO, 'apps', 'customer', 'dist'),
  customerDistFile: path.join(STATE, 'customer-dist.json'),
};

const PORTS = {
  postgres: 15460,
  nats: 14232,
  natsMonitor: 18232,
  edge: 14500,
  ledger: 14501,
  identity: 14502,
  trade: 14504,
  matching: 14505,
  pay: 14506,
  bank: 14509,
  // Services the Customer app calls through Edge (More door, Notifications, P2P, Trade tools).
  token: 14503,
  agents: 14507,
  p2p: 14508,
  notify: 14510,
  academy: 14511,
  support: 14512,
  market: 14513,
  blueprint: 14514,
  quant: 14515,
  execution: 14516,
  customer: 3210,
};
const HOST = '127.0.0.1';
const CUSTOMER_ORIGIN = `http://${HOST}:${PORTS.customer}`;
// LOCAL TEST: WebAuthn (passkeys) cannot use an IP address as its relying-party ID, so the same Customer
// server is also reachable as localhost. Passkeys: open this one. Everything else works on either.
const CUSTOMER_LOCALHOST_ORIGIN = `http://localhost:${PORTS.customer}`;
const DB_NAME = 'intafaced_local_test';
const DB_ADMIN = 'local_test_admin';
// One Postgres schema + one login role (svc_<schema>) per service that owns tables.
// svc-quant and svc-execution own no tables (execution keeps a file journal).
const SCHEMAS = [
  'identity',
  'ledger',
  'trade',
  'pay',
  'bank',
  'token',
  'agents',
  'p2p',
  'notify',
  'academy',
  'support',
  'market',
  'blueprint',
];
const STREAM_PREFIX = 'LOCAL_TEST';
const BANNER_TEXT = 'LOCAL TEST STACK — balances are test funds, not real money';
const FUND_RAIL = 'local-test';
const MIN_FREE_GB = 14; // 10 GB machine floor + build margin

// Prior art: the NATS binary that was already downloaded and checksum-verified.
// Checksum-verified NATS download from the 10-10 account test. macOS tmp_cleaner removes /tmp
// files after 3 days, so prefer the durable copy in ~/.intafaced/archive when it exists.
const NATS_PRIOR =
  [path.join(os.homedir(), '.intafaced', 'archive', 'account-test-10-10'), '/tmp/intafaced-product-vitality-2026-10-10/account-test'].find(
    (d) => fs.existsSync(path.join(d, 'NATS-VERIFIED.json')),
  ) ?? '/tmp/intafaced-product-vitality-2026-10-10/account-test';
const NATS_ZIP = 'nats-server-v2.10.24-darwin-arm64.zip';

const PG_BIN = '/opt/homebrew/bin';
const PNPM_PATH = [path.dirname(process.execPath), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'].join(':');

// ── Small helpers ───────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const say = (line = '') => process.stdout.write(`${line}\n`);
const fail = (msg, code = 1) => {
  process.stderr.write(`\nlocal-test-stack: ${msg}\n`);
  process.exit(code);
};
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
function writePrivate(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, text, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}
const sha256File = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function baseEnv() {
  // A clean environment: nothing from the caller's shell leaks into services.
  return { PATH: PNPM_PATH, HOME: os.homedir(), LANG: 'en_US.UTF-8', TMPDIR: path.join(STATE, 'tmp') };
}

function freeGb() {
  const r = spawnSync('df', ['-k', '/'], { encoding: 'utf8' });
  const cols = r.stdout.trim().split('\n').pop().split(/\s+/);
  return Number(cols[3]) / (1024 * 1024); // disk-space gauge, not money
}

function portOpen(port) {
  return new Promise((resolve) => {
    const s = net.connect({ host: HOST, port });
    s.once('connect', () => (s.destroy(), resolve(true)));
    s.once('error', () => resolve(false));
    s.setTimeout(800, () => (s.destroy(), resolve(false)));
  });
}

async function httpGet(url, timeoutMs = 4000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, { redirect: 'error', signal: ac.signal });
    const text = await res.text();
    return { status: res.status, text };
  } catch (err) {
    return { status: 0, text: String(err?.message ?? err) };
  } finally {
    clearTimeout(t);
  }
}

function psCommand(pid) {
  const r = spawnSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : '';
}

// ── Secrets (generated once, mode 600) ──────────────────────────────────────

const SECRET_NAMES = [
  'pgAdmin',
  'pgService',
  'jwt',
  'edgePrincipal',
  'internal',
  'tradeAdmission',
  'payAdmission',
  'edgeAuthority',
  'payCryptoWebhook',
  'payCardWebhook',
  'identityTotp', // identity's TOTP sealing key; lets the labelled local test operators enrol a second factor
];

function loadOrCreateSecrets() {
  fs.mkdirSync(STATE, { recursive: true, mode: 0o700 });
  fs.chmodSync(STATE, 0o700);
  for (const d of [P.run, P.logs, P.data, P.bin, path.join(STATE, 'tmp')]) fs.mkdirSync(d, { recursive: true, mode: 0o700 });
  let s = {};
  if (fs.existsSync(P.secrets)) s = readJson(P.secrets);
  let changed = false;
  for (const n of SECRET_NAMES) {
    if (!s[n]) {
      s[n] = crypto.randomBytes(32).toString('hex'); // 64 chars, satisfies every >=32 rule
      changed = true;
    }
  }
  if (changed) writePrivate(P.secrets, JSON.stringify(s, null, 2));
  return s;
}

const dbUrl = (role, secrets) => `postgres://${role}:${secrets.pgService}@${HOST}:${PORTS.postgres}/${DB_NAME}`;
const urlOf = (name) => `http://${HOST}:${PORTS[name]}`;
/** User ids of the two LOCAL TEST operators (comma-separated), or '' while they have not been created yet. */
function localOperatorIds() {
  try {
    const ops = JSON.parse(fs.readFileSync(path.join(STATE, 'operators.json'), 'utf8')).operators ?? {};
    return ['a', 'b']
      .map((k) => ops[k]?.userId)
      .filter((id) => typeof id === 'string' && /^[0-9a-zA-Z-]{8,64}$/.test(id))
      .join(',');
  } catch {
    return '';
  }
}

// ── Process records (pid file + argv) ───────────────────────────────────────

function readProcs() {
  try {
    return readJson(P.procs);
  } catch {
    return {};
  }
}
const writeProcs = (procs) => writePrivate(P.procs, JSON.stringify(procs, null, 2));

/** A record is "ours and alive" only if the pid is alive AND its argv still matches. */
function ownedAlive(rec) {
  if (!rec?.pid) return false;
  const cmd = psCommand(rec.pid);
  if (!cmd) return false;
  return cmd.startsWith(rec.argv[0]) && rec.argv.slice(1).every((a) => cmd.includes(a));
}

function startProc(name, argv, env, cwd) {
  const logPath = path.join(P.logs, `${name}.log`);
  rotateLog(logPath); // a log over 50 MB keeps its newest 50 MB as .1 (3 files at most); see local-test-logs.mjs
  const fd = fs.openSync(logPath, 'a', 0o600);
  const child = spawn(argv[0], argv.slice(1), { cwd, env, detached: true, stdio: ['ignore', fd, fd] });
  child.unref();
  fs.closeSync(fd);
  const procs = readProcs();
  procs[name] = { pid: child.pid, argv, startedAt: new Date().toISOString() };
  writeProcs(procs);
  return child.pid;
}

async function stopProc(name, rec) {
  if (!ownedAlive(rec)) return 'not running';
  process.kill(rec.pid, 'SIGTERM');
  for (let i = 0; i < 50; i++) {
    if (!ownedAlive(rec)) return 'stopped';
    await sleep(200);
  }
  if (ownedAlive(rec)) process.kill(rec.pid, 'SIGKILL'); // re-verified just above
  return 'killed after 10s';
}

// ── Postgres ────────────────────────────────────────────────────────────────

function pgEnv(secrets, db = 'postgres', user = DB_ADMIN, password = secrets.pgAdmin) {
  return { ...baseEnv(), PGHOST: HOST, PGPORT: String(PORTS.postgres), PGUSER: user, PGPASSWORD: password, PGDATABASE: db };
}

function psql(secrets, sql, { db = 'postgres', user = DB_ADMIN, password = secrets.pgAdmin, vars = {}, tuples = false } = {}) {
  const args = ['-X', '-v', 'ON_ERROR_STOP=1', ...(tuples ? ['-At'] : [])];
  for (const [k, v] of Object.entries(vars)) args.push('-v', `${k}=${v}`);
  const r = spawnSync(`${PG_BIN}/psql`, args, {
    input: sql,
    encoding: 'utf8',
    env: pgEnv(secrets, db, user, password),
  });
  if (r.status !== 0) throw new Error(`psql failed: ${(r.stderr || r.stdout).trim().slice(0, 600)}`);
  return r.stdout;
}

function pgRunning() {
  const pidFile = path.join(P.pgdata, 'postmaster.pid');
  if (!fs.existsSync(pidFile)) return false;
  const pid = Number(fs.readFileSync(pidFile, 'utf8').split('\n')[0]);
  return Boolean(pid) && psCommand(pid).includes(P.pgdata);
}

function ensurePostgres(secrets) {
  if (!fs.existsSync(path.join(P.pgdata, 'PG_VERSION'))) {
    say('  postgres: first run, initialising a dedicated data directory');
    const pwfile = path.join(STATE, 'tmp', 'pg-admin.pw');
    writePrivate(pwfile, `${secrets.pgAdmin}\n`);
    const r = spawnSync(
      `${PG_BIN}/initdb`,
      [
        '-D',
        P.pgdata,
        '-U',
        DB_ADMIN,
        `--pwfile=${pwfile}`,
        '--auth-local=scram-sha-256',
        '--auth-host=scram-sha-256',
        '--encoding=UTF8',
        '--locale=C',
      ],
      { encoding: 'utf8', env: baseEnv() },
    );
    fs.rmSync(pwfile, { force: true });
    if (r.status !== 0) fail(`initdb failed: ${(r.stderr || r.stdout).slice(0, 500)}`);
  }
  if (!pgRunning()) {
    const r = spawnSync(
      `${PG_BIN}/pg_ctl`,
      ['-D', P.pgdata, '-l', path.join(P.logs, 'postgres.log'), '-o', `-p ${PORTS.postgres} -h ${HOST} -k ${P.run}`, '-w', 'start'],
      { encoding: 'utf8', env: baseEnv() },
    );
    if (r.status !== 0) fail(`pg_ctl start failed (port ${PORTS.postgres} busy?): ${(r.stderr || r.stdout).slice(0, 500)}`);
  }
  const exists = psql(secrets, `SELECT 1 FROM pg_database WHERE datname = '${DB_NAME}'`, { tuples: true }).trim();
  if (!exists) psql(secrets, `CREATE DATABASE ${DB_NAME}`);
  const roleSql = SCHEMAS.map(
    (s) => `
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'svc_${s}') THEN
    CREATE ROLE svc_${s} LOGIN PASSWORD '${secrets.pgService}';
  END IF;
END $$;
ALTER ROLE svc_${s} PASSWORD '${secrets.pgService}';
CREATE SCHEMA IF NOT EXISTS ${s} AUTHORIZATION svc_${s};
ALTER ROLE svc_${s} SET search_path TO ${s}, public;
GRANT USAGE ON SCHEMA public TO svc_${s};`,
  ).join('\n');
  psql(secrets, `CREATE EXTENSION IF NOT EXISTS citext; CREATE EXTENSION IF NOT EXISTS pgcrypto;\n${roleSql}`, { db: DB_NAME });
}

// ── NATS (reuse the checksum-verified binary) ───────────────────────────────

function ensureNatsBinary() {
  if (fs.existsSync(P.nats) && fs.existsSync(P.natsVerified)) {
    const rec = readJson(P.natsVerified);
    if (sha256File(P.nats) !== rec.binarySHA256) fail(`NATS binary changed since it was verified: ${P.nats}`);
    return;
  }
  const src = path.join(NATS_PRIOR, 'bin', 'nats-server');
  const zip = path.join(NATS_PRIOR, 'downloads', NATS_ZIP);
  const sums = path.join(NATS_PRIOR, 'downloads', 'SHA256SUMS');
  const verified = path.join(NATS_PRIOR, 'NATS-VERIFIED.json');
  for (const f of [src, zip, sums, verified]) if (!fs.existsSync(f)) fail(`cannot verify NATS: missing ${f}`);
  const recordedArchive = readJson(verified).archiveSHA256;
  const archiveSha = sha256File(zip);
  const officialLine = fs
    .readFileSync(sums, 'utf8')
    .split('\n')
    .find((l) => l.trim().split(/\s+/).pop().replace(/^\*/, '') === NATS_ZIP);
  const officialSha = officialLine?.trim().split(/\s+/)[0];
  if (archiveSha !== recordedArchive || archiveSha !== officialSha) {
    fail(`NATS archive checksum mismatch (actual ${archiveSha}, recorded ${recordedArchive}, official ${officialSha})`);
  }
  const list = spawnSync('unzip', ['-Z1', zip], { encoding: 'utf8' }).stdout.split('\n');
  const member = list.find((n) => n.endsWith('/nats-server'));
  const extracted = spawnSync('unzip', ['-p', zip, member], { maxBuffer: 64 * 1024 * 1024 });
  const extractedSha = crypto.createHash('sha256').update(extracted.stdout).digest('hex');
  const srcSha = sha256File(src);
  if (extractedSha !== srcSha) fail(`NATS binary in ${src} does not match the verified archive`);
  fs.copyFileSync(src, P.nats);
  fs.chmodSync(P.nats, 0o755);
  writePrivate(
    P.natsVerified,
    JSON.stringify(
      {
        release: 'v2.10.24',
        archiveSHA256: archiveSha,
        matchedOfficialSHA256SUMS: true,
        binarySHA256: sha256File(P.nats),
        copiedFrom: src,
      },
      null,
      2,
    ),
  );
  say(`  nats: binary copied and verified (archive ${archiveSha.slice(0, 12)}…, binary ${srcSha.slice(0, 12)}…)`);
}

// ── Build and migrate ───────────────────────────────────────────────────────

const BACKEND_PKGS = [
  'svc-edge',
  'svc-identity',
  'svc-ledger',
  'svc-bank',
  'svc-trade',
  'svc-pay',
  'svc-matching',
  'svc-token',
  'svc-agents',
  'svc-p2p',
  'svc-notify',
  'svc-academy',
  'svc-support',
  'svc-market',
  'svc-blueprint',
  'svc-quant',
  'svc-execution',
];

function gitHead() {
  const r = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: REPO, encoding: 'utf8' });
  return r.stdout.trim();
}

function runPnpm(args, label, extraEnv = {}) {
  const logPath = path.join(P.logs, `${label}.log`);
  const fd = fs.openSync(logPath, 'w', 0o600);
  const r = spawnSync('pnpm', args, { cwd: REPO, env: { ...baseEnv(), ...extraEnv }, stdio: ['ignore', fd, fd] });
  fs.closeSync(fd);
  if (r.status !== 0) {
    const tail = fs.readFileSync(logPath, 'utf8').split('\n').slice(-25).join('\n');
    fail(`${label} failed (exit ${r.status}). Log: ${logPath}\n${tail}`);
  }
}

const SOURCE_PATHS = ['services', 'packages', 'apps/customer', 'pnpm-lock.yaml'];

/** True when no service, package or Customer source changed between two commits (tooling and docs do not count). */
function sourceUnchangedSince(oldHead, head) {
  if (!oldHead) return false;
  if (oldHead === head) return true;
  const r = spawnSync('git', ['diff', '--quiet', oldHead, head, '--', ...SOURCE_PATHS], { cwd: REPO });
  return r.status === 0;
}

const distOf = (pkg) => path.join(REPO, 'services', pkg, 'dist', 'index.js');

// ── Customer folder override (LOCAL_STACK_CUSTOMER_DIST) ────────────────────
// A folder the founder is reviewing (for example a redesign build from another worktree) can be served
// instead of this checkout's apps/customer/dist. While it is set, this script never builds into it,
// never builds the Customer app at all, and never writes into it.

const CUSTOMER_DIST_ENV = 'LOCAL_STACK_CUSTOMER_DIST';

/** True when `file` is `dir` or lies under it (both already real paths). */
const insideDir = (dir, file) => file === dir || file.startsWith(dir + path.sep);

/** Validate a candidate folder. Returns { dir } or { error } (plain words). Touches nothing. */
function checkCustomerDist(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') return { error: 'no folder given' };
  if (!path.isAbsolute(raw)) return { error: `the folder must be an absolute path starting with "/" (got "${raw}")` };
  const dir = path.resolve(raw);
  let real;
  try {
    real = fs.realpathSync(dir);
    if (!fs.statSync(real).isDirectory()) return { error: `${dir} is not a folder` };
  } catch {
    return { error: `${dir} does not exist` };
  }
  let home = os.homedir();
  try {
    home = fs.realpathSync(home);
  } catch {
    /* keep the plain home path */
  }
  if (!real.startsWith(home + path.sep))
    return { error: `${dir} is not inside your home folder (${home}); only folders under it are allowed` };
  // Hidden folders under home hold state and keys (~/.intafaced, ~/.ssh, ~/.config ...): never serve them.
  const hidden = path
    .relative(home, real)
    .split(path.sep)
    .find((seg) => seg.startsWith('.'));
  if (hidden) return { error: `${dir} is inside a hidden folder (${hidden}); those are never served` };
  try {
    if (!fs.statSync(path.join(real, 'index.html')).isFile()) throw new Error('not a file');
    if (!insideDir(real, fs.realpathSync(path.join(real, 'index.html')))) throw new Error('index.html points outside');
  } catch {
    return { error: `${dir} has no index.html, so it is not a built Customer app` };
  }
  // A source folder (apps/customer) also has an index.html; serving it would expose src/ and node_modules.
  if (fs.existsSync(path.join(real, 'package.json')))
    return { error: `${dir} contains package.json, so it looks like a source folder, not a build output` };
  // The realpath captured here is what gets stored and served, so a later symlink swap cannot redirect it.
  return { dir: real };
}

/** Which source is asked for: the environment wins over the saved choice. */
function customerDistChoice() {
  const env = process.env[CUSTOMER_DIST_ENV];
  if (env !== undefined && env !== '') return { source: 'env', raw: env };
  try {
    return { source: 'saved', raw: readJson(P.customerDistFile).path };
  } catch (e) {
    if (e?.code === 'ENOENT') return { source: 'own' };
    return { source: 'saved', raw: undefined }; // unreadable file: reported as invalid, never ignored
  }
}

/** The folder the Customer server serves right now: { source, dir } or { source, error }. */
function activeCustomerDist() {
  const c = customerDistChoice();
  if (c.source === 'own') return { source: 'own', dir: P.customerDist };
  const v = checkCustomerDist(c.raw);
  return v.error ? { source: c.source, error: v.error } : { source: c.source, dir: v.dir };
}

function describeCustomerDist() {
  const a = activeCustomerDist();
  if (a.source === 'own') return `customer app: this checkout's own build (${P.customerDist})`;
  const from = a.source === 'env' ? `${CUSTOMER_DIST_ENV} in your shell` : 'saved by "customer-dist"';
  if (a.error) return `customer app: OVERRIDE UNUSABLE (${from}): ${a.error}. Fix it or run: pnpm local:stack customer-dist --clear`;
  return `customer app: ${a.dir}  (override, ${from}; never rebuilt or overwritten)`;
}

/** An override given in the environment is saved, so later commands (restart, start) keep serving it. */
function adoptEnvCustomerDist() {
  const c = customerDistChoice();
  if (c.source !== 'env') return;
  const v = checkCustomerDist(c.raw);
  if (v.error) fail(`${CUSTOMER_DIST_ENV}: ${v.error}`);
  writePrivate(P.customerDistFile, JSON.stringify({ path: v.dir, setAt: new Date().toISOString(), from: 'env' }, null, 2));
}

/** `customer-dist [<abs path> | --clear]`: show, set or clear the saved choice. Does not touch running processes. */
function cmdCustomerDist(args) {
  if (args.length === 0) return say(`  ${describeCustomerDist()}`);
  const envSet = (process.env[CUSTOMER_DIST_ENV] ?? '') !== '';
  if (args[0] === '--clear') {
    fs.rmSync(P.customerDistFile, { force: true });
    say("  customer-dist: cleared; the Customer app is this checkout's own build again.");
    if (envSet) say(`  Note: ${CUSTOMER_DIST_ENV} is still set in your shell and wins until you unset it.`);
    return;
  }
  if (args.length !== 1) fail('usage: customer-dist <absolute folder> | customer-dist --clear', 2);
  const v = checkCustomerDist(args[0]);
  if (v.error) fail(`refusing: ${v.error}`);
  writePrivate(P.customerDistFile, JSON.stringify({ path: v.dir, setAt: new Date().toISOString(), from: 'command' }, null, 2));
  say(`  customer-dist: saved ${v.dir}`);
  say(
    '  restart, start and the build step will leave it alone. A running Customer server reads this per request, so no restart is needed.',
  );
  if (envSet) say(`  Note: ${CUSTOMER_DIST_ENV} is set in your shell and wins over the saved folder.`);
}

/** What ensureBuilt would do. Read-only. `customer` is true only when the Customer app would be built. */
function buildPlan(rebuild, act = activeCustomerDist()) {
  const head = gitHead();
  const stamp = fs.existsSync(P.buildStamp) ? readJson(P.buildStamp) : {};
  const override = act.source !== 'own';
  // Without an override, a stamp written while an override skipped the Customer build cannot vouch for our own dist.
  const customerOk = override ? !act.error : fs.existsSync(path.join(P.customerDist, 'index.html')) && stamp.customerBuilt !== false;
  const fresh = !rebuild && sourceUnchangedSince(stamp.head, head);
  const missing = BACKEND_PKGS.filter((s) => !fs.existsSync(distOf(s)));
  const backend = fresh && customerOk ? (missing.length === 0 ? 'none' : 'missing') : 'full';
  return { head, stamp, override, missing, backend, customer: backend === 'full' && !override };
}

function ensureBuilt(rebuild) {
  const act = activeCustomerDist();
  if (act.error) fail(`customer folder override is unusable: ${act.error}\n  Fix it, or run: pnpm local:stack customer-dist --clear`);
  const { head, stamp, override, missing, backend } = buildPlan(rebuild, act);
  if (override) say(`  build: customer app is ${act.dir} (override); not building it`);
  if (backend === 'none') {
    say('  build: up to date (use --rebuild to force)');
    if (stamp.head !== head) writePrivate(P.buildStamp, JSON.stringify({ ...stamp, head }, null, 2));
    return;
  }
  if (backend === 'missing') {
    // Source is the same as the last full build; only some services have never been built.
    // Build just those so running services keep their files untouched.
    say(`  build: ${missing.length} service(s) not built yet (${missing.map((m) => m.replace('svc-', '')).join(', ')})…`);
    runPnpm([...missing.flatMap((s) => ['--filter', `@intafaced/${s}...`]), 'build'], 'build-backend-missing');
    writePrivate(P.buildStamp, JSON.stringify({ ...stamp, head, builtAt: stamp.builtAt ?? new Date().toISOString() }, null, 2));
    return;
  }
  say('  build: backend packages and services (a few minutes on a cold tree)…');
  runPnpm([...BACKEND_PKGS.flatMap((s) => ['--filter', `@intafaced/${s}...`]), 'build'], 'build-backend');
  if (!override) {
    say('  build: customer app…');
    runPnpm(['--filter', '@intafaced/customer...', 'build'], 'build-customer');
  }
  writePrivate(P.buildStamp, JSON.stringify({ head, builtAt: new Date().toISOString(), customerBuilt: !override }, null, 2));
}

function migrate(secrets, schemas = SCHEMAS) {
  for (const s of schemas) {
    runPnpm(['--filter', `@intafaced/svc-${s}`, 'db:migrate'], `migrate-${s}`, { DATABASE_URL: dbUrl(`svc_${s}`, secrets) });
  }
  say(`  migrations: ${schemas.length ? schemas.join(', ') : 'none needed'} applied (idempotent)`);
}

// ── Service definitions ─────────────────────────────────────────────────────

// Placeholder secrets used only to list names, ports and URLs (plan / health table). Never reaches a process.
const PLAN_SECRETS = Object.fromEntries(SECRET_NAMES.map((n) => [n, 'x'.repeat(64)]));
const UNUSED = `http://${HOST}:1`; // nothing listens; routes to unstarted services fail fast

function commonEnv(secrets, name, port) {
  return {
    ...baseEnv(),
    NODE_ENV: 'development',
    APP_ENV: 'dev',
    HTTP_HOST: HOST,
    HTTP_PORT: String(port),
    SERVICE_NAME: name,
    LOG_LEVEL: 'info',
    OTEL_ENABLED: 'false',
    DATABASE_SSL: 'false',
    DATABASE_POOL_MAX: '4',
    NATS_URL: `nats://${HOST}:${PORTS.nats}`,
    NATS_STREAM_PREFIX: STREAM_PREFIX,
    EDGE_PRINCIPAL_SECRET: secrets.edgePrincipal,
    INTERNAL_SERVICE_SECRET: secrets.internal,
    INTERNAL_SERVICE_BODY_BIND: 'accept-both',
    JWT_ACCESS_SECRET: secrets.jwt,
    // Every service that consults packages/config's screening reads the same pass-through
    // (Bank refuses spaces without it). Never set here; see screeningEnv().
    ...screeningEnv(),
    // LOCAL TEST ONLY, option B approved by Nitro on 2026-10-13: the stack may stand in for the compliance
    // officer who accepts a sanctions list. The list stays the labelled test fixture kept outside this repo
    // (STATE/screening.local.json); turning the fail-closed refusal off lets that fixture be read as "a list
    // exists" so Bank, Pay and Trade answer test accounts. packages/config/src/jurisdiction.ts
    // (screeningFailClosedFromEnv). This is not a counsel-approved list and nothing here makes it one.
    // The production-side guard against this value lives with the shared config check, not here.
    INTAFACED_SCREENING_FAIL_CLOSED: 'off',
  };
}

/**
 * Edge env var -> the stack service it points at. Every route in services/svc-edge/src/routes.ts
 * (UPSTREAMS) must appear here or in EDGE_ABSENT; the test checks that, and that every module the
 * Customer app calls is in this table.
 */
const EDGE_UPSTREAMS = {
  IDENTITY_URL: 'identity',
  TRADE_URL: 'trade',
  BANK_URL: 'bank',
  PAY_URL: 'pay',
  LEDGER_URL: 'ledger',
  MATCHING_URL: 'matching',
  TOKEN_URL: 'token',
  AGENTS_URL: 'agents',
  P2P_URL: 'p2p',
  BLUEPRINT_URL: 'blueprint',
  NOTIFY_URL: 'notify',
  ACADEMY_URL: 'academy',
  SUPPORT_URL: 'support',
  MARKET_URL: 'market',
  EXECUTION_URL: 'execution',
  QUANT_URL: 'quant',
};

/** Edge upstreams that are intentionally not started, each with the reason. The Customer app calls none of them except where noted. */
const EDGE_ABSENT = {
  MINING_POOL_URL:
    'svc-mining-pool hard-codes listen on 0.0.0.0 (services/svc-mining-pool/src/server.ts), which breaks the loopback-only rule. The Mining room is a static "unavailable" page; only its health probe answers 502.',
  PROTOCOL_URL: 'Protocol Plane (custody and chain); needs MPC custody and chain providers. The Customer app never calls it.',
  DEX_URL: 'On-chain DEX; needs chain RPC. The Customer app never calls it.',
  INDEXER_URL: 'Chain indexer; needs chain RPC. The Customer app never calls it.',
  TAX_URL: 'Tax reporting; the Customer app never calls /api/tax.',
  OPS_URL: 'Back-office CRM and analytics for operators; not a customer door.',
  CONNECT_URL: 'Operator data-lake door; not a customer door.',
};

function serviceDefs(secrets) {
  const c = (name, port) => commonEnv(secrets, name, port);
  return [
    {
      name: 'ledger',
      env: () => ({
        ...c('svc-ledger', PORTS.ledger),
        DATABASE_URL: dbUrl('svc_ledger', secrets),
        LEDGER_POSTING_ENABLED: 'true',
        // Required, no default. LOCAL TEST value chosen for this stack only, not an owner decision.
        // Weekly, not hourly. The run is a proof that reads every ledger entry, inside the ledger's fixed 15 s
        // statement timeout. On a busy local stack that stopped fitting (464,000 entries in a day); the statement
        // timed out, the run threw, and a throw freezes posting: every order is then refused with 400 LedgerError
        // (14 Oct). Weekly only POSTPONES this: the proof scans all history, so a stack running more than about
        // 7 days times out and freezes again. Remedy then: reset the local database, or a lighter run once the
        // production fix lands.
        RECONCILE_CRON_MINUTES: '10080',
      }),
    },
    {
      name: 'identity',
      env: () => ({
        ...c('svc-identity', PORTS.identity),
        DATABASE_URL: dbUrl('svc_identity', secrets),
        LEDGER_URL: urlOf('ledger'),
        REGISTRATION_OPEN: 'true',
        // LOCAL TEST ONLY: passkeys on. Relying-party ID must be a hostname, so use localhost and open
        // http://localhost:3210 for passkeys. Not the production relying party.
        WEBAUTHN_ENABLED: 'true',
        WEBAUTHN_RP_ID: 'localhost',
        WEBAUTHN_RP_NAME: 'INTAFACED (LOCAL TEST)',
        WEBAUTHN_ORIGIN: CUSTOMER_LOCALHOST_ORIGIN,
        IDENTITY_TRADE_ADMISSION_SECRET: secrets.tradeAdmission,
        IDENTITY_PAY_ADMISSION_SECRET: secrets.payAdmission,
        // Edge reads each caller's current account authority with this key; without it
        // Edge refuses every signed-in token as 'invalid' and forwards anonymously.
        IDENTITY_EDGE_AUTHORITY_SECRET: secrets.edgeAuthority,
        // LOCAL TEST ONLY (Nitro, option B, 2026-10-13). Required, no default, owner-unpublished: how long a
        // two-person action approval lives. 600 s is a local test value, not an owner decision. The labelled
        // local test operators (tooling/scripts/local-test-gates.mjs) use it to open markets and verify
        // test accounts; "LOCAL TEST — not a real approval".
        IDENTITY_ACTION_APPROVAL_TTL_SECONDS: '600',
        // Sealing key for operator second factors (TOTP). Generated per machine in secrets.json.
        IDENTITY_TOTP_SECRET_KEY: secrets.identityTotp,
      }),
    },
    {
      name: 'matching',
      env: () => ({
        ...c('svc-matching', PORTS.matching),
        MATCHING_ENGINE_ENABLED: 'true',
        MATCHING_SNAPSHOT_EVERY: '0', // required, owner-unpublished; 0 = snapshotting off (no magnitude invented)
        MATCHING_JOURNAL_PATH: path.join(P.data, 'matching', 'engine_journal.ndjson'),
        // Opening a market needs a two-person approval that matching consumes from identity
        // (services/svc-matching/src/action-approval-consume.ts). Without this it refuses by name.
        IDENTITY_URL: urlOf('identity'),
        // Opening a market also requires BOTH the proposer and the approver to be on this list (security fix #4742;
        // unset, nobody can open a market). LOCAL TEST: the two labelled operators of local-test-gates.mjs, read
        // from operators.json. They exist only after `local-test-gates.mjs operators`, so the first time restart
        // matching afterwards (pnpm local:stack:restart matching). Harmless before #4742 merges.
        ...(localOperatorIds() ? { MATCHING_OPERATOR_IDS: localOperatorIds() } : {}),
      }),
    },
    {
      name: 'trade',
      env: () => ({
        ...c('svc-trade', PORTS.trade),
        DATABASE_URL: dbUrl('svc_trade', secrets),
        LEDGER_URL: urlOf('ledger'),
        IDENTITY_URL: urlOf('identity'),
        MATCHING_URL: urlOf('matching'),
        TOKEN_URL: urlOf('token'), // OTC stake tiers; picked up the next time trade restarts
        IDENTITY_ADMISSION_SECRET: secrets.tradeAdmission,
        // LOCAL TEST owner risk limits, not owner decisions: the stack stands in for the owner
        // under Nitro's 2026-10-13 option B. pretrade-credit.ts only requires them to be published
        // integers; it does not compare orders against them. Test funds only.
        TRADE_MAX_ORDER: '1000000',
        TRADE_MAX_POSITION: '5000000',
        TRADE_MAX_LOSS: '100000',
        // LOCAL TEST, not an owner decision (option B, 2026-10-13): realistic retail-exchange commercial values.
        // Market buys are funded at bestAsk x (1 + cap) and refuse trade.slippage_cap_unset without it
        // (services/svc-trade/src/env.ts TRADE_MARKET_SLIPPAGE_CAP_BPS): 50 bps.
        TRADE_MARKET_SLIPPAGE_CAP_BPS: '50',
        // House edge on Convert quotes; convert.quote refuses trade.convert_spread_unset without it: 20 bps.
        TRADE_CONVERT_SPREAD_BPS: '20',
        // How long a firm Convert quote binds; refuses trade.convert_quote_ttl_unset without it: 15 s.
        TRADE_CONVERT_QUOTE_TTL_MS: '15000',
        // LOCAL TEST, not an owner decision (option B, 2026-10-13). Fee schedule reference: OKX's public
        // regular-user spot tier, maker 8 bps, taker 10 bps, no maker rebate (makerRebateBps omitted).
        // Without it trade refuses every order with 400 trade.fee_schedule_blank
        // (services/svc-trade/src/spot/fee-schedule.ts, trade-service.ts assertOwnerFeeSchedulePublished).
        TRADE_FEE_SCHEDULE: JSON.stringify({
          published: true,
          version: 'local-test:okx-regular-spot-reference',
          makerBps: '8',
          takerBps: '10',
        }),
      }),
    },
    {
      name: 'pay',
      env: () => ({
        ...c('svc-pay', PORTS.pay),
        DATABASE_URL: dbUrl('svc_pay', secrets),
        LEDGER_URL: urlOf('ledger'),
        IDENTITY_URL: urlOf('identity'),
        IDENTITY_ADMISSION_SECRET: secrets.payAdmission,
        PAY_CRYPTO_WEBHOOK_SECRET: secrets.payCryptoWebhook,
        PAY_CARD_SANDBOX_WEBHOOK_SECRET: secrets.payCardWebhook,
        PAY_CRYPTO_WATCHER_ENABLED: 'false', // no chain RPC in the local stack
        PAY_ALLOW_SANDBOX_RAILS: 'false',
        // Required, no default. LOCAL TEST values copied from .env.example.
        PAY_OPERATOR_CREDIT_RAILS: 'card-sandbox',
        PAY_MIN_CONFIRMATIONS: '6',
        PAY_WEBHOOK_TOLERANCE_SECONDS: '300',
        PAY_CHECKOUT_SESSION_TTL_SECONDS: '900',
        PAY_CHECKOUT_MAX_OPEN_SESSIONS: '25',
        PAY_LINK_DEFAULT_TTL_DAYS: '30',
        PAY_LINK_MAX_TTL_DAYS: '365',
      }),
    },
    {
      name: 'bank',
      env: () => ({
        ...c('svc-bank', PORTS.bank),
        DATABASE_URL: dbUrl('svc_bank', secrets),
        LEDGER_URL: urlOf('ledger'),
        IDENTITY_URL: urlOf('identity'),
        TRADE_URL: urlOf('trade'),
        // Required, no default (owner-unpublished). Inert LOCAL TEST placeholders so the service can
        // boot: the jobs they size are all switched off below, so no batch size is ever exercised.
        LOAN_QUOTE_ASSET_ID: 'USDT',
        TRANSFER_BATCH_SIZE: '1',
        LOAN_SWEEP_BATCH_SIZE: '1',
        // Nothing moves money in the background of a test stack.
        SCHEDULED_TRANSFERS_ENABLED: 'false',
        AUTO_INVEST_ENABLED: 'false',
        INTEREST_ACCRUAL_ENABLED: 'false',
        LOAN_ACCRUAL_ENABLED: 'false',
        LOAN_RISK_SWEEP_ENABLED: 'false',
      }),
    },
    // ── Services behind the Customer's More door, Notifications, P2P and Trade tools ──
    // Same wiring as above: commonEnv() (edge principal, internal service secret, screening
    // pass-through), own schema + role, loopback only. Anything that needs a real outside
    // provider is left unconnected on purpose; each limit is listed in docs/LOCAL-TEST-STACK.md.
    {
      name: 'token',
      env: () => ({
        ...c('svc-token', PORTS.token),
        DATABASE_URL: dbUrl('svc_token', secrets),
        LEDGER_URL: urlOf('ledger'),
        IDENTITY_URL: urlOf('identity'),
        TRADE_URL: urlOf('trade'),
        // Nothing mints, distributes or buys back in the background of a test stack.
        EMISSIONS_AUTO_TICK: 'false',
        YIELD_JOB_ENABLED: 'false',
        BUYBACK_JOB_ENABLED: 'false',
      }),
    },
    {
      name: 'p2p',
      env: () => ({
        ...c('svc-p2p', PORTS.p2p),
        DATABASE_URL: dbUrl('svc_p2p', secrets),
        LEDGER_URL: urlOf('ledger'),
        IDENTITY_URL: urlOf('identity'),
        // The house fee (P2P_FEE_BPS) and offer caps are owner-unpublished money numbers: left unset, so the
        // service refuses those steps by name. The clocks below have no default and the service will not boot
        // without them; they are LOCAL TEST values (the figures the service's own messages name), not owner decisions.
        P2P_ESCROW_DEADLINE_SECONDS: '120',
        P2P_PAYMENT_DEADLINE_SECONDS: '900',
        P2P_RELEASE_DEADLINE_SECONDS: '1800',
        P2P_DISPUTE_SLA_SECONDS: '604800',
        P2P_DISPUTE_ESCALATION_RECHECK_SECONDS: '3600',
        P2P_SWEEP_INTERVAL_SECONDS: '30',
        P2P_INSTRUMENT_RETENTION_DAYS: '90',
      }),
    },
    {
      name: 'academy',
      env: () => ({
        ...c('svc-academy', PORTS.academy),
        DATABASE_URL: dbUrl('svc_academy', secrets),
        TOKEN_URL: urlOf('token'),
        IDENTITY_URL: urlOf('identity'),
        TRADE_URL: urlOf('trade'),
        ACADEMY_STREAM_PROVIDER: 'none', // no LiveKit / video storage: live classes and video stay unconnected
      }),
    },
    {
      name: 'support',
      env: () => ({
        ...c('svc-support', PORTS.support),
        DATABASE_URL: dbUrl('svc_support', secrets),
        IDENTITY_URL: urlOf('identity'),
      }),
    },
    {
      name: 'market',
      env: () => ({
        ...c('svc-market', PORTS.market),
        DATABASE_URL: dbUrl('svc_market', secrets),
        TOKEN_URL: urlOf('token'),
        LEDGER_URL: urlOf('ledger'),
        IDENTITY_URL: urlOf('identity'),
        // MARKET_HOUSE_COMMISSION_BPS is owner-unpublished: left unset.
      }),
    },
    {
      name: 'notify',
      env: () => ({
        ...c('svc-notify', PORTS.notify),
        DATABASE_URL: dbUrl('svc_notify', secrets),
        TRADE_URL: urlOf('trade'),
        MATCHING_URL: urlOf('matching'),
        // In-app inbox only. No email, push or SMS gateway exists locally, so those channels refuse honestly.
        NOTIFY_REQUIRED_CHANNELS: 'none',
        // Required, no default. LOCAL TEST values: attempts only matter for out-of-app delivery (none here);
        // the verification-code lifetime is the .env.example value.
        NOTIFY_MAX_DELIVERY_ATTEMPTS: '3',
        NOTIFY_VERIFY_TTL_MINUTES: '15',
      }),
    },
    {
      name: 'agents',
      env: () => ({
        ...c('svc-agents', PORTS.agents),
        DATABASE_URL: dbUrl('svc_agents', secrets),
        LEDGER_URL: urlOf('ledger'),
        IDENTITY_URL: urlOf('identity'),
        ACADEMY_URL: urlOf('academy'),
        SUPPORT_URL: urlOf('support'),
        TRADE_URL: urlOf('trade'),
        PAY_URL: urlOf('pay'),
        // Required, no default (owner-unpublished). Inert LOCAL TEST placeholders: metering is off,
        // so no usage fee is ever charged.
        AGENTS_FEE_ASSET_ID: 'USDT',
        AGENTS_USAGE_WINDOW_MINUTES: '60',
        AGENTS_METERING_ENABLED: 'false',
        // No model provider is connected: "upstream" pointed at a closed loopback port, so every
        // model call fails with a connection error instead of returning invented text. The service's
        // built-in "mock" provider is deliberately not used.
        AGENTS_PROVIDER: 'upstream',
        AGENTS_UPSTREAM_BASE_URL: UNUSED,
        AGENTS_UPSTREAM_API_KEY: 'not-connected-local-test',
      }),
    },
    {
      name: 'blueprint',
      env: () => ({
        ...c('svc-blueprint', PORTS.blueprint),
        DATABASE_URL: dbUrl('svc_blueprint', secrets),
        // The neural engine is an outside provider. "http" at a closed loopback port means the engine
        // is unreachable and requests fail; the stub engine ("mock") is deliberately not used.
        BLUEPRINT_ENGINE_MODE: 'http',
        BLUEPRINT_ENGINE_URL: UNUSED,
      }),
    },
    {
      name: 'quant',
      env: () => ({ ...c('svc-quant', PORTS.quant) }), // no database; no data lake or venue vault is connected
    },
    {
      name: 'execution',
      env: () => ({
        ...c('svc-execution', PORTS.execution),
        TRADE_URL: urlOf('trade'),
        MATCHING_URL: urlOf('matching'),
        EXECUTION_EMS_STORE_PATH: path.join(P.data, 'execution', 'ems-orders.ndjson'),
        // EXECUTION_VENUE_IDS empty: no outside venue, so nothing can route off-platform.
      }),
    },
    {
      name: 'edge',
      env: () => {
        const env = {
          ...c('svc-edge', PORTS.edge),
          IDENTITY_OWNERSHIP_SECRET: secrets.edgeAuthority,
          EDGE_ALLOWED_ORIGINS: `${CUSTOMER_ORIGIN},${CUSTOMER_LOCALHOST_ORIGIN}`,
          EDGE_RATE_LIMIT_ENABLED: 'true',
          // Required, no default. LOCAL TEST values (generous: the UI polls).
          EDGE_RATE_LIMIT_MAX: '1200',
          EDGE_RATE_LIMIT_WINDOW_MS: '60000',
          EDGE_BODY_LIMIT_BYTES: '1048576',
          EDGE_KILL_STATE_PATH: path.join(P.data, 'edge-kill-state.json'),
        };
        for (const [k, service] of Object.entries(EDGE_UPSTREAMS)) env[k] = urlOf(service);
        for (const k of Object.keys(EDGE_ABSENT)) env[k] = UNUSED; // nothing listens; answers 502 by design
        // Screening: pass through ONLY what is already in the caller's environment.
        // Never set, default or invent a sanctions list.
        return env;
      },
    },
  ];
}

// Screening comes from the caller's environment, else from a file that exists only on
// the owner's machine (e.g. a labelled local test fixture the owner approved). The repo
// never carries a value.
const SCREENING_FILE = path.join(STATE, 'screening.local.json');
function screeningEnv() {
  const fromEnv = {
    INTAFACED_SANCTIONS_REGIONS: process.env.INTAFACED_SANCTIONS_REGIONS,
    INTAFACED_SANCTIONS_LIST_SOURCE: process.env.INTAFACED_SANCTIONS_LIST_SOURCE,
  };
  if (fromEnv.INTAFACED_SANCTIONS_REGIONS && fromEnv.INTAFACED_SANCTIONS_LIST_SOURCE) return fromEnv;
  if (!fs.existsSync(SCREENING_FILE)) return {};
  const file = JSON.parse(fs.readFileSync(SCREENING_FILE, 'utf8'));
  if (typeof file.regions !== 'string' || typeof file.source !== 'string' || !file.regions || !file.source) {
    throw new Error(`${SCREENING_FILE} needs non-empty string fields "regions" and "source"`);
  }
  return { INTAFACED_SANCTIONS_REGIONS: file.regions, INTAFACED_SANCTIONS_LIST_SOURCE: file.source };
}
const screeningSet = () => Boolean(screeningEnv().INTAFACED_SANCTIONS_REGIONS);

// ── Start / status / stop ───────────────────────────────────────────────────

async function waitHealthy(name, url, pid, timeoutMs = 90_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (!psCommand(pid)) {
      const tail = fs
        .readFileSync(path.join(P.logs, `${name}.log`), 'utf8')
        .split('\n')
        .slice(-20)
        .join('\n');
      fail(`${name} exited during start. Log ${path.join(P.logs, `${name}.log`)}:\n${tail}`);
    }
    const r = await httpGet(url, 2000);
    if (r.status === 200) return;
    await sleep(500);
  }
  fail(`${name} did not become healthy at ${url} within ${timeoutMs / 1000}s (see ${path.join(P.logs, `${name}.log`)})`);
}

async function startNats() {
  const procs = readProcs();
  if (ownedAlive(procs.nats) && (await httpGet(`http://${HOST}:${PORTS.natsMonitor}/healthz`)).status === 200) return;
  if (await portOpen(PORTS.nats)) fail(`port ${PORTS.nats} is in use by a process this script did not start`);
  fs.mkdirSync(P.natsdata, { recursive: true, mode: 0o700 });
  writePrivate(
    P.natsConf,
    `host: ${HOST}\nport: ${PORTS.nats}\nhttp: ${HOST}:${PORTS.natsMonitor}\nserver_name: local-test-stack\njetstream {\n  store_dir: "${P.natsdata}"\n}\n`,
  );
  const pid = startProc('nats', [P.nats, '-c', P.natsConf], baseEnv(), STATE);
  await waitHealthy('nats', `http://${HOST}:${PORTS.natsMonitor}/healthz`, pid, 30_000);
}

/**
 * Services subscribe to streams other services own (identity listens to ledger/trade/…), and the
 * subscribe fails with "stream not found" if the owner has not started yet. Create every stream
 * the event catalog declares, empty and idempotent, using the repo's own ensureStream.
 */
function ensureStreams() {
  const code = `
    import { connect } from 'nats';
    import { EVENT_CATALOG, ensureStream } from '@intafaced/events';
    const nc = await connect({ servers: process.env.NATS_URL });
    const jsm = await nc.jetstreamManager();
    const modules = [...new Set(Object.values(EVENT_CATALOG).map((d) => d.service))];
    for (const m of modules) await ensureStream(jsm, m, process.env.NATS_STREAM_PREFIX);
    await nc.close();
    console.log(modules.join(','));`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    cwd: path.join(REPO, 'packages', 'events'),
    env: { ...baseEnv(), NATS_URL: `nats://${HOST}:${PORTS.nats}`, NATS_STREAM_PREFIX: STREAM_PREFIX },
    encoding: 'utf8',
  });
  if (r.status !== 0) fail(`creating NATS streams failed: ${(r.stderr || r.stdout).slice(0, 500)}`);
  say(`  nats streams: ${r.stdout.trim()}`);
}

async function startNodeService(def) {
  const port = Number(def.env().HTTP_PORT);
  const procs = readProcs();
  const url = `http://${HOST}:${port}/health`;
  if (ownedAlive(procs[def.name]) && (await httpGet(url, 2000)).status === 200) return;
  if (await portOpen(port)) fail(`port ${port} (${def.name}) is in use by a process this script did not start`);
  for (const d of ['matching', 'execution']) fs.mkdirSync(path.join(P.data, d), { recursive: true, mode: 0o700 });
  const entry = path.join(REPO, 'services', `svc-${def.name}`, 'dist', 'index.js');
  const pid = startProc(def.name, [process.execPath, entry], def.env(), path.join(REPO, 'services', `svc-${def.name}`));
  await waitHealthy(def.name, url, pid);
}

async function startCustomer() {
  const procs = readProcs();
  const url = `${CUSTOMER_ORIGIN}/`;
  if (ownedAlive(procs.customer) && (await httpGet(url, 2000)).status === 200) return;
  if (await portOpen(PORTS.customer)) fail(`port ${PORTS.customer} (customer) is in use by a process this script did not start`);
  const pid = startProc('customer', [process.execPath, SCRIPT, '__serve-customer'], baseEnv(), REPO);
  await waitHealthy('customer', url, pid, 20_000);
}

/** Every Node service this script runs, in start order (Edge last). */
function serviceNames() {
  return serviceDefs(PLAN_SECRETS).map((d) => d.name);
}

async function healthTable({ gateMarket = false } = {}) {
  const procs = readProcs();
  const rows = [];
  rows.push([
    'postgres',
    PORTS.postgres,
    pgRunning() ? 'owned' : '-',
    pgRunning() &&
    (() => {
      try {
        psql(readJson(P.secrets), 'SELECT 1', { db: DB_NAME, tuples: true });
        return true;
      } catch {
        return false;
      }
    })()
      ? 'ok'
      : 'DOWN',
  ]);
  const nats = await httpGet(`http://${HOST}:${PORTS.natsMonitor}/healthz`, 2000);
  rows.push(['nats', `${PORTS.nats}/${PORTS.natsMonitor}`, procs.nats?.pid ?? '-', nats.status === 200 ? 'ok' : 'DOWN']);
  for (const n of serviceNames()) {
    const r = await httpGet(`${urlOf(n)}/health`, 2500);
    // A ledger that answers /health but has posting switched off refuses every order: not "ok".
    const posting = n === 'ledger' && r.status === 200 ? ledgerPosting(r.text) : null;
    rows.push([
      `svc-${n}`,
      PORTS[n],
      procs[n]?.pid ?? '-',
      posting?.frozen ? `FROZEN (${posting.text})` : r.status === 200 ? 'ok' : `DOWN (${r.status})`,
    ]);
  }
  const cust = await httpGet(`${CUSTOMER_ORIGIN}/`, 2500);
  rows.push([
    'customer',
    PORTS.customer,
    procs.customer?.pid ?? '-',
    cust.status === 200 && cust.text.includes(BANNER_TEXT) ? 'ok (banner on)' : `DOWN (${cust.status})`,
  ]);
  // The test market maker is not a service of the stack, but its prices freeze silently when it dies (it did, twice).
  const mk = marketStatus();
  rows.push(['market-maker', '-', mk.pid ?? '-', mk.text]);
  const w = [14, 12, 8];
  say(`  ${'SERVICE'.padEnd(w[0])}${'PORT'.padEnd(w[1])}${'PID'.padEnd(w[2])}HEALTH`);
  for (const r of rows) say(`  ${String(r[0]).padEnd(w[0])}${String(r[1]).padEnd(w[1])}${String(r[2]).padEnd(w[2])}${r[3]}`);
  const marketBad = mk.state === 'down' || mk.state === 'stale';
  return rows.slice(0, -1).every((r) => String(r[3]).startsWith('ok')) && !(gateMarket && marketBad);
}

/** `--only a,b` -> ['a','b'] (validated against the services this script knows); null when absent. */
function onlyFlag(flags) {
  const at = flags.indexOf('--only');
  if (at === -1) return null;
  const names = (flags[at + 1] ?? '').split(',').filter(Boolean);
  const known = [...serviceNames(), 'customer'];
  const bad = names.filter((n) => !known.includes(n));
  if (names.length === 0 || bad.length)
    fail(`--only needs a comma list of: ${known.join(', ')}${bad.length ? ` (unknown: ${bad.join(', ')})` : ''}`, 2);
  return names;
}

async function cmdStart(flags) {
  say('INTAFACED local test stack');
  say(`  repo ${REPO}`);
  say(`  state ${STATE}`);
  const free = freeGb();
  if (free < MIN_FREE_GB) fail(`only ${free.toFixed(1)} GB free on / (need >= ${MIN_FREE_GB} GB so free space stays above 12 GB)`);
  for (const b of [`${PG_BIN}/pg_ctl`, `${PG_BIN}/initdb`, `${PG_BIN}/psql`])
    if (!fs.existsSync(b)) fail(`missing ${b} (install PostgreSQL 16 via Homebrew)`);
  const secrets = loadOrCreateSecrets();
  rotateAll(P.logs); // every log capped at 50 MB, 3 files; the running market sweeps them too
  writePrivate(
    P.marker,
    JSON.stringify(
      {
        kind: 'intafaced-local-test-stack',
        warning: 'LOCAL TEST STACK — balances are test funds, not real money',
        repo: REPO,
        ports: PORTS,
        database: { host: HOST, port: PORTS.postgres, name: DB_NAME },
        updatedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
  // Edge fails closed (every module halted) when its kill-state file is missing. An explicit empty
  // list is the operator statement "nothing is killed"; for a local test stack we write that once
  // and never overwrite a file an operator (or the kill switch itself) has changed.
  if (!fs.existsSync(path.join(P.data, 'edge-kill-state.json'))) {
    writePrivate(
      path.join(P.data, 'edge-kill-state.json'),
      `${JSON.stringify({ killed: [], updatedAt: new Date().toISOString() }, null, 2)}\n`,
    );
  }
  adoptEnvCustomerDist();
  const only = onlyFlag(flags);
  ensureNatsBinary();
  ensureBuilt(flags.includes('--rebuild'));
  ensurePostgres(secrets);
  const wanted = serviceDefs(secrets).filter((d) => !only || only.includes(d.name));
  // Migrate only what is about to start: a service that is already running was migrated when it started.
  const toStart = wanted.filter((d) => !ownedAlive(readProcs()[d.name]));
  migrate(
    secrets,
    SCHEMAS.filter((s) => toStart.some((d) => d.name === s)),
  );
  await startNats();
  ensureStreams();
  for (const def of wanted) await startNodeService(def);
  if (activeCustomerDist().error || !fs.existsSync(path.join(activeCustomerDist().dir, 'index.html')))
    fail('customer build missing; run with --rebuild');
  if (!only || only.includes('customer')) await startCustomer();
  ensureMarket();
  say('');
  const allOk = await healthTable();
  say('');
  if (!screeningSet()) {
    say('  Edge will refuse money reads: edge.screening_unset — decision pending with Nitro');
    say('  (INTAFACED_SANCTIONS_REGIONS / INTAFACED_SANCTIONS_LIST_SOURCE are not set; this script will not invent them.)');
  } else {
    say(
      `  Screening passed through to Edge from ${process.env.INTAFACED_SANCTIONS_REGIONS ? 'your shell' : SCREENING_FILE} (not set by this script).`,
    );
  }
  say('');
  say(`  ${describeCustomerDist()}`);
  say(`  Open: ${CUSTOMER_ORIGIN}   (register, sign in, then: pnpm local:fund <email> USDT 1000)`);
  say(`  Stop: pnpm local:stack:stop`);
  if (!allOk) process.exit(1);
}

/**
 * Failure it prevents: the test market maker died overnight and prices froze unnoticed. If it was started before
 * and is not running now, start it again (the market script holds a lock and a pid file, so never twice).
 * A stack that never ran the market is left alone, and a failure here never fails the stack.
 */
function ensureMarket() {
  const r = spawnSync(process.execPath, [path.join(path.dirname(SCRIPT), 'local-test-market.mjs'), 'ensure'], {
    env: { PATH: process.env.PATH, HOME: os.homedir() },
    encoding: 'utf8',
  });
  const text = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim().split('\n').filter(Boolean).join(' | ');
  say(`  market maker: ${text || `ensure exited ${r.status}`}`);
}

async function cmdStop(names = []) {
  const procs = readProcs();
  const order = ['customer', ...serviceNames().reverse(), 'nats'];
  const only = names.length ? names : null;
  let bad = false;
  for (const name of order) {
    if (only && !only.includes(name)) continue;
    const rec = procs[name];
    if (!rec) continue;
    if (rec.pid && psCommand(rec.pid) && !ownedAlive(rec)) {
      say(`  ${name}: pid ${rec.pid} no longer matches the recorded command line, refusing to signal it`);
      bad = true;
      continue;
    }
    say(`  ${name}: ${await stopProc(name, rec)}`);
  }
  if (only) {
    if (bad) process.exit(1);
    return;
  }
  if (pgRunning()) {
    const r = spawnSync(`${PG_BIN}/pg_ctl`, ['-D', P.pgdata, '-m', 'fast', '-w', 'stop'], { encoding: 'utf8', env: baseEnv() });
    say(`  postgres: ${r.status === 0 ? 'stopped' : `stop failed: ${r.stderr.trim()}`}`);
    if (r.status !== 0) bad = true;
  } else {
    say('  postgres: not running');
  }
  say('  Data is kept in the state directory. Start again with: pnpm local:stack');
  if (bad) process.exit(1);
}

// ── plan / restart ──────────────────────────────────────────────────────────

/** Read-only: what this script would run and where Edge would send every route. Touches nothing. */
function cmdPlan(flags) {
  const defs = serviceDefs(PLAN_SECRETS);
  const procs = fs.existsSync(P.procs) ? readProcs() : {};
  const services = defs.map((d) => ({
    name: d.name,
    port: Number(d.env().HTTP_PORT),
    url: `http://${HOST}:${d.env().HTTP_PORT}`,
    schema: SCHEMAS.includes(d.name) ? d.name : null,
    running: ownedAlive(procs[d.name]),
  }));
  const edgeEnv = defs.find((d) => d.name === 'edge').env();
  const edgeUpstreams = Object.fromEntries([
    ...Object.entries(EDGE_UPSTREAMS).map(([k, service]) => [k, { url: edgeEnv[k], service }]),
    ...Object.entries(EDGE_ABSENT).map(([k, reason]) => [k, { url: edgeEnv[k], service: null, absentReason: reason }]),
  ]);
  const act = activeCustomerDist();
  const bp = buildPlan(flags.includes('--rebuild'), act);
  const customer = { source: act.source, dir: act.dir ?? null, error: act.error ?? null, wouldBuild: bp.customer };
  if (flags.includes('--json'))
    return say(JSON.stringify({ host: HOST, services, edgeUpstreams, backendPackages: BACKEND_PKGS, schemas: SCHEMAS, customer }, null, 2));
  say('INTAFACED local test stack, plan (nothing is started or changed)');
  for (const sv of services)
    say(
      `  ${sv.name.padEnd(11)}${String(sv.port).padEnd(7)}${(sv.schema ?? 'no database').padEnd(13)}${sv.running ? 'running' : 'not running'}`,
    );
  say(`  ${describeCustomerDist()}`);
  say(`  Customer build on next start: ${bp.customer ? 'yes' : 'no'}`);
  say('  Edge upstreams:');
  for (const [k, v] of Object.entries(edgeUpstreams)) say(`    ${k.padEnd(16)}${v.service ?? `ABSENT (${v.absentReason})`}`);
}

/** Stop the named services (plain stop, leaves Postgres and the rest alone), then start whatever is not running. */
async function cmdRestart(names) {
  const known = [...serviceNames(), 'customer'];
  const bad = names.filter((n) => !known.includes(n));
  if (names.length === 0 || bad.length)
    fail(`restart needs service names from: ${known.join(', ')}${bad.length ? ` (unknown: ${bad.join(', ')})` : ''}`, 2);
  await cmdStop(names);
  await cmdStart([]);
}

// ── Customer static server + reverse proxy ──────────────────────────────────

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json',
  '.wasm': 'application/wasm',
  '.webmanifest': 'application/manifest+json',
};

const BANNER_HTML =
  `<style>body{padding-top:28px !important}</style>` +
  `<div id="local-test-stack-banner" role="status" style="position:fixed;top:0;left:0;right:0;height:28px;z-index:2147483647;` +
  `display:flex;align-items:center;justify-content:center;background:#F5A915;color:#0b0b0b;` +
  `font:600 12px/1 ui-sans-serif,system-ui,-apple-system,'Segoe UI',sans-serif;letter-spacing:.04em;text-align:center;` +
  `pointer-events:none;user-select:none">${BANNER_TEXT}</div>`;

function indexWithBanner(dist) {
  const html = fs.readFileSync(path.join(dist, 'index.html'), 'utf8');
  return html.replace(/<body([^>]*)>/i, (m) => `${m}${BANNER_HTML}`);
}

function serveCustomer(port = PORTS.customer) {
  const edge = { host: HOST, port: PORTS.edge };
  const send = (res, status, type, body, extra = {}) => {
    res.writeHead(status, { 'content-type': type, 'content-length': Buffer.byteLength(body), 'cache-control': 'no-store', ...extra });
    res.end(body);
  };
  const server = http.createServer((req, res) => {
    const host = req.headers.host ?? '';
    if (host !== `${HOST}:${port}` && host !== `localhost:${port}`) {
      // Refuse foreign Host headers (DNS rebinding). Only the two local names are served.
      res.writeHead(403);
      return void res.end();
    }
    const url = new URL(req.url, CUSTOMER_ORIGIN);
    const p = url.pathname;

    if (p === '/api' || p === '/ws') return send(res, 404, 'text/plain; charset=utf-8', 'not found');
    if (p.startsWith('/ws/')) {
      return send(
        res,
        503,
        'application/json',
        JSON.stringify({ error: 'ws_not_started', message: 'The WebSocket service is not part of the local test stack.' }),
      );
    }
    if (p.startsWith('/api/')) {
      const headers = {};
      for (const [k, v] of Object.entries(req.headers)) {
        const lk = k.toLowerCase();
        if (['connection', 'keep-alive', 'transfer-encoding', 'upgrade'].includes(lk)) continue;
        if (lk.startsWith('x-intafaced-') || lk.startsWith('x-service-')) continue; // only Edge may mint these
        headers[k] = v;
      }
      headers['x-forwarded-for'] = req.socket.remoteAddress ?? HOST;
      headers['x-forwarded-proto'] = 'http';
      const up = http.request({ ...edge, method: req.method, path: req.url, headers }, (ur) => {
        res.writeHead(ur.statusCode ?? 502, { ...ur.headers, 'cache-control': 'no-store' });
        ur.pipe(res);
      });
      up.on('error', () =>
        res.headersSent ? res.destroy() : send(res, 502, 'application/json', JSON.stringify({ error: 'edge_unreachable' })),
      );
      return void req.pipe(up);
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'text/plain; charset=utf-8', 'method not allowed');

    // The folder is resolved on every request, so "customer-dist <path>" / "--clear" take effect at once.
    const active = activeCustomerDist();
    if (active.error) {
      return send(
        res,
        503,
        'text/plain; charset=utf-8',
        `The Customer folder override is unusable: ${active.error}\nFix it, or run: pnpm local:stack customer-dist --clear`,
      );
    }
    const dist = active.dir;

    // Static files; unknown paths fall back to index.html like apps/customer/nginx.conf.
    let decoded;
    try {
      decoded = decodeURIComponent(p);
    } catch {
      return send(res, 400, 'text/plain; charset=utf-8', 'bad request');
    }
    const rel = path.normalize(decoded).replace(/^([/\\])+/, '');
    const file = path.join(dist, rel);
    // Hidden files and folders are never served, and neither is anything whose real path leaves the folder
    // (a symlink inside the build pointing elsewhere).
    if (rel.split(path.sep).some((seg) => seg.startsWith('.'))) return send(res, 404, 'text/plain; charset=utf-8', 'not found');
    let target = null;
    if (insideDir(dist, file) && rel !== '' && rel !== 'index.html') {
      try {
        const real = fs.realpathSync(file);
        if (!insideDir(dist, real)) return send(res, 404, 'text/plain; charset=utf-8', 'not found');
        if (fs.statSync(real).isFile()) target = real;
      } catch {
        /* not found: falls through to the app shell like nginx try_files */
      }
    }
    if (target) {
      const body = fs.readFileSync(target);
      const immutable = p.startsWith('/assets/');
      res.writeHead(200, {
        'content-type': MIME[path.extname(target)] ?? 'application/octet-stream',
        'content-length': body.length,
        'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-store',
      });
      return void res.end(req.method === 'HEAD' ? undefined : body);
    }
    if (p.startsWith('/assets/')) return send(res, 404, 'text/plain; charset=utf-8', 'not found');
    let html;
    try {
      html = indexWithBanner(dist);
    } catch {
      return send(res, 503, 'text/plain; charset=utf-8', `No Customer build found in ${dist}. Run: pnpm local:stack --rebuild`);
    }
    res.writeHead(200, { 'content-type': MIME['.html'], 'content-length': Buffer.byteLength(html), 'cache-control': 'no-store' });
    res.end(req.method === 'HEAD' ? undefined : html);
  });
  // No WebSocket service: refuse upgrades instead of hanging.
  server.on('upgrade', (req, socket) => {
    socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
  });
  server.listen(port, HOST);
}

// ── local:fund ──────────────────────────────────────────────────────────────

const AMOUNT_RE = /^\d+(\.\d+)?$/;

async function cmdFund(rawArgs) {
  // Optional --ref <id>: reuse it when retrying after a lost reply, so the ledger's
  // idempotency key turns the repeat into a no-op instead of a second credit.
  const args = [...rawArgs];
  let ref;
  const refAt = args.indexOf('--ref');
  if (refAt !== -1) {
    ref = args[refAt + 1];
    args.splice(refAt, 2);
    if (!ref || !/^[A-Za-z0-9-]{4,64}$/.test(ref)) fail('--ref must be 4-64 letters, digits or dashes', 2);
  }
  const [who, assetRaw, amountStr] = args;
  if (!who || !assetRaw || !amountStr)
    fail(
      'usage: pnpm local:fund <email-or-userId|house> <ASSET> <decimal-amount> [--ref <id>]   e.g. pnpm local:fund me@example.com USDT 1000  (house = Convert counterparty inventory)',
      2,
    );
  const asset = assetRaw.toUpperCase();
  if (!/^[A-Z0-9]{2,12}$/.test(asset)) fail(`bad asset id: ${assetRaw}`, 2);
  if (!AMOUNT_RE.test(amountStr)) fail(`amount must be a plain decimal string like 1000 or 12.5 (got "${amountStr}")`, 2);

  // Guards: this only ever touches the local stack.
  if (!fs.existsSync(P.marker)) fail(`refusing: marker ${P.marker} not found. Start the stack first (pnpm local:stack).`);
  const marker = readJson(P.marker);
  if (marker.kind !== 'intafaced-local-test-stack') fail('refusing: marker file is not a local test stack marker');
  const secrets = readJson(P.secrets);
  const dbUrlParsed = new URL(dbUrl('svc_identity', secrets));
  if (
    dbUrlParsed.hostname !== '127.0.0.1' ||
    dbUrlParsed.port !== String(marker.ports?.postgres) ||
    String(marker.ports?.postgres) !== String(PORTS.postgres)
  ) {
    fail('refusing: database is not 127.0.0.1 on the local test stack port');
  }
  if (!pgRunning()) fail('refusing: the local stack Postgres is not running. Run: pnpm local:stack');
  if (!ownedAlive(readProcs().ledger)) fail('refusing: the local stack ledger is not running. Run: pnpm local:stack');

  // `who` = "house": stock the house market-maker pot, which Convert settles against (quotes are principal
  // inventory, not book trades: services/svc-trade/src/convert/settle.ts). Without BTC in that pot an accepted
  // Convert buy fails with "Insufficient BTC". LOCAL TEST inventory, not real money.
  const toHouse = who === 'house';
  let userId = null;
  let email = null;
  if (!toHouse) {
    const found = psql(secrets, `SELECT id::text || E'\\t' || email::text FROM identity.users WHERE email = :'who' OR id::text = :'who'`, {
      db: DB_NAME,
      user: 'svc_identity',
      password: secrets.pgService,
      vars: { who },
      tuples: true,
    })
      .trim()
      .split('\n')
      .filter(Boolean);
    if (found.length === 0) fail(`no user "${who}" in the local identity database. Register at ${CUSTOMER_ORIGIN} first.`);
    if (found.length > 1) fail(`"${who}" matches more than one user`);
    [userId, email] = found[0].split('\t');
  }

  const load = (pkg) => import(pathToFileURL(path.join(REPO, 'packages', pkg, 'dist', 'index.js')).href);
  let ledgerClient, contracts;
  try {
    [ledgerClient, contracts] = await Promise.all([load('ledger-client'), load('contracts')]);
  } catch (err) {
    fail(`packages are not built (${err.message}). Run: pnpm local:stack --rebuild`);
  }
  const { recipes, parseAmount, formatAmount } = ledgerClient;
  const railRef = ref
    ? `LOCAL-TEST-${ref}`
    : `LOCAL-TEST-${new Date().toISOString().replace(/[-:.]/g, '').replace('T', '-').slice(0, 19)}-${crypto.randomBytes(3).toString('hex')}`;
  let amount;
  try {
    amount = parseAmount(amountStr); // scaled bigint; throws on bad precision
  } catch (err) {
    fail(`ledger refused the amount "${amountStr}": ${err.message}`, 2);
  }
  let request;
  try {
    request = toHouse
      ? recipes.marketMakerSeedFund({ assetId: asset, amount, seedId: railRef, rail: FUND_RAIL })
      : recipes.deposit({ userId, assetId: asset, amount, rail: FUND_RAIL, railRef });
  } catch (err) {
    fail(`ledger refused the deposit: ${err.message}`, 2);
  }
  const wire = {
    idempotencyKey: request.idempotencyKey,
    module: request.module,
    reason: request.reason,
    meta: { ...request.meta, label: 'LOCAL TEST FUNDS — not real money' },
    entries: request.entries.map((e) => ({ account: e.account, direction: e.direction, amount: formatAmount(e.amount) })),
  };
  const ledgerUrl = urlOf('ledger');
  const call = async (route, body) => {
    const raw = JSON.stringify(body);
    const headers = {
      'content-type': 'application/json',
      ...contracts.serviceAuthHeadersForBody('local-test-fund', secrets.internal, raw),
    };
    const res = await fetch(`${ledgerUrl}/trpc/${route}`, { redirect: 'error', method: 'POST', headers, body: raw });
    const text = await res.text();
    if (!res.ok) fail(`ledger ${route} refused (${res.status}): ${text.slice(0, 400)}`);
    return JSON.parse(text);
  };
  const posted = await call('post', wire);
  const bal = await call(
    'balance',
    toHouse
      ? { ownerType: 'house', ownerId: 'market-maker', assetId: asset, kind: 'available' }
      : { ownerType: 'user', ownerId: userId, assetId: asset, kind: 'available' },
  );
  say(`TEST FUNDS credited through the real ledger (rail "${FUND_RAIL}", not real money)`);
  say(toHouse ? `  account   house market-maker inventory (Convert counterparty)` : `  user      ${email}  (${userId})`);
  say(`  credited  ${formatAmount(amount)} ${asset}`);
  say(`  railRef   ${railRef}   (to retry safely: --ref ${railRef.replace(/^LOCAL-TEST-/, '')})`);
  say(`  ledger tx ${posted.txId ?? JSON.stringify(posted)}`);
  say(`  available ${bal.amount} ${asset}   (read back from svc-ledger)`);
}

// ── Entry ───────────────────────────────────────────────────────────────────

const [cmd = 'start', ...rest] = process.argv.slice(2);
if (cmd === '__serve-customer')
  serveCustomer(Number(rest[0]) || PORTS.customer); // the port argument is for tests only
else if (cmd === 'start' && rest[0] === 'customer-dist')
  cmdCustomerDist(rest.slice(1)); // pnpm local:stack customer-dist <path>
else if (cmd === 'start') await cmdStart(rest);
else if (cmd === 'stop') await cmdStop(rest);
else if (cmd === 'plan') cmdPlan(rest);
else if (cmd === 'restart') await cmdRestart(rest);
else if (cmd === 'fund') await cmdFund(rest);
else if (cmd === 'customer-dist') cmdCustomerDist(rest);
else if (cmd === 'status') {
  const ok = await healthTable({ gateMarket: true });
  say('');
  say(`  ${describeCustomerDist()}`);
  process.exit(ok ? 0 : 1);
} else fail(`unknown command "${cmd}". Use: start | stop | status | fund | plan | restart | customer-dist`, 2);
