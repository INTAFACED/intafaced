#!/usr/bin/env node
/**
 * LOCAL TEST WORLD — makes a new account on the LOCAL test stack feel used. Local only.
 *
 *   node tooling/scripts/local-test-world.mjs watch   welcome funds for every new account + a friend who sends money back
 *   node tooling/scripts/local-test-world.mjs seed    create `test_friend`, fund it, send the newest real user 3 small transfers
 *   node tooling/scripts/local-test-world.mjs status  who has been welcomed, what the friend has seen
 *   node tooling/scripts/local-test-world.mjs populate [--only a,b] [--login-file <path>] [--dry-run] [--verify]
 *                                                     fill every customer room of the test account with labelled
 *                                                     test data, created only through the real service doors
 *
 * Integrity: every balance change is a real svc-ledger entry. Welcome credits reuse `local:fund`
 * (rail "local-test", ref LOCAL-TEST-welcome-<userId>-<ASSET>, so a repeat is a ledger no-op).
 * Friend transfers go through the customer path: Edge -> svc-bank transfers.toUser, signed in as
 * the friend (its own generated password, saved mode 600). Nothing writes a balance to a database,
 * and nobody signs in as a real user.
 *
 * Containment (failure it prevents: funding or sending against a real environment): refuses unless
 * ~/.intafaced/local-test-stack/LOCAL-TEST-STACK.json exists and every target URL is
 * http://127.0.0.1:<a port that marker lists>.
 *
 * Limits found in the current services (see docs paragraph in the hand-off):
 *   - svc-bank transfers.toUser has no memo/label field, so "Lunch — test" cannot be stored.
 *   - the recipient needs a primary space for the asset (bank.dest_user_missing).
 *   - identity.register takes handle/email/password only: no display name, no hyphen in a handle.
 */
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assertActiveLocalStack } from './local-test-state.mjs';
import * as gatesLocal from './local-test-gates.mjs';
import { approvePending, makeContext as makeGatesContext, pendingKycCount } from './local-test-gates.mjs';

const SCRIPT = fileURLToPath(import.meta.url);
const STACK_SCRIPT = path.join(path.dirname(SCRIPT), 'local-test-stack.mjs');
const MARKER_KIND = 'intafaced-local-test-stack';
const LOCAL_HOST = '127.0.0.1';
const EDGE = `http://${LOCAL_HOST}:14500`;
const CUSTOMER_ORIGIN = `http://${LOCAL_HOST}:3210`;
const PSQL = '/opt/homebrew/bin/psql';
const DB_NAME = 'intafaced_local_test';
const POLL_MS = 5000;

/** The one place to change welcome amounts. Only assets that exist in ledger.assets are credited. */
export const WELCOME_AMOUNTS = { USDT: '10000', BTC: '0.25', ETH: '2' };

/** The counterparty. Handles allow letters, digits and underscore only (identity router.ts register regex). */
export const FRIEND = { handle: 'test_friend', email: 'test-friend@local.test' };

/** What the friend sends the newest real user on `seed`. Labels live in the log only (no memo field in Bank). */
export const SEED_TRANSFERS = [
  { asset: 'USDT', amount: '25', label: 'Lunch — test' },
  { asset: 'BTC', amount: '0.001', label: 'Test transfer' },
  { asset: 'USDT', amount: '50', label: 'Rent split — test' },
];

const LABEL = 'LOCAL TEST WORLD — test funds and a test counterparty, not real money';

// ── Containment guard (exported for tests) ──────────────────────────────────

export class GuardError extends Error {}

/**
 * The state folder of the stack that is actually running. `LOCAL_STACK_STATE` (an absolute folder path) selects a
 * non-default stack, the same variable the stack script uses; unset means the default folder. A typo never falls back.
 */
export function stackStateDir(home = os.homedir(), env = process.env) {
  if (env.LOCAL_STACK_STATE === undefined) return path.join(home, '.intafaced', 'local-test-stack');
  const state = env.LOCAL_STACK_STATE;
  if (!state.trim() || !path.isAbsolute(state)) throw new GuardError('refusing: LOCAL_STACK_STATE must be an absolute folder path');
  return path.resolve(state);
}

export function stackPaths(home = os.homedir(), env = process.env) {
  const stateDir = stackStateDir(home, env);
  return {
    stateDir,
    marker: path.join(stateDir, 'LOCAL-TEST-STACK.json'),
    secrets: path.join(stateDir, 'secrets.json'),
    accounts: path.join(stateDir, 'world-accounts.json'),
    state: path.join(stateDir, 'run', 'world-state.json'),
    pidFile: path.join(stateDir, 'run', 'world.json'),
    log: path.join(stateDir, 'logs', 'world.log'),
  };
}

/** Throws GuardError unless the local test stack's marker exists and every URL is its own 127.0.0.1 port. */
export function assertLocalTarget({ home = os.homedir(), urls = [EDGE], env = process.env } = {}) {
  const p = stackPaths(home, env);
  if (!fs.existsSync(p.marker)) throw new GuardError(`refusing: marker ${p.marker} not found. Start the stack first (pnpm local:stack).`);
  let marker;
  try {
    marker = JSON.parse(fs.readFileSync(p.marker, 'utf8'));
  } catch {
    throw new GuardError('refusing: marker file is unreadable');
  }
  if (marker?.kind !== MARKER_KIND) throw new GuardError('refusing: marker file is not a local test stack marker');
  const ports = new Set(Object.values(marker.ports ?? {}).map(String));
  const dbHost = marker.database?.host;
  if (dbHost !== undefined && dbHost !== LOCAL_HOST) throw new GuardError(`refusing: database host ${dbHost} is not ${LOCAL_HOST}`);
  for (const raw of urls) {
    let u;
    try {
      u = new URL(raw);
    } catch {
      throw new GuardError(`refusing: "${raw}" is not a URL`);
    }
    if (u.protocol !== 'http:' || u.hostname !== LOCAL_HOST) throw new GuardError(`refusing: ${raw} is not http://${LOCAL_HOST}`);
    if (!ports.has(u.port)) throw new GuardError(`refusing: port ${u.port || '(default)'} of ${raw} is not a port of the local test stack`);
  }
  return { paths: p, marker };
}

// ── Pure planning functions (exported for tests) ────────────────────────────

/** Accounts the welcome watcher never funds: the market tooling funds those itself. */
export function isSkippedAccount(handle) {
  return /^test[-_](market[-_]maker|taker)/i.test(String(handle)) || isOperatorAccount(handle);
}

/** The two labelled stand-in operators (local-test-gates.mjs). They approve things; they never receive welcome funds. */
export function isOperatorAccount(handle) {
  return /^local_test_operator_[ab]$/i.test(String(handle));
}

/** A test account of any kind (market, friend, harness) — never picked as "the founder". */
export function isTestAccount(user) {
  return (
    /^test[-_]/i.test(String(user.handle)) ||
    isOperatorAccount(user.handle) ||
    /@(local\.test|local-test\.invalid|example\.invalid)$/i.test(String(user.email))
  );
}

export const welcomeRef = (userId, asset) => `welcome-${userId}-${asset}`;
export const doneKey = (userId, asset) => `${userId}:${asset}`;
export const seedTransferId = (founderId, n) => `world-seed-${founderId.slice(0, 8)}-${n}`;
export const returnTransferId = (txId) => `world-return-${txId.replace(/-/g, '').slice(0, 32)}`;

/** Newest registered non-test user, or null. `users` need `createdAt` (sortable) and `handle`/`email`. */
export function pickFounder(users) {
  const real = users.filter((u) => !isTestAccount(u));
  real.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
  return real[0] ?? null;
}

/**
 * Welcome credits still to do: [{ userId, handle, asset, amount, ref }].
 * `done` is a Set of "userId:ASSET". Idempotent: a finished set yields [].
 */
export function pendingWelcomes({ users, ledgerAssets, done, amounts = WELCOME_AMOUNTS }) {
  const have = new Set(ledgerAssets);
  const out = [];
  for (const u of users) {
    if (isSkippedAccount(u.handle)) continue;
    for (const [asset, amount] of Object.entries(amounts)) {
      if (!have.has(asset) || done.has(doneKey(u.id, asset))) continue;
      out.push({ userId: u.id, handle: u.handle, asset, amount, ref: welcomeRef(u.id, asset) });
    }
  }
  return out;
}

/**
 * Incoming user-to-friend payments to answer: `incoming` rows { seq, txId, fromUserId, asset, amount }.
 * Skips the friend itself, skipped accounts, rows at or below the cursor, and already answered tx ids.
 */
export function planReturns({ incoming, friendId, cursor, answered, skipUserIds = new Set() }) {
  return incoming
    .filter((r) => r.seq > cursor && r.fromUserId && r.fromUserId !== friendId && !skipUserIds.has(r.fromUserId) && !answered.has(r.txId))
    .map((r) => ({ ...r, transferId: returnTransferId(r.txId) }));
}

// ── Plumbing ────────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nowIso = () => new Date().toISOString();

function die(msg, code = 1) {
  process.stderr.write(`\nlocal-test-world: ${msg}\n`);
  process.exit(code);
}

function makeLogger(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  return (msg) => {
    const line = `${nowIso()} ${msg}`;
    process.stdout.write(`${line}\n`);
    try {
      fs.appendFileSync(file, `${line}\n`, { mode: 0o600 });
      fs.chmodSync(file, 0o600);
    } catch {
      /* log is best effort */
    }
  };
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writePrivate(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, `${JSON.stringify(obj, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

function psql(secrets, role, sql) {
  const r = spawnSync(
    PSQL,
    ['-X', '-At', '-F', '\t', '-v', 'ON_ERROR_STOP=1', '-h', LOCAL_HOST, '-p', '15460', '-U', role, '-d', DB_NAME, '-c', sql],
    {
      encoding: 'utf8',
      env: { PATH: '/usr/bin:/bin:/opt/homebrew/bin', PGPASSWORD: secrets.pgService },
    },
  );
  if (r.status !== 0) throw new Error(`psql failed: ${(r.stderr || r.stdout).trim().slice(0, 300)}`);
  return r.stdout
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => l.split('\t'));
}

// Read-only SELECTs, as each service's own role (the same way `local:fund` reads identity.users).
const listUsers = (secrets) =>
  psql(
    secrets,
    'svc_identity',
    'SELECT id::text, handle::text, email::text, created_at::text FROM identity.users ORDER BY created_at, id',
  ).map(([id, handle, email, createdAt]) => ({ id, handle, email, createdAt }));
const listLedgerAssets = (secrets) => psql(secrets, 'svc_ledger', 'SELECT id FROM ledger.assets WHERE active').map(([id]) => id);
const maxTxSeq = (secrets) => Number(psql(secrets, 'svc_ledger', 'SELECT COALESCE(max(seq),0) FROM ledger.ledger_tx')[0][0]);

/** Bank transfers where `friendId`'s available account was credited from another user's available account. */
function listIncoming(secrets, friendId, sinceSeq) {
  const sql = `
    SELECT t.seq, t.id::text, da.owner_id, ce.asset_id, ce.amount::text
      FROM ledger.ledger_tx t
      JOIN ledger.ledger_entries ce ON ce.tx_id = t.id AND ce.direction = 'credit'
      JOIN ledger.accounts ca ON ca.id = ce.account_id AND ca.owner_type = 'user' AND ca.kind = 'available' AND ca.owner_id = '${friendId}'
      JOIN ledger.ledger_entries de ON de.tx_id = t.id AND de.direction = 'debit' AND de.asset_id = ce.asset_id
      JOIN ledger.accounts da ON da.id = de.account_id AND da.owner_type = 'user' AND da.kind = 'available'
     WHERE t.module = 'bank' AND t.seq > ${Number(sinceSeq)}
     ORDER BY t.seq`;
  return psql(secrets, 'svc_ledger', sql).map(([seq, txId, fromUserId, asset, amount]) => ({
    seq: Number(seq),
    txId,
    fromUserId,
    asset,
    amount,
  }));
}

/**
 * Which stack script credits funds. By default this checkout's. When `LOCAL_STACK_STATE` selects a non-default stack,
 * the checkout recorded in that stack's marker (the one whose built services are running), because `fund` loads the
 * ledger client from its own checkout. Pure: the existence check is injected.
 */
export function pickStackScript({ marker, env = process.env, fallback = STACK_SCRIPT, exists = fs.existsSync }) {
  if (env.LOCAL_STACK_STATE === undefined) return fallback;
  const repo = marker?.repo;
  if (typeof repo !== 'string' || !path.isAbsolute(repo)) return fallback;
  const candidate = path.join(repo, 'tooling', 'scripts', 'local-test-stack.mjs');
  return exists(candidate) ? candidate : fallback;
}

/** Set by guard(): where `fund` runs from and the environment it sees. */
const RUNTIME = { script: STACK_SCRIPT, env: process.env };

/** Credit through the real ledger by calling `local:fund` (idempotent on --ref). Returns { ok, txId, text }. */
function fundViaStack(userId, asset, amount, ref) {
  const r = spawnSync(process.execPath, [RUNTIME.script, 'fund', userId, asset, amount, '--ref', ref], {
    encoding: 'utf8',
    env: RUNTIME.env,
  });
  const text = `${r.stdout || ''}${r.stderr || ''}`.trim();
  const txId = /ledger tx\s+(\S+)/.exec(text)?.[1];
  return { ok: r.status === 0, txId, text };
}

// ── Edge client (the same front door the customer app uses) ─────────────────

class EdgeClient {
  constructor(account) {
    this.account = account;
    this.token = null;
    this.tokenAt = 0;
  }
  async http(method, route, body, auth = true) {
    if (method !== 'GET') assertActiveLocalStack({ services: ['edge', 'identity', 'ledger', 'bank'] });
    if (auth && (!this.token || Date.now() - this.tokenAt > 8 * 60_000)) await this.login();
    const headers = { origin: CUSTOMER_ORIGIN, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) };
    if (auth) headers.authorization = `Bearer ${this.token}`;
    const res = await fetch(`${EDGE}${route}`, {
      redirect: 'error',
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30_000),
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* non-JSON */
    }
    return { status: res.status, json, text };
  }
  adopt(data) {
    this.token = data.accessToken;
    this.tokenAt = Date.now();
    this.account.userId = data.userId;
  }
  async login() {
    const res = await this.http(
      'POST',
      '/api/identity/trpc/auth.login',
      { identifier: this.account.email, password: this.account.password },
      false,
    );
    const data = res.json?.result?.data;
    if (!data?.accessToken) throw new Error(`login refused for ${this.account.handle} (${res.status}): ${refusalText(res)}`);
    this.adopt(data);
  }
  async ensureAccount() {
    const login = await this.http(
      'POST',
      '/api/identity/trpc/auth.login',
      { identifier: this.account.email, password: this.account.password },
      false,
    );
    if (login.json?.result?.data?.accessToken) {
      this.adopt(login.json.result.data);
      return 'existing';
    }
    const reg = await this.http(
      'POST',
      '/api/identity/trpc/auth.register',
      { handle: this.account.handle, email: this.account.email, password: this.account.password },
      false,
    );
    const data = reg.json?.result?.data;
    if (!data?.accessToken) throw new Error(`could not register ${this.account.handle} (${reg.status}): ${refusalText(reg)}`);
    this.adopt(data);
    return 'created';
  }
  async query(mod, proc, input) {
    return this.http('GET', `/api/${mod}/trpc/${proc}${input === undefined ? '' : `?input=${encodeURIComponent(JSON.stringify(input))}`}`);
  }
  async mutate(mod, proc, input) {
    return this.http('POST', `/api/${mod}/trpc/${proc}`, input ?? {});
  }
}

/** The exact refusal a service gave: message plus its code, as received. */
export function refusalText(res) {
  const e = res.json?.error;
  if (e) return `${e.message ?? e.json?.message ?? ''} [${e.data?.code ?? e.json?.data?.code ?? res.status}]`.trim();
  return res.text.slice(0, 300);
}

function loadFriend(p) {
  const have = readJson(p.accounts, {})?.friend;
  const friend = have?.password ? have : { ...FRIEND, password: crypto.randomBytes(18).toString('base64url'), userId: null };
  return friend;
}
function saveFriend(p, friend) {
  writePrivate(p.accounts, { kind: 'intafaced-local-test-world-accounts', label: 'LOCAL TEST account, not a real person', friend });
}

// ── Friend helpers ──────────────────────────────────────────────────────────

/** Make sure the friend has a primary space for each asset (Bank refuses a transfer to a user without one). */
async function ensureFriendSpaces(client, assets, log) {
  const list = await client.query('bank', 'spaces.list', { limit: 200 });
  const rows = list.json?.result?.data;
  if (!Array.isArray(rows)) throw new Error(`friend spaces.list refused (${list.status}): ${refusalText(list)}`);
  for (const asset of assets) {
    if (rows.some((s) => s.assetId === asset && s.kind === 'primary')) continue;
    const created = await client.mutate('bank', 'spaces.create', { assetId: asset, name: 'Test wallet' });
    if (!created.json?.result?.data?.id)
      throw new Error(`friend spaces.create ${asset} refused (${created.status}): ${refusalText(created)}`);
    log(`friend: created ${asset} space (primary + "Test wallet") through svc-bank`);
  }
  const again = await client.query('bank', 'spaces.list', { limit: 200 });
  return again.json?.result?.data ?? [];
}

/** One transfer through the same call the Send screen makes. Returns { ok, ledgerTxId } or { ok:false, refusal }. */
async function friendSend(client, fromSpaceId, toUserId, amount, transferId) {
  const res = await client.mutate('bank', 'transfers.toUser', { transferId, fromSpaceId, toUserId, amount });
  const data = res.json?.result?.data;
  if (data?.ledgerTxId) return { ok: true, ledgerTxId: data.ledgerTxId };
  return { ok: false, refusal: refusalText(res), status: res.status };
}

// ── Welcome pass (shared by watch and seed) ─────────────────────────────────

function runWelcomePass({ secrets, state, log, onlyUserIds }) {
  const users = listUsers(secrets).filter((u) => !onlyUserIds || onlyUserIds.has(u.id));
  const ledgerAssets = listLedgerAssets(secrets);
  const done = new Set(state.welcomed ?? []);
  const todo = pendingWelcomes({ users, ledgerAssets, done });
  let credited = 0;
  let failed = 0;
  let firstError = null;
  for (const w of todo) {
    const r = fundViaStack(w.userId, w.asset, w.amount, w.ref);
    if (!r.ok) {
      failed += 1;
      firstError ??= r.text.replace(/\s+/g, ' ').slice(0, 240);
      const key = `${w.ref}`;
      if (!state._warned?.has(key)) {
        (state._warned ??= new Set()).add(key);
        log(`welcome FAILED ${w.amount} ${w.asset} -> ${w.handle}: ${r.text.replace(/\s+/g, ' ').slice(0, 240)}`);
      }
      continue;
    }
    done.add(doneKey(w.userId, w.asset));
    credited += 1;
    log(
      `welcome ${w.amount} ${w.asset} -> ${w.handle} (${w.userId}) ledger tx ${r.txId ?? '?'} ref LOCAL-TEST-${w.ref} [TEST FUNDS, not real money]`,
    );
  }
  state.welcomed = [...done];
  return { credited, users, failed, firstError };
}

const saveState = (p, state) => {
  // Keys starting with "_" are in-memory only (clients, credentials, warning de-dupe).
  writePrivate(p.state, Object.fromEntries(Object.entries(state).filter(([k]) => !k.startsWith('_'))));
};

// ── Friend replies (watch) ──────────────────────────────────────────────────

async function friendReplyPass({ secrets, p, state, log, skipUserIds }) {
  const friend = state._friend;
  if (!friend?.userId) return;
  const incoming = listIncoming(secrets, friend.userId, state.returnCursor ?? 0);
  const plan = planReturns({
    incoming,
    friendId: friend.userId,
    cursor: state.returnCursor ?? 0,
    answered: new Set(state.answered ?? []),
    skipUserIds,
  });
  if (plan.length === 0) return;
  const client = state._friendClient;
  const spaces = await ensureFriendSpaces(client, [...new Set(plan.map((r) => r.asset))], log);
  for (const r of plan) {
    const from = spaces.find((s) => s.assetId === r.asset && s.kind === 'primary');
    if (!from) {
      log(`friend: no ${r.asset} space to send back ${r.amount} from (tx ${r.txId})`);
      continue;
    }
    const out = await friendSend(client, from.id, r.fromUserId, r.amount, r.transferId);
    if (out.ok) {
      (state.answered ??= []).push(r.txId);
      log(
        `friend sent back ${r.amount} ${r.asset} to ${r.fromUserId} (answering ledger tx ${r.txId}) -> ledger tx ${out.ledgerTxId} [TEST transfer]`,
      );
    } else if (!state._warned?.has(r.txId)) {
      (state._warned ??= new Set()).add(r.txId);
      log(`friend could NOT send back ${r.amount} ${r.asset} to ${r.fromUserId}: ${out.refusal}`);
    }
  }
  const handled = plan.filter((r) => (state.answered ?? []).includes(r.txId));
  const lowestOpen = plan.find((r) => !(state.answered ?? []).includes(r.txId));
  state.returnCursor = lowestOpen ? lowestOpen.seq - 1 : Math.max(state.returnCursor ?? 0, ...handled.map((r) => r.seq));
}

// ── Verification (the operator stand-in; local-test-gates.mjs) ──────────────

/**
 * Any account that has asked to be verified gets approved by the two labelled local test operators
 * ("LOCAL TEST — not a real approval"). Cheap when idle: one read-only count. A failure is logged once
 * and retried after a minute, never in a tight loop.
 */
async function verifyPass({ secrets, state, log }) {
  if (state._kycRetryAt && Date.now() < state._kycRetryAt) return;
  if (pendingKycCount(secrets) === 0) return;
  try {
    state._gates ??= await makeGatesContext({ log });
    const rows = await approvePending(state._gates);
    if (rows.some((r) => !r.ok)) state._kycRetryAt = Date.now() + 60_000;
  } catch (err) {
    state._kycRetryAt = Date.now() + 60_000;
    log(`verify pass failed (will retry in 60 s): ${String(err.message ?? err).slice(0, 240)}`);
  }
}

// ── Commands ────────────────────────────────────────────────────────────────

function guard() {
  try {
    const found = assertLocalTarget({
      urls: [EDGE, `http://${LOCAL_HOST}:14501`, `http://${LOCAL_HOST}:14502`, `http://${LOCAL_HOST}:14509`],
    });
    RUNTIME.script = pickStackScript({ marker: found.marker });
    RUNTIME.env = process.env.LOCAL_STACK_STATE === undefined ? process.env : { ...process.env, LOCAL_STACK_STATE: found.paths.stateDir };
    return found;
  } catch (err) {
    if (err instanceof GuardError) die(err.message);
    throw err;
  }
}

async function cmdWatch() {
  const { paths: p } = guard();
  assertActiveLocalStack({ stateDir: p.stateDir, services: ['edge', 'identity', 'ledger', 'bank'] });
  const log = makeLogger(p.log);
  const secrets = readJson(p.secrets, null);
  if (!secrets) die('secrets.json missing in the local stack state directory');
  const prior = readJson(p.pidFile, null);
  if (prior?.pid && prior.pid !== process.pid) {
    try {
      process.kill(prior.pid, 0);
      die(`already running (pid ${prior.pid})`);
    } catch (err) {
      if (err.code === 'EPERM') die(`already running (pid ${prior.pid})`);
    }
  }
  writePrivate(p.pidFile, { pid: process.pid, startedAt: nowIso(), label: LABEL });
  const state = readJson(p.state, {});
  let stop = false;
  const bye = () => {
    stop = true;
  };
  process.on('SIGINT', bye);
  process.on('SIGTERM', bye);
  log(`watch started (pid ${process.pid}). ${LABEL}. Welcome: ${JSON.stringify(WELCOME_AMOUNTS)}`);

  while (!stop) {
    try {
      const { users } = runWelcomePass({ secrets, state, log });
      await verifyPass({ secrets, state, log });
      // Friend replies, only once the friend exists (seed creates it).
      const acct = readJson(p.accounts, {})?.friend;
      if (acct?.password) {
        const friend = { ...acct };
        if (!state._friendClient) {
          state._friend = friend;
          state._friendClient = new EdgeClient(friend);
          await state._friendClient.login();
          if (state.returnCursor === undefined) state.returnCursor = maxTxSeq(secrets);
          log(`friend ${friend.handle} online; answering payments after ledger seq ${state.returnCursor}`);
        }
        const skip = new Set(users.filter((u) => isSkippedAccount(u.handle)).map((u) => u.id));
        await friendReplyPass({ secrets, p, state, log, skipUserIds: skip });
      }
      saveState(p, state);
    } catch (err) {
      log(`tick error: ${String(err.message ?? err).slice(0, 300)}`);
    }
    for (let waited = 0; waited < POLL_MS && !stop; waited += 250) await sleep(250);
  }
  try {
    fs.rmSync(p.pidFile);
  } catch {
    /* already gone */
  }
  log('watch stopped');
}

async function cmdSeed() {
  const { paths: p } = guard();
  assertActiveLocalStack({ stateDir: p.stateDir, services: ['edge', 'identity', 'ledger', 'bank'] });
  const log = makeLogger(p.log);
  const secrets = readJson(p.secrets, null);
  if (!secrets) die('secrets.json missing in the local stack state directory');
  const state = readJson(p.state, {});

  // 1. Counterparty account.
  const friend = loadFriend(p);
  saveFriend(p, friend); // password on disk before the first register, so a crash cannot lose it
  const client = new EdgeClient(friend);
  const how = await client.ensureAccount();
  saveFriend(p, friend);
  log(`friend ${friend.handle} ${how} (${friend.userId}); credentials in ${p.accounts} (mode 600)`);

  // 2. Welcome funds (friend + everyone else pending), real ledger entries.
  const welcome = runWelcomePass({ secrets, state, log });
  saveState(p, state);
  log(`welcome pass credited ${welcome.credited} line(s)`);

  // 3. Friend's spaces, then the three transfers.
  const ledgerAssets = new Set(listLedgerAssets(secrets));
  const assets = Object.keys(WELCOME_AMOUNTS).filter((a) => ledgerAssets.has(a));
  const founder = pickFounder(listUsers(secrets));
  if (!founder) die('no non-test user registered yet; register in the app first, then re-run seed');
  log(`recipient: newest non-test user ${founder.handle} (${founder.id}, registered ${founder.createdAt})`);
  let spaces;
  try {
    spaces = await ensureFriendSpaces(client, assets, log);
  } catch (err) {
    // Report the service's exact refusal; do not work around it. Probe the Send door too (nil space id),
    // because the access gate runs before input validation, so it shows what Send itself would say.
    const probe = await friendSend(client, '00000000-0000-4000-8000-000000000000', founder.id, '1', 'world-probe-0000');
    log(`seed BLOCKED at svc-bank: ${String(err.message).slice(0, 400)}`);
    log(`seed BLOCKED probe of transfers.toUser (Send): ${probe.refusal ?? 'unexpectedly accepted'}`);
    console.log(
      `\nseed: BLOCKED. Welcome funds were credited, but Bank refuses this account, so no transfer was attempted.\n  ${err.message}`,
    );
    process.exitCode = 3;
    return;
  }

  const results = [];
  for (const [i, t] of SEED_TRANSFERS.entries()) {
    const from = spaces.find((s) => s.assetId === t.asset && s.kind === 'primary');
    if (!from) {
      results.push({ ...t, ok: false, refusal: `friend has no ${t.asset} space` });
      continue;
    }
    const out = await friendSend(client, from.id, founder.id, t.amount, seedTransferId(founder.id, i + 1));
    results.push({ ...t, ...out });
    log(
      out.ok
        ? `seed: ${t.amount} ${t.asset} "${t.label}" -> ${founder.handle} ledger tx ${out.ledgerTxId}`
        : `seed REFUSED ${t.amount} ${t.asset} "${t.label}": ${out.refusal}`,
    );
  }
  const ok = results.filter((r) => r.ok).length;
  console.log(`\nseed: ${ok}/${results.length} transfers settled. ${LABEL}`);
  for (const r of results)
    console.log(`  ${r.ok ? 'OK     ' : 'REFUSED'} ${r.amount} ${r.asset} "${r.label}"  ${r.ok ? `ledger tx ${r.ledgerTxId}` : r.refusal}`);
  if (ok < results.length) process.exitCode = 3;
}

function cmdStatus() {
  const { paths: p } = guard();
  const state = readJson(p.state, {});
  const running = readJson(p.pidFile, null);
  console.log(
    JSON.stringify(
      {
        label: LABEL,
        watcherPid: running?.pid ?? null,
        welcomedLines: (state.welcomed ?? []).length,
        answered: (state.answered ?? []).length,
        returnCursor: state.returnCursor ?? null,
        friend: readJson(p.accounts, {})?.friend?.handle ?? null,
      },
      null,
      2,
    ),
  );
}

// ── Populate: pure planning (exported for tests) ────────────────────────────

/** Everything populate creates carries this prefix in its reference, name or label, so it is recognisable as local test data. */
export const POPULATE_PREFIX = 'LOCAL-TEST-';
export const POPULATE_LABEL = 'LOCAL TEST';
export const DEFAULT_LOGIN_FILE = path.join(os.homedir(), '.codex', 'context', 'work', 'TEST-LOGIN.md');

export const populateRef = (name) => `${POPULATE_PREFIX}${name}`;

/** A stable UUID (v4 layout) from a name, so a rerun sends the same business key and the service treats it as the same record. */
export function populateUuid(name) {
  const h = crypto.createHash('sha256').update(`local-test-populate:${name}`).digest('hex');
  const variant = ((Number.parseInt(h[16], 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** Transfer business key: <= 64 chars, stable per (kind, user, n). */
export const populateTransferId = (kind, userId, n) => `${POPULATE_PREFIX}${kind}-${String(userId).slice(0, 8)}-${n}`;

/** Email and password from the test-login note ("Email: ..." / "Password: ..." lines). Null if either is missing. Never logged. */
export function parseLoginFile(text) {
  const email = /^\s*Email:\s*(\S+)\s*$/im.exec(String(text))?.[1];
  const password = /^\s*Password:\s*(\S+)\s*$/im.exec(String(text))?.[1];
  return email && password ? { email, password } : null;
}

/** Spaces the test account should have. Names say "(test)" so they cannot be mistaken for a real person's setup. */
export const POPULATE_SPACES = [
  { key: 'savings', name: 'Savings (test)', assetId: 'USDT', goalTarget: '2000' },
  { key: 'travel', name: 'Travel (test)', assetId: 'USDT', goalTarget: '600' },
  { key: 'rainy', name: 'Rainy day, locked 90 days (test)', assetId: 'USDT', goalTarget: '1000', lockDays: 90 },
  { key: 'btc', name: 'Bitcoin stash (test)', assetId: 'BTC', goalTarget: '0.01' },
];

/** Moves between the account's own spaces. `from`/`to` are a space key, or "primary:<ASSET>" for the primary space. */
export const POPULATE_TRANSFERS = [
  { n: 1, from: 'primary:USDT', to: 'savings', amount: '300', label: 'Monthly saving — test' },
  { n: 2, from: 'primary:USDT', to: 'travel', amount: '120', label: 'Trip fund — test' },
  { n: 3, from: 'savings', to: 'travel', amount: '40', label: 'Top up travel from savings — test' },
  { n: 4, from: 'primary:USDT', to: 'rainy', amount: '50', label: 'Rainy day — test' },
];

/** What test_friend sends the account, then what the account sends back. Labels live in the log (Bank has no memo field). */
export const POPULATE_FRIEND_TO_USER = [
  { n: 1, asset: 'USDT', amount: '25', label: 'Lunch — test' },
  { n: 2, asset: 'USDT', amount: '50', label: 'Rent split — test' },
  { n: 3, asset: 'BTC', amount: '0.001', label: 'Test transfer' },
];
export const POPULATE_USER_TO_FRIEND = [{ n: 1, asset: 'USDT', amount: '5', label: 'Coffee, paying back — test' }];

/** Spaces still to create, given the account's current spaces (matched by exact name). */
export function planSpaces(existing, specs = POPULATE_SPACES) {
  const have = new Set(existing.map((s) => s.name));
  return specs.filter((s) => !have.has(s.name));
}

const resolveSpaceRef = (ref, spaces, specs) => {
  if (ref.startsWith('primary:')) return spaces.find((s) => s.kind === 'primary' && s.assetId === ref.slice(8))?.id ?? null;
  const spec = specs.find((s) => s.key === ref);
  return spec ? (spaces.find((s) => s.name === spec.name)?.id ?? null) : null;
};

/** Internal transfers whose two spaces exist, with stable ids. `skipped` names the ones that cannot run yet. */
export function planInternalTransfers({ userId, spaces, specs = POPULATE_SPACES, transfers = POPULATE_TRANSFERS }) {
  const plan = [];
  const skipped = [];
  for (const t of transfers) {
    const fromSpaceId = resolveSpaceRef(t.from, spaces, specs);
    const toSpaceId = resolveSpaceRef(t.to, spaces, specs);
    if (!fromSpaceId || !toSpaceId) skipped.push({ ...t, reason: `missing space ${!fromSpaceId ? t.from : t.to}` });
    else plan.push({ ...t, transferId: populateTransferId('xfer', userId, t.n), fromSpaceId, toSpaceId });
  }
  return { plan, skipped };
}

// Decimal string arithmetic without JS numbers (AGENTS.md "Money": amounts are strings on the wire, bigint in memory).
export function toScaled(str, dp) {
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(String(str));
  if (!m) throw new Error(`not a plain decimal: "${str}"`);
  const frac = (m[3] ?? '').padEnd(dp, '0').slice(0, dp);
  const v = BigInt(m[2]) * 10n ** BigInt(dp) + BigInt(frac || '0');
  return m[1] ? -v : v;
}
export function fromScaled(v, dp) {
  const neg = v < 0n;
  const abs = neg ? -v : v;
  const base = 10n ** BigInt(dp);
  const whole = abs / base;
  const frac = dp === 0 ? '' : (abs % base).toString().padStart(dp, '0').replace(/0+$/, '');
  return `${neg ? '-' : ''}${whole}${frac ? `.${frac}` : ''}`;
}
/** price * (10000 + bps) / 10000, rounded down to `decimals` places. */
export function shiftPrice(price, bps, decimals) {
  const dp = Math.max(decimals, 8);
  const scaled = (toScaled(price, dp) * BigInt(10_000 + bps)) / 10_000n;
  const unit = 10n ** BigInt(dp - decimals);
  return fromScaled((scaled / unit) * unit, dp);
}

/** Price alerts to create from last prices { 'BTC/USDT': { marketId, last } }. Skips ones the account already has. */
export function planAlerts({ marks, existing = [], wanted }) {
  const have = new Set(existing.map((a) => `${a.marketId}:${a.direction}:${a.targetPrice}`));
  const out = [];
  for (const w of wanted) {
    const m = marks[w.symbol];
    if (!m?.marketId || !m.last) continue;
    const targetPrice = shiftPrice(m.last, w.bps, w.decimals);
    const row = { symbol: w.symbol, marketId: m.marketId, direction: w.direction, targetPrice };
    if (!have.has(`${m.marketId}:${w.direction}:${targetPrice}`)) out.push(row);
  }
  return out;
}
/** Paths svc-academy accepts for enrolment (enrollCertPath). */
export const ACADEMY_PATHS = ['foundations', 'markets'];
export const POPULATE_ALERTS = [
  { symbol: 'BTC/USDT', direction: 'above', bps: 500, decimals: 0 },
  { symbol: 'BTC/USDT', direction: 'below', bps: -500, decimals: 0 },
  { symbol: 'ETH/USDT', direction: 'above', bps: 500, decimals: 0 },
];

/** Academy: mark the first `take` required lessons of a path done (partial progress; the certificate is never granted). */
export function planAcademyProgress({ requiredItemSlugs, take = 4 }) {
  return requiredItemSlugs.slice(0, Math.max(0, Math.min(take, requiredItemSlugs.length - 1)));
}

/** A limit buy `bpsBelow` under the last price, as a resting order that cannot fill. Strings in, strings out. */
export function planRestingBuy({ last, bpsBelow, notionalTarget, pricePrecision, amountPrecision, minAmount, minCost }) {
  const pdp = pricePrecision.includes('.') ? pricePrecision.split('.')[1].length : 0;
  const adp = amountPrecision.includes('.') ? amountPrecision.split('.')[1].length : 0;
  const price = shiftPrice(last, -bpsBelow, pdp);
  const dp = 18;
  let amount = (toScaled(notionalTarget, dp) * 10n ** BigInt(dp)) / toScaled(price, dp);
  const lot = 10n ** BigInt(dp - adp);
  amount = (amount / lot) * lot;
  if (amount < toScaled(minAmount, dp)) amount = toScaled(minAmount, dp);
  const cost = (amount * toScaled(price, dp)) / 10n ** BigInt(dp);
  if (cost < toScaled(minCost ?? '0', dp)) throw new Error(`notional ${fromScaled(cost, dp)} is under the market minimum ${minCost}`);
  return { price, amount: fromScaled(amount, dp) };
}

export const RESULT_STATUSES = ['created', 'exists', 'refused', 'skipped', 'error'];

/** Counts by status and by room, for the end-of-run table and the report. */
export function summarizeResults(results) {
  const total = Object.fromEntries(RESULT_STATUSES.map((s) => [s, 0]));
  const rooms = {};
  for (const r of results) {
    total[r.status] = (total[r.status] ?? 0) + 1;
    const room = (rooms[r.room] ??= Object.fromEntries(RESULT_STATUSES.map((s) => [s, 0])));
    room[r.status] = (room[r.status] ?? 0) + 1;
  }
  return { total, rooms };
}

export function parsePopulateArgs(argv) {
  const opts = { only: null, loginFile: DEFAULT_LOGIN_FILE, dryRun: false, verify: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--only')
      opts.only = String(argv[++i] ?? '')
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean);
    else if (a === '--login-file') opts.loginFile = path.resolve(String(argv[++i] ?? ''));
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--verify') opts.verify = true;
    else throw new Error(`unknown option "${a}"`);
  }
  return opts;
}

// ── Populate: running it against the local stack ─────────────────────────────

/** Steps in run order. `key` is what --only takes. */
export const POPULATE_STEPS = [
  'spaces',
  'transfers',
  'friend',
  'earn',
  'loans',
  'cards',
  'p2p',
  'alerts',
  'trade',
  'support',
  'academy',
  'academy-room',
  'referral',
  'blueprint',
  'quant',
  'market',
  'token',
  'agents',
  'merchant',
];

/** One tRPC call: { ok, data } or { ok:false, refusal, status }. Never throws on a service refusal. */
async function call(client, kind, mod, proc, input) {
  const res = kind === 'q' ? await client.query(mod, proc, input) : await client.mutate(mod, proc, input);
  if (res.status >= 200 && res.status < 300 && res.json && 'result' in res.json)
    return { ok: true, data: res.json.result.data, status: res.status };
  return { ok: false, refusal: refusalText(res), status: res.status };
}

async function restJson(client, route, body) {
  const res = await client.http(body === undefined ? 'GET' : 'POST', route, body, true);
  if (res.status >= 200 && res.status < 300) return { ok: true, data: res.json, status: res.status };
  return {
    ok: false,
    refusal: res.json?.message ? `${res.json.message} [${res.json.intafacedCode ?? res.status}]` : res.text.slice(0, 200),
    status: res.status,
  };
}

const oneLine = (x, n = 160) => String(x).replace(/\s+/g, ' ').slice(0, n);

async function populateSpacesStep(ctx) {
  const { user, record } = ctx;
  const listed = await call(user, 'q', 'bank', 'spaces.list', { limit: 200 });
  if (!listed.ok) return record('bank', 'spaces', 'refused', listed.refusal);
  const missing = planSpaces(listed.data);
  for (const spec of POPULATE_SPACES) {
    if (!missing.includes(spec)) {
      record('bank', `space "${spec.name}"`, 'exists', `${spec.assetId} space already there`);
      continue;
    }
    const input = { assetId: spec.assetId, name: spec.name, ...(spec.goalTarget ? { goalTarget: spec.goalTarget } : {}) };
    if (spec.lockDays) input.lockedUntil = new Date(Date.now() + spec.lockDays * 86_400_000).toISOString();
    const made = await call(user, 'm', 'bank', 'spaces.create', input);
    record(
      'bank',
      `space "${spec.name}"`,
      made.ok ? 'created' : 'refused',
      made.ok ? `${spec.assetId} space ${made.data.id}` : made.refusal,
    );
  }
  const again = await call(user, 'q', 'bank', 'spaces.list', { limit: 200 });
  ctx.spaces = again.ok ? again.data : listed.data;
}

async function populateTransfersStep(ctx) {
  const { user, record } = ctx;
  if (!ctx.spaces) ctx.spaces = (await call(user, 'q', 'bank', 'spaces.list', { limit: 200 })).data ?? [];
  const { plan, skipped } = planInternalTransfers({ userId: user.account.userId, spaces: ctx.spaces });
  for (const s of skipped) record('bank', `transfer #${s.n} ${s.label}`, 'skipped', s.reason);
  for (const t of plan) {
    const out = await call(user, 'm', 'bank', 'transfers.create', {
      transferId: t.transferId,
      fromSpaceId: t.fromSpaceId,
      toSpaceId: t.toSpaceId,
      amount: t.amount,
    });
    record(
      'bank',
      `transfer ${t.amount} "${t.label}"`,
      out.ok ? 'created' : 'refused',
      out.ok ? `ledger tx ${out.data.ledgerTxId}` : out.refusal,
    );
  }
}

/**
 * The verification stand-ins (local-test-gates.mjs). For a non-default stack, the copy that sits next to the stack script
 * that started it, because it must match the running identity service and load that checkout's built packages.
 */
async function gatesApi() {
  if (RUNTIME.script === STACK_SCRIPT) return gatesLocal;
  return import(pathToFileURL(path.join(path.dirname(RUNTIME.script), 'local-test-gates.mjs')).href);
}

/** Verification tier "full" for the friend only, through the two labelled test operators. Never approves anyone else's request. */
async function verifyFriend(ctx, friend) {
  const { log, secrets } = ctx;
  const gates = await gatesApi();
  const gctx = await gates.makeContext({ log });
  const before = gates.listAccountsAndTiers(secrets);
  const submitted = await gates.submitOwnedAccounts(gctx, before);
  const after = gates.listAccountsAndTiers(secrets);
  const others = after.pending.filter((r) => r.userId !== friend.userId);
  if (others.length > 0)
    return {
      ok: false,
      why: `${others.length} other pending verification request(s) exist; populate approves only the friend's, so it stopped`,
    };
  const rows = await gates.approvePending(gctx);
  const mine = rows.filter((r) => r.ok).length;
  return { ok: mine > 0 || submitted.some((x) => x.ok) || after.approved.get(friend.userId)?.has('full'), why: `${mine} approved` };
}

async function populateFriendStep(ctx) {
  const { user, record, p, secrets, log } = ctx;
  const friend = loadFriend(p);
  saveFriend(p, friend);
  const client = new EdgeClient(friend);
  let how;
  try {
    how = await client.ensureAccount();
  } catch (err) {
    return record('bank', 'test_friend account', 'refused', oneLine(err.message));
  }
  saveFriend(p, friend);
  record(
    'bank',
    'test_friend account',
    how === 'created' ? 'created' : 'exists',
    `${friend.handle} (${friend.userId}), credentials in ${p.accounts} (mode 600)`,
  );
  ctx.friend = { account: friend, client };

  // Welcome funds for the friend through local:fund (same ref as the watcher, so no double credit).
  const state = readJson(p.state, {});
  const welcome = runWelcomePass({ secrets, state, log, onlyUserIds: new Set([friend.userId]) });
  saveState(p, state);
  record(
    'bank',
    'test_friend funds',
    welcome.failed > 0 ? 'refused' : welcome.credited > 0 ? 'created' : 'exists',
    welcome.failed > 0
      ? `${welcome.failed} welcome credit(s) refused: ${welcome.firstError}`
      : `${welcome.credited} welcome line(s) credited through the ledger`,
  );

  const assets = [...new Set(POPULATE_FRIEND_TO_USER.map((t) => t.asset))];
  let friendSpaces;
  try {
    try {
      friendSpaces = await ensureFriendSpaces(client, assets, log);
    } catch (err) {
      if (!/Verification tier/i.test(String(err.message))) throw err;
      const v = await verifyFriend(ctx, friend);
      record('bank', 'test_friend verification (local test operators)', v.ok ? 'created' : 'refused', v.why);
      if (!v.ok) throw err;
      friendSpaces = await ensureFriendSpaces(client, assets, log);
    }
  } catch (err) {
    return record('bank', 'test_friend spaces', 'refused', oneLine(err.message, 300));
  }
  // The user needs a primary space per asset to receive (Bank: dest_user_missing). Spaces step creates them.
  for (const t of POPULATE_FRIEND_TO_USER) {
    const from = friendSpaces.find((s) => s.assetId === t.asset && s.kind === 'primary');
    if (!from) {
      record('bank', `incoming ${t.amount} ${t.asset} "${t.label}"`, 'skipped', `friend has no ${t.asset} space`);
      continue;
    }
    const out = await friendSend(client, from.id, user.account.userId, t.amount, populateTransferId('in', user.account.userId, t.n));
    record(
      'bank',
      `incoming ${t.amount} ${t.asset} "${t.label}"`,
      out.ok ? 'created' : 'refused',
      out.ok ? `from test_friend, ledger tx ${out.ledgerTxId}` : out.refusal,
    );
  }
  const userSpaces = (await call(user, 'q', 'bank', 'spaces.list', { limit: 200 })).data ?? [];
  for (const t of POPULATE_USER_TO_FRIEND) {
    const from = userSpaces.find((s) => s.assetId === t.asset && s.kind === 'primary');
    if (!from) {
      record('bank', `outgoing ${t.amount} ${t.asset} "${t.label}"`, 'skipped', `no ${t.asset} primary space`);
      continue;
    }
    const out = await friendSend(user, from.id, friend.userId, t.amount, populateTransferId('out', user.account.userId, t.n));
    record(
      'bank',
      `outgoing ${t.amount} ${t.asset} "${t.label}"`,
      out.ok ? 'created' : 'refused',
      out.ok ? `to test_friend, ledger tx ${out.ledgerTxId}` : out.refusal,
    );
  }
}

async function populateEarnStep(ctx) {
  const { user, record } = ctx;
  const pools = await call(user, 'q', 'bank', 'earn.pools', { limit: 50 });
  if (!pools.ok) return record('earn', 'pools', 'refused', pools.refusal);
  const pool = pools.data.find((x) => x.assetId === 'USDT');
  if (!pool) return record('earn', 'deposit', 'skipped', 'no USDT earn pool is configured');
  const out = await call(user, 'm', 'bank', 'earn.deposit', {
    poolId: pool.id,
    amount: pool.minDeposit,
    positionId: populateUuid(`earn-${user.account.userId}-${pool.id}`),
  });
  record(
    'earn',
    `deposit ${pool.minDeposit} USDT into "${pool.name}"`,
    out.ok ? 'created' : 'refused',
    out.ok ? `position ${out.data.positionId}` : out.refusal,
  );
}

async function populateLoansStep(ctx) {
  const { user, record } = ctx;
  const products = await call(user, 'q', 'bank', 'loans.products', { limit: 50 });
  if (!products.ok) return record('loans', 'products', 'refused', products.refusal);
  if (products.data.length === 0)
    return record('loans', 'open a loan', 'skipped', 'no loan product is configured (loans.products is empty)');
  record(
    'loans',
    'open a loan',
    'skipped',
    `${products.data.length} product(s) exist; sizing collateral needs a priced LTV calculation that populate does not do yet`,
  );
}

async function populateCardsStep(ctx) {
  const { user, record } = ctx;
  const programme = await call(user, 'q', 'bank', 'cards.programme');
  if (!programme.ok) return record('cards', 'programme', 'refused', programme.refusal);
  if (programme.data.id === 'none')
    return record('cards', 'issue a card', 'skipped', `no card programme configured (cards.programme = "${programme.data.displayName}")`);
  const out = await call(user, 'm', 'bank', 'cards.issue', {
    cardId: populateUuid(`card-${user.account.userId}-1`),
    assetId: 'USDT',
    perAuthorizationLimit: '100',
  });
  record(
    'cards',
    'issue a card (USDT, 100 per authorization)',
    out.ok ? 'created' : 'refused',
    out.ok ? `card ${out.data.id}` : out.refusal,
  );
}

async function populateP2pStep(ctx) {
  const { user, record } = ctx;
  const offer = await call(user, 'm', 'p2p', 'offers.create', {
    side: 'sell',
    asset: 'USDT',
    fiatCurrency: 'USD',
    priceType: 'fixed',
    price: '1',
    minAmount: '10',
    maxAmount: '100',
    totalAmount: '100',
    methods: ['bank_transfer'],
    terms: `${POPULATE_LABEL}: test offer, not real money`,
  });
  record('p2p', 'sell offer (test)', offer.ok ? 'created' : 'refused', offer.ok ? `offer ${offer.data.id}` : offer.refusal);
  record(
    'p2p',
    'one order on that offer',
    'skipped',
    offer.ok ? 'an order needs a second account taking the offer; not automated yet' : 'there is no offer to order against',
  );
}

async function populateAlertsStep(ctx) {
  const { user, record } = ctx;
  const markets = await restJson(user, '/api/v1/markets?limit=500');
  if (!markets.ok) return record('alerts', 'markets', 'refused', markets.refusal);
  const marks = {};
  for (const sym of new Set(POPULATE_ALERTS.map((a) => a.symbol))) {
    const m = markets.data.find((x) => x.symbol === sym && x.orderable);
    if (!m) continue;
    const t = await restJson(user, `/api/v1/ticker/${encodeURIComponent(sym)}`);
    if (t.ok && t.data?.last) marks[sym] = { marketId: m.id, last: t.data.last };
  }
  const existing = await call(user, 'q', 'notify', 'notify.alerts', { limit: 50 });
  const have = existing.ok
    ? (existing.data.items ?? []).map((a) => ({ marketId: a.marketId, direction: a.direction, targetPrice: a.targetPrice }))
    : [];
  for (const sym of new Set(POPULATE_ALERTS.map((a) => a.symbol))) {
    if (!marks[sym]) record('alerts', `${sym} alerts`, 'skipped', 'no orderable market or last price to anchor them on');
  }
  const plan = planAlerts({ marks, existing: have, wanted: POPULATE_ALERTS });
  if (plan.length === 0) record('alerts', 'price alerts', 'exists', `${have.length} alert(s) already on the account`);
  for (const a of plan) {
    const out = await call(user, 'm', 'notify', 'notify.createAlert', {
      marketId: a.marketId,
      direction: a.direction,
      targetPrice: a.targetPrice,
    });
    record(
      'alerts',
      `${a.symbol} ${a.direction} ${a.targetPrice}`,
      out.ok ? 'created' : 'refused',
      out.ok ? `alert ${out.data.alert?.id ?? ''}`.trim() : out.refusal,
    );
  }
}

async function populateTradeStep(ctx) {
  const { user, record } = ctx;
  const sym = 'BTC/USDT';
  const markets = await restJson(user, '/api/v1/markets?limit=500');
  const m = markets.ok ? markets.data.find((x) => x.symbol === sym && x.orderable) : null;
  if (!m)
    return record('trade', 'resting order', 'skipped', `${sym} is not orderable (${markets.ok ? 'market missing' : markets.refusal})`);
  const t = await restJson(user, `/api/v1/ticker/${encodeURIComponent(sym)}`);
  if (!t.ok || !t.data?.last) return record('trade', 'resting order', 'skipped', 'no last price to anchor a test order');
  const { price, amount } = planRestingBuy({
    last: t.data.last,
    bpsBelow: 1000,
    notionalTarget: '25',
    pricePrecision: m.precision.price,
    amountPrecision: m.precision.amount,
    minAmount: m.limits.amount.min ?? m.precision.amount,
    minCost: m.limits.cost.min ?? '0',
  });
  const clientOrderId = `${POPULATE_PREFIX}resting-btc-1`;
  const out = await restJson(user, '/api/v1/orders', {
    symbol: sym,
    type: 'limit',
    side: 'buy',
    amount,
    price,
    timeInForce: 'GTC',
    clientOrderId,
  });
  record(
    'trade',
    `resting buy ${amount} BTC at ${price} (10% under last, will not fill)`,
    out.ok ? 'created' : 'refused',
    out.ok ? `order ${out.data?.id ?? clientOrderId}` : out.refusal,
  );
}

async function populateSupportStep(ctx) {
  const { user, record } = ctx;
  const subject = `${POPULATE_LABEL}: question about my order fills`;
  const mine = await call(user, 'q', 'support', 'listMine', { limit: 50 });
  if (!mine.ok) return record('support', 'tickets', 'refused', mine.refusal);
  let ticket = mine.data.find((x) => x.subject === subject);
  if (ticket) record('support', 'ticket', 'exists', `ticket ${ticket.id}`);
  else {
    const made = await call(user, 'm', 'support', 'create', {
      category: 'trading',
      subject,
      body: `${POPULATE_LABEL}, not a real person. Why did my BTC buy fill in two parts? This ticket was created by the local test world so the Support room has data.`,
    });
    if (!made.ok) return record('support', 'ticket', 'refused', made.refusal);
    ticket = made.data;
    record('support', 'ticket', 'created', `ticket ${ticket.id}`);
  }
  const comments = await call(user, 'q', 'support', 'listComments', { ticketId: ticket.id, limit: 20 });
  if (comments.ok && comments.data.length === 0) {
    const c = await call(user, 'm', 'support', 'comment', {
      ticketId: ticket.id,
      body: `${POPULATE_LABEL}: following up, same question as above.`,
    });
    record('support', 'ticket comment', c.ok ? 'created' : 'refused', c.ok ? 'comment added' : c.refusal);
  } else
    record(
      'support',
      'ticket comment',
      comments.ok ? 'exists' : 'refused',
      comments.ok ? `${comments.data.length} comment(s)` : comments.refusal,
    );
}

async function populateAcademyStep(ctx) {
  const { user, record } = ctx;
  const defs = await call(user, 'q', 'academy', 'certDefinitions');
  if (!defs.ok) return record('academy', 'paths', 'refused', defs.refusal);
  const def = defs.data[0];
  if (!def) return record('academy', 'enrol', 'skipped', 'no certification path is defined');
  for (const pathSlug of ACADEMY_PATHS) {
    const enrol = await call(user, 'm', 'academy', 'enrollCertPath', { pathSlug });
    record(
      'academy',
      `enrol in path "${pathSlug}"`,
      enrol.ok ? 'created' : 'refused',
      enrol.ok ? 'enrolled (repeat is a no-op)' : enrol.refusal,
    );
  }
  for (const slug of planAcademyProgress({ requiredItemSlugs: def.requiredItemSlugs })) {
    const done = await call(user, 'm', 'academy', 'markCurriculumComplete', { itemSlug: slug });
    record('academy', `lesson done: ${slug}`, done.ok ? 'created' : 'refused', done.ok ? 'marked complete' : done.refusal);
  }
  const prog = await call(user, 'q', 'academy', 'certProgress', { certId: def.id });
  if (prog.ok)
    record(
      'academy',
      'path progress',
      'exists',
      `${prog.data.completedCount} of ${prog.data.requiredCount} lessons; certificate not granted (left unfinished on purpose)`,
    );
}

async function populateAcademyRoomStep(ctx) {
  const { user, record } = ctx;
  const slug = 'local-test-study-room';
  const rooms = await call(user, 'q', 'academy', 'rooms', { limit: 100 });
  if (!rooms.ok) return record('academy', 'study room', 'refused', rooms.refusal);
  if (rooms.data.some((r) => r.slug === slug)) return record('academy', 'study room', 'exists', slug);
  const room = await call(user, 'm', 'academy', 'createRoom', {
    slug,
    name: `${POPULATE_LABEL} study room`,
    kind: 'general',
    access: 'free',
    capacity: 25,
  });
  record('academy', 'study room (free, 25 seats)', room.ok ? 'created' : 'refused', room.ok ? `room ${room.data.id}` : room.refusal);
  if (!room.ok) return;
  const startsAt = new Date(Date.now() + 2 * 86_400_000).toISOString();
  const session = await call(user, 'm', 'academy', 'scheduleSession', {
    roomId: room.data.id,
    title: `${POPULATE_LABEL}: orientation session`,
    startsAt,
  });
  record(
    'academy',
    'scheduled session (in 2 days)',
    session.ok ? 'created' : 'refused',
    session.ok ? `session ${session.data.id}` : session.refusal,
  );
}

async function populateReferralStep(ctx) {
  const { user, record } = ctx;
  const out = await call(user, 'm', 'identity', 'affiliates.createShare');
  record(
    'promotion',
    'referral share link',
    out.ok ? 'created' : 'refused',
    out.ok ? `share token ${out.data.token} (idempotent while unrevoked)` : out.refusal,
  );
}

async function populateBlueprintStep(ctx) {
  const { user, record } = ctx;
  const me = await call(user, 'q', 'blueprint', 'me');
  if (me.ok && me.data) return record('blueprint', 'profile', 'exists', 'profile already there');
  const out = await call(user, 'm', 'blueprint', 'onboard', {
    locale: 'en',
    responses: [{ key: 'intent', value: `${POPULATE_LABEL}: test answer from the local test world, not a real person` }],
    visibility: 'private',
    mentorAvailable: false,
  });
  record('blueprint', 'onboard a profile', out.ok ? 'created' : 'refused', out.ok ? 'private test profile' : out.refusal);
}

async function populateQuantStep(ctx) {
  const { user, record } = ctx;
  const list = await call(user, 'q', 'quant', 'studio.list', { limit: 50 });
  const name = `${POPULATE_PREFIX}momentum sketch`;
  if (list.ok && list.data.strategies.some((s) => s.name === name)) return record('quant', 'saved strategy', 'exists', name);
  const out = await call(user, 'm', 'quant', 'studio.save', {
    name,
    blocks: [{ side: 'buy', symbol: 'BTC-USD', qty: '0.01' }],
    risk: { maxDrawdown: '500', maxNotional: '1000', kill: '900' },
    cash: '10000',
    environment: 'paper',
  });
  record(
    'quant',
    'saved strategy (paper)',
    out.ok ? 'created' : 'refused',
    out.ok ? `strategy ${out.data.id} (svc-quant keeps these in memory only)` : out.refusal,
  );
}

async function populateMarketStep(ctx) {
  const { user, record } = ctx;
  const mine = await call(user, 'q', 'market', 'mine');
  if (mine.ok && mine.data) return record('market', 'vendor application', 'exists', `status ${mine.data.status ?? 'recorded'}`);
  const out = await call(user, 'm', 'market', 'applyAsVendor', {
    displayName: `${POPULATE_LABEL} vendor`,
    description: `${POPULATE_LABEL}: a test vendor application from the local test world, not a real business.`,
  });
  record('market', 'vendor application', out.ok ? 'created' : 'refused', out.ok ? 'pending operator review' : out.refusal);
  const listing = await call(user, 'm', 'market', 'createListing', {
    title: `${POPULATE_LABEL} listing`,
    description: `${POPULATE_LABEL}: test listing, not for sale.`,
    offerType: 'one_time',
    assetId: 'USDT',
    price: '1',
  });
  record('market', 'listing', listing.ok ? 'created' : 'refused', listing.ok ? `listing ${listing.data.id}` : listing.refusal);
}

async function populateTokenStep(ctx) {
  const { user, record } = ctx;
  const stakes = await call(user, 'q', 'token', 'listStakes', { limit: 10 });
  if (stakes.ok && stakes.data.length > 0) return record('token', 'stake', 'exists', `${stakes.data.length} stake(s)`);
  const ref = `populate-ifc-${user.account.userId}`;
  const fund = fundViaStack(user.account.userId, 'IFC', '1000', ref);
  record(
    'token',
    'test IFC funds',
    fund.ok ? 'created' : 'refused',
    fund.ok ? `1000 IFC through the ledger, ref ${populateRef(ref)}` : oneLine(fund.text, 240),
  );
  if (!fund.ok) return;
  const out = await call(user, 'm', 'token', 'stake', {
    amount: '100',
    tier: 'flex',
    stakeId: populateUuid(`stake-${user.account.userId}-1`),
  });
  record('token', 'stake 100 IFC (flex)', out.ok ? 'created' : 'refused', out.ok ? `stake ${out.data.id}` : out.refusal);
}

async function populateAgentsStep(ctx) {
  ctx.record(
    'agents',
    'agent sessions',
    'skipped',
    'opening a session or running an agent calls a language-model provider (real spend); not done by populate. The agent definitions and routes are readable without it',
  );
}

async function populateMerchantStep(ctx) {
  const { user, record } = ctx;
  const me = await call(user, 'q', 'pay', 'merchant.me');
  if (me.ok && me.data) return record('merchant', 'merchant account', 'exists', `merchant ${me.data.id}`);
  record(
    'merchant',
    'sandbox merchant account, payments, link, customer, invoice',
    'refused',
    `${me.ok ? 'no merchant' : me.refusal}. pay:* merchant scopes are never issued to an ordinary session (packages/auth merchant-pay-scope-grant.ts: owner-only, refuse-closed); populate does not mint them`,
  );
}

const STEP_FNS = {
  spaces: populateSpacesStep,
  transfers: populateTransfersStep,
  friend: populateFriendStep,
  earn: populateEarnStep,
  loans: populateLoansStep,
  cards: populateCardsStep,
  p2p: populateP2pStep,
  alerts: populateAlertsStep,
  trade: populateTradeStep,
  support: populateSupportStep,
  academy: populateAcademyStep,
  'academy-room': populateAcademyRoomStep,
  referral: populateReferralStep,
  blueprint: populateBlueprintStep,
  quant: populateQuantStep,
  market: populateMarketStep,
  token: populateTokenStep,
  agents: populateAgentsStep,
  merchant: populateMerchantStep,
};

/** Read-only: what each room would show right now. PRESENT when it has rows, EMPTY when it does not. */
export const VERIFY_READS = [
  { room: 'bank', item: 'spaces', mod: 'bank', proc: 'spaces.list', input: { limit: 200 }, count: (d) => d.length },
  { room: 'bank', item: 'activity (first page)', mod: 'bank', proc: 'activity.list', input: { limit: 50 }, count: (d) => d.items.length },
  {
    room: 'bank',
    item: 'portfolio priced assets',
    mod: 'bank',
    proc: 'portfolio.summary',
    input: undefined,
    count: (d) => d.priced.length,
  },
  { room: 'earn', item: 'positions', mod: 'bank', proc: 'earn.positions', input: { limit: 50 }, count: (d) => d.length },
  { room: 'loans', item: 'loans', mod: 'bank', proc: 'loans.list', input: { limit: 50 }, count: (d) => d.length },
  { room: 'cards', item: 'cards', mod: 'bank', proc: 'cards.list', input: { limit: 50 }, count: (d) => d.length },
  { room: 'p2p', item: 'offers', mod: 'p2p', proc: 'offers.list', input: { limit: 50 }, count: (d) => d.length },
  { room: 'notifications', item: 'inbox items', mod: 'notify', proc: 'notify.list', input: { limit: 50 }, count: (d) => d.items.length },
  { room: 'alerts', item: 'price alerts', mod: 'notify', proc: 'notify.alerts', input: { limit: 50 }, count: (d) => d.items.length },
  { room: 'support', item: 'tickets', mod: 'support', proc: 'listMine', input: { limit: 50 }, count: (d) => d.length },
  { room: 'academy', item: 'rooms', mod: 'academy', proc: 'rooms', input: { limit: 50 }, count: (d) => d.length },
  { room: 'academy', item: 'certificates granted', mod: 'academy', proc: 'myCerts', input: { limit: 50 }, count: (d) => d.length },
  { room: 'quant', item: 'saved strategies', mod: 'quant', proc: 'studio.list', input: { limit: 50 }, count: (d) => d.strategies.length },
  { room: 'market', item: 'vendor application', mod: 'market', proc: 'mine', input: undefined, count: (d) => (d ? 1 : 0) },
  { room: 'token', item: 'stakes', mod: 'token', proc: 'listStakes', input: { limit: 50 }, count: (d) => d.length },
  { room: 'blueprint', item: 'profile', mod: 'blueprint', proc: 'me', input: undefined, count: (d) => (d ? 1 : 0) },
  { room: 'merchant', item: 'merchant account', mod: 'pay', proc: 'merchant.me', input: undefined, count: (d) => (d ? 1 : 0) },
];

async function populateVerify(ctx) {
  const { user, record } = ctx;
  for (const r of VERIFY_READS) {
    const out = await call(user, 'q', r.mod, r.proc, r.input);
    if (!out.ok) {
      record(r.room, r.item, 'refused', out.refusal);
      continue;
    }
    const n = r.count(out.data);
    record(r.room, r.item, n > 0 ? 'exists' : 'skipped', n > 0 ? `PRESENT (${n})` : 'EMPTY (0)');
  }
  const progress = await call(user, 'q', 'academy', 'certProgress', { certId: 'foundations-v1' });
  if (progress.ok)
    record('academy', 'path progress', 'exists', `${progress.data.completedCount} of ${progress.data.requiredCount} lessons done`);
}

function renderTable(results) {
  const lines = [];
  for (const r of results)
    lines.push(
      `  ${r.status.toUpperCase().padEnd(7)} ${r.room.padEnd(10)} ${r.item}  ${r.detail ? `- ${oneLine(r.detail, 220)}` : ''}`.trimEnd(),
    );
  return lines.join('\n');
}

async function cmdPopulate(argv) {
  let opts;
  try {
    opts = parsePopulateArgs(argv);
  } catch (err) {
    die(err.message, 2);
  }
  const unknown = (opts.only ?? []).filter((k) => !POPULATE_STEPS.includes(k));
  if (unknown.length) die(`unknown step(s): ${unknown.join(', ')}. Steps: ${POPULATE_STEPS.join(', ')}`, 2);
  const steps = opts.only ?? POPULATE_STEPS;
  const { paths: p } = guard();
  const log = makeLogger(p.log);
  if (opts.dryRun) {
    console.log(`populate (dry run, nothing is changed). ${LABEL}\nstate: ${p.stateDir}\nsteps: ${steps.join(', ')}`);
    console.log(`spaces: ${POPULATE_SPACES.map((s) => `${s.name} [${s.assetId}]`).join('; ')}`);
    console.log(`internal transfers: ${POPULATE_TRANSFERS.map((t) => `${t.amount} ${t.from}->${t.to}`).join('; ')}`);
    console.log(
      `friend -> user: ${POPULATE_FRIEND_TO_USER.map((t) => `${t.amount} ${t.asset}`).join('; ')}; user -> friend: ${POPULATE_USER_TO_FRIEND.map((t) => `${t.amount} ${t.asset}`).join('; ')}`,
    );
    return;
  }
  const secrets = readJson(p.secrets, null);
  if (!secrets) die('secrets.json missing in the local stack state directory');
  let login;
  try {
    login = parseLoginFile(fs.readFileSync(opts.loginFile, 'utf8'));
  } catch {
    login = null;
  }
  if (!login) die(`no Email / Password lines in ${opts.loginFile} (the test account note). Nothing was changed.`);
  const account = { handle: 'local_test_account', email: login.email, password: login.password, userId: null };
  const user = new EdgeClient(account);
  try {
    await user.login();
  } catch (err) {
    die(`the test account could not sign in: ${oneLine(err.message, 200)}`);
  }
  log(`populate started for ${account.email} (${account.userId}). ${LABEL}. Steps: ${steps.join(', ')}`);

  const results = [];
  const ctx = { user, p, secrets, log, spaces: null, friend: null, record: null };
  let room = 'run';
  ctx.record = (r, item, status, detail = '') => {
    const row = { room: r, item, status, detail };
    results.push(row);
    room = r;
    log(`populate ${status.toUpperCase()} ${r}: ${item}${detail ? ` - ${oneLine(detail, 200)}` : ''}`);
  };
  for (const key of opts.verify ? [] : steps) {
    try {
      await STEP_FNS[key](ctx);
    } catch (err) {
      ctx.record(room === 'run' ? key : room, `step ${key}`, 'error', oneLine(err.message ?? err, 300));
    }
  }
  if (opts.verify) await populateVerify(ctx);
  const summary = summarizeResults(results);
  if (opts.verify) {
    console.log(`\npopulate --verify (read-only): ${JSON.stringify(summary.total)}  ${LABEL}\n${renderTable(results)}`);
    return;
  }
  writePrivate(path.join(p.stateDir, 'run', 'populate-last.json'), {
    label: LABEL,
    at: nowIso(),
    userId: account.userId,
    summary,
    results,
  });
  console.log(`\npopulate: ${JSON.stringify(summary.total)}  ${LABEL}\n${renderTable(results)}`);
  if (summary.total.error > 0) process.exitCode = 3;
}

async function main() {
  const cmd = process.argv[2];
  if (cmd === 'watch') await cmdWatch();
  else if (cmd === 'seed') await cmdSeed();
  else if (cmd === 'status') cmdStatus();
  else if (cmd === 'populate') await cmdPopulate(process.argv.slice(3));
  else die('usage: local-test-world.mjs watch | seed | status | populate [--only a,b] [--login-file <path>] [--dry-run] [--verify]', 2);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) await main();
