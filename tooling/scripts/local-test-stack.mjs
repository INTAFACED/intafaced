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
 *   -notify, -agents, -blueprint, -quant, -execution, -tax) · svc-ops (the outreach intake and CRM) ·
 *   svc-protocol (the Web3 rooms' read side; no chain node) ·
 *   svc-edge · a small Customer static server + reverse proxy on http://127.0.0.1:3210 · the same
 *   for the public invitation site (apps/invitation) on http://127.0.0.1:3220 · the founder console
 *   (apps/admin, a production Next build) on http://127.0.0.1:3100
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
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { marketStatus } from './local-test-market.mjs';
import { serveVideoStore } from './local-video-store.mjs';
import academy from './local-stack-services/academy.mjs';
import agents from './local-stack-services/agents.mjs';
import bank from './local-stack-services/bank.mjs';
import blueprint from './local-stack-services/blueprint.mjs';
import edge from './local-stack-services/edge.mjs';
import execution from './local-stack-services/execution.mjs';
import identity from './local-stack-services/identity.mjs';
import ledger from './local-stack-services/ledger.mjs';
import market from './local-stack-services/market.mjs';
import matching from './local-stack-services/matching.mjs';
import miningPool from './local-stack-services/mining-pool.mjs';
import notify from './local-stack-services/notify.mjs';
import ops from './local-stack-services/ops.mjs';
import p2p from './local-stack-services/p2p.mjs';
import pay from './local-stack-services/pay.mjs';
import protocol from './local-stack-services/protocol.mjs';
import quant from './local-stack-services/quant.mjs';
import support from './local-stack-services/support.mjs';
import tax from './local-stack-services/tax.mjs';
import token from './local-stack-services/token.mjs';
import trade from './local-stack-services/trade.mjs';
import {
  FOUNDER_VAULT_NAME,
  enrolledFounderPair,
  ensureFounderVaultDraft,
  enrolTestStackFounders,
  founderIdentityEnv,
  foundersEnrolled,
  planFounderIdentityRestart,
  readFounderPinStamp,
  writeFounderPinStamp,
} from './local-test-founders.mjs';
import { consoleTreasuryToken, makeContext } from './local-test-gates.mjs';
import {
  localStackState,
  localPgBin,
  assertActiveLocalStack,
  processRecordMatches,
  readProcessIdentity,
  postgresProcessMatches,
  localPgOsUser,
} from './local-test-state.mjs';

// ── Paths and ports ─────────────────────────────────────────────────────────

const SCRIPT = fileURLToPath(import.meta.url);
const REPO = path.resolve(path.dirname(SCRIPT), '..', '..');
const STATE = localStackState();
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
  invitationDist: path.join(REPO, 'apps', 'invitation', 'dist'),
  customerDistFile: path.join(STATE, 'customer-dist.json'),
  admin: path.join(REPO, 'apps', 'admin'),
  adminBuildId: path.join(REPO, 'apps', 'admin', '.next', 'BUILD_ID'),
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
  tax: 14517,
  'mining-pool': 14518,
  // The outreach intake behind the invitation site, and the founders' CRM.
  ops: 14519,
  // The Web3 rooms' read side (no chain node on this stack).
  protocol: 14520,
  // LOCAL TEST stand-in for the object store Academy signs video URLs for (local-video-store.mjs).
  'video-store': 14521,
  customer: 3210,
  invitation: 3220,
  admin: 3100,
};
const HOST = '127.0.0.1';
const CUSTOMER_ORIGIN = `http://${HOST}:${PORTS.customer}`;
// LOCAL TEST: WebAuthn (passkeys) cannot use an IP address as its relying-party ID, so the same Customer
// server is also reachable as localhost. Passkeys: open this one. Everything else works on either.
const CUSTOMER_LOCALHOST_ORIGIN = `http://localhost:${PORTS.customer}`;
const ADMIN_ORIGIN = `http://${HOST}:${PORTS.admin}`;
const INVITATION_ORIGIN = `http://${HOST}:${PORTS.invitation}`;
const DB_NAME = 'intafaced_local_test';
const DB_ADMIN = 'local_test_admin';
// One Postgres schema + one login role (svc_<schema>) per service that owns tables.
// svc-execution owns no tables (it keeps a file journal).
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
  'quant',
  'tax',
  'mining_pool',
  'ops',
  'protocol',
];
// A schema whose service is named differently (svc-mining-pool owns schema mining_pool).
const SCHEMA_SERVICE = { mining_pool: 'mining-pool' };
const serviceOfSchema = (s) => SCHEMA_SERVICE[s] ?? s;
const STREAM_PREFIX = 'LOCAL_TEST';
const BANNER_TEXT = 'LOCAL TEST STACK — TEST PRICES · TEST FUNDS · not real money';
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

const PG_BIN = localPgBin();
const PG_OS_USER = localPgOsUser();
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
  return { PATH: PNPM_PATH, HOME: os.homedir(), LANG: 'en_US.UTF-8', TMPDIR: path.join(STATE, 'tmp'), LOCAL_STACK_STATE: STATE };
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
  'identityFlowSubject', // identity's key for sign-up and recovery flows (address identifier and code hash)
  'notifyStatusLink', // notify's key for the signed links in status subscription mail
  'academyVideoStore', // the TEST video store's signing key, shared with academy (local-video-store.mjs)
];

function loadOrCreateSecrets() {
  // As root, the folders the stack creates above STATE stay traversable for the database's OS user (preparePgPaths).
  if (PG_OS_USER) fs.mkdirSync(path.dirname(STATE), { recursive: true, mode: 0o711 });
  fs.mkdirSync(STATE, { recursive: true, mode: 0o700 });
  fs.chmodSync(STATE, PG_OS_USER ? 0o711 : 0o700);
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
  // The founder console wants exactly 32 bytes as canonical base64url (apps/admin/src/lib/founder-session.ts).
  if (!/^[A-Za-z0-9_-]{43}$/.test(s.adminSession ?? '')) {
    s.adminSession = crypto.randomBytes(32).toString('base64url');
    changed = true;
  }
  if (changed) writePrivate(P.secrets, JSON.stringify(s, null, 2));
  return s;
}

const dbUrl = (role, secrets) => `postgres://${role}:${secrets.pgService}@${HOST}:${PORTS.postgres}/${DB_NAME}`;
const urlOf = (name) => `http://${HOST}:${PORTS[name]}`;
/** LOCAL TEST maintenance ladder for the TEST perpetual (TRADE_FUTURES_LADDER_POLICY). Same numbers as
 * services/svc-trade/src/futures/ladder-policy.test-harness.ts: coarse on purpose, never an owner D3 table. */
export const TEST_FUTURES_LADDER_POLICY = Object.freeze({
  tiers: [
    { uptoDepthBps: 500, maintenanceBps: 50 },
    { uptoDepthBps: 2_000, maintenanceBps: 100 },
    { uptoDepthBps: 5_000, maintenanceBps: 250 },
    { uptoDepthBps: Number.MAX_SAFE_INTEGER, maintenanceBps: 500 },
  ],
  marginCallBps: 12_000,
  targetBps: 15_000,
  maxTrancheBps: 2_500,
});

const PLACEHOLDER_OPERATOR_IDS = '00000000-0000-4000-8000-0000000000a1,00000000-0000-4000-8000-0000000000b2';

/**
 * User ids of the two LOCAL TEST operators and, once enrolled, the two local founders (comma-separated), or '' while
 * none exist yet. The founders approve founder-only actions such as opening a book, so matching must seat them too.
 */
function localOperatorIds() {
  let ops = {};
  try {
    ops = JSON.parse(fs.readFileSync(path.join(STATE, 'operators.json'), 'utf8')).operators ?? {};
  } catch {
    /* no operators yet */
  }
  let vault = null;
  try {
    vault = readJson(path.join(STATE, FOUNDER_VAULT_NAME));
  } catch {
    /* no founder vault yet */
  }
  const founders = enrolledFounderPair(vault) ?? [];
  const ids = [...['a', 'b'].map((k) => ops[k]?.userId), ...founders.map((f) => f.userId)];
  return [...new Set(ids.filter((id) => typeof id === 'string' && /^[0-9a-zA-Z-]{8,64}$/.test(id)))].join(',');
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

/** Verify each record independently, including while other stack services are down. */
function ownedAlive(rec) {
  return processRecordMatches(rec, readProcessIdentity(rec?.pid));
}

function startProc(name, argv, env, cwd, extra = {}) {
  const logPath = path.join(P.logs, `${name}.log`);
  const fd = fs.openSync(logPath, 'a', 0o600);
  const child = spawn(argv[0], argv.slice(1), { cwd, env, detached: true, stdio: ['ignore', fd, fd] });
  child.unref();
  fs.closeSync(fd);
  const procs = readProcs();
  procs[name] = { pid: child.pid, argv, startedAt: new Date().toISOString(), ...extra };
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
  const [pid, directory, started] = fs.readFileSync(pidFile, 'utf8').split('\n');
  return directory === P.pgdata && postgresProcessMatches(P.pgdata, Number(started) * 1000, readProcessIdentity(Number(pid)));
}

/** A command as the caller or, when the caller is root, as PG_OS_USER (initdb and postgres refuse root). */
function asPgUser(cmd, args, options) {
  // runuser lives in /usr/sbin or /sbin, which baseEnv()'s PATH leaves out on purpose.
  const runuser = PG_OS_USER && ['/usr/sbin/runuser', '/sbin/runuser'].find((f) => fs.existsSync(f));
  if (PG_OS_USER && !runuser) fail(`running as root needs runuser to start Postgres as ${PG_OS_USER}`);
  const r = PG_OS_USER ? spawnSync(runuser, ['-u', PG_OS_USER, '--', cmd, ...args], options) : spawnSync(cmd, args, options);
  if (r.error) fail(`${path.basename(cmd)} could not start: ${r.error.message}`);
  return r;
}
const pgServerTool = (tool, args, options) => asPgUser(`${PG_BIN}/${tool}`, args, options);

/**
 * As root, hand the database's own paths to PG_OS_USER: its data directory, socket directory and log. The state
 * folders above them open for traversal only (0711), so secrets.json and the other 0600 files stay root's.
 */
function preparePgPaths(extra = []) {
  if (!PG_OS_USER) return;
  const ids = (flag) => Number(spawnSync('id', [flag, PG_OS_USER], { encoding: 'utf8' }).stdout.trim());
  const uid = ids('-u');
  const gid = ids('-g');
  if (!Number.isInteger(uid) || uid <= 0)
    fail(`running as root, but there is no OS user ${PG_OS_USER} to run Postgres as (set LOCAL_STACK_PG_USER)`);
  for (const d of [STATE, P.data, P.logs]) fs.chmodSync(d, 0o711);
  fs.mkdirSync(P.pgdata, { recursive: true, mode: 0o700 });
  const log = path.join(P.logs, 'postgres.log');
  if (!fs.existsSync(log)) fs.writeFileSync(log, '', { mode: 0o600 });
  for (const f of [P.pgdata, P.run, log, ...extra]) fs.chownSync(f, uid, gid);
  if (asPgUser('/usr/bin/test', ['-w', P.pgdata], {}).status !== 0)
    fail(
      `the OS user ${PG_OS_USER} cannot reach ${P.pgdata}; set LOCAL_STACK_STATE to a folder whose parents it can enter, for example /var/lib/intafaced/local-test-stack`,
    );
}

function ensurePostgres(secrets) {
  if (!fs.existsSync(path.join(P.pgdata, 'PG_VERSION'))) {
    say('  postgres: first run, initialising a dedicated data directory');
    const pwfile = path.join(STATE, 'tmp', 'pg-admin.pw');
    writePrivate(pwfile, `${secrets.pgAdmin}\n`);
    if (PG_OS_USER) fs.chmodSync(path.join(STATE, 'tmp'), 0o711);
    preparePgPaths([pwfile]);
    const r = pgServerTool(
      'initdb',
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
    preparePgPaths();
    const r = pgServerTool(
      'pg_ctl',
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
  if (process.env.LOCAL_STACK_NATS_BIN) {
    // Linux/CI: a nats-server already on the box (CI installs a pinned release).
    if (!fs.existsSync(P.nats) || sha256File(P.nats) !== sha256File(process.env.LOCAL_STACK_NATS_BIN)) {
      fs.copyFileSync(process.env.LOCAL_STACK_NATS_BIN, P.nats);
      fs.chmodSync(P.nats, 0o755);
    }
    writePrivate(
      P.natsVerified,
      JSON.stringify({ binarySHA256: sha256File(P.nats), copiedFrom: process.env.LOCAL_STACK_NATS_BIN }, null, 2),
    );
    return;
  }
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
  'svc-tax',
  'svc-mining-pool',
  'svc-ops',
  'svc-protocol',
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
function sourceUnchangedSince(oldHead, head, paths = SOURCE_PATHS) {
  if (!oldHead) return false;
  if (oldHead === head) return true;
  const r = spawnSync('git', ['diff', '--quiet', oldHead, head, '--', ...paths], { cwd: REPO });
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

// The founder console has its own stamp, so a console-only change never rebuilds the services and the reverse.
const ADMIN_SOURCE_PATHS = ['apps/admin', 'packages', 'pnpm-lock.yaml'];

function ensureAdminBuilt(rebuild) {
  const head = gitHead();
  const stamp = fs.existsSync(P.buildStamp) ? readJson(P.buildStamp) : {};
  if (!rebuild && fs.existsSync(P.adminBuildId) && sourceUnchangedSince(stamp.adminHead, head, ADMIN_SOURCE_PATHS)) return;
  say('  build: founder console (apps/admin)…');
  runPnpm(['--filter', '@intafaced/admin...', 'build'], 'build-admin');
  const now = fs.existsSync(P.buildStamp) ? readJson(P.buildStamp) : {};
  writePrivate(P.buildStamp, JSON.stringify({ ...now, adminHead: head }, null, 2));
}

const INVITATION_SOURCE_PATHS = ['apps/invitation', 'packages', 'pnpm-lock.yaml'];

/** The invitation site is rebuilt when its own source, a package or the lockfile changed since its last build, or on --rebuild. */
function ensureInvitationBuilt(rebuild) {
  const head = gitHead();
  const stamp = fs.existsSync(P.buildStamp) ? readJson(P.buildStamp) : {};
  const built = fs.existsSync(path.join(P.invitationDist, 'index.html'));
  if (!rebuild && built && sourceUnchangedSince(stamp.invitationHead, head, INVITATION_SOURCE_PATHS)) return;
  say('  build: invitation site (apps/invitation)…');
  runPnpm(['--filter', '@intafaced/invitation...', 'build'], 'build-invitation');
  const now = fs.existsSync(P.buildStamp) ? readJson(P.buildStamp) : {};
  writePrivate(P.buildStamp, JSON.stringify({ ...now, invitationHead: head }, null, 2));
}

function ensureBuilt(rebuild) {
  const act = activeCustomerDist();
  if (act.error) fail(`customer folder override is unusable: ${act.error}\n  Fix it, or run: pnpm local:stack customer-dist --clear`);
  const { head, stamp, override, missing, backend } = buildPlan(rebuild, act);
  if (override) say(`  build: customer app is ${act.dir} (override); not building it`);
  if (backend === 'none') {
    say('  build: up to date (use --rebuild to force)');
    if (stamp.head !== head) writePrivate(P.buildStamp, JSON.stringify({ ...stamp, head }, null, 2));
    ensureAdminBuilt(rebuild);
    return;
  }
  if (backend === 'missing') {
    // Source is the same as the last full build; only some services have never been built.
    // Build just those so running services keep their files untouched.
    say(`  build: ${missing.length} service(s) not built yet (${missing.map((m) => m.replace('svc-', '')).join(', ')})…`);
    runPnpm([...missing.flatMap((s) => ['--filter', `@intafaced/${s}...`]), 'build'], 'build-backend-missing');
    writePrivate(P.buildStamp, JSON.stringify({ ...stamp, head, builtAt: stamp.builtAt ?? new Date().toISOString() }, null, 2));
    ensureAdminBuilt(rebuild);
    return;
  }
  say('  build: backend packages and services (a few minutes on a cold tree)…');
  runPnpm([...BACKEND_PKGS.flatMap((s) => ['--filter', `@intafaced/${s}...`]), 'build'], 'build-backend');
  if (!override) {
    say('  build: customer app…');
    runPnpm(['--filter', '@intafaced/customer...', 'build'], 'build-customer');
  }
  writePrivate(
    P.buildStamp,
    JSON.stringify({ head, builtAt: new Date().toISOString(), customerBuilt: !override, adminHead: stamp.adminHead }, null, 2),
  );
  ensureAdminBuilt(rebuild);
}

function migrate(secrets, schemas = SCHEMAS) {
  for (const s of schemas) {
    runPnpm(['--filter', `@intafaced/svc-${serviceOfSchema(s)}`, 'db:migrate'], `migrate-${s}`, {
      DATABASE_URL: dbUrl(`svc_${s}`, secrets),
    });
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
    // S2S_AUTH_MODE stays unset here: svc-ledger then accepts this shared secret
    // and counts each post as unbound. See services/svc-ledger/CALLER-BINDING.md.
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
  TAX_URL: 'tax',
  MINING_POOL_URL: 'mining-pool',
  OPS_URL: 'ops',
  PROTOCOL_URL: 'protocol',
};

/** Edge upstreams that are intentionally not started, each with the reason. The Customer app calls none of them except where noted. */
const EDGE_ABSENT = {
  DEX_URL: 'On-chain DEX; needs chain RPC. The Web3 rooms show it as a service that did not answer.',
  INDEXER_URL: 'Chain indexer; needs chain RPC. The Web3 rooms show it as a service that did not answer.',
  CONNECT_URL: 'Operator data-lake door; not a customer door.',
};

/**
 * The services the stack starts, in start order. Each service's env lives in its own file,
 * tooling/scripts/local-stack-services/<name>.mjs, so a slice changes only its service's file.
 * Every file gets the same wiring helpers below; a new service adds its file and one line here.
 */
const SERVICES = [
  ledger,
  identity,
  matching,
  trade,
  pay,
  bank,
  // ── Services behind the Customer's More door, Notifications, P2P and Trade tools ──
  // Same wiring as above: commonEnv() (edge principal, internal service secret, screening
  // pass-through), own schema + role, loopback only. Anything that needs a real outside
  // provider is left unconnected on purpose; each limit is listed in docs/LOCAL-TEST-STACK.md.
  token,
  p2p,
  academy,
  support,
  ops,
  market,
  notify,
  agents,
  blueprint,
  quant,
  execution,
  tax,
  miningPool,
  protocol,
  edge,
];

function serviceDefs(secrets) {
  const ctx = {
    c: (name, port) => commonEnv(secrets, name, port),
    secrets,
    dbUrl,
    urlOf,
    PORTS,
    STATE,
    P,
    UNUSED,
    CUSTOMER_ORIGIN,
    CUSTOMER_LOCALHOST_ORIGIN,
    INVITATION_ORIGIN,
    identityFounderEnv,
    opsOutreachEnv,
    localOperatorIds,
    PLACEHOLDER_OPERATOR_IDS,
    TEST_FUTURES_LADDER_POLICY,
    EDGE_UPSTREAMS,
    EDGE_ABSENT,
  };
  return SERVICES.map((service) => service(ctx));
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

/** Invite hashes and, once enrolled, the two local-test founder ids. A bad vault contributes nothing. */
function identityFounderEnv() {
  const file = path.join(STATE, 'founders.json');
  if (!fs.existsSync(file)) return {};
  let vault;
  try {
    vault = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    fail(`local test founder vault is unreadable: ${err instanceof Error ? err.message : err}`);
  }
  return founderIdentityEnv(vault);
}

/**
 * The outreach intake's configuration for this stack: the local test founder pair (absent until it is enrolled, so the
 * intake refuses ops.crm.configuration_unverified until then) and LOCAL TEST review settings, never owner decisions.
 */
function opsOutreachEnv() {
  const pinned = identityFounderEnv();
  const founders = [pinned.IDENTITY_FOUNDER_NITRO_USER_ID, pinned.IDENTITY_FOUNDER_PHANTOM_USER_ID];
  if (!founders.every(Boolean)) return {};
  return {
    OPS_OUTREACH_CONFIG: JSON.stringify({
      founders,
      initialOwnerUserId: founders[0],
      // LOCAL TEST: a one-day continuation, Monday to Friday review at 09:00 Europe/London.
      continuationTtlSeconds: 86_400,
      timeZone: 'Europe/London',
      businessWeekdays: [1, 2, 3, 4, 5],
      reviewHour: 9,
      reviewMinute: 0,
    }),
  };
}

async function startNodeService(def) {
  const env = def.env();
  const port = Number(env.HTTP_PORT);
  const procs = readProcs();
  const url = `http://${HOST}:${port}/health`;
  if (ownedAlive(procs[def.name]) && (await httpGet(url, 2000)).status === 200) return;
  if (await portOpen(port)) fail(`port ${port} (${def.name}) is in use by a process this script did not start`);
  for (const d of ['matching', 'execution']) fs.mkdirSync(path.join(P.data, d), { recursive: true, mode: 0o700 });
  if (def.name === 'identity') writeFounderPinStamp(STATE, env);
  const entry = path.join(REPO, 'services', `svc-${def.name}`, 'dist', def.entry ?? 'index.js');
  const pid = startProc(def.name, [process.execPath, entry], env, path.join(REPO, 'services', `svc-${def.name}`));
  if (def.name === 'ops') {
    // Which founder pair svc-ops read at start, so a later start can tell when the pair changed.
    const procs = readProcs();
    procs.ops.outreachConfig = env.OPS_OUTREACH_CONFIG ?? null;
    writeProcs(procs);
  }
  await waitHealthy(def.name, url, pid);
}

async function restartIdentity() {
  say('  identity: restarting so the local test founder pair is the configured pair');
  await stopProc('identity', readProcs().identity);
  const def = serviceDefs(readJson(P.secrets)).find((d) => d.name === 'identity');
  await startNodeService(def);
}

/**
 * Seed local_test_founder_a and local_test_founder_b on this stack's identity and
 * pin IDENTITY_FOUNDER_* to those two ids. No-op when identity or edge is not up.
 */
async function ensureLocalTestFounders() {
  const identityUp = (await httpGet(`${urlOf('identity')}/health`, 2000)).status === 200;
  const edgeUp = (await httpGet(`${urlOf('edge')}/health`, 2000)).status === 200;
  if (!identityUp || !edgeUp) {
    say('  founders: identity or edge is not up, so the local test founder pair was not enrolled on this run');
    return;
  }
  const marker = readJson(P.marker);
  const edgeUrl = urlOf('edge');
  const { vaultPath } = ensureFounderVaultDraft({ stateDir: STATE, marker, edgeUrl, log: say });
  const readVault = () => JSON.parse(fs.readFileSync(vaultPath, 'utf8'));
  let vault = readVault();
  const plan = planFounderIdentityRestart({ enrolled: foundersEnrolled(vault), stamp: readFounderPinStamp(STATE), vault });
  if (plan.restartBeforeEnrol) await restartIdentity();
  if (!foundersEnrolled(vault)) {
    say('  founders: enrolling local_test_founder_a and local_test_founder_b on this stack');
    await enrolTestStackFounders({ stateDir: STATE, marker, edgeUrl, log: say });
    vault = readVault();
    await restartIdentity();
  } else if (plan.restartToPin) {
    await restartIdentity();
  }
  if (!foundersEnrolled(readVault())) fail('local test founder pair did not enrol');
}

/** svc-ops reads the founder pair at start. When it started before the pair was enrolled, or with another pair, restart it. */
async function pinOpsFounders() {
  const procs = readProcs();
  const wanted = opsOutreachEnv().OPS_OUTREACH_CONFIG;
  if (!ownedAlive(procs.ops) || !wanted || procs.ops.outreachConfig === wanted) return;
  say('  ops: restarting so the outreach intake knows the local test founder pair');
  await stopProc('ops', procs.ops);
  await startNodeService(serviceDefs(readJson(P.secrets)).find((d) => d.name === 'ops'));
}

async function startCustomer() {
  const procs = readProcs();
  const url = `${CUSTOMER_ORIGIN}/`;
  if (ownedAlive(procs.customer) && (await httpGet(url, 2000)).status === 200) return;
  if (await portOpen(PORTS.customer)) fail(`port ${PORTS.customer} (customer) is in use by a process this script did not start`);
  const pid = startProc('customer', [process.execPath, SCRIPT, '__serve-customer'], baseEnv(), REPO);
  await waitHealthy('customer', url, pid, 20_000);
}

/** The LOCAL TEST video store (local-video-store.mjs): signed, expiring reads of the TEST video Academy plays. */
async function startVideoStore(secrets) {
  const procs = readProcs();
  const url = `${urlOf('video-store')}/health`;
  if (ownedAlive(procs['video-store']) && (await httpGet(url, 2000)).status === 200) return;
  if (await portOpen(PORTS['video-store']))
    fail(`port ${PORTS['video-store']} (video-store) is in use by a process this script did not start`);
  const env = { ...baseEnv(), LOCAL_VIDEO_STORE_SECRET: secrets.academyVideoStore };
  const pid = startProc('video-store', [process.execPath, SCRIPT, '__serve-video-store'], env, REPO);
  await waitHealthy('video-store', url, pid, 20_000);
}

/** The public invitation site (apps/invitation), served like the Customer app so its intake reaches svc-ops through Edge. */
async function startInvitation() {
  const procs = readProcs();
  const url = `${INVITATION_ORIGIN}/`;
  if (ownedAlive(procs.invitation) && (await httpGet(url, 2000)).status === 200) return;
  if (!fs.existsSync(path.join(P.invitationDist, 'index.html'))) fail('invitation build missing; run with --rebuild');
  if (await portOpen(PORTS.invitation)) fail(`port ${PORTS.invitation} (invitation) is in use by a process this script did not start`);
  const pid = startProc('invitation', [process.execPath, SCRIPT, '__serve-invitation'], baseEnv(), REPO);
  await waitHealthy('invitation', url, pid, 20_000);
}

/** The founder console's env: the four settings apps/admin needs to sign founders in on a local http origin. */
function adminEnv(secrets) {
  return {
    ...baseEnv(),
    NODE_ENV: 'production',
    APP_ENV: 'dev', // local http origin is accepted only for dev/test (founder-session.ts); never prod posture
    EDGE_URL: urlOf('edge'),
    ADMIN_ORIGIN,
    ADMIN_SESSION_SECRET: secrets.adminSession,
  };
}

/** How long the console's LOCAL TEST treasury token lives. A start with less than an hour left restarts the console. */
const TREASURY_TTL_SECONDS = 24 * 60 * 60;
const TREASURY_RENEW_MS = 60 * 60 * 1000;

/**
 * The console's treasury transport (ADMIN_TREASURY_TOKEN), minted on founder a's own second-factor session by
 * local-test-gates.mjs and held only in the console's environment. Without it the console shows define, change and run
 * parked, so a mint that fails is said out loud and leaves them parked rather than stopping the stack.
 */
async function consoleTreasuryEnv() {
  try {
    const minted = await consoleTreasuryToken(await makeContext({ log: () => {} }), { ttlSeconds: TREASURY_TTL_SECONDS });
    if (minted) return { env: { ADMIN_TREASURY_TOKEN: minted.token }, expiresAt: minted.expiresAt.toISOString() };
    say('  admin: the founder pair is not enrolled, so the console keeps its treasury doors parked');
  } catch (err) {
    say(`  admin: no LOCAL TEST treasury token (${err instanceof Error ? err.message : String(err)}); treasury doors stay parked`);
  }
  return { env: {}, expiresAt: null };
}

/** Until when this console's treasury token holds, or null when it holds none (or has run out). */
function treasuryHeldUntil(rec) {
  const until = typeof rec?.treasuryExpiresAt === 'string' ? Date.parse(rec.treasuryExpiresAt) : NaN;
  return Number.isFinite(until) && until > Date.now() ? until : null;
}

async function startAdmin(secrets) {
  const procs = readProcs();
  const url = `${ADMIN_ORIGIN}/login`;
  let treasury = null;
  if (ownedAlive(procs.admin)) {
    const until = treasuryHeldUntil(procs.admin);
    // Ours but not answering yet (a first request compiles nothing, but prepare() takes a few seconds): wait for it.
    if (until !== null && until - Date.now() >= TREASURY_RENEW_MS) return waitHealthy('admin', url, procs.admin.pid, 60_000);
    // No token, or under an hour left: mint first, and keep the running console when the mint fails.
    treasury = await consoleTreasuryEnv();
    if (!treasury.expiresAt) return waitHealthy('admin', url, procs.admin.pid, 60_000);
    say('  admin: restarting so the console holds a fresh LOCAL TEST treasury token');
    await stopProc('admin', procs.admin);
  }
  if (await portOpen(PORTS.admin)) fail(`port ${PORTS.admin} (admin) is in use by a process this script did not start`);
  if (!fs.existsSync(P.adminBuildId)) fail('founder console build missing; run with --rebuild');
  treasury ??= await consoleTreasuryEnv();
  const pid = startProc('admin', [process.execPath, SCRIPT, '__serve-admin'], { ...adminEnv(secrets), ...treasury.env }, P.admin, {
    treasuryExpiresAt: treasury.expiresAt,
  });
  await waitHealthy('admin', url, pid, 60_000);
}

/**
 * The founder console's production build, served in this script's own process so the recorded command line stays
 * what was started (the `next` CLI renames its process, which ownership checks would then refuse to stop).
 */
async function serveAdmin(port = PORTS.admin) {
  const req = createRequire(path.join(P.admin, 'package.json'));
  const next = (await import(pathToFileURL(req.resolve('next')).href)).default;
  const app = next({ dev: false, dir: P.admin, hostname: HOST, port });
  const exit = (what, err) => {
    console.error(`admin: ${what}: ${err?.message ?? err}`);
    process.exit(1);
  };
  await app.prepare().catch((err) => exit('the build in apps/admin/.next could not be loaded (pnpm local:stack --rebuild)', err));
  const handle = app.getRequestHandler();
  const server = http.createServer((rq, rs) => handle(rq, rs));
  server.on('error', (err) => exit(`cannot listen on ${HOST}:${port}`, err));
  server.listen(port, HOST);
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
    rows.push([`svc-${n}`, PORTS[n], procs[n]?.pid ?? '-', r.status === 200 ? 'ok' : `DOWN (${r.status})`]);
  }
  const store = await httpGet(`${urlOf('video-store')}/health`, 2500);
  rows.push([
    'video-store',
    PORTS['video-store'],
    procs['video-store']?.pid ?? '-',
    store.status === 200 ? 'ok (TEST)' : `DOWN (${store.status})`,
  ]);
  const cust = await httpGet(`${CUSTOMER_ORIGIN}/`, 2500);
  rows.push([
    'customer',
    PORTS.customer,
    procs.customer?.pid ?? '-',
    cust.status === 200 && cust.text.includes(BANNER_TEXT) ? 'ok (banner on)' : `DOWN (${cust.status})`,
  ]);
  const invitation = await httpGet(`${INVITATION_ORIGIN}/`, 2500);
  rows.push([
    'invitation',
    PORTS.invitation,
    procs.invitation?.pid ?? '-',
    invitation.status === 200 && invitation.text.includes(BANNER_TEXT) ? 'ok (banner on)' : `DOWN (${invitation.status})`,
  ]);
  const admin = await httpGet(`${ADMIN_ORIGIN}/login`, 4000);
  rows.push(['admin', PORTS.admin, procs.admin?.pid ?? '-', admin.status === 200 ? 'ok' : `DOWN (${admin.status})`]);
  // The test market maker is not a service of the stack, but its prices freeze silently when it dies (it did, twice).
  const mk = marketStatus();
  rows.push(['market-maker', '-', mk.pid ?? '-', mk.text]);
  const w = [17, 12, 8];
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
  const known = [...serviceNames(), 'video-store', 'customer', 'invitation', 'admin'];
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
  ensureInvitationBuilt(flags.includes('--rebuild'));
  ensurePostgres(secrets);
  const wanted = serviceDefs(secrets).filter((d) => !only || only.includes(d.name));
  // Migrate only what is about to start: a service that is already running was migrated when it started.
  const toStart = wanted.filter((d) => !ownedAlive(readProcs()[d.name]));
  migrate(
    secrets,
    SCHEMAS.filter((s) => toStart.some((d) => d.name === serviceOfSchema(s))),
  );
  await startNats();
  ensureStreams();
  // Vault before identity starts, so the first boot already has the invite hashes.
  // Enrolment itself waits until edge is up (below).
  try {
    ensureFounderVaultDraft({ stateDir: STATE, marker: readJson(P.marker), edgeUrl: urlOf('edge'), log: say });
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
  // Academy's env points at the video store, so `--only academy` starts it too.
  if (!only || only.includes('video-store') || only.includes('academy')) await startVideoStore(secrets);
  for (const def of wanted) await startNodeService(def);
  try {
    await ensureLocalTestFounders();
    if (!only || only.includes('ops')) await pinOpsFounders();
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
  if (activeCustomerDist().error || !fs.existsSync(path.join(activeCustomerDist().dir, 'index.html')))
    fail('customer build missing; run with --rebuild');
  if (!only || only.includes('customer')) await startCustomer();
  if (!only || only.includes('invitation')) await startInvitation();
  if (!only || only.includes('admin')) await startAdmin(secrets);
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
  const pinned = identityFounderEnv();
  say(
    pinned.IDENTITY_FOUNDER_NITRO_USER_ID && pinned.IDENTITY_FOUNDER_PHANTOM_USER_ID
      ? '  Founders: local_test_founder_a and local_test_founder_b are the identity pair on this stack'
      : '  Founders: pair not pinned (identity and edge must both be up)',
  );
  say(`  Open: ${CUSTOMER_ORIGIN}   (register, sign in, then: pnpm local:fund <email> USDT 1000)`);
  say(`  Invitation site: ${INVITATION_ORIGIN}   (the public join and partner enquiry forms)`);
  say(`  Founder console: ${ADMIN_ORIGIN}   (local_test_founder_a / _b; credentials in ${FOUNDER_VAULT_NAME})`);
  const consoleRec = readProcs().admin;
  const treasuryUntil = ownedAlive(consoleRec) ? treasuryHeldUntil(consoleRec) : null;
  say(
    treasuryUntil !== null
      ? `  Console treasury doors: LOCAL TEST token on local_test_founder_a's session until ${new Date(treasuryUntil).toISOString()}`
      : '  Console treasury doors: parked (the console holds no LOCAL TEST treasury token)',
  );
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
    env: { PATH: process.env.PATH, HOME: os.homedir(), LOCAL_STACK_STATE: STATE },
    encoding: 'utf8',
  });
  const text = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim().split('\n').filter(Boolean).join(' | ');
  say(`  market maker: ${text || `ensure exited ${r.status}`}`);
}

async function cmdStop(names = []) {
  const procs = readProcs();
  const order = ['admin', 'invitation', 'customer', ...serviceNames().reverse(), 'video-store', 'nats'];
  const only = names.length ? names : null;
  let bad = false;
  for (const name of order) {
    if (only && !only.includes(name)) continue;
    const rec = procs[name];
    if (!rec) continue;
    if (rec.pid && psCommand(rec.pid) && !ownedAlive(rec)) {
      say(`  ${name}: pid ${rec.pid} no longer matches the recorded command line or start time, refusing to signal it`);
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
    const r = pgServerTool('pg_ctl', ['-D', P.pgdata, '-m', 'fast', '-w', 'stop'], { encoding: 'utf8', env: baseEnv() });
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
    schema: SCHEMAS.find((s) => serviceOfSchema(s) === d.name) ?? null,
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
    return say(
      JSON.stringify(
        { host: HOST, stateDir: STATE, services, edgeUpstreams, backendPackages: BACKEND_PKGS, schemas: SCHEMAS, customer },
        null,
        2,
      ),
    );
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
  const known = [...serviceNames(), 'video-store', 'customer', 'invitation', 'admin'];
  const bad = names.filter((n) => !known.includes(n));
  if (names.length === 0 || bad.length)
    fail(`restart needs service names from: ${known.join(', ')}${bad.length ? ` (unknown: ${bad.join(', ')})` : ''}`, 2);
  await cmdStop(names);
  await cmdStart([]);
}

// The local customer server does not start svc-ws and does not read
// CUSTOMER_WS_URL into a proxy. The typed refusal names that key. Wiring the
// upstream is the local-stack owner's job; this default stays a refusal.
const WS_UPSTREAM_REFUSAL = {
  code: 'ws.upstream_unset',
  key: 'CUSTOMER_WS_URL',
  message: 'CUSTOMER_WS_URL is not wired. The local test stack has no WebSocket upstream and does not start svc-ws.',
};

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

/** The two static sites this stack serves, each with `/api/*` passed to Edge. The invitation site has no folder override. */
const SITES = {
  customer: { label: 'Customer', origin: CUSTOMER_ORIGIN, dist: () => activeCustomerDist() },
  invitation: { label: 'invitation', origin: INVITATION_ORIGIN, dist: () => ({ dir: P.invitationDist, error: null }) },
};

function serveCustomer(port = PORTS.customer, site = SITES.customer) {
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
    const url = new URL(req.url, site.origin);
    const p = url.pathname;

    if (p === '/api' || p === '/ws') return send(res, 404, 'text/plain; charset=utf-8', 'not found');
    if (p.startsWith('/ws/')) {
      return send(res, 503, 'application/json', JSON.stringify(WS_UPSTREAM_REFUSAL));
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
    const active = site.dist();
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
      return send(res, 503, 'text/plain; charset=utf-8', `No ${site.label} build found in ${dist}. Run: pnpm local:stack --rebuild`);
    }
    res.writeHead(200, { 'content-type': MIME['.html'], 'content-length': Buffer.byteLength(html), 'cache-control': 'no-store' });
    res.end(req.method === 'HEAD' ? undefined : html);
  });
  // No WebSocket upstream is published. The refusal names CUSTOMER_WS_URL and
  // does not start svc-ws or proxy when that key is set.
  server.on('upgrade', (req, socket) => {
    const body = JSON.stringify(WS_UPSTREAM_REFUSAL);
    socket.end(
      `HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
    );
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
  assertActiveLocalStack({ stateDir: STATE, services: ['ledger'] });

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

/** Env each local service would get. Starts nothing. Placeholder secrets only. */
export function localTestServiceEnvs(secrets = PLAN_SECRETS) {
  return serviceDefs(secrets).map((service) => ({ name: service.name, env: service.env() }));
}

function runningAsCli() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return fs.realpathSync(entry) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

// ── Entry ───────────────────────────────────────────────────────────────────

if (runningAsCli()) await runCli();

async function runCli() {
  const [cmd = 'start', ...rest] = process.argv.slice(2);
  if (cmd === '__serve-customer')
    serveCustomer(Number(rest[0]) || PORTS.customer); // the port argument is for tests only
  else if (cmd === '__serve-invitation') serveCustomer(PORTS.invitation, SITES.invitation);
  else if (cmd === '__serve-admin') await serveAdmin();
  else if (cmd === '__serve-video-store')
    serveVideoStore({
      host: HOST,
      port: PORTS['video-store'],
      secretKey: process.env.LOCAL_VIDEO_STORE_SECRET ?? '',
      uploadsDir: path.join(STATE, 'video-store-uploads'),
    });
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
}
