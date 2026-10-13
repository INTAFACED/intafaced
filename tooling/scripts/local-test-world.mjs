#!/usr/bin/env node
/**
 * LOCAL TEST WORLD — makes a new account on the LOCAL test stack feel used. Local only.
 *
 *   node tooling/scripts/local-test-world.mjs watch   welcome funds for every new account + a friend who sends money back
 *   node tooling/scripts/local-test-world.mjs seed    create `test_friend`, fund it, send the newest real user 3 small transfers
 *   node tooling/scripts/local-test-world.mjs status  who has been welcomed, what the friend has seen
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

export function stackPaths(home = os.homedir()) {
  const stateDir = path.join(home, '.intafaced', 'local-test-stack');
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
export function assertLocalTarget({ home = os.homedir(), urls = [EDGE] } = {}) {
  const p = stackPaths(home);
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
  return /^test[-_](market[-_]maker|taker)/i.test(String(handle));
}

/** A test account of any kind (market, friend, harness) — never picked as "the founder". */
export function isTestAccount(user) {
  return /^test[-_]/i.test(String(user.handle)) || /@(local\.test|local-test\.invalid|example\.invalid)$/i.test(String(user.email));
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
      fs.appendFileSync(file, `${line}\n`);
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

/** Credit through the real ledger by calling `local:fund` (idempotent on --ref). Returns { ok, txId, text }. */
function fundViaStack(userId, asset, amount, ref) {
  const r = spawnSync(process.execPath, [STACK_SCRIPT, 'fund', userId, asset, amount, '--ref', ref], { encoding: 'utf8' });
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
    if (auth && (!this.token || Date.now() - this.tokenAt > 8 * 60_000)) await this.login();
    const headers = { origin: CUSTOMER_ORIGIN, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) };
    if (auth) headers.authorization = `Bearer ${this.token}`;
    const res = await fetch(`${EDGE}${route}`, {
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
  for (const w of todo) {
    const r = fundViaStack(w.userId, w.asset, w.amount, w.ref);
    if (!r.ok) {
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
  return { credited, users };
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

// ── Commands ────────────────────────────────────────────────────────────────

function guard() {
  try {
    return assertLocalTarget({ urls: [EDGE, `http://${LOCAL_HOST}:14501`, `http://${LOCAL_HOST}:14502`, `http://${LOCAL_HOST}:14509`] });
  } catch (err) {
    if (err instanceof GuardError) die(err.message);
    throw err;
  }
}

async function cmdWatch() {
  const { paths: p } = guard();
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

async function main() {
  const cmd = process.argv[2];
  if (cmd === 'watch') await cmdWatch();
  else if (cmd === 'seed') await cmdSeed();
  else if (cmd === 'status') cmdStatus();
  else die('usage: local-test-world.mjs watch | seed | status', 2);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) await main();
