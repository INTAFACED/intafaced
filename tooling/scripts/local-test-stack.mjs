#!/usr/bin/env node
/**
 * LOCAL TEST STACK — one command, no Docker.
 *
 *   pnpm local:stack                      start (idempotent) and print a health table
 *   pnpm local:stack:stop                 stop only the processes this script started
 *   pnpm local:fund <email|userId> <ASSET> <amount>
 *                                         credit labelled TEST funds through the real ledger
 *   node tooling/scripts/local-test-stack.mjs chain-deposit <address> <ASSET> <amount> <confirmations> --tx <label>
 *                                         deliver a signed TEST chain transfer to a deposit address svc-pay issued
 *   node tooling/scripts/local-test-stack.mjs chain-reorg <address> --tx <label>
 *                                         the TEST chain takes that transfer back (a reorg), as the watcher would report it
 *   node tooling/scripts/local-test-stack.mjs bank-transfer <reference> <CCY> <amount> --tx <label> [--payer <name>]
 *                                         the TEST bank reports a pushed transfer quoting a hosted checkout's reference
 *   node tooling/scripts/local-test-stack.mjs status
 *   node tooling/scripts/local-test-stack.mjs age-addresses <email> <hours>
 *                                         move a TEST account's saved addresses back in time (the cooling-off wait)
 *
 * What it starts, all bound to 127.0.0.1, state in ~/.intafaced/local-test-stack/:
 *   Postgres 16 (own data dir) · NATS JetStream · svc-ledger · svc-identity ·
 *   svc-matching · svc-trade · svc-pay · svc-bank · the services behind the Customer's
 *   More door, Notifications and P2P (svc-token, -p2p, -academy, -support, -market,
 *   -notify, -agents, -blueprint, -quant, -execution, -tax, -campaigns) · svc-ops (the outreach intake and CRM) ·
 *   svc-protocol (the Web3 rooms' read side) · a LOCAL TEST chain (anvil, chain id 84532) when anvil is installed ·
 *   svc-ws (the streams behind /ws) ·
 *   svc-edge · a small Customer static server + reverse proxy on http://127.0.0.1:3210 · the same
 *   for the public invitation site (apps/invitation) on http://127.0.0.1:3220 · a TEST apex stand-in page on
 *   http://127.0.0.1:3260 (the host check's apex; the real apex is deployed outside this repo) · the founder console
 *   (apps/admin, a production Next build) on http://127.0.0.1:3100
 *
 *   pnpm local:stack plan                 print services, ports and Edge wiring; changes nothing
 *   node tooling/scripts/local-test-stack.mjs csp-report [--fail|--clear]   Content-Security-Policy violations the Customer app reported
 *   pnpm local:stack --only a,b           start only the named services (plus Postgres/NATS)
 *   pnpm local:stack restart edge         stop the named services, then start (idempotent)
 *   pnpm local:stack customer-dist <abs>  serve a Customer build from another folder (never rebuilt or overwritten)
 *   pnpm local:stack customer-dist --clear   go back to this checkout's own build
 *   node tooling/scripts/local-test-stack.mjs age-linked-accounts <email> <hours>   TEST fixture: past a cooling-off
 *   node tooling/scripts/local-test-stack.mjs expire-address-approvals <email>   TEST fixture: open approval links run out
 *   node tooling/scripts/local-test-stack.mjs expire-deposit-addresses <email>   TEST fixture: open extra deposit addresses expire
 *   node tooling/scripts/local-test-stack.mjs expire-staff-holds <email>   TEST fixture: open staff holds with an expiry reach it
 *   node tooling/scripts/local-test-stack.mjs age-task-progress <email> <campaignId> <days>   TEST fixture: a task campaign's counted events happened days earlier
 *   node tooling/scripts/local-test-stack.mjs token-params   TEST fixture: svc-token's blank emission settings get the TEST profile values
 *   node tooling/scripts/local-test-stack.mjs seed-withdrawal <email> <ASSET> <amount> --state <s> --ref <label> [--count <n>] [--failure-code <code>]   TEST fixture: a withdrawal in that state, sent and failed included (or n requested ones)
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
import { apiSecurityHeaders, securityHeaders } from '../../apps/customer/deployment/render-security-headers.mjs';
import { APEX_DESCRIPTOR_PATH, APEX_PRODUCT } from '../../apps/customer/deployment/host-dispatch.mjs';
import { anvilBin, chainRecordPath, chainStatus, CHAIN_PORTS, GATE_URL, runSeedScript, TEST_CHAIN_ID } from './local-test-chain.mjs';
import { marketStatus } from './local-test-market.mjs';
import { serveVideoStore } from './local-video-store.mjs';
import academy from './local-stack-services/academy.mjs';
import agents from './local-stack-services/agents.mjs';
import bank from './local-stack-services/bank.mjs';
import blueprint from './local-stack-services/blueprint.mjs';
import edge from './local-stack-services/edge.mjs';
import execution from './local-stack-services/execution.mjs';
import identity, { confirmLocalFounderEmails } from './local-stack-services/identity.mjs';
import indexer from './local-stack-services/indexer.mjs';
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
import campaigns from './local-stack-services/campaigns.mjs';
import ws from './local-stack-services/ws.mjs';
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
import { RailRecordError, readRail, recordRailMovement } from './local-test-rail-records.mjs';
import { loadProfile, profileEnvFor } from './owner-settings.mjs';
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
  s2sMode: path.join(STATE, 'run', 's2s-mode'),
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
  hostReceipt: path.join(STATE, 'host-dispatch.json'),
  apexDist: path.join(STATE, 'apex-test'),
  cspViolations: path.join(STATE, 'csp-violations.jsonl'),
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
  // The Web3 rooms' read side; its RPC is the TEST chain's gate (local-test-chain.mjs, 14530-14532) when anvil is found.
  protocol: 14520,
  // The chain explorer's read model; follows the TEST chain through the same gate (local-stack-services/indexer.mjs).
  indexer: 14524,
  // LOCAL TEST stand-in for the object store Academy signs video URLs for (local-video-store.mjs).
  'video-store': 14521,
  // Seasons, limited drops and the TGE claim (the drop room).
  campaigns: 14522,
  // The live market-data and private streams the Customer app opens through /ws.
  ws: 14523,
  customer: 3210,
  invitation: 3220,
  // LOCAL TEST stand-in for the apex host (the host check); the real apex site is not in this repo.
  apex: 3260,
  admin: 3100,
};
const HOST = '127.0.0.1';
const CUSTOMER_ORIGIN = `http://${HOST}:${PORTS.customer}`;
// LOCAL TEST: WebAuthn (passkeys) cannot use an IP address as its relying-party ID, so the same Customer
// server is also reachable as localhost. Passkeys: open this one. Everything else works on either.
const CUSTOMER_LOCALHOST_ORIGIN = `http://localhost:${PORTS.customer}`;
const ADMIN_ORIGIN = `http://${HOST}:${PORTS.admin}`;
const INVITATION_ORIGIN = `http://${HOST}:${PORTS.invitation}`;
const APEX_ORIGIN = `http://${HOST}:${PORTS.apex}`;
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
  'indexer',
  'campaigns',
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
  'payBankTransferWebhook', // pay's TEST bank webhook key (J-merchant-04 step 6); the `bank-transfer` command signs with it
  'identityTotp', // identity's TOTP sealing key; lets the labelled local test operators enrol a second factor
  'identityFlowSubject', // identity's key for sign-up and recovery flows (address identifier and code hash)
  'notifyStatusLink', // notify's key for the signed links in status subscription mail
  'academyVideoStore', // the TEST video store's signing key, shared with academy (local-video-store.mjs)
  'payKybDocKey', // pay's key for business verification documents (PAY_KYB_DOC_KEY, 32 bytes as hex)
  'payTravelRuleKey', // pay's travel-rule sealing key (PAY_TRAVEL_RULE_MESSAGE_KEY is its SHA-256 as base64); this stack's own, valid nowhere else
  'identityApiKeySigning', // identity's sealing key for API-key request-signing secrets (API_KEY_SIGNING_ENC_KEY, 32 bytes as hex)
  'identityKycDoc', // identity's key for the KYC document vault (IDENTITY_KYC_DOC_KEY, 32 bytes as hex); this stack's own, valid nowhere else
  'identityPayQr', // identity's TEST pay QR signing key (IDENTITY_PAY_QR_KEY carries it after `local-test:`); this stack's own, valid nowhere else
  'tradeVipProofKey', // trade's key for VIP application proof files (TRADE_VIP_PROOF_KEY, 32 bytes as hex); this stack's own, valid nowhere else
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
  // One TEST service key per S2S service, used only when LOCAL_STACK_S2S=dual (s2sEnv). Valid nowhere else.
  s.s2sKeys ??= {};
  for (const svc of S2S_SERVICES) {
    if (!serviceKeyMatches(svc, s.s2sKeys[svc])) {
      s.s2sKeys[svc] = newServiceKey(svc);
      changed = true;
    }
  }
  if (changed) writePrivate(P.secrets, JSON.stringify(s, null, 2));
  return s;
}

// ── Service keys (LOCAL_STACK_S2S=dual) ─────────────────────────────────────

/**
 * The stack's services that speak S2S v3 (packages/contracts SERVICE_NAMES). svc-blueprint and svc-protocol have no
 * S2S role, and svc-fix is not started here.
 */
export const S2S_SERVICES = [
  'svc-academy',
  'svc-agents',
  'svc-bank',
  'svc-campaigns',
  'svc-edge',
  'svc-execution',
  'svc-identity',
  'svc-ledger',
  'svc-market',
  'svc-matching',
  'svc-mining-pool',
  'svc-notify',
  'svc-ops',
  'svc-p2p',
  'svc-pay',
  'svc-quant',
  'svc-support',
  'svc-tax',
  'svc-token',
  'svc-trade',
  'svc-ws',
];

/** A fresh Ed25519 key in the forms packages/contracts reads: the keyring's raw public key and PKCS8, both base64url. */
export function newServiceKey(svc) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return {
    kid: `${svc}.local`,
    x: publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64url'),
    key: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64url'),
  };
}

/** True when a stored key has this service's kid and its private key gives its public x (else it is made afresh). */
export function serviceKeyMatches(svc, k) {
  if (k?.kid !== `${svc}.local` || typeof k.key !== 'string' || typeof k.x !== 'string') return false;
  try {
    const priv = crypto.createPrivateKey({ key: Buffer.from(k.key, 'base64url'), format: 'der', type: 'pkcs8' });
    return crypto.createPublicKey(priv).export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64url') === k.x;
  } catch {
    return false;
  }
}

const keyrings = new WeakMap();

/**
 * The S2S env for one service. Unset or `off` adds nothing, so the shared secret stays the only form (the default, and
 * what the journeys run). `dual` gives every S2S service the same public keyring and its own signing key: each one
 * signs with its key and still accepts the shared secret, so svc-ledger binds callers by key and refuses a
 * shared-secret post of a key-only recipe (services/svc-ledger/CALLER-BINDING.md). `keypair` is refused: the local
 * fund and seed scripts sign with the shared secret.
 */
export function s2sEnv(secrets, name, mode = process.env.LOCAL_STACK_S2S) {
  if (mode === undefined || mode === '' || mode === 'off') return {};
  if (mode !== 'dual') throw new Error(`LOCAL_STACK_S2S must be off or dual (keypair would refuse the local fund and seed scripts)`);
  const keys = secrets.s2sKeys ?? {};
  const missing = S2S_SERVICES.filter((svc) => !keys[svc]);
  if (missing.length)
    throw new Error(`LOCAL_STACK_S2S=dual: no stack key for ${missing.join(', ')}; run pnpm local:stack once to create them`);
  if (!S2S_SERVICES.includes(name)) return {};
  if (!keyrings.has(keys))
    keyrings.set(keys, JSON.stringify({ keys: S2S_SERVICES.map((svc) => ({ kid: keys[svc].kid, svc, use: 's2s', x: keys[svc].x })) }));
  const keyring = keyrings.get(keys);
  return { S2S_AUTH_MODE: 'dual', S2S_KEYRING: keyring, S2S_SIGNING_KID: keys[name].kid, S2S_SIGNING_KEY: keys[name].key };
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
  'svc-indexer',
  'svc-campaigns',
  'svc-ws',
];

function gitHead() {
  const r = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: REPO, encoding: 'utf8' });
  return r.stdout.trim();
}

/** Runs `pnpm args` with its output in logs/<label>.log; `spawner` is spawnSync or spawn. */
function pnpmRun(spawner, args, label, extraEnv) {
  const logPath = path.join(P.logs, `${label}.log`);
  const fd = fs.openSync(logPath, 'w', 0o600);
  const result = spawner('pnpm', args, { cwd: REPO, env: { ...baseEnv(), ...extraEnv }, stdio: ['ignore', fd, fd] });
  const failed = (status) => {
    const tail = fs.readFileSync(logPath, 'utf8').split('\n').slice(-25).join('\n');
    fail(`${label} failed (exit ${status}). Log: ${logPath}\n${tail}`);
  };
  return { fd, result, failed };
}

function runPnpm(args, label, extraEnv = {}) {
  const { fd, result: r, failed } = pnpmRun(spawnSync, args, label, extraEnv);
  fs.closeSync(fd);
  if (r.status !== 0) failed(r.status);
}

// pnpm runs still going when the script exits early (one side-by-side run failed): stopped with it, never orphaned.
const livePnpm = new Set();
process.on('exit', () => {
  for (const child of livePnpm) child.kill('SIGTERM');
});

/** runPnpm without blocking, so several can run side by side. */
function runPnpmAsync(args, label, extraEnv = {}) {
  const { fd, result: child, failed } = pnpmRun(spawn, args, label, extraEnv);
  livePnpm.add(child);
  return new Promise((resolve) => {
    let finished = false;
    const done = (status) => {
      if (finished) return;
      finished = true;
      livePnpm.delete(child);
      fs.closeSync(fd);
      if (status !== 0) failed(status);
      resolve();
    };
    child.on('error', () => done(-1));
    child.on('exit', (code, signal) => done(signal ? -1 : code));
  });
}

/** Run `task` on every item, at most `limit` at a time. */
export async function inPool(items, limit, task) {
  const queue = [...items];
  const lane = async () => {
    while (queue.length) await task(queue.shift());
  };
  await Promise.all(Array.from({ length: Math.min(limit, queue.length) }, lane));
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

// Each schema migrates as its own role inside its own schema and reads no build output, so they run side by side,
// one per core (they were 19 runs of about a second each, one after another).
async function migrate(secrets, schemas = SCHEMAS) {
  await inPool(schemas, os.availableParallelism(), (s) =>
    runPnpmAsync(['--filter', `@intafaced/svc-${serviceOfSchema(s)}`, 'db:migrate'], `migrate-${s}`, {
      DATABASE_URL: dbUrl(`svc_${s}`, secrets),
    }),
  );
  say(`  migrations: ${schemas.length ? schemas.join(', ') : 'none needed'} applied (idempotent)`);
}

// ── Service definitions ─────────────────────────────────────────────────────

// Placeholder secrets used only to list names, ports and URLs (plan / health table). Never reaches a process.
export const PLAN_SECRETS = {
  ...Object.fromEntries(SECRET_NAMES.map((n) => [n, 'x'.repeat(64)])),
  // Placeholders, so `plan` under LOCAL_STACK_S2S=dual shows the keyed env without reading secrets.json.
  s2sKeys: Object.fromEntries(S2S_SERVICES.map((svc) => [svc, { kid: `${svc}.local`, x: 'x'.repeat(43), key: 'x' }])),
};

/**
 * LOCAL_STACK_S2S for a start or restart, checked before anything is stopped or started. A stack whose services are
 * running with another value is refused: start and restart leave a running service alone, so it would mix modes.
 */
function validS2sMode() {
  const raw = process.env.LOCAL_STACK_S2S;
  const mode = raw === undefined || raw === '' ? 'off' : raw;
  if (mode !== 'off' && mode !== 'dual')
    fail(`LOCAL_STACK_S2S must be off or dual, not "${raw}" (keypair would refuse the local fund and seed scripts)`, 2);
  return mode;
}

function checkedS2sMode() {
  const mode = validS2sMode();
  const procs = readProcs();
  const running = serviceNames().filter((n) => ownedAlive(procs[n]));
  const was = fs.existsSync(P.s2sMode) ? fs.readFileSync(P.s2sMode, 'utf8').trim() : 'off';
  if (running.length && was !== mode)
    fail(
      `this stack's services run with LOCAL_STACK_S2S=${was} (${running.join(', ')}); set the same value, or stop the stack first (pnpm local:stack:stop)`,
      2,
    );
  return mode;
}
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
    // S2S_AUTH_MODE stays unset here unless LOCAL_STACK_S2S=dual (s2sEnv): svc-ledger then accepts this shared
    // secret and counts each post as unbound. See services/svc-ledger/CALLER-BINDING.md.
    ...s2sEnv(secrets, name),
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
  INDEXER_URL: 'indexer',
  CAMPAIGNS_URL: 'campaigns',
};

/** Edge upstreams that are intentionally not started, each with the reason. The Customer app calls none of them except where noted. */
const EDGE_ABSENT = {
  DEX_URL: 'On-chain DEX; needs chain RPC. The Web3 rooms show it as a service that did not answer.',
  CONNECT_URL: 'Operator data-lake door; not a customer door.',
};

/**
 * The services the stack starts. A service listed before one it calls starts first (startDependencies); the order
 * says nothing else. Each service's env lives in its own file, tooling/scripts/local-stack-services/<name>.mjs, so a
 * slice changes only its service's file. Every file gets the same wiring helpers below; a new service adds its file
 * and one line here.
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
  indexer,
  campaigns,
  ws,
  edge,
];

/**
 * Which services `def` waits for: every service before it in `defs` (SERVICES order) whose port its env names. One by
 * one, each service started only once every service before it answered; it still starts only once those it calls
 * answer, and the rest start side by side (one after another they took about 36 seconds). A service named later in
 * SERVICES was never up when it booted, and still is not waited for.
 */
export function startDependencies(defs, def, envOf = (d) => d.env()) {
  const port = (d) => String(envOf(d).HTTP_PORT);
  const values = Object.values(envOf(def)).map(String);
  const before = defs.slice(0, defs.indexOf(def));
  return before.filter((d) => {
    const named = new RegExp(`:${port(d)}(?![0-9])`);
    return values.some((v) => named.test(v));
  });
}

/** Starts every service once the services it waits for (startDependencies) answer, the rest side by side. */
async function startServices(defs) {
  const envs = new Map(defs.map((d) => [d, d.env()]));
  const envOf = (d) => envs.get(d);
  const started = new Map();
  for (const def of defs) {
    const waits = startDependencies(defs, def, envOf).map((d) => started.get(d));
    started.set(
      def,
      Promise.all(waits).then(() => startNodeService(def)),
    );
  }
  await Promise.all(started.values());
}

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
    testChain,
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

// ── The LOCAL TEST chain (local-test-chain.mjs) ─────────────────────────────

/**
 * What the TEST chain holds, read when a service's env is built: `{ rpcUrl, factory, router }` while the `chain`
 * process this script started is alive and seeded, else null (svc-protocol then keeps PROTOCOL_RPC_URL=UNUSED).
 */
function testChain() {
  if (!ownedAlive(readProcs().chain) || !fs.existsSync(chainRecordPath(STATE))) return null;
  const record = readJson(chainRecordPath(STATE));
  return { rpcUrl: GATE_URL, factory: record.factory, router: record.router };
}

/**
 * Starts anvil behind its gate and seeds it, when an anvil binary is found. Without one the stack runs as it did
 * before this chain existed, and says so. A failure to seed fails the start: a half-seeded chain would let the DEX
 * journeys fail later for a reason the log no longer shows.
 */
async function startTestChain() {
  const bin = anvilBin(process.env);
  const procs = readProcs();
  if (!bin) {
    if (!ownedAlive(procs.chain)) {
      fs.rmSync(chainRecordPath(STATE), { force: true });
      // A chain an earlier start ran is not this stack's any more: no health row for it.
      if (procs.chain) {
        delete procs.chain;
        writeProcs(procs);
      }
    }
    say('  chain: no anvil binary (LOCAL_STACK_ANVIL_BIN unset, none on PATH); svc-protocol keeps no node (UNUSED)');
    return;
  }
  if (!ownedAlive(procs.chain)) {
    for (const port of Object.values(CHAIN_PORTS))
      if (await portOpen(port)) fail(`port ${port} (TEST chain) is in use by a process this script did not start`);
    // A new anvil starts empty: whatever an earlier record named is gone with the old node.
    fs.rmSync(chainRecordPath(STATE), { force: true });
    startProc(
      'chain',
      [process.execPath, path.join(path.dirname(SCRIPT), 'local-test-chain.mjs'), 'serve'],
      {
        ...baseEnv(),
        LOCAL_STACK_ANVIL_BIN: bin,
      },
      REPO,
    );
  }
  const want = `0x${TEST_CHAIN_ID.toString(16)}`;
  for (let i = 0; i < 60; i++) {
    const answer = await rpcChainId();
    if (answer === want) break;
    if (i === 59) fail(`the TEST chain never answered chain id ${want} on ${GATE_URL} (see ${path.join(P.logs, 'chain.log')})`);
    await sleep(500);
  }
  if ((await chainStatus()).gate !== 'open') fail('the TEST chain gate is closed; a journey left it shut (local-test-chain.mjs gate open)');
  const seeded = runSeedScript(['seed', chainRecordPath(STATE)]);
  say(`  chain: ${seeded.output.split('\n').pop()}`);
  if (seeded.status !== 0) fail(`seeding the TEST chain failed:\n${seeded.output}`);
}

async function rpcChainId() {
  try {
    const res = await fetch(GATE_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId' }),
      signal: AbortSignal.timeout(2000),
    });
    return (await res.json()).result;
  } catch {
    return null;
  }
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
  await confirmLocalFounderEmails({ STATE, marker, edgeUrl, say });
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
  const env = { ...baseEnv(), CUSTOMER_WS_URL: customerWsUpstream() };
  const pid = startProc('customer', [process.execPath, SCRIPT, '__serve-customer'], env, REPO);
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

/**
 * LOCAL TEST: the apex host's stand-in, a TEST page and an apex descriptor marked `test` written to the state folder on
 * every start. The real apex (the marketing site) is built and deployed outside this repo, so this stack has no apex
 * build to serve; the host check accepts a `test` descriptor only in its LOCAL TEST mode.
 */
function writeApexStandIn() {
  fs.mkdirSync(P.apexDist, { recursive: true });
  const descriptor = { product: APEX_PRODUCT, schemaVersion: 1, test: true };
  fs.writeFileSync(path.join(P.apexDist, APEX_DESCRIPTOR_PATH.slice(1)), `${JSON.stringify(descriptor, null, 2)}\n`);
  fs.writeFileSync(
    path.join(P.apexDist, 'index.html'),
    '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>TEST apex stand-in</title></head>' +
      "<body><main><h1>TEST apex stand-in</h1><p>This machine's local test stack. No deployment is shown.</p></main></body></html>\n",
  );
}

async function startApex() {
  const procs = readProcs();
  const url = `${APEX_ORIGIN}/`;
  writeApexStandIn();
  if (ownedAlive(procs.apex) && (await httpGet(url, 2000)).status === 200) return;
  if (await portOpen(PORTS.apex)) fail(`port ${PORTS.apex} (apex) is in use by a process this script did not start`);
  const pid = startProc('apex', [process.execPath, SCRIPT, '__serve-apex'], baseEnv(), REPO);
  await waitHealthy('apex', url, pid, 20_000);
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

/** Every Node service this script runs, in SERVICES order (Edge last). */
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
  if (procs.chain) {
    const status = await chainStatus();
    const answer = await rpcChainId();
    rows.push([
      'chain (TEST)',
      `${CHAIN_PORTS.gate}`,
      procs.chain.pid ?? '-',
      answer === `0x${TEST_CHAIN_ID.toString(16)}`
        ? `ok (anvil ${TEST_CHAIN_ID}, gate open)`
        : status.gate === 'closed'
          ? 'ok (gate closed by a journey)'
          : 'DOWN',
    ]);
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
  const apex = await httpGet(`${APEX_ORIGIN}/`, 2500);
  rows.push([
    'apex',
    PORTS.apex,
    procs.apex?.pid ?? '-',
    apex.status === 200 && apex.text.includes(BANNER_TEXT) ? 'ok (TEST)' : `DOWN (${apex.status})`,
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
  const known = [...serviceNames(), 'video-store', 'customer', 'invitation', 'apex', 'admin'];
  const bad = names.filter((n) => !known.includes(n));
  if (names.length === 0 || bad.length)
    fail(`--only needs a comma list of: ${known.join(', ')}${bad.length ? ` (unknown: ${bad.join(', ')})` : ''}`, 2);
  return names;
}

async function cmdStart(flags) {
  const s2sMode = checkedS2sMode();
  say('INTAFACED local test stack');
  say(`  repo ${REPO}`);
  say(`  state ${STATE}`);
  const free = freeGb();
  if (free < MIN_FREE_GB) fail(`only ${free.toFixed(1)} GB free on / (need >= ${MIN_FREE_GB} GB so free space stays above 12 GB)`);
  for (const b of [`${PG_BIN}/pg_ctl`, `${PG_BIN}/initdb`, `${PG_BIN}/psql`])
    if (!fs.existsSync(b)) fail(`missing ${b} (install PostgreSQL 16 via Homebrew)`);
  const secrets = loadOrCreateSecrets();
  // Each stack starts with no recorded CSP violations, so `csp-report --fail` speaks only of this run.
  fs.rmSync(P.cspViolations, { force: true });
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
  await migrate(
    secrets,
    SCHEMAS.filter((s) => toStart.some((d) => d.name === serviceOfSchema(s))),
  );
  await startNats();
  ensureStreams();
  if (!only || only.includes('protocol')) await startTestChain();
  // Vault before identity starts, so the first boot already has the invite hashes.
  // Enrolment itself waits until edge is up (below).
  try {
    ensureFounderVaultDraft({ stateDir: STATE, marker: readJson(P.marker), edgeUrl: urlOf('edge'), log: say });
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
  // Academy's env points at the video store, so `--only academy` starts it too.
  if (!only || only.includes('video-store') || only.includes('academy')) await startVideoStore(secrets);
  writePrivate(P.s2sMode, `${s2sMode}\n`);
  await startServices(wanted);
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
  if (!only || only.includes('apex')) await startApex();
  if (!only || HOST_SITES.some((name) => only.includes(name))) await checkLocalTestHosts();
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
  const order = ['admin', 'apex', 'invitation', 'customer', ...serviceNames().reverse(), 'chain', 'video-store', 'nats'];
  const only = names.length ? names : null;
  // A TEST host receipt never outlives the sites it says are served (checkLocalTestHosts writes it again on start).
  if (!only || HOST_SITES.some((name) => only.includes(name))) fs.rmSync(P.hostReceipt, { force: true });
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
  validS2sMode();
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
  const known = [...serviceNames(), 'video-store', 'customer', 'invitation', 'apex', 'admin'];
  const bad = names.filter((n) => !known.includes(n));
  if (names.length === 0 || bad.length)
    fail(`restart needs service names from: ${known.join(', ')}${bad.length ? ` (unknown: ${bad.join(', ')})` : ''}`, 2);
  checkedS2sMode();
  await cmdStop(names);
  await cmdStart([]);
}

// The Customer server proxies /ws/* to CUSTOMER_WS_URL with the /ws prefix stripped, as apps/customer/nginx.conf
// does to svc-ws. The stack sets it to its own svc-ws (startCustomer); blank, every /ws request is this typed refusal.
// `LOCAL_STACK_WS_UPSTREAM=off` on a start or restart of customer leaves it blank, so a journey can see the refusal.
const WS_UPSTREAM_REFUSAL = {
  code: 'ws.upstream_unset',
  key: 'CUSTOMER_WS_URL',
  message: 'CUSTOMER_WS_URL is not wired. The Customer server has no WebSocket upstream.',
};
const customerWsUpstream = () => (process.env.LOCAL_STACK_WS_UPSTREAM === 'off' ? '' : urlOf('ws'));

// ── LOCAL TEST hosts ────────────────────────────────────────────────────────

/** The sites the host check reads; starting or stopping any of them checks again or drops the receipt. */
const HOST_SITES = ['customer', 'invitation', 'apex'];

/** Where the Customer app reads the host dispatch receipt (apps/customer/src/features/public/host-dispatch.ts). */
const HOST_RECEIPT_PATH = '/host-dispatch.json';

/**
 * The apex, app and join hosts on this machine: TEST stand-ins on loopback, made from this stack's own ports and never
 * an owner value. The apex is the stack's TEST apex page (writeApexStandIn), the invitation site is the join host and the
 * Customer server is the app host. `LOCAL_STACK_HOSTS=off` on a start or restart leaves all three unset, so a
 * journey can see the typed refusal.
 */
export function localTestHosts(env = process.env) {
  if (env.LOCAL_STACK_HOSTS === 'off') return {};
  return { INTAFACED_APEX_HOST: APEX_ORIGIN, INTAFACED_APP_HOST: CUSTOMER_ORIGIN, INTAFACED_JOIN_HOST: INVITATION_ORIGIN };
}

/**
 * Runs the deployment's host check against the TEST hosts in its LOCAL TEST mode (APP_ENV test, loopback only) and
 * keeps its receipt in the state folder, where the Customer server publishes it at /host-dispatch.json. The previous
 * receipt is removed first, so with the hosts unset nothing is published. A refusal is printed, never fatal.
 */
async function checkLocalTestHosts() {
  fs.rmSync(P.hostReceipt, { force: true });
  const check = path.join(REPO, 'apps', 'customer', 'deployment', 'host-dispatch.mjs');
  const env = { PATH: PNPM_PATH, HOME: os.homedir(), APP_ENV: 'test', ...localTestHosts() };
  const result = await new Promise((done) => {
    const child = spawn(process.execPath, [check, '--local-test', '--out', P.hostReceipt], { env, cwd: REPO });
    let out = '';
    child.stdout.on('data', (chunk) => (out += chunk));
    child.stderr.on('data', (chunk) => (out += chunk));
    child.on('close', (status) => done({ status, out }));
  });
  for (const line of result.out.trim().split('\n').filter(Boolean)) say(`  ${line}`);
  if (result.status !== 0) say(`  host dispatch (TEST): exited ${result.status}; the Help room shows no host as served`);
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

/** What nginx's /api/ location adds to Edge's answers (security-headers-api.conf). */
const API_SECURITY = apiSecurityHeaders();
/** Where the Customer app's browser sends Content-Security-Policy violation reports on this stack. */
const CSP_REPORT_PATH = '/__csp-report';

/**
 * The Customer site's production security headers (apps/customer/security-headers.conf.template), with this stack's
 * TEST video store standing in for CUSTOMER_STORAGE_ORIGIN and a report-uri so every violation is recorded. Journeys
 * therefore run under the policy the deployed app has, and `csp-report --fail` turns any violation red.
 */
export function customerSecurityHeaders() {
  return securityHeaders({ mediaSrc: `'self' blob: ${urlOf('video-store')}`, reportUri: CSP_REPORT_PATH });
}

/**
 * The static sites this stack serves. The Customer and invitation sites pass `/api/*` to Edge; the TEST apex page has no
 * api. Only the Customer site has a folder override.
 */
const SITES = {
  customer: { label: 'Customer', origin: CUSTOMER_ORIGIN, dist: () => activeCustomerDist(), headers: () => customerSecurityHeaders() },
  invitation: { label: 'invitation', origin: INVITATION_ORIGIN, dist: () => ({ dir: P.invitationDist, error: null }), headers: () => ({}) },
  apex: { label: 'apex', origin: APEX_ORIGIN, dist: () => ({ dir: P.apexDist, error: null }), headers: () => ({}), noApi: true },
};

/** One CSP report body (application/csp-report or reports+json) as the rows csp-violations.jsonl keeps. */
export function cspReportRows(body, at = new Date().toISOString()) {
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    return [];
  }
  const list = Array.isArray(parsed) ? parsed.map((r) => r?.body ?? r) : [parsed?.['csp-report'] ?? parsed];
  return list
    .filter((r) => r && typeof r === 'object')
    .map((r) => ({
      at,
      directive: String(r['effective-directive'] ?? r.effectiveDirective ?? r['violated-directive'] ?? '').slice(0, 80),
      blocked: String(r['blocked-uri'] ?? r.blockedURL ?? '').slice(0, 300),
      page: String(r['document-uri'] ?? r.documentURL ?? '')
        .replace(/[?#].*$/, '')
        .slice(0, 300),
      source: String(r['source-file'] ?? r.sourceFile ?? '')
        .replace(/[?#].*$/, '')
        .slice(0, 300),
      line: Number(r['line-number'] ?? r.lineNumber ?? 0) || 0,
      sample: String(r['script-sample'] ?? r.sample ?? '').slice(0, 80),
    }));
}

// The status badge's cache life comes from svc-notify through the edge, as apps/customer/nginx.conf passes it; every
// other /api/ answer stays no-store.
const STATUS_BADGE_PATH = '/api/notify/status/badge.svg';
export function apiCacheControl(pathname, upstream) {
  return pathname === STATUS_BADGE_PATH && typeof upstream === 'string' && upstream.length > 0 ? upstream : 'no-store';
}

/** Request headers to forward upstream: no hop-by-hop headers, and none only Edge may mint. */
function proxyHeaders(req, { upgrade = false } = {}) {
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) {
    const lk = k.toLowerCase();
    if (['connection', 'keep-alive', 'transfer-encoding', 'upgrade'].includes(lk) && !upgrade) continue;
    if (lk.startsWith('x-intafaced-') || lk.startsWith('x-service-')) continue; // only Edge may mint these
    headers[k] = v;
  }
  headers['x-forwarded-for'] = req.socket.remoteAddress ?? HOST;
  headers['x-forwarded-proto'] = 'http';
  return headers;
}

function serveCustomer(port = PORTS.customer, site = SITES.customer) {
  const edge = { host: HOST, port: PORTS.edge };
  // The invitation site serves no /ws. Customer: the stack's svc-ws, or blank (the typed refusal).
  const wsRaw = site === SITES.customer ? (process.env.CUSTOMER_WS_URL ?? '').trim() : '';
  const wsUrl = wsRaw ? new URL(wsRaw) : null;
  const wsUpstream = wsUrl ? { host: wsUrl.hostname, port: Number(wsUrl.port) || 80 } : null;
  // nginx sets these on every response (`always`), errors included.
  const security = site.headers();
  const send = (res, status, type, body, extra = {}) => {
    res.writeHead(status, {
      ...security,
      'content-type': type,
      'content-length': Buffer.byteLength(body),
      'cache-control': 'no-store',
      ...extra,
    });
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

    if (p === CSP_REPORT_PATH && site === SITES.customer) {
      if (req.method !== 'POST') return send(res, 405, 'text/plain; charset=utf-8', 'method not allowed');
      let body = '';
      req.setEncoding('utf8');
      req.on('data', (chunk) => {
        body += chunk;
        if (body.length > 64 * 1024) req.destroy();
      });
      req.on('end', () => {
        const rows = cspReportRows(body);
        try {
          if (rows.length) {
            fs.mkdirSync(path.dirname(P.cspViolations), { recursive: true });
            fs.appendFileSync(P.cspViolations, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
          }
        } catch (error) {
          // The record cannot be written: say so on every report rather than take the Customer site down.
          console.error(`CSP report not recorded (${error.message}); csp-report cannot see it`);
        }
        for (const r of rows) console.error(`CSP violation: ${r.directive} blocked ${r.blocked || '(inline)'} on ${r.page}`);
        send(res, 204, 'text/plain; charset=utf-8', '');
      });
      return;
    }
    if (p === '/api' || p === '/ws' || (site.noApi && p.startsWith('/api/')))
      return send(res, 404, 'text/plain; charset=utf-8', 'not found');
    if (p.startsWith('/ws/')) {
      if (!wsUpstream) return send(res, 503, 'application/json', JSON.stringify(WS_UPSTREAM_REFUSAL));
      const up = http.request(
        { ...wsUpstream, method: req.method, path: req.url.slice('/ws'.length), headers: proxyHeaders(req) },
        (ur) => {
          res.writeHead(ur.statusCode ?? 502, { ...ur.headers, ...API_SECURITY, 'cache-control': 'no-store' });
          ur.pipe(res);
        },
      );
      up.on('error', () =>
        res.headersSent ? res.destroy() : send(res, 502, 'application/json', JSON.stringify({ error: 'ws_unreachable' })),
      );
      return void req.pipe(up);
    }
    if (p.startsWith('/api/')) {
      const up = http.request({ ...edge, method: req.method, path: req.url, headers: proxyHeaders(req) }, (ur) => {
        res.writeHead(ur.statusCode ?? 502, {
          ...ur.headers,
          ...API_SECURITY,
          'cache-control': apiCacheControl(p, ur.headers['cache-control']),
        });
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

    // The LOCAL TEST host receipt, from the state folder (checkLocalTestHosts). With none, the build's own file or the index.
    // The receipt, or a 404 while there is none: never the app's index in its place.
    if (site === SITES.customer && p === HOST_RECEIPT_PATH) {
      if (!fs.existsSync(P.hostReceipt)) return send(res, 404, 'text/plain; charset=utf-8', 'no host dispatch receipt');
      return send(res, 200, MIME['.json'], fs.readFileSync(P.hostReceipt, 'utf8'));
    }

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
        ...security,
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
    res.writeHead(200, {
      ...security,
      'content-type': MIME['.html'],
      'content-length': Buffer.byteLength(html),
      'cache-control': 'no-store',
    });
    res.end(req.method === 'HEAD' ? undefined : html);
  });
  // A WebSocket upgrade under /ws/ goes to the same upstream; blank, or any other path, it is refused, never dropped.
  server.on('upgrade', (req, socket, head) => {
    const refuse = (status, reason, payload) => {
      const body = JSON.stringify(payload);
      socket.end(
        `HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
      );
    };
    const host = req.headers.host ?? '';
    if (host !== `${HOST}:${port}` && host !== `localhost:${port}`) return refuse(403, 'Forbidden', { error: 'foreign_host' });
    if (!wsUpstream) return refuse(503, 'Service Unavailable', WS_UPSTREAM_REFUSAL);
    if (!req.url.startsWith('/ws/')) return refuse(404, 'Not Found', { error: 'not_found' });
    const up = http.request({
      ...wsUpstream,
      method: req.method,
      path: req.url.slice('/ws'.length),
      headers: proxyHeaders(req, { upgrade: true }),
    });
    up.on('upgrade', (ur, upSocket, upHead) => {
      const lines = [`HTTP/1.1 ${ur.statusCode} ${ur.statusMessage}`];
      for (let i = 0; i < ur.rawHeaders.length; i += 2) lines.push(`${ur.rawHeaders[i]}: ${ur.rawHeaders[i + 1]}`);
      socket.write(`${lines.join('\r\n')}\r\n\r\n`);
      if (upHead.length) socket.write(upHead);
      if (head.length) upSocket.write(head);
      upSocket.pipe(socket).pipe(upSocket);
      upSocket.on('error', () => socket.destroy());
      socket.on('error', () => upSocket.destroy());
    });
    // The upstream answered without upgrading (a 400 for an unknown channel, a 503 refusal): pass that answer on.
    up.on('response', (ur) => {
      // Node has already de-chunked the body, so it goes out whole with its own length, never as a stale chunked frame.
      const chunks = [];
      ur.on('data', (chunk) => chunks.push(chunk));
      ur.on('end', () => {
        const body = Buffer.concat(chunks);
        const lines = [`HTTP/1.1 ${ur.statusCode} ${ur.statusMessage}`];
        for (let i = 0; i < ur.rawHeaders.length; i += 2) {
          if (/^(transfer-encoding|content-length|connection)$/i.test(ur.rawHeaders[i])) continue;
          lines.push(`${ur.rawHeaders[i]}: ${ur.rawHeaders[i + 1]}`);
        }
        lines.push(`Content-Length: ${body.length}`, 'Connection: close');
        socket.end(Buffer.concat([Buffer.from(`${lines.join('\r\n')}\r\n\r\n`), body]));
      });
    });
    up.on('error', () => refuse(502, 'Bad Gateway', { error: 'ws_unreachable' }));
    up.end();
  });
  server.listen(port, HOST);
}

/**
 * `csp-report [--fail] [--clear]`: the Content-Security-Policy violations the Customer app's browser reported to this
 * stack (csp-violations.jsonl), grouped by directive and blocked source. `--fail` exits 1 when there is any, so a journey
 * run that broke the production policy is red; `--clear` empties the record (`start` does too, so each stack starts clean).
 */
function cmdCspReport(args) {
  if (args.includes('--clear')) {
    fs.rmSync(P.cspViolations, { force: true });
    say('  csp-report: cleared');
    return;
  }
  const rows = fs.existsSync(P.cspViolations)
    ? fs
        .readFileSync(P.cspViolations, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => {
          try {
            return JSON.parse(l);
          } catch {
            // A line cut short (the server stopped mid-write) still means a violation was seen.
            return { directive: 'unreadable record line', blocked: l.slice(0, 80), page: '?' };
          }
        })
    : [];
  if (rows.length === 0) {
    say('  csp-report: no Content-Security-Policy violations recorded');
    return;
  }
  const groups = new Map();
  for (const r of rows) {
    const key = `${r.directive} blocked ${r.blocked || '(inline)'}`;
    const g = groups.get(key) ?? { n: 0, pages: new Set(), source: r.source, line: r.line, sample: r.sample };
    g.n++;
    g.pages.add(r.page);
    groups.set(key, g);
  }
  say(`  csp-report: ${rows.length} Content-Security-Policy violation(s), ${groups.size} kind(s)`);
  for (const [key, g] of groups) {
    say(
      `    ${key}  ×${g.n}  on ${[...g.pages].slice(0, 3).join(', ')}${g.source ? `  from ${g.source}:${g.line}` : ''}${g.sample ? `  "${g.sample}"` : ''}`,
    );
    if (process.env.GITHUB_ACTIONS) console.log(`::error title=CSP violation::${key} (×${g.n}) on ${[...g.pages][0]}`);
  }
  if (args.includes('--fail')) process.exit(1);
}

// ── local:fund ──────────────────────────────────────────────────────────────

const AMOUNT_RE = /^\d+(\.\d+)?$/;

/**
 * `age-linked-accounts <email-or-userId> <hours>`: move this TEST person's linked bank accounts `hours` back in time, so
 * a journey can start, as J-bank-03 #4 does, from "a saved bank destination past its cooling-off" without waiting the
 * TEST window out. A local test fixture like `fund`: it refuses anything but this stack's own database, changes only when
 * the accounts were linked (never their verification, which only the partner's signed call sets) and moves no value.
 */
/**
 * The running local stack's own database and one TEST person on it, for the fixtures below. Refuses anything but this
 * stack's database.
 */
/** The running local stack's secrets, after the same marker, port and Postgres checks every fixture makes. */
function localFixtureSecrets() {
  if (!fs.existsSync(P.marker)) fail(`refusing: marker ${P.marker} not found. Start the stack first (pnpm local:stack).`);
  const marker = readJson(P.marker);
  if (marker.kind !== 'intafaced-local-test-stack') fail('refusing: marker file is not a local test stack marker');
  const secrets = readJson(P.secrets);
  if (String(marker.ports?.postgres) !== String(PORTS.postgres)) fail('refusing: database is not on the local test stack port');
  if (!pgRunning()) fail('refusing: the local stack Postgres is not running. Run: pnpm local:stack');
  assertActiveLocalStack({ stateDir: STATE });
  return secrets;
}

function localFixturePerson(who) {
  const secrets = localFixtureSecrets();
  const found = psql(secrets, `SELECT id::text FROM identity.users WHERE email = :'who' OR id::text = :'who'`, {
    db: DB_NAME,
    user: 'svc_identity',
    password: secrets.pgService,
    vars: { who },
    tuples: true,
  })
    .trim()
    .split('\n')
    .filter(Boolean);
  if (found.length !== 1) fail(`no single user "${who}" in the local identity database`);
  return { secrets, userId: found[0] };
}

/**
 * `token-params`: svc-token's emission settings get the labelled TEST values from
 * tooling/profiles/test-owner-values/token.json (total supply, halving interval, first-epoch reward), so a journey can
 * mint one TEST epoch through the job door and read the treasury back against the ledger (J-more-catalogue-09 #9). Only a
 * blank column is written; a value already there is left alone. It moves no value itself: the mint is the job door's,
 * through the ledger recipe.
 */
function cmdTokenParams() {
  const secrets = localFixtureSecrets();
  const v = (name) => {
    const entry = loadProfile().values[name];
    if (!entry) fail(`${name} is missing from tooling/profiles/test-owner-values/token.json`);
    return entry.value;
  };
  const row = psql(
    secrets,
    `UPDATE token.token_params
        SET total_supply = COALESCE(total_supply, :'supply'::numeric),
            halving_interval = COALESCE(halving_interval, :'halving'::int),
            emission_curve = COALESCE(emission_curve, jsonb_build_object('initialEpochReward', :'reward'::text)),
            updated_at = now()
      WHERE id = true
      RETURNING total_supply::text || ' ' || halving_interval || ' ' || (emission_curve->>'initialEpochReward')`,
    {
      db: DB_NAME,
      user: 'svc_token',
      password: secrets.pgService,
      vars: {
        supply: v('TOKEN_PARAMS_TOTAL_SUPPLY'),
        halving: v('TOKEN_PARAMS_HALVING_INTERVAL'),
        reward: v('TOKEN_PARAMS_INITIAL_EPOCH_REWARD'),
      },
      tuples: true,
    },
  )
    .trim()
    .split('\n')[0];
  if (!row) fail('token.token_params has no row; svc-token has not migrated yet');
  say(`  token_params (supply, halving interval, first-epoch reward): ${row} (LOCAL TEST fixture)`);
}

function cmdAgeLinkedAccounts(args) {
  const [who, hoursRaw] = args;
  if (!who || !hoursRaw) fail('usage: node tooling/scripts/local-test-stack.mjs age-linked-accounts <email-or-userId> <hours>', 2);
  if (!/^[1-9][0-9]{0,3}$/.test(hoursRaw)) fail(`hours must be a whole number from 1 to 9999 (got "${hoursRaw}")`, 2);
  const { secrets, userId } = localFixturePerson(who);
  const moved = psql(
    secrets,
    `UPDATE bank.linked_bank_accounts SET created_at = created_at - make_interval(hours => :'hours'::int)
      WHERE user_id = :'uid' AND removed_at IS NULL RETURNING id`,
    { db: DB_NAME, user: 'svc_bank', password: secrets.pgService, vars: { uid: userId, hours: hoursRaw }, tuples: true },
  )
    .trim()
    .split('\n')
    // psql prints the UPDATE tag after the ids; count the ids alone.
    .filter((line) => /^[0-9a-f-]{36}$/.test(line));
  say(`  ${moved.length} linked account(s) of ${who} now linked ${hoursRaw} hours earlier (LOCAL TEST fixture)`);
}

/**
 * `expire-deposit-addresses <email-or-userId>`: the TEST person's open extra deposit addresses (W-deposit-02) expire now, in
 * custody (svc-pay, whose stored expiry decides a late deposit) and in the bank's list alike, so a journey can show, as
 * J-wallet-02 #4 does, that a deposit to an expired address is held for release, without waiting the TEST window out. The
 * first address never expires and is left alone. It credits nothing, releases nothing and moves no value.
 */
function cmdExpireDepositAddresses(args) {
  const [who] = args;
  if (!who) fail('usage: node tooling/scripts/local-test-stack.mjs expire-deposit-addresses <email-or-userId>', 2);
  const { secrets, userId } = localFixturePerson(who);
  const expire = (schema, role) =>
    psql(
      secrets,
      `UPDATE ${schema}.${schema === 'pay' ? 'custody_deposit_addresses' : 'deposit_addresses'}
          SET expires_at = now() - interval '1 minute'
        WHERE user_id = :'uid' AND address_index > 0 AND expires_at > now() RETURNING address`,
      { db: DB_NAME, user: role, password: secrets.pgService, vars: { uid: userId }, tuples: true },
    )
      .trim()
      .split('\n')
      // psql prints the UPDATE tag after the addresses; count the addresses alone.
      .filter((line) => line && !/^UPDATE \d+$/.test(line));
  const custody = expire('pay', 'svc_pay');
  const listed = expire('bank', 'svc_bank');
  say(
    `  ${custody.length} extra deposit address(es) of ${who} now expired in custody, ${listed.length} in the bank list (LOCAL TEST fixture)`,
  );
}

/**
 * `expire-staff-holds <email-or-userId>`: the TEST person's staff holds that have an expiry (J-ops-console-04, OPS-accounts-desk-01)
 * reach it now, so a journey can show svc-ops' own expiry worker releasing what is left, without waiting the TEST hours out. It
 * only moves the stored expiry; svc-ops checks it against its clock under the hold's lock and posts the release through the
 * ledger itself. A hold without an expiry is left alone, and this releases nothing and moves no value.
 */
function cmdExpireStaffHolds(args) {
  const [who] = args;
  if (!who) fail('usage: node tooling/scripts/local-test-stack.mjs expire-staff-holds <email-or-userId>', 2);
  const { secrets, userId } = localFixturePerson(who);
  const moved = psql(
    secrets,
    `UPDATE ops.staff_holds SET expires_at = now() - interval '1 minute'
      WHERE user_id = :'uid' AND expires_at > now() AND state IN ('active', 'partially_released') RETURNING hold_no`,
    { db: DB_NAME, user: 'svc_ops', password: secrets.pgService, vars: { uid: userId }, tuples: true },
  )
    .trim()
    .split('\n')
    // psql prints the UPDATE tag after the hold numbers; count the numbers alone.
    .filter((line) => /^[0-9]+$/.test(line));
  say(`  ${moved.length} staff hold(s) of ${who} now past their expiry; svc-ops releases them on its next tick (LOCAL TEST fixture)`);
}

/**
 * `seed-notice <email-or-userId> <tradeId>`: one P2P escrow-locked notice in the TEST person's inbox, stored exactly as
 * svc-notify wrote it before PR 5435 moved its targets (`href` `/p2p/trades/<tradeId>`). Rows stored then are never
 * rewritten, so the customer app must still open them (J-home-ia-05 #2). It writes the notice row only: no trade, no
 * escrow, no event, and it moves no value. The same person and trade id is the same row, stored again as new and unread.
 */
function cmdSeedNotice(args) {
  const [who, tradeId] = args;
  if (!who || !tradeId) fail('usage: node tooling/scripts/local-test-stack.mjs seed-notice <email-or-userId> <tradeId>', 2);
  if (!/^[A-Za-z0-9-]{4,64}$/.test(tradeId)) fail('tradeId must be 4-64 letters, digits or dashes', 2);
  const { secrets, userId } = localFixturePerson(who);
  const id = psql(
    secrets,
    `INSERT INTO notify.notifications (user_id, kind, title_key, body_key, params, href, severity, source_subject, source_idempotency_key)
     VALUES (:'uid', 'p2p.escrow.locked', 'notify.p2p.escrow.locked.title', 'notify.p2p.escrow.locked.body',
             coalesce((SELECT params FROM notify.notifications
                        WHERE user_id = :'uid' AND kind = 'p2p.escrow.locked' AND params->>'tradeId' = :'tid'
                          AND source_idempotency_key NOT LIKE 'local-test-old-link:%'
                        ORDER BY created_at LIMIT 1),
                       jsonb_build_object('tradeId', :'tid'::text)),
             '/p2p/trades/' || :'tid', 'action',
             'intafaced.p2p.escrow.locked', 'local-test-old-link:' || :'tid')
     ON CONFLICT (user_id, source_subject, source_idempotency_key)
       DO UPDATE SET href = EXCLUDED.href, read_at = NULL, created_at = now()
     RETURNING id::text`,
    { db: DB_NAME, user: 'svc_notify', password: secrets.pgService, vars: { uid: userId, tid: tradeId }, tuples: true },
  )
    .trim()
    .split('\n')
    .find((line) => /^[0-9a-f-]{36}$/.test(line.trim()));
  if (!id) fail(`no notice was stored for ${who}`);
  say(`  notice ${id.trim()} for ${who} links /p2p/trades/${tradeId}, as stored before PR 5435 (LOCAL TEST fixture)`);
}

/**
 * `age-task-progress <email-or-userId> <campaignId> <days>`: the TEST person's join of one task campaign and the events
 * counted for its steps move `days` back in time (J-campaigns-02 #8), so a journey can show a streak step reset after a
 * missed day without waiting a day out. svc-campaigns reads the streak from these stored times on every read. It writes
 * no event, no reward and moves no value.
 */
function cmdAgeTaskProgress(args) {
  const [who, campaignId, daysRaw] = args;
  if (!who || !campaignId || !daysRaw) {
    fail('usage: node tooling/scripts/local-test-stack.mjs age-task-progress <email-or-userId> <campaignId> <days>', 2);
  }
  const days = Number(daysRaw);
  if (!Number.isInteger(days) || days < 1 || days > 30) fail('days must be a whole number from 1 to 30', 2);
  if (!/^cmp_[0-9a-f-]{36}$/.test(campaignId)) fail('campaignId must be a cmp_<uuid> id', 2);
  const { secrets, userId } = localFixturePerson(who);
  const out = psql(
    secrets,
    `WITH joined AS (
       UPDATE campaigns.participations SET created_at = created_at - make_interval(days => :'days'::int)
        WHERE campaign_id = :'cid' AND lower(account_id) = lower(:'uid') RETURNING 1
     ), moved AS (
       UPDATE campaigns.task_progress SET occurred_at = occurred_at - make_interval(days => :'days'::int)
        WHERE campaign_id = :'cid' AND lower(account_id) = lower(:'uid') RETURNING 1
     )
     SELECT (SELECT count(*) FROM joined) || ' ' || (SELECT count(*) FROM moved)`,
    {
      db: DB_NAME,
      user: 'svc_campaigns',
      password: secrets.pgService,
      vars: { uid: userId, cid: campaignId, days: String(days) },
      tuples: true,
    },
  )
    .trim()
    .split('\n')
    .find((line) => /^[0-9]+ [0-9]+$/.test(line.trim()));
  const [joined, moved] = (out ?? '0 0').trim().split(' ');
  say(`  ${joined} join(s) and ${moved} counted event(s) of ${who} on ${campaignId} moved ${days} day(s) back (LOCAL TEST fixture)`);
}

/**
 * `expire-address-approvals <email-or-userId>`: the TEST person's open withdrawal-address approval links (W-withdraw-09)
 * run out now, so a journey can show, as J-wallet-04 #5 does, that an expired link is refused and a new one is needed,
 * without waiting the TEST lifetime out. Both times move back by the same amount, so a link stays as long as it was
 * issued for. It never marks a link used, never approves an address and moves no value.
 */
function cmdExpireAddressApprovals(args) {
  const [who] = args;
  if (!who) fail('usage: node tooling/scripts/local-test-stack.mjs expire-address-approvals <email-or-userId>', 2);
  const { secrets, userId } = localFixturePerson(who);
  const moved = psql(
    secrets,
    `UPDATE bank.destination_approval_links
        SET created_at = created_at - (expires_at - now()) - interval '1 minute',
            mailed_at = mailed_at - (expires_at - now()) - interval '1 minute',
            expires_at = now() - interval '1 minute'
      WHERE user_id = :'uid' AND used_at IS NULL AND expires_at > now() RETURNING id`,
    { db: DB_NAME, user: 'svc_bank', password: secrets.pgService, vars: { uid: userId }, tuples: true },
  )
    .trim()
    .split('\n')
    .filter((line) => /^[0-9a-f-]{36}$/.test(line));
  say(`  ${moved.length} open address approval link(s) of ${who} now expired (LOCAL TEST fixture)`);
}

// The pool's own reference check, from its build, so a TEST nonce is found exactly as the pool verifies it.
async function miningPow() {
  try {
    return await import(pathToFileURL(path.join(REPO, 'services', 'svc-mining-pool', 'dist', 'pow.js')).href);
  } catch (err) {
    fail(`svc-mining-pool is not built (${err.message}). Run: pnpm local:stack --rebuild`);
  }
}

// One TEST share from a TEST rig through the pool's miner door, at the address the mining room shows. The door's window
// has no published reward or fee, so the share is stored and nothing is ever paid for it. The rig logs in as the
// account's own id and the published worker name for --worker (what the room copies); no --worker is the default
// worker. --pool and --login dial and log in with values copied from the room instead. --secret is the miner secret the
// room issues; without the account's current one the door refuses by name (mining.stratum_secret_invalid).
async function cmdMiningShare(rawArgs) {
  const args = [...rawArgs];
  const take = (flag) => {
    const at = args.indexOf(flag);
    if (at === -1) return undefined;
    const value = args[at + 1];
    args.splice(at, 2);
    if (value === undefined) fail(`${flag} needs a value`, 2);
    return value;
  };
  const worker = take('--worker');
  const label = take('--share');
  const pool = take('--pool');
  const login = take('--login');
  const secret = take('--secret');
  const invalidAt = args.indexOf('--invalid-pow');
  const invalidPow = invalidAt !== -1;
  if (invalidPow) args.splice(invalidAt, 1);
  const [who] = args;
  if (!who || !label)
    fail(
      'usage: node tooling/scripts/local-test-stack.mjs mining-share <email-or-userId> --share <label> [--worker <rig name>] [--pool <host:port>] [--login <account id>.<worker name>] [--secret <miner secret>] [--invalid-pow]',
      2,
    );
  if (!/^[A-Za-z0-9-]{4,64}$/.test(label)) fail('--share must be 4-64 letters, digits or dashes', 2);
  if (worker !== undefined && !/^[A-Za-z0-9_-]{1,64}$/.test(worker)) fail('--worker must be 1-64 letters, digits, dash or underscore', 2);
  if (pool !== undefined && !/^127\.0\.0\.1:\d{1,5}$/.test(pool)) fail('--pool must be 127.0.0.1:<port> (the local stack only)', 2);
  if (login !== undefined && !/^[0-9a-f-]{36}(\.[A-Za-z0-9_.{}-]{1,80})?$/.test(login))
    fail('--login must be <account id>[.<worker name>]', 2);
  if (login !== undefined && worker !== undefined) fail('--login already names the worker; drop --worker', 2);
  if (secret !== undefined && !/^[A-Za-z0-9_-]{1,100}$/.test(secret)) fail('--secret must be the miner secret the room shows', 2);

  if (!fs.existsSync(P.marker)) fail(`refusing: marker ${P.marker} not found. Start the stack first (pnpm local:stack).`);
  const marker = readJson(P.marker);
  if (marker.kind !== 'intafaced-local-test-stack') fail('refusing: marker file is not a local test stack marker');
  const secrets = readJson(P.secrets);
  if (!pgRunning()) fail('refusing: the local stack Postgres is not running. Run: pnpm local:stack');
  if (!ownedAlive(readProcs()['mining-pool'])) fail('refusing: the local stack mining pool is not running. Run: pnpm local:stack');
  // The pool starts from server.js, which the ownership check does not model; the owned-process check above covers it.
  assertActiveLocalStack({ stateDir: STATE });
  const found = psql(secrets, `SELECT id::text FROM identity.users WHERE email = :'who' OR id::text = :'who'`, {
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
  const [userId] = found;

  const shareId = `LOCAL-TEST-${label}`;
  // The rig finds a nonce with the TEST proof-of-work parameters the pool's job names, against the pool's own header for
  // the door's window, the account and the rig; --invalid-pow sends a nonce that misses the target. A pool started with
  // LOCAL_STACK_MINING_POOL_POW=off has no parameters and refuses the rig by name (mining.pow_spec_unset).
  const pow = await miningPow();
  const published = profileEnvFor('mining-pool', 'dev');
  const [host, port] = (pool ?? `${published.MINING_POOL_HOST}:${published.MINING_POOL_PORT}`).split(':');
  const workerName = worker === undefined ? null : published.MINING_WORKER_NAME_PATTERN.replace('{worker}', worker);
  // Each share searches from its own start, derived from its label, so two shares of one rig never send the same work,
  // and one label sent again sends the same work (the pool refuses repeated work in a window as mining.share_duplicate).
  const start = Number.parseInt(crypto.createHash('sha256').update(shareId).digest('hex').slice(0, 12), 16);
  const { rigShare } = await import('./local-test-mining-rig.mjs');
  let result;
  try {
    result = await rigShare({
      host,
      port: Number(port),
      login: login ?? (workerName ? `${userId}.${workerName}` : userId),
      pow,
      start,
      invalid: invalidPow,
      secret,
    });
  } catch (err) {
    fail(`the TEST rig could not reach the pool's miner door at ${host}:${port}: ${err.message}`);
  }
  const powNote = `TEST testnet proof of work, ${invalidPow ? 'invalid' : 'valid'} nonce ${result.nonce}`;
  // The same work again is refused by name; that is the pool's answer, not a tool failure.
  if (result.code === 'mining.share_duplicate') {
    console.log(`refused mining.share_duplicate: TEST share ${shareId}, or its work, is already stored; nothing new was kept`);
    return;
  }
  // A share whose work misses the target is refused by name and stored nowhere but the pool's rejection log.
  if (invalidPow && result.code === 'mining.pow_invalid') {
    console.log(`refused mining.pow_invalid: TEST share ${shareId} (${powNote}); nothing was kept`);
    return;
  }
  // A rig without the account's current miner secret is refused by name before the door touches the account.
  if (result.code === 'mining.stratum_secret_invalid') {
    console.log(`refused mining.stratum_secret_invalid: the miner secret is missing or wrong, so TEST share ${shareId} was not sent`);
    return;
  }
  if (result.code === 'mining.pow_spec_unset') {
    console.log(`refused mining.pow_spec_unset: the pool has no proof-of-work parameters, so TEST share ${shareId} was not kept`);
    return;
  }
  if (!result.ok) fail(`the pool refused the TEST share: ${result.code}`);
  console.log(
    `accepted TEST share ${shareId} for miner ${userId}, ${login === undefined ? `worker ${worker ?? 'default'}` : `login ${login}`}, ${powNote} through the miner door at ${host}:${port} (unpaid window, nothing credited)`,
  );
}

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

/**
 * `seed-withdrawal <email-or-userId> <ASSET> <amount> --state requested|held|dispatching|broadcast|sent|failed --ref <label>
 * [--failure-code <code>]`: one TEST
 * withdrawal of the person's own funds, in the state a journey starts from (J-wallet-06). Sending out is switched off in
 * svc-pay (its withdraw feature is published `blocked`), so no withdrawal can reach these states through the Withdraw form on
 * this stack. This writes the row the way svc-pay's `withdraw` leaves it at that point and books the hold through the ledger's
 * own recipe (`withdrawHold`, keyed on the attempt), exactly as `withdraw` does, hold first. `requested`: a row and nothing
 * posted. `held`: the hold booked and the row held, nothing asked of a rail. `dispatching`: a send journalled `requested` with no
 * answer (a lost reply). `broadcast`: the send journalled `accepted` with a TEST transaction reference. `sent`: broadcast, then
 * settled as `withdraw` settles it (`withdrawSettle` under the same attempt, the row `sent` with its TEST reference), so a
 * return can be recorded against it (J-wallet-06 #6). `failed` (with `--failure-code`, required for it): held, the send journalled
 * `refused`, then the hold reversed under the same attempt (`withdrawReverse`) and the row `failed` with that code and its attempt
 * advanced, as `withdraw` finishes a rail refusal (J-wallet-05 #8). What the person can do
 * next (cancel, and what that gives back) is svc-pay's own code. The same --ref is the same withdrawal. `--count <n>` (requested
 * only) writes n requested withdrawals one second apart, for a history longer than one page (J-wallet-06 #5).
 */
async function cmdSeedWithdrawal(rawArgs) {
  const args = [...rawArgs];
  const option = (name) => {
    const at = args.indexOf(name);
    if (at === -1) return undefined;
    const value = args[at + 1];
    args.splice(at, 2);
    return value;
  };
  const state = option('--state');
  const ref = option('--ref');
  const countRaw = option('--count');
  const failureCode = option('--failure-code');
  const [who, assetRaw, amountStr] = args;
  const usage =
    'usage: node tooling/scripts/local-test-stack.mjs seed-withdrawal <email-or-userId> <ASSET> <amount> --state requested|held|dispatching|broadcast|sent|failed --ref <label> [--count <n>, requested only] [--failure-code <code>, failed only]';
  if (!who || !assetRaw || !amountStr || !state || !ref) fail(usage, 2);
  if (!['requested', 'held', 'dispatching', 'broadcast', 'sent', 'failed'].includes(state))
    fail(`--state must be requested, held, dispatching, broadcast, sent or failed (got "${state}")`, 2);
  if ((state === 'failed') !== (failureCode !== undefined)) fail('--failure-code goes with --state failed, and only with it', 2);
  if (failureCode !== undefined && !/^[a-z][a-z_]*(\.[a-z_]+)+$/.test(failureCode))
    fail(`--failure-code must be a dotted code like rail.refused (got "${failureCode}")`, 2);
  if (!/^[A-Za-z0-9-]{4,48}$/.test(ref)) fail('--ref must be 4-48 letters, digits or dashes', 2);
  const asset = assetRaw.toUpperCase();
  if (!/^[A-Z0-9]{2,12}$/.test(asset)) fail(`bad asset id: ${assetRaw}`, 2);
  if (!AMOUNT_RE.test(amountStr)) fail(`amount must be a plain decimal string like 40 or 12.5 (got "${amountStr}")`, 2);
  if (countRaw !== undefined && (!/^\d{1,3}$/.test(countRaw) || Number(countRaw) < 1 || Number(countRaw) > 500))
    fail(`--count must be a whole number from 1 to 500 (got "${countRaw}")`, 2);
  if (countRaw !== undefined && state !== 'requested') fail('--count writes requested withdrawals only (nothing is held for them)', 2);
  const { secrets, userId } = localFixturePerson(who);
  if (!ownedAlive(readProcs().ledger)) fail('refusing: the local stack ledger is not running. Run: pnpm local:stack');
  const asPay = (sql, vars) =>
    psql(secrets, sql, { db: DB_NAME, user: 'svc_pay', password: secrets.pgService, vars, tuples: true })
      .trim()
      .split('\n')
      .filter((line) => line && !/^(INSERT|UPDATE) \d+( \d+)?$/.test(line));

  if (countRaw !== undefined) {
    // A long history (J-wallet-06 #5): <count> requested withdrawals, one second apart, the newest now. Nothing is posted for
    // a requested withdrawal, so no ledger call is made. References are `<ref>-<n>`; the same --ref is the same rows.
    const count = Number(countRaw);
    asPay(
      `INSERT INTO pay.withdrawals (user_id, asset_id, amount, rail, destination, client_ref, status, attempts, created_at, updated_at)
       SELECT :'uid', :'asset', :'amount'::numeric, 'crypto-native',
              jsonb_build_object('kind', 'crypto', 'ref', '0x' || substr(md5(:'ref' || '-to-' || n), 1, 40)),
              :'ref' || '-' || n, 'pending', 0, now() - (n || ' seconds')::interval, now()
         FROM generate_series(1, :'count'::int) AS n
       ON CONFLICT (user_id, client_ref) DO NOTHING`,
      { uid: userId, asset, amount: amountStr, ref: `local-test-${ref}`, count: String(count) },
    );
    const [found] = asPay(
      `SELECT count(*)::text FROM pay.withdrawals
        WHERE user_id = :'uid' AND status = 'pending' AND asset_id = :'asset' AND amount = :'amount'::numeric
          AND client_ref IN (SELECT :'ref' || '-' || n FROM generate_series(1, :'count'::int) AS n)`,
      { uid: userId, ref: `local-test-${ref}`, asset, amount: amountStr, count: String(count) },
    );
    if (Number(found) !== count) fail(`--ref ${ref} already names other withdrawals (${found} of ${count} match); use a new --ref`, 2);
    say(`TEST withdrawals (LOCAL TEST, not real money)`);
    say(`  withdrawals ${count}`);
    say(`  state       requested   ${asset} ${amountStr} each   references local-test-${ref}-1..${count}`);
    return;
  }

  const clientRef = `local-test-${ref}`;
  const txRef = `0x${crypto.createHash('sha256').update(`seed-withdrawal:${ref}`).digest('hex')}`;
  const destination = JSON.stringify({
    kind: 'crypto',
    ref: `0x${crypto.createHash('sha256').update(`seed-withdrawal-to:${ref}`).digest('hex').slice(0, 40)}`,
  });
  asPay(
    `INSERT INTO pay.withdrawals (user_id, asset_id, amount, rail, destination, client_ref, status, attempts)
     VALUES (:'uid', :'asset', :'amount'::numeric, 'crypto-native', :'dest'::jsonb, :'ref', 'pending', 0)
     ON CONFLICT (user_id, client_ref) DO NOTHING`,
    { uid: userId, asset, amount: amountStr, dest: destination, ref: clientRef },
  );
  const [found] = asPay(
    `SELECT id::text || E'\\t' || status::text || E'\\t' || amount::text || E'\\t' || asset_id FROM pay.withdrawals
      WHERE user_id = :'uid' AND client_ref = :'ref'`,
    { uid: userId, ref: clientRef },
  );
  if (!found) fail('svc-pay has no row for that reference after the insert');
  const [id, stored, storedAmount, storedAsset] = found.split('\t');
  const load = (pkg) => import(pathToFileURL(path.join(REPO, 'packages', pkg, 'dist', 'index.js')).href);
  let ledgerClient, contracts;
  try {
    [ledgerClient, contracts] = await Promise.all([load('ledger-client'), load('contracts')]);
  } catch (err) {
    fail(`packages are not built (${err.message}). Run: pnpm local:stack --rebuild`);
  }
  if (ledgerClient.parseAmount(storedAmount) !== ledgerClient.parseAmount(amountStr) || storedAsset !== asset)
    fail(`--ref ${ref} already names a withdrawal of ${storedAmount} ${storedAsset}`, 2);

  // One TEST post of a withdrawal recipe for attempt 0, through the ledger's own door, as `withdraw` posts it.
  const post = async (recipe, label) => {
    const request = ledgerClient.recipes[recipe]({
      userId,
      assetId: asset,
      amount: ledgerClient.parseAmount(amountStr),
      rail: 'crypto-native',
      withdrawalId: `${id}:0`,
    });
    const raw = JSON.stringify({
      idempotencyKey: request.idempotencyKey,
      module: request.module,
      reason: request.reason,
      meta: { ...request.meta, label },
      entries: request.entries.map((e) => ({ account: e.account, direction: e.direction, amount: ledgerClient.formatAmount(e.amount) })),
    });
    const res = await fetch(`${urlOf('ledger')}/trpc/post`, {
      redirect: 'error',
      method: 'POST',
      headers: { 'content-type': 'application/json', ...contracts.serviceAuthHeadersForBody('local-test-fund', secrets.internal, raw) },
      body: raw,
    });
    if (!res.ok) fail(`ledger refused the TEST ${recipe} (${res.status}): ${(await res.text()).slice(0, 400)}`);
  };
  // A failed seed starts from a fresh row: a reference already seeded in another state is refused before anything is
  // posted or journalled, never turned into failed.
  if (state === 'failed' && stored !== 'pending' && stored !== 'failed')
    fail(`--ref ${ref} already names a withdrawal that is ${stored}, not failed; use a new --ref`, 2);
  if (state !== 'requested' && stored === 'pending') {
    // The hold first, as `withdraw` posts it: funds leave available for a hold that names this withdrawal and attempt 0.
    await post('withdrawHold', 'LOCAL TEST withdrawal hold, not real money');
    asPay(
      `UPDATE pay.withdrawals SET status = 'held', dispatch_journaled = true, updated_at = now() WHERE id = :'id' AND status = 'pending'`,
      {
        id,
      },
    );
  }
  if (state === 'dispatching' || state === 'broadcast' || state === 'sent' || state === 'failed') {
    const outcome = { dispatching: 'requested', failed: 'refused' }[state] ?? 'accepted';
    asPay(
      `INSERT INTO pay.withdrawal_rail_attempts (withdrawal_id, attempt, outcome, rail_ref)
       VALUES (:'id', 0, :'outcome', NULLIF(:'tx', '')) ON CONFLICT DO NOTHING`,
      { id, outcome, tx: outcome === 'accepted' ? txRef : '' },
    );
  }
  if (state === 'failed' && stored !== 'failed') {
    // The rail refused it: the code stamped while held, the hold reversed under the same attempt, then the row failed with its
    // attempt advanced, as `withdraw` finishes a refusal. A reused reference whose send was not refused is refused here.
    const [outcome] = asPay(`SELECT outcome FROM pay.withdrawal_rail_attempts WHERE withdrawal_id = :'id' AND attempt = 0`, { id });
    if (outcome !== 'refused')
      fail(`--ref ${ref} already names a withdrawal whose send is ${outcome ?? 'not journalled'}, not refused; use a new --ref`, 2);
    asPay(`UPDATE pay.withdrawals SET failure_code = :'code', updated_at = now() WHERE id = :'id' AND status = 'held'`, {
      id,
      code: failureCode,
    });
    await post('withdrawReverse', 'LOCAL TEST withdrawal reverse, not real money');
    asPay(
      `UPDATE pay.withdrawals SET status = 'failed', attempts = attempts + 1, updated_at = now() WHERE id = :'id' AND status = 'held'`,
      { id },
    );
  }
  if (state === 'sent' && stored !== 'sent') {
    // The rail sent it: the settle under the same attempt, then the row, as `withdraw` does once a send is accepted. A
    // reused reference whose send is not accepted (a dispatching one) is refused before anything is posted.
    const [outcome] = asPay(`SELECT outcome FROM pay.withdrawal_rail_attempts WHERE withdrawal_id = :'id' AND attempt = 0`, { id });
    if (outcome !== 'accepted')
      fail(`--ref ${ref} already names a withdrawal whose send is ${outcome ?? 'not journalled'}, not sent; use a new --ref`, 2);
    chainRecord({
      key: `withdrawal:${id}:0`,
      direction: 'out',
      assetId: asset,
      amount: ledgerClient.formatAmount(ledgerClient.parseAmount(amountStr)),
    });
    await post('withdrawSettle', 'LOCAL TEST withdrawal settle, not real money');
    asPay(`UPDATE pay.withdrawals SET status = 'sent', rail_ref = :'tx', updated_at = now() WHERE id = :'id' AND status = 'held'`, {
      id,
      tx: txRef,
    });
  }
  // Read back what svc-pay holds: a reference reused for another state is refused, never reported as the state asked for.
  const [after] = asPay(
    `SELECT w.status::text || E'\\t' || coalesce(a.outcome, 'none') || E'\\t' || coalesce(w.failure_code, '') FROM pay.withdrawals w
       LEFT JOIN pay.withdrawal_rail_attempts a ON a.withdrawal_id = w.id AND a.attempt = w.attempts
      WHERE w.id = :'id'`,
    { id },
  );
  const [nowStored, journal, storedCode] = (after ?? '').split('\t');
  const reached = {
    pending: 'requested',
    held: { none: 'held', requested: 'dispatching', accepted: 'broadcast' }[journal],
    sent: journal === 'accepted' ? 'sent' : undefined,
    // A failed row's attempt has advanced past the refused one, so its own attempt has no journal row.
    failed: journal === 'none' && storedCode === failureCode ? 'failed' : undefined,
  }[nowStored];
  if (state === 'failed' && nowStored === 'failed' && storedCode !== failureCode)
    fail(`--ref ${ref} already names a withdrawal that failed with ${storedCode || 'no code'}, not ${failureCode}; use a new --ref`, 2);
  if (reached !== state) fail(`--ref ${ref} already names a withdrawal that is ${reached ?? nowStored}, not ${state}; use a new --ref`, 2);
  say(`TEST withdrawal (LOCAL TEST, not real money)`);
  say(`  withdrawal ${id}`);
  say(`  state      ${state}   ${asset} ${amountStr}   reference ${clientRef}`);
}

/**
 * `chain-deposit <address> <ASSET> <amount> <confirmations> --tx <label> [--index <n>]`: a TEST chain transfer to a deposit
 * address the stack issued, delivered to svc-pay's own `/webhooks/crypto-native` exactly as its chain watcher would (the
 * stack's chain is in memory and has no watcher). Signed with this stack's crypto webhook secret. The transaction hash comes
 * from the address and the label, so the same label to the same address is the same transfer: sending it again (with a higher confirmation count, or the same)
 * is a repeat of one chain event, never a second deposit. svc-pay decides what it is worth; nothing here touches the ledger.
 */
async function cmdChainDeposit(rawArgs) {
  const { args, label, index } = chainArgs(rawArgs);
  const [address, assetRaw, amountStr, confirmationsStr, ...extra] = args;
  if (!address || !assetRaw || !amountStr || !confirmationsStr || !label || extra.length > 0)
    fail(
      'usage: node tooling/scripts/local-test-stack.mjs chain-deposit <address> <ASSET> <decimal-amount> <confirmations> --tx <label> [--index <n>]',
      2,
    );
  const asset = assetRaw.toUpperCase();
  if (!/^[A-Z0-9]{2,12}$/.test(asset)) fail(`bad asset id: ${assetRaw}`, 2);
  if (!AMOUNT_RE.test(amountStr)) fail(`amount must be a plain decimal string like 100 or 12.5 (got "${amountStr}")`, 2);
  if (!/^\d{1,4}$/.test(confirmationsStr)) fail(`confirmations must be a whole number (got "${confirmationsStr}")`, 2);
  if (address.length > 200 || /\s/.test(address)) fail('bad deposit address', 2);

  const txHash = chainTxHash(address, label);
  const logIndex = Number(index ?? '0');
  assertChainDelivery();
  // Only a transfer into the stack's own custody counts on its statement: an address svc-pay issued, once the chain holds it final.
  if (Number(confirmationsStr) >= TEST_CHAIN_FINALITY && custodyAddress(address))
    chainRecord({ key: `${txHash}:${logIndex}`, direction: 'in', assetId: asset, amount: canonicalAmount(amountStr) });
  const text = await deliverChainEvent({
    id: `chain:${txHash}:${address}:${logIndex}`,
    type: 'captured',
    ref: address,
    amount: amountStr,
    assetId: asset,
    occurredAt: new Date().toISOString(),
    txHash,
    logIndex,
    from: '0xTEST-sender',
    confirmations: Number(confirmationsStr),
  });
  say('TEST chain delivery to svc-pay (in-memory TEST chain, not real money)');
  say(`  to        ${address}`);
  say(`  amount    ${amountStr} ${asset}, ${confirmationsStr} confirmations`);
  say(`  tx        ${txHash}:${logIndex}   (label ${label})`);
  say(`  answer    ${text}`);
}

/**
 * The `--tx <label>` and `--index <n>` options `chain-deposit` and `chain-reorg` share, so one label always names the same
 * transfer in both. Returns the positional arguments left.
 */
function chainArgs(rawArgs) {
  const args = [...rawArgs];
  const option = (name, re, what) => {
    const at = args.indexOf(name);
    if (at === -1) return undefined;
    const value = args[at + 1];
    args.splice(at, 2);
    if (!value || !re.test(value)) fail(`${name} must be ${what}`, 2);
    return value;
  };
  const label = option('--tx', /^[A-Za-z0-9-]{4,64}$/, '4-64 letters, digits or dashes');
  const index = option('--index', /^\d{1,4}$/, 'a whole number');
  if (args.some((arg) => arg.startsWith('--'))) fail(`unknown option: ${args.find((arg) => arg.startsWith('--'))}`, 2);
  return { args, label, index };
}

/** The TEST transaction hash of `label` to `address`: the same label to the same address is the same transfer, another address another one. */
export function chainTxHash(address, label) {
  return `0x${crypto.createHash('sha256').update(`local-test-chain-deposit:${address}:${label}`).digest('hex')}`;
}

/**
 * Confirmations at which the TEST chain holds a transfer final on its own statement. It is the chain's own rule, not read from
 * svc-pay: if the platform ever credits below it, a run shows that credit as a gap, which is what it is.
 */
const TEST_CHAIN_FINALITY = 6;

/** `amount` as the ledger writes it (no leading or trailing zeros), so a repeat of one transfer is recorded with the same facts. */
function canonicalAmount(amount) {
  const [whole, frac = ''] = amount.split('.');
  const digits = frac.replace(/0+$/, '');
  return `${BigInt(whole)}${digits ? `.${digits}` : ''}`;
}

/** Whether svc-pay issued `address` as a deposit address: the custodian's own list of its addresses, not a ledger figure. */
function custodyAddress(address) {
  const secrets = readJson(P.secrets);
  const found = psql(secrets, `SELECT 1 FROM pay.custody_deposit_addresses WHERE lower(address) = lower(:'address') LIMIT 1`, {
    db: DB_NAME,
    user: 'svc_pay',
    password: secrets.pgService,
    vars: { address },
    tuples: true,
  });
  return found.trim() === '1';
}

/** The TEST chain's records so far, refused by name when the file cannot be read. */
function chainRecords() {
  try {
    return readRail(STATE, 'crypto-native');
  } catch (err) {
    if (err instanceof RailRecordError) fail(`refusing: the TEST chain record: ${err.message}`, 2);
    throw err;
  }
}

/**
 * The TEST chain's own record of a movement on rail crypto-native (local-test-rail-records.mjs), written before svc-pay or the
 * ledger hears of it, so the stack's outside source reads what the chain did, never the ledger.
 */
function chainRecord(movement) {
  try {
    recordRailMovement(STATE, { rail: 'crypto-native', ...movement });
  } catch (err) {
    if (err instanceof RailRecordError) fail(`refusing: the TEST chain record: ${err.message}`, 2);
    throw err;
  }
}

/** Guards: a chain event only ever goes to the local stack's own svc-pay. Returns the stack's crypto webhook secret. */
function assertChainDelivery() {
  if (!fs.existsSync(P.marker)) fail(`refusing: marker ${P.marker} not found. Start the stack first (pnpm local:stack).`);
  if (readJson(P.marker).kind !== 'intafaced-local-test-stack') fail('refusing: marker file is not a local test stack marker');
  if (!ownedAlive(readProcs().pay)) fail('refusing: the local stack svc-pay is not running. Run: pnpm local:stack');
  assertActiveLocalStack({ stateDir: STATE, services: ['pay'] });
  const secret = readJson(P.secrets).payCryptoWebhook;
  if (!secret) fail('refusing: this stack has no crypto webhook secret. Run: pnpm local:stack --rebuild');
  return secret;
}

/** Signs one chain watcher event with this stack's crypto webhook secret and delivers it to the stack's own svc-pay. Returns its answer. */
async function deliverChainEvent(event) {
  const secret = assertChainDelivery();
  const body = JSON.stringify(event);
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = crypto.createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
  const res = await fetch(`${urlOf('pay')}/webhooks/crypto-native`, {
    method: 'POST',
    redirect: 'error',
    headers: { 'content-type': 'application/json', 'x-chain-signature': signature, 'x-chain-timestamp': timestamp },
    body,
  });
  const text = await res.text();
  if (res.status !== 200) fail(`svc-pay refused the TEST chain delivery (${res.status}): ${text.slice(0, 400)}`);
  return text;
}

/**
 * `chain-reorg <address> --tx <label> [--index <n>]`: the TEST chain takes back the transfer `chain-deposit` delivered with
 * that label to that address, as a chain watcher reports a reorg (W-deposit-06): a `chain.reorged` event to svc-pay's own
 * `/webhooks/crypto-native`, signed with the stack's secret. svc-pay decides what that means (closed, reversed through the
 * ledger, or needs review when the funds were spent); nothing here touches the ledger. A repeat is the same report.
 */
async function cmdChainReorg(rawArgs) {
  const { args, label, index } = chainArgs(rawArgs);
  const [address, ...extra] = args;
  if (!address || !label || extra.length > 0)
    fail('usage: node tooling/scripts/local-test-stack.mjs chain-reorg <address> --tx <label> [--index <n>]', 2);
  if (address.length > 200 || /\s/.test(address)) fail('bad deposit address', 2);
  const txHash = chainTxHash(address, label);
  const logIndex = Number(index ?? '0');
  assertChainDelivery();
  const final = chainRecords().find((row) => row.key === `${txHash}:${logIndex}`);
  if (final) chainRecord({ key: `reorg:${txHash}:${logIndex}`, direction: 'out', assetId: final.assetId, amount: final.amount });
  const text = await deliverChainEvent({
    id: `reorg:${txHash}:${address}:${logIndex}`,
    type: 'chain.reorged',
    ref: address,
    occurredAt: new Date().toISOString(),
    txHash,
    logIndex,
    confirmations: 0,
  });
  say('TEST chain reorg delivered to svc-pay (in-memory TEST chain, not real money)');
  say(`  at        ${address}`);
  say(`  tx        ${txHash}:${logIndex}   (label ${label})`);
  say(`  answer    ${text}`);
}

/**
 * `bank-transfer <reference> <CCY> <amount> --tx <label> [--payer <name>]`: the TEST bank reports a pushed transfer quoting
 * the reference a hosted checkout showed (J-merchant-04 step 6), to svc-pay's own `/webhooks/bank-transfer-sandbox`, signed
 * with this stack's TEST bank secret. `--payer` is the name on the sending account as the bank reports it; leave it out
 * for a bank that reports none. The transfer id comes from the reference and the label, so the same label is the same
 * transfer, never a second one. svc-pay checks the name and decides; nothing here touches the ledger.
 */
async function cmdBankTransfer(rawArgs) {
  const args = [...rawArgs];
  const option = (name) => {
    const at = args.indexOf(name);
    if (at === -1) return undefined;
    const value = args[at + 1];
    args.splice(at, 2);
    if (value === undefined) fail(`${name} needs a value`, 2);
    return value;
  };
  const label = option('--tx');
  const payer = option('--payer');
  const usage =
    'usage: node tooling/scripts/local-test-stack.mjs bank-transfer <reference> <CCY> <decimal-amount> --tx <label> [--payer <name>]';
  if (args.some((arg) => arg.startsWith('--'))) fail(`unknown option: ${args.find((arg) => arg.startsWith('--'))}`, 2);
  const [reference, currencyRaw, amountStr, ...extra] = args;
  if (!reference || !currencyRaw || !amountStr || !label || extra.length > 0) fail(usage, 2);
  if (!/^BT[0-9A-F]{12}$/.test(reference)) fail(`bad reference: ${reference} (the hosted checkout shows one like BT1A2B3C4D5E6F)`, 2);
  const currency = currencyRaw.toUpperCase();
  if (!/^[A-Z0-9]{2,12}$/.test(currency)) fail(`bad currency: ${currencyRaw}`, 2);
  if (!AMOUNT_RE.test(amountStr)) fail(`amount must be a plain decimal string like 100 or 12.5 (got "${amountStr}")`, 2);
  if (!/^[A-Za-z0-9-]{4,64}$/.test(label)) fail('--tx must be 4-64 letters, digits or dashes', 2);
  if (payer !== undefined && (!payer.trim() || payer.length > 140)) fail('--payer must be 1-140 characters', 2);

  // Guards: this only ever talks to the local stack's own svc-pay.
  if (!fs.existsSync(P.marker)) fail(`refusing: marker ${P.marker} not found. Start the stack first (pnpm local:stack).`);
  if (readJson(P.marker).kind !== 'intafaced-local-test-stack') fail('refusing: marker file is not a local test stack marker');
  if (!ownedAlive(readProcs().pay)) fail('refusing: the local stack svc-pay is not running. Run: pnpm local:stack');
  assertActiveLocalStack({ stateDir: STATE, services: ['pay'] });
  const secret = readJson(P.secrets).payBankTransferWebhook;
  if (!secret) fail('refusing: this stack has no TEST bank webhook secret. Run: pnpm local:stack --rebuild');

  const transferId = `bt:${crypto.createHash('sha256').update(`local-test-bank-transfer:${reference}:${label}`).digest('hex').slice(0, 32)}`;
  const body = JSON.stringify({
    id: transferId,
    type: 'captured',
    ref: reference,
    amount: amountStr,
    assetId: currency,
    occurredAt: new Date().toISOString(),
    ...(payer === undefined ? {} : { payerName: payer }),
  });
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = crypto.createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
  const res = await fetch(`${urlOf('pay')}/webhooks/bank-transfer-sandbox`, {
    method: 'POST',
    redirect: 'error',
    headers: { 'content-type': 'application/json', 'x-bank-signature': signature, 'x-bank-timestamp': timestamp },
    body,
  });
  const text = await res.text();
  if (res.status !== 200) fail(`svc-pay refused the TEST bank delivery (${res.status}): ${text.slice(0, 400)}`);
  say('TEST bank transfer delivered to svc-pay (TEST bank, not real money)');
  say(`  reference ${reference}`);
  say(`  amount    ${amountStr} ${currency}`);
  say(`  from      ${payer ?? '(no name reported)'}`);
  say(`  transfer  ${transferId}   (label ${label})`);
  say(`  answer    ${text}`);
}

/**
 * `card-funds <paymentId> available|pending [--on <ISO date>]`: the TEST card acquirer reports that the funds of one card
 * payment it captured are released (`available`) or still held, optionally until a named day (`pending --on`), to svc-pay's
 * own `/webhooks/card-sandbox`, signed with this stack's TEST card webhook secret (RC-merchant-10). The payment must have
 * been taken with the held-funds TEST token, or svc-pay ignores the report. The event id comes from the payment and the
 * report, so sending it again is the same delivery, never a second release. Nothing here touches the ledger.
 */
async function cmdCardFunds(rawArgs) {
  const args = [...rawArgs];
  const at = args.indexOf('--on');
  const on = at === -1 ? undefined : args[at + 1];
  if (at !== -1) args.splice(at, 2);
  const usage = 'usage: node tooling/scripts/local-test-stack.mjs card-funds <paymentId> available|pending [--on <ISO date>]';
  if (args.some((arg) => arg.startsWith('--'))) fail(`unknown option: ${args.find((arg) => arg.startsWith('--'))}`, 2);
  const [paymentId, state, ...extra] = args;
  if (!paymentId || !state || extra.length > 0) fail(usage, 2);
  if (!/^[0-9a-f-]{36}$/i.test(paymentId)) fail(`bad payment id: ${paymentId}`, 2);
  if (state !== 'available' && state !== 'pending') fail(usage, 2);
  if (on !== undefined && (state !== 'pending' || Number.isNaN(Date.parse(on)))) fail('--on takes an ISO date, with pending only', 2);

  // Guards: this only ever talks to the local stack's own svc-pay.
  if (!fs.existsSync(P.marker)) fail(`refusing: marker ${P.marker} not found. Start the stack first (pnpm local:stack).`);
  if (readJson(P.marker).kind !== 'intafaced-local-test-stack') fail('refusing: marker file is not a local test stack marker');
  if (!ownedAlive(readProcs().pay)) fail('refusing: the local stack svc-pay is not running. Run: pnpm local:stack');
  assertActiveLocalStack({ stateDir: STATE, services: ['pay'] });
  const secret = readJson(P.secrets).payCardWebhook;
  if (!secret) fail('refusing: this stack has no TEST card webhook secret. Run: pnpm local:stack --rebuild');

  const body = JSON.stringify({
    id: `funds:${paymentId}:${state}${on ? `:${on}` : ''}`,
    type: `funds.${state}`,
    ref: `ch_${paymentId}`,
    occurredAt: new Date().toISOString(),
    ...(on ? { availableOn: new Date(on).toISOString() } : {}),
  });
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = crypto.createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
  const res = await fetch(`${urlOf('pay')}/webhooks/card-sandbox`, {
    method: 'POST',
    redirect: 'error',
    headers: { 'content-type': 'application/json', 'x-sandbox-signature': signature, 'x-sandbox-timestamp': timestamp },
    body,
  });
  const text = await res.text();
  if (res.status !== 200) fail(`svc-pay refused the TEST card delivery (${res.status}): ${text.slice(0, 400)}`);
  say('TEST card funds report delivered to svc-pay (TEST acquirer, not real money)');
  say(`  payment   ${paymentId}`);
  say(`  funds     ${state}${on ? ` until ${on}` : ''}`);
  say(`  answer    ${text}`);
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

/**
 * LOCAL TEST clock for one account's address book: moves the saved and last-changed times of every address the
 * account saved back by whole hours, standing in for the cooling-off wait (BANK_OFFRAMP_COOLING_HOURS) a journey cannot
 * sit through. Only this stack's database, only addresses the customer saved, and nothing that holds or moves value.
 */
function cmdAgeAddresses(args) {
  const [who, hoursRaw] = args;
  if (!who || !/^[1-9]\d{0,3}$/.test(hoursRaw ?? ''))
    fail('usage: node tooling/scripts/local-test-stack.mjs age-addresses <email-or-userId> <whole hours, 1 to 9999>', 2);
  if (!fs.existsSync(P.marker)) fail(`refusing: marker ${P.marker} not found. Start the stack first (pnpm local:stack).`);
  const marker = readJson(P.marker);
  if (marker.kind !== 'intafaced-local-test-stack') fail('refusing: marker file is not a local test stack marker');
  if (!pgRunning()) fail('refusing: the local stack Postgres is not running. Run: pnpm local:stack');
  const secrets = readJson(P.secrets);
  const ids = psql(secrets, `SELECT id::text FROM identity.users WHERE email = :'who' OR id::text = :'who'`, {
    db: DB_NAME,
    user: 'svc_identity',
    password: secrets.pgService,
    vars: { who },
    tuples: true,
  })
    .trim()
    .split('\n')
    .filter(Boolean);
  if (ids.length !== 1) fail(`"${who}" matches ${ids.length} users in the local identity database`);
  const moved = psql(
    secrets,
    `WITH moved AS (UPDATE bank.user_withdraw_destinations
        SET created_at = created_at - make_interval(hours => :'hours'::int), updated_at = updated_at - make_interval(hours => :'hours'::int)
      WHERE user_id = :'user' AND origin = 'customer' RETURNING 1) SELECT count(*) FROM moved`,
    { db: DB_NAME, user: 'svc_bank', password: secrets.pgService, vars: { user: ids[0], hours: hoursRaw }, tuples: true },
  ).trim();
  say(`  LOCAL TEST: ${moved} saved address(es) of ${who} moved back ${hoursRaw} hours`);
}

if (runningAsCli()) await runCli();

async function runCli() {
  const [cmd = 'start', ...rest] = process.argv.slice(2);
  if (cmd === '__serve-customer')
    serveCustomer(Number(rest[0]) || PORTS.customer); // the port argument is for tests only
  else if (cmd === '__serve-invitation') serveCustomer(PORTS.invitation, SITES.invitation);
  else if (cmd === '__serve-apex') serveCustomer(PORTS.apex, SITES.apex);
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
  else if (cmd === 'csp-report') cmdCspReport(rest);
  else if (cmd === 'restart') await cmdRestart(rest);
  else if (cmd === 'fund') await cmdFund(rest);
  else if (cmd === 'mining-share') await cmdMiningShare(rest);
  else if (cmd === 'seed-withdrawal') await cmdSeedWithdrawal(rest);
  else if (cmd === 'chain-deposit') await cmdChainDeposit(rest);
  else if (cmd === 'chain-reorg') await cmdChainReorg(rest);
  else if (cmd === 'bank-transfer') await cmdBankTransfer(rest);
  else if (cmd === 'card-funds') await cmdCardFunds(rest);
  else if (cmd === 'age-linked-accounts') cmdAgeLinkedAccounts(rest);
  else if (cmd === 'token-params') cmdTokenParams();
  else if (cmd === 'expire-address-approvals') cmdExpireAddressApprovals(rest);
  else if (cmd === 'expire-deposit-addresses') cmdExpireDepositAddresses(rest);
  else if (cmd === 'expire-staff-holds') cmdExpireStaffHolds(rest);
  else if (cmd === 'age-task-progress') cmdAgeTaskProgress(rest);
  else if (cmd === 'seed-notice') cmdSeedNotice(rest);
  else if (cmd === 'age-addresses') cmdAgeAddresses(rest);
  else if (cmd === 'customer-dist') cmdCustomerDist(rest);
  else if (cmd === 'status') {
    const ok = await healthTable({ gateMarket: true });
    say('');
    say(`  ${describeCustomerDist()}`);
    process.exit(ok ? 0 : 1);
  } else
    fail(
      `unknown command "${cmd}". Use: start | stop | status | fund | seed-withdrawal | age-addresses | age-linked-accounts | expire-address-approvals | expire-deposit-addresses | expire-staff-holds | age-task-progress | seed-notice | plan | restart | customer-dist`,
      2,
    );
}
