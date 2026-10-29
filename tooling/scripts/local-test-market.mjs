#!/usr/bin/env node
/**
 * LOCAL TEST MARKET — makes Trade look alive on the LOCAL test stack only.
 *
 *   pnpm local:market                start (background, safe to re-run); prints what it found
 *   pnpm local:market status         pid, ok / STALE / DOWN, and the age of its last log line
 *   pnpm local:market ensure          start it again only if it was started before and is not running now
 *   pnpm local:market stop           stop it, cancel its resting orders, and forget it (ensure then leaves it off)
 *                                    (pnpm local:market:stop is the same as stop)
 *   node tooling/scripts/local-test-market.mjs check
 *   node tooling/scripts/local-test-market.mjs history [--bars 210] [--step-minutes 15] [--trades-per-bar 2]
 *                                    on a FRESH stack, with the market stopped: real TEST trades now, then moved into the
 *                                    past (fill times only) so charts have history. Skips any market that already traded.
 *
 * What it does, every few seconds, for each published market it has a TEST PRICE for:
 *   1. moves a deterministic, seedable synthetic price (integer arithmetic, no float money);
 *   2. as the labelled test account `test_market_maker`, re-places (new first, then cancels the old) a ladder of
 *      post-only bids and asks around that price;
 *   3. now and then, a second labelled account `test_taker` crosses the best level with a
 *      small immediate-or-cancel order, so trades (and therefore candles) exist.
 *
 * Every order goes through the real front door (Edge /api/v1 -> svc-trade -> svc-matching),
 * and every balance is a real ledger entry: funding reuses `local:fund` (svc-ledger deposit
 * recipe, rail ref LOCAL-TEST-...). Nothing here writes a balance, a fill or a price into any
 * database. Prices are TEST PRICES: invented starting points, not a market feed. `history` also asks
 * svc-trade's signed LOCAL TEST route to move its own TEST tape fills into the past; it moves times, nothing else.
 *
 * Containment (failure it prevents: quoting or funding against a real environment): refuses
 * unless the local test stack's state directory and LOCAL-TEST-STACK.json marker exist and
 * every target URL is http://127.0.0.1:<a port the marker lists>.
 *
 * Preflight: three gates in the current services stop any order on a fresh local stack (see
 * docs/LOCAL-TEST-STACK.md, "Living test market"). This script reads them with GET requests
 * and refuses, naming each one, instead of spamming failing orders.
 *
 * Docs: docs/LOCAL-TEST-STACK.md
 */
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  localStackState,
  assertActiveLocalStack,
  processRecordMatches,
  readProcessIdentity,
  readLatestEmailConfirmToken,
} from './local-test-state.mjs';
import { LOCAL_TEST_DEVICE_KEY } from './local-test-device.mjs';

const SCRIPT = fileURLToPath(import.meta.url);
const REPO = path.resolve(path.dirname(SCRIPT), '..', '..');
const STACK_SCRIPT = path.join(path.dirname(SCRIPT), 'local-test-stack.mjs');
const MARKER_KIND = 'intafaced-local-test-stack';
const LOCAL_HOST = '127.0.0.1';
const DEFAULT_EDGE = 'http://127.0.0.1:14500';
const DEFAULT_CUSTOMER_ORIGIN = 'http://127.0.0.1:3210';
const LABEL = 'LOCAL TEST MARKET — TEST PRICES, not a market feed, not real money';

// ── Containment guard (exported for tests) ──────────────────────────────────

export class GuardError extends Error {}

export function stackPaths(home = os.homedir()) {
  const stateDir = localStackState(home);
  return {
    stateDir,
    marker: path.join(stateDir, 'LOCAL-TEST-STACK.json'),
    secrets: path.join(stateDir, 'secrets.json'),
    accounts: path.join(stateDir, 'market-accounts.json'),
    runDir: path.join(stateDir, 'run'),
    pidFile: path.join(stateDir, 'run', 'market.json'),
    walkFile: path.join(stateDir, 'run', 'market-walk.json'),
    log: path.join(stateDir, 'logs', 'market.log'),
  };
}

/** Throws GuardError unless this machine has the local test stack and every URL is its own 127.0.0.1 port. */
export function assertLocalTarget({ home = os.homedir(), urls = [DEFAULT_EDGE] } = {}) {
  const p = stackPaths(home);
  if (!fs.existsSync(p.stateDir))
    throw new GuardError(`refusing: state directory ${p.stateDir} not found. Start the stack first (pnpm local:stack).`);
  if (!fs.existsSync(p.marker)) throw new GuardError(`refusing: marker ${p.marker} not found. Start the stack first (pnpm local:stack).`);
  let marker;
  try {
    marker = JSON.parse(fs.readFileSync(p.marker, 'utf8'));
  } catch {
    throw new GuardError('refusing: marker file is unreadable');
  }
  if (marker?.kind !== MARKER_KIND) throw new GuardError('refusing: marker file is not a local test stack marker');
  const ports = new Set(Object.values(marker.ports ?? {}).map(String));
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

// ── Decimal helpers: scaled bigint, 8 places. No JS number ever holds money. ─

const SCALE_DIGITS = 8;
const ONE = 10n ** BigInt(SCALE_DIGITS);

export function toScaled(text) {
  if (typeof text !== 'string' || !/^\d+(\.\d+)?$/.test(text)) throw new Error(`not a plain decimal string: ${String(text)}`);
  const [whole, frac = ''] = text.split('.');
  if (frac.length > SCALE_DIGITS) throw new Error(`more than ${SCALE_DIGITS} decimal places: ${text}`);
  return BigInt(whole) * ONE + BigInt(frac.padEnd(SCALE_DIGITS, '0'));
}
/** Like toScaled, but rounds a longer fraction DOWN to 8 places. For reading balances: trade fills can leave a balance with more places than the 8 this script quotes in. */
export function toScaledFloor(text) {
  if (typeof text !== 'string' || !/^\d+(\.\d+)?$/.test(text)) throw new Error(`not a plain decimal string: ${String(text)}`);
  const [whole, frac = ''] = text.split('.');
  return BigInt(whole) * ONE + BigInt(frac.slice(0, SCALE_DIGITS).padEnd(SCALE_DIGITS, '0'));
}
export function fromScaled(value) {
  const whole = value / ONE;
  const frac = (value % ONE).toString().padStart(SCALE_DIGITS, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : `${whole}`;
}
const floorTo = (v, step) => (v / step) * step;
const ceilTo = (v, step) => ((v + step - 1n) / step) * step;

// ── Deterministic price walk (exported for tests) ───────────────────────────

/** mulberry32 over a 32-bit seed from sha256(seed:symbol). Pure and portable. */
function rngFor(seed, symbol) {
  let a = crypto.createHash('sha256').update(`${seed}:${symbol}`).digest().readUInt32LE(0);
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296; // a unit fraction for randomness only, never money
  };
}

/**
 * A bounded random walk with gentle pull back to the starting reference, in whole
 * basis points on a scaled bigint price, snapped to the market tick. Same seed + symbol +
 * start gives the same series. `startScaled` is a TEST PRICE.
 */
export function createPriceWalk({ seed, symbol, startScaled, tickScaled, maxStepBps = 12n, bandBps = 2000n }) {
  const rand = rngFor(String(seed), symbol);
  let price = floorTo(startScaled, tickScaled);
  let steps = 0;
  const lo = floorTo((startScaled * (10000n - bandBps)) / 10000n, tickScaled);
  const hi = ceilTo((startScaled * (10000n + bandBps)) / 10000n, tickScaled);
  return {
    get steps() {
      return steps;
    },
    current: () => price,
    next() {
      const span = Number(maxStepBps) * 2 + 1;
      const move = BigInt(Math.floor(rand() * span)) - maxStepBps;
      const pullBps = ((price - startScaled) * 10000n) / startScaled / 40n; // 1/40 of the distance, in bps
      let bps = move - pullBps;
      if (bps === 0n) bps = rand() < 0.5 ? 1n : -1n; // never freeze
      let next = floorTo(price + (price * bps) / 10000n, tickScaled);
      if (next === price) next = bps > 0n ? price + tickScaled : price - tickScaled;
      price = next < lo ? lo : next > hi ? hi : next;
      steps += 1;
      return price;
    },
    advance(n) {
      for (let i = 0; i < n; i += 1) this.next();
      return price;
    },
  };
}

// ── Quote ladder (exported for tests) ───────────────────────────────────────

/**
 * Layered post-only quotes around `mid`. Bids round down, asks round up to the tick; the
 * size of each level is a notional (in quote units) divided by the level price, rounded to
 * the lot step and raised if it would fall under the market's minimum amount or cost.
 */
export function buildLadder({ mid, tick, lot, minAmount, minCost, levels, halfSpreadBps, stepBps, levelNotional }) {
  const out = [];
  for (let i = 0; i < levels; i += 1) {
    const offset = halfSpreadBps + BigInt(i) * stepBps;
    for (const side of ['buy', 'sell']) {
      let price = side === 'buy' ? floorTo((mid * (10000n - offset)) / 10000n, tick) : ceilTo((mid * (10000n + offset)) / 10000n, tick);
      if (price <= 0n) price = tick;
      let amount = floorTo((levelNotional * BigInt(i + 1) * ONE) / price, lot);
      if (amount < minAmount) amount = ceilTo(minAmount, lot);
      if ((price * amount) / ONE < minCost) amount = ceilTo((minCost * 12n * ONE) / (10n * price), lot);
      out.push({ side, level: i, price: fromScaled(price), amount: fromScaled(amount) });
    }
  }
  return out;
}

// ── TEST PRICE table: invented, illustrative starting points ────────────────
// Not a feed and not quotes. Quote-currency amounts per level are for sizing only.
export const TEST_PRICES = {
  'BTC/USDT': { start: '65000', notional: '3000' },
  'BTC/USDC': { start: '65000', notional: '3000' },
  'ETH/USDT': { start: '2600', notional: '2000' },
  'ETH/USDC': { start: '2600', notional: '2000' },
  'IFC/USDT': { start: '1', notional: '500' },
  // The labelled TEST spot market with no dollar side (`local-test-gates.mjs apply` lists it). Notional is in BTC.
  'ETH/BTC': { start: '0.04', notional: '0.05' },
  // The labelled TEST perpetual (`local-test-gates.mjs futures` lists it). Its mark comes from the BTC/USDT book
  // (TRADE_FUTURES_INDEX_SPOT_MARKETS), so it is quoted around that book's own mid each cycle (`quoteOrder`) and stays
  // inside the band and the market-open slippage cap around that mark.
  // Quotes go through the futures book; no crossings by test_taker, whose account carries no futures terms.
  'BTC/USDT:USDT': { start: '65000', notional: '3000', follows: 'BTC/USDT', cross: false },
  'XAU/USD': { start: '2650', notional: '3000' },
  'XAG/USD': { start: '31', notional: '1500' },
  'WTI/USD': { start: '72', notional: '1500' },
  'BRENT/USD': { start: '76', notional: '1500' },
  'NATGAS/USD': { start: '2.8', notional: '1500' },
};
/**
 * The markets in quoting order, each with the market it is centred on (exported for tests). A market that follows
 * another quoted in this run (`follows`, as the TEST perp follows the BTC/USDT book that marks it) comes after it and
 * is quoted around that book's own mid, read after the leader is requoted (`bookMid`), never around a walk of its
 * own: `history` advances only the spot walks, hundreds of steps, so a follower walking the same series from its own
 * step count sat at an unrelated point of it, up to about 1% from the book that marks it (failure it prevents:
 * J-derivatives-03 #9 on main runs 640 and 641, the reverse's market open found no bid within the 50 bps slippage cap
 * of the mark and ended `closed_only`, unfilled). A follower whose leader is not quoted in this run, or that follows
 * itself round a loop, walks on its own (`leader: null`).
 */
export function quoteOrder(markets, prices = TEST_PRICES) {
  const inRun = new Set(markets.map((m) => m.symbol));
  const followsIn = (m) => {
    const follows = prices[m.symbol]?.follows;
    return follows && follows !== m.symbol && inRun.has(follows) ? follows : null;
  };
  const out = [];
  const placed = new Set();
  // Each market right after the one it follows, so its leader's book is read just after that book was requoted.
  const visit = (m, leader) => {
    out.push({ market: m, leader });
    placed.add(m.symbol);
    for (const f of markets) if (!placed.has(f.symbol) && followsIn(f) === m.symbol) visit(f, m.symbol);
  };
  for (const m of markets) if (!placed.has(m.symbol) && !followsIn(m)) visit(m, null);
  // What is left follows round a loop: each walks on its own.
  for (const m of markets) if (!placed.has(m.symbol)) visit(m, null);
  return out;
}

/** The mid of a book's best bid and best ask (a public order book answer), scaled; null when either side is empty. */
export function bookMid(book) {
  const bid = book?.bids?.[0]?.[0];
  const ask = book?.asks?.[0]?.[0];
  if (typeof bid !== 'string' || typeof ask !== 'string') return null;
  try {
    return (toScaled(bid) + toScaled(ask)) / 2n;
  } catch {
    return null;
  }
}

const DEFAULT_SYMBOLS = ['BTC/USDT', 'BTC/USDC', 'ETH/USDT', 'ETH/USDC', 'IFC/USDT', 'ETH/BTC', 'BTC/USDT:USDT'];
// Funded to this level by `local:fund` (real ledger deposits, LOCAL-TEST- rail refs); the taker gets a tenth.
const FUND_TO = {
  USDT: '1000000',
  USDC: '1000000',
  USD: '1000000',
  BTC: '20',
  ETH: '300',
  IFC: '2000000',
  XAU: '100',
  XAG: '5000',
  WTI: '5000',
  BRENT: '5000',
  NATGAS: '100000',
};

// ── Logging ─────────────────────────────────────────────────────────────────

let LOG_FILE = null;
let ECHO = true; // background child: stdout already is the log file
const nowIso = () => new Date().toISOString();
function log(line) {
  const text = `${nowIso()} [TEST MARKET] ${line}`;
  if (ECHO) process.stdout.write(`${text}\n`);
  if (LOG_FILE) {
    try {
      fs.appendFileSync(LOG_FILE, `${text}\n`, { mode: 0o600 });
    } catch {
      /* console copy remains */
    }
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function die(msg, code = 1) {
  process.stderr.write(`\nlocal-test-market: ${msg}\n`);
  if (LOG_FILE) {
    EXIT.reason ??= msg;
    log(`exiting: ${msg}`);
  }
  process.exit(code);
}

// ── Exit logging ────────────────────────────────────────────────────────────
// Failure it prevents: the market stopped twice overnight and the second time the log ended with no
// word on why (a stop nobody noticed for 30+ minutes). Every exit path now writes one EXIT line.
// SIGKILL and a power cut cannot be caught; for those the log simply ends and `status` shows STALE.

export const STOP = { requested: false };
const EXIT = { reason: null };

/** Route every way this process can end into the log. Pass the log file; echo to the console is switched off. */
export function installExitLogging(logFile, { echo = false } = {}) {
  LOG_FILE = logFile;
  ECHO = echo;
  fs.mkdirSync(path.dirname(logFile), { recursive: true, mode: 0o700 });
  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP'])
    process.on(sig, () => {
      EXIT.reason ??= `received ${sig}`;
      STOP.requested = true;
      log(`received ${sig}; stopping`);
    });
  process.on('uncaughtException', (err) => {
    EXIT.reason = `uncaught exception: ${err?.stack ?? err}`;
    log(`FATAL ${EXIT.reason}`);
    process.exit(70);
  });
  process.on('unhandledRejection', (err) => {
    EXIT.reason = `unhandled rejection: ${err?.stack ?? err}`;
    log(`FATAL ${EXIT.reason}`);
    process.exit(71);
  });
  process.on('exit', (code) => {
    log(`EXIT pid ${process.pid} code ${code}: ${EXIT.reason ?? (code === 0 ? 'normal stop' : 'no reason recorded')}`);
  });
}

// ── Edge client (the real customer-facing front door) ───────────────────────

class EdgeClient {
  constructor(edge, account) {
    this.edge = edge;
    this.account = account;
    this.token = null;
    this.tokenAt = 0;
  }
  async http(method, route, body, { auth = true } = {}) {
    if (method !== 'GET') assertActiveLocalStack();
    if (auth && (!this.token || Date.now() - this.tokenAt > 8 * 60_000)) await this.login();
    const headers = { origin: DEFAULT_CUSTOMER_ORIGIN, ...(body ? { 'content-type': 'application/json' } : {}) };
    if (auth) headers.authorization = `Bearer ${this.token}`;
    const res = await fetch(`${this.edge}${route}`, {
      redirect: 'error',
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30_000),
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* non-JSON refusal */
    }
    if (res.status === 401 && auth) this.token = null;
    return { status: res.status, json, text };
  }
  async login() {
    const res = await this.http(
      'POST',
      '/api/identity/trpc/auth.login',
      { identifier: this.account.email, password: this.account.password, deviceKey: LOCAL_TEST_DEVICE_KEY },
      { auth: false },
    );
    const data = res.json?.result?.data;
    if (!data?.accessToken) throw new Error(`login refused for ${this.account.handle} (${res.status})`);
    this.token = data.accessToken;
    this.tokenAt = Date.now();
    this.account.userId = data.userId;
  }
  async ensureAccount() {
    const login = await this.http(
      'POST',
      '/api/identity/trpc/auth.login',
      { identifier: this.account.email, password: this.account.password, deviceKey: LOCAL_TEST_DEVICE_KEY },
      { auth: false },
    );
    if (login.json?.result?.data?.accessToken) {
      this.token = login.json.result.data.accessToken;
      this.tokenAt = Date.now();
      this.account.userId = login.json.result.data.userId;
      return 'existing';
    }
    const reg = await this.http(
      'POST',
      '/api/identity/trpc/auth.register',
      { handle: this.account.handle, email: this.account.email, password: this.account.password, deviceKey: LOCAL_TEST_DEVICE_KEY },
      { auth: false },
    );
    const data = reg.json?.result?.data;
    if (!data?.accessToken) throw new Error(`could not register ${this.account.handle} (${reg.status}): ${reg.text.slice(0, 200)}`);
    this.token = data.accessToken;
    this.tokenAt = Date.now();
    this.account.userId = data.userId;
    return 'created';
  }
  /**
   * New custodial orders need a proved email (RC-identity-01). Proves it the way a
   * person does: auth.requestEmailConfirmation, then the link from the LOCAL-TEST
   * outbox into auth.confirmEmail. Never writes email_verified_at itself.
   */
  async proveEmail(outboxPath, waitMs = 10_000) {
    const me = await this.http('GET', '/api/identity/trpc/me');
    if (me.json?.result?.data?.emailVerified === true) return 'already proved';
    const readToken = () => {
      try {
        return readLatestEmailConfirmToken(fs.readFileSync(outboxPath, 'utf8'), this.account.email);
      } catch {
        return null;
      }
    };
    const before = readToken();
    const asked = await this.http('POST', '/api/identity/trpc/auth.requestEmailConfirmation', {});
    if (asked.status !== 200)
      throw new Error(`email proof request refused for ${this.account.handle} (${asked.status}): ${asked.text.slice(0, 200)}`);
    const until = Date.now() + waitMs;
    let token = readToken();
    while (!token || token === before) {
      if (Date.now() >= until) throw new Error(`no LOCAL-TEST confirm link reached ${this.account.email} in ${outboxPath}`);
      await new Promise((resolve) => setTimeout(resolve, 250));
      token = readToken();
    }
    const confirmed = await this.http('POST', '/api/identity/trpc/auth.confirmEmail', { token }, { auth: false });
    if (confirmed.status !== 200)
      throw new Error(`email confirm refused for ${this.account.handle} (${confirmed.status}): ${confirmed.text.slice(0, 200)}`);
    return 'proved';
  }
}

function loadAccounts(p) {
  let file = {};
  try {
    file = JSON.parse(fs.readFileSync(p.accounts, 'utf8'));
  } catch {
    /* first run */
  }
  const make = (key, handle) => {
    const email = `${handle.replace(/_/g, '-')}@local-test.invalid`;
    const have = file[key];
    return have?.password ? have : { handle, email, password: crypto.randomBytes(18).toString('base64url'), userId: null };
  };
  const accounts = { maker: make('maker', 'test_market_maker'), taker: make('taker', 'test_taker') };
  save(p, accounts);
  return accounts;
}
function save(p, accounts) {
  fs.mkdirSync(path.dirname(p.accounts), { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    p.accounts,
    JSON.stringify({ kind: 'intafaced-local-test-market-accounts', label: 'LOCAL TEST accounts, not real people', ...accounts }, null, 2),
    { mode: 0o600 },
  );
  fs.chmodSync(p.accounts, 0o600);
}

// ── Preflight: read the gates that stop orders ──────────────────────────────

async function preflight(maker, symbols) {
  const blockers = [];
  const edgeHealth = await fetch(`${maker.edge.replace(/\/+$/, '')}/health`, {
    redirect: 'error',
    signal: AbortSignal.timeout(10_000),
  }).catch(() => null);
  if (!edgeHealth) blockers.push('edge is not answering on its local port. Run: pnpm local:stack');
  // Gate 1: Edge refuses every NEW order unless matching's /health carries a halt flag.
  const marker = JSON.parse(fs.readFileSync(stackPaths().marker, 'utf8'));
  const matchingUrl = `http://${LOCAL_HOST}:${marker.ports.matching}`;
  const mh = await fetch(`${matchingUrl}/health`, { redirect: 'error', signal: AbortSignal.timeout(10_000) })
    .then((r) => r.json())
    .catch(() => null);
  if (!mh) blockers.push('matching /health is not answering');
  else if (typeof (mh.venueHalted ?? mh.halted) !== 'boolean')
    blockers.push(
      'GATE 1: matching /health has no halted/venueHalted flag, so Edge answers every new order with 503 edge.venue_halt_unavailable (services/svc-edge/src/matching-venue-halt.ts:51, services/svc-matching/src/index.ts:115)',
    );
  // Gate 2 + 3: lifecycle authority per market, as the same account would be judged.
  const reasons = new Map();
  for (const symbol of symbols) {
    const res = await maker.http('GET', `/api/v1/account/market-lifecycle/${encodeURIComponent(symbol)}`);
    const snap = res.json;
    const ok = snap?.allowedActions?.includes?.('PLACE_POST_ONLY');
    if (!ok)
      reasons.set(snap?.reasonCode ?? `http_${res.status}`, (reasons.get(snap?.reasonCode ?? `http_${res.status}`) ?? []).concat(symbol));
  }
  for (const [reason, syms] of reasons) {
    if (reason === 'trade.lifecycle_authority_unavailable')
      blockers.push(
        `GATE 2: no market-lifecycle publication exists for ${syms.join(', ')} (reason ${reason}); trade refuses every order (services/svc-trade/src/spot/trade-service.ts:757, services/svc-trade/src/market-lifecycle.ts:445). Publication is owner/legal approval evidence; this script does not invent it.`,
      );
    else if (reason === 'trade.matching_market_missing')
      blockers.push(
        `GATE 3: matching holds no book for ${syms.join(', ')} yet, and trade will not admit the first order until it does (services/svc-trade/src/market-lifecycle.ts:476-486; a book is only created by a submit, services/svc-matching/src/engine/engine.ts:254)`,
      );
    else blockers.push(`market lifecycle refuses PLACE_POST_ONLY for ${syms.join(', ')}: ${reason}`);
  }
  return blockers;
}

/** Crossing side for the nth crossing in a market: buy, sell, buy, sell... so the taker's balances stay flat. */
export const crossingSide = (n) => (n % 2 === 1 ? 'buy' : 'sell');

/**
 * Whether the taker crosses `symbol` on loop cycle `cycle` (from 1): every third cycle, the markets taking turns by
 * the parity of their symbol's length, so each market trades every sixth cycle. The first crossing is on cycle 1 for
 * the even-length symbols, BTC/USDT among them (failure it prevents:
 * the first BTC/USDT trade came on cycle 6, about a minute after the maker started, and the journeys run waited for it).
 */
export function crossesOn(cycle, symbol) {
  if (cycle % 3 !== 1) return false;
  return (Math.floor(cycle / 3) + symbol.length) % 2 === 0;
}

// ── Funding (reuses local:fund: real svc-ledger deposit, LOCAL-TEST- rail ref) ─

async function ensureFunds(client, who, assets, divisor) {
  const bal = await client.http('GET', '/api/v1/account/balance');
  const have = bal.json?.balances ?? {};
  for (const asset of assets) {
    const target = toScaled(FUND_TO[asset] ?? '0') / BigInt(divisor);
    if (target === 0n) continue;
    const free = toScaledFloor(have[asset]?.free ?? '0');
    if (free * 2n >= target) continue;
    const ref = `MM-${who}-${asset}-${nowIso().slice(0, 13).replace(/[-:T]/g, '')}`;
    const r = spawnSync(process.execPath, [STACK_SCRIPT, 'fund', client.account.userId, asset, fromScaled(target), '--ref', ref], {
      encoding: 'utf8',
    });
    if (r.status !== 0) throw new Error(`local:fund ${asset} failed: ${(r.stderr || r.stdout).trim().slice(0, 300)}`);
    // The rail ref repeats within the hour, so a second top-up is a ledger no-op: say so instead of "funded".
    const after = await client.http('GET', '/api/v1/account/balance');
    const nowFree = toScaledFloor(after.json?.balances?.[asset]?.free ?? '0');
    if (nowFree > free)
      log(`funded ${who} ${fromScaled(target)} ${asset} through the real ledger (TEST FUNDS, rail ref LOCAL-TEST-${ref})`);
    else log(`top-up for ${who} ${asset} already booked this hour (rail ref LOCAL-TEST-${ref}); nothing new credited`);
  }
}

// ── The loop ────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const opts = {
    seed: '1013',
    seconds: 8,
    levels: 3,
    symbols: null,
    foreground: false,
    edge: DEFAULT_EDGE,
    bars: 210,
    stepMinutes: 15,
    perBar: 2,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--seed') opts.seed = argv[++i];
    else if (a === '--interval') opts.seconds = Number(argv[++i]);
    else if (a === '--levels') opts.levels = Number(argv[++i]);
    else if (a === '--markets') opts.symbols = argv[++i] === 'all' ? Object.keys(TEST_PRICES) : argv[i].split(',');
    else if (a === '--edge-url') opts.edge = argv[++i];
    else if (a === '--foreground') opts.foreground = true;
    else if (a === '--bars') opts.bars = Number(argv[++i]);
    else if (a === '--step-minutes') opts.stepMinutes = Number(argv[++i]);
    else if (a === '--trades-per-bar') opts.perBar = Number(argv[++i]);
    else if (!a.startsWith('--'))
      // Failure it prevents: `pnpm local:market status` used to be `start status` and started a second copy.
      die(
        `unexpected argument "${a}". Commands: start | stop | status | ensure | check | history (for example: pnpm local:market ${a})`,
        2,
      );
  }
  if (!Number.isInteger(opts.seconds) || opts.seconds < 2) die('--interval must be a whole number of seconds, at least 2', 2);
  if (!Number.isInteger(opts.levels) || opts.levels < 1 || opts.levels > 10) die('--levels must be 1..10', 2);
  if (!Number.isInteger(opts.bars) || opts.bars < 1 || opts.bars > 2000) die('--bars must be 1..2000', 2);
  if (!Number.isInteger(opts.stepMinutes) || opts.stepMinutes < 1 || opts.stepMinutes > 1440) die('--step-minutes must be 1..1440', 2);
  if (![1, 2, 3, 4, 5, 6].includes(opts.perBar)) die('--trades-per-bar must be 1..6', 2);
  // svc-trade's own limits on one retime (services/svc-trade/src/spot/local-test-tape.ts).
  if (opts.bars * opts.perBar > 5000) die('--bars times --trades-per-bar must be at most 5000', 2);
  // One bar of slack: the window ends at the start of the current bucket, not at now, so a full 31 days would start
  // just past svc-trade's 31-day limit.
  if ((opts.bars + 1) * opts.stepMinutes > 31 * 24 * 60) die('--bars plus one, times --step-minutes, must stay within 31 days', 2);
  return opts;
}

async function discoverMarkets(edge, wanted) {
  const res = await edge.http('GET', '/api/v1/markets?limit=500', null, { auth: false });
  if (!Array.isArray(res.json)) throw new Error(`could not list markets (${res.status})`);
  return res.json
    .filter(
      (m) =>
        m.active &&
        m.orderable &&
        (m.spot || (m.swap && m.test === true)) &&
        !m.paper &&
        TEST_PRICES[m.symbol] &&
        wanted.includes(m.symbol),
    )
    .map((m) => ({
      id: m.id,
      symbol: m.symbol,
      swap: m.swap === true,
      base: m.base,
      quote: m.quote,
      tick: toScaled(m.precision.price),
      lot: toScaled(m.precision.amount),
      minAmount: toScaled(m.limits.amount.min ?? m.precision.amount),
      minCost: toScaled(m.limits.cost.min ?? '0'),
    }));
}

async function runLoop(opts, home) {
  const { paths: p } = assertLocalTarget({ home, urls: [opts.edge] });
  installExitLogging(p.log, { echo: ECHO });
  assertActiveLocalStack({ stateDir: p.stateDir });
  const accounts = loadAccounts(p);
  const maker = new EdgeClient(opts.edge, accounts.maker);
  const taker = new EdgeClient(opts.edge, accounts.taker);
  log(`${LABEL}. seed=${opts.seed}, requote every ${opts.seconds}s`);
  log(`maker ${await maker.ensureAccount()} (${accounts.maker.handle}); taker ${await taker.ensureAccount()} (${accounts.taker.handle})`);
  save(p, accounts);
  const outbox = path.join(p.stateDir, 'email-outbox.log');
  log(`maker email ${await maker.proveEmail(outbox)}; taker email ${await taker.proveEmail(outbox)}`);

  const wanted = opts.symbols ?? DEFAULT_SYMBOLS;
  const markets = await discoverMarkets(maker, wanted);
  if (markets.length === 0) die(`none of ${wanted.join(', ')} is an active, orderable spot market on this stack`);
  const blockers = await preflight(
    maker,
    markets.map((m) => m.symbol),
  );
  if (blockers.length) {
    EXIT.reason = 'preflight refused (services refuse orders on this stack)';
    log('NOT QUOTING. The services refuse orders on this stack for these reasons:');
    for (const b of blockers) log(`  - ${b}`);
    return 3;
  }
  const assets = [...new Set(markets.flatMap((m) => [m.base, m.quote]))];
  await ensureFunds(maker, 'maker', assets, 1);
  await ensureFunds(taker, 'taker', assets, 10);
  if (markets.some((m) => m.swap)) await prepareFuturesMaker(maker);
  /** The top TEST margin tier the maker accepts per perp, read again on a later quote while the tiers were unreadable. */
  const acceptedTiers = new Map();
  const acceptedTier = async (m) => {
    if (!acceptedTiers.has(m.symbol)) {
      const top = await topMarginTier(maker, m);
      if (top > 0) acceptedTiers.set(m.symbol, top);
    }
    return acceptedTiers.get(m.symbol);
  };

  let saved = {};
  try {
    saved = JSON.parse(fs.readFileSync(p.walkFile, 'utf8'));
  } catch {
    /* fresh walk */
  }
  const walks = new Map();
  for (const m of markets) {
    const cfg = TEST_PRICES[m.symbol];
    const walk = createPriceWalk({
      seed: opts.seed,
      symbol: cfg.follows ?? m.symbol,
      startScaled: toScaled(cfg.start),
      tickScaled: m.tick,
    });
    // Steps are saved per market symbol (below), so each market resumes its own count. A follower's own walk is only
    // its fallback, used when its leader is not quoted in this run: it resumes at its leader's saved step, where that
    // book last stood, and its own count is never saved.
    const from = cfg.follows ? saved.steps?.[cfg.follows] : saved.steps?.[m.symbol];
    if (saved.seed === opts.seed && from) walk.advance(from);
    walks.set(m.symbol, walk);
  }
  const order = quoteOrder(markets);
  for (const { market: m, leader } of order) {
    const cfg = TEST_PRICES[m.symbol];
    const walk = walks.get(m.symbol);
    log(
      leader
        ? `${m.symbol}: quoted around the ${leader} book's mid each cycle`
        : `${m.symbol}: TEST PRICE reference ${cfg.start} ${m.quote}, walking from step ${walk.steps} at ${fromScaled(walk.current())}`,
    );
  }

  const runId = crypto.randomBytes(3).toString('hex');
  let counter = 0;
  let cycle = 0;
  const crossings = new Map();
  /** The maker's resting quote ids per market, from the cycle before. */
  const quoted = new Map();
  const place = (client, m, side, price, amount, tif) =>
    m.swap
      ? acceptedTier(m).then((tier) => placeFutures(client, m, side, price, amount, `LTEST-${runId}-${(counter += 1)}`, tier))
      : client.http('POST', '/api/v1/orders', {
          symbol: m.symbol,
          type: 'limit',
          side,
          amount,
          price,
          ...(tif === 'IOC' ? { timeInForce: 'IOC' } : { timeInForce: 'GTC', postOnly: true }),
          clientOrderId: `LTEST-${runId}-${(counter += 1)}`,
        });

  while (!STOP.requested) {
    cycle += 1;
    /** This cycle's mid per market, so a follower whose leader's book cannot be read uses the leader's walk. */
    const mids = new Map();
    for (const { market: m, leader } of order) {
      let mid;
      if (leader) {
        const book = await maker
          .http('GET', `/api/v1/orderbook/${encodeURIComponent(leader)}?limit=1`, null, { auth: false })
          .catch(() => null);
        mid = (book?.status === 200 ? bookMid(book.json) : null) ?? mids.get(leader) ?? walks.get(m.symbol).next();
      } else {
        mid = walks.get(m.symbol).next();
      }
      mids.set(m.symbol, mid);
      const cfg = TEST_PRICES[m.symbol];
      const ladder = buildLadder({
        mid,
        tick: m.tick,
        lot: m.lot,
        minAmount: m.minAmount,
        minCost: m.minCost,
        levels: opts.levels,
        halfSpreadBps: 6n,
        stepBps: 9n,
        levelNotional: toScaled(cfg.notional),
      });
      // The new ladder goes up before the old one comes down, so the book never stands empty between two quotes
      // (failure it prevents: a person's market buy landing in that gap was refused for want of a reference price).
      // The first cycle takes over whatever an earlier run left resting the same way; if that cannot be read, it clears
      // them first, as before.
      let previous = quoted.get(m.symbol);
      if (!previous && m.swap) {
        previous = (await openFuturesQuoteIds(maker, m)) ?? undefined;
      } else if (!previous) {
        const open = await maker.http('GET', `/api/v1/orders/open?symbol=${encodeURIComponent(m.symbol)}&limit=100`);
        const rows = Array.isArray(open.json) ? open.json : null;
        if (open.status === 200 && rows && rows.length < 100) previous = rows.map((o) => o.id);
        else await maker.http('DELETE', `/api/v1/orders?symbol=${encodeURIComponent(m.symbol)}`);
      }
      const ids = [];
      let refused = null;
      for (const q of ladder) {
        // A new post-only quote can meet one of the maker's own old quotes when the walk jumps; it is refused and
        // that level is quoted again next cycle.
        const r = await place(maker, m, q.side, q.price, q.amount, 'GTC');
        if (r.status === 201 && r.json?.id) ids.push(r.json.id);
        else if (m.swap && r.status === 200 && r.json?.orderId && LIVE_FUTURES.has(r.json.status)) ids.push(r.json.orderId);
        else refused = `${r.status} ${(r.json?.intafacedCode ?? r.json?.code ?? r.json?.error ?? r.text).toString().slice(0, 120)}`;
      }
      // An old quote whose cancel did not go through stays on the list, so the next cycle cancels it again (a 404 or
      // 409 means it is already gone: filled or cancelled).
      const stale = [];
      for (const id of previous ?? []) {
        const r = m.swap
          ? await maker.http('DELETE', `/api/v1/futures/orders/${encodeURIComponent(id)}`)
          : await maker.http('DELETE', `/api/v1/orders/${encodeURIComponent(id)}?symbol=${encodeURIComponent(m.symbol)}`);
        if (r.status >= 300 && r.status !== 404 && r.status !== 409) stale.push(id);
      }
      quoted.set(m.symbol, [...ids, ...stale]);
      const rested = ids.length;
      log(
        `${m.symbol} TEST PRICE mid ${fromScaled(mid)} ${m.quote}: ${rested}/${ladder.length} quotes resting${refused ? `; last refusal ${refused}` : ''}`,
      );
      if (cfg.cross !== false && rested > 0 && crossesOn(cycle, m.symbol)) {
        // Alternate per market (failure it prevents: every symbol here has the same name length, so a
        // side picked from cycle and name parity was always "buy", drained the taker's quote asset, and
        // every crossing then failed with 400 ledger.insufficient_funds).
        const n = (crossings.get(m.symbol) ?? 0) + 1;
        crossings.set(m.symbol, n);
        const side = crossingSide(n);
        // Top the taker up through the real ledger if either leg is under half its target.
        await ensureFunds(taker, 'taker', [m.base, m.quote], 10).catch((err) => log(`taker top-up failed: ${err.message}`));
        const best = ladder.find((q) => q.level === 0 && q.side === (side === 'buy' ? 'sell' : 'buy'));
        const r = await place(taker, m, side, best.price, best.amount, 'IOC');
        const why = r.status === 201 ? '' : ` (${(r.json?.intafacedCode ?? r.json?.code ?? r.text).toString().slice(0, 120)})`;
        log(`${m.symbol} crossing trade by test_taker: ${side} ${best.amount} @ ${best.price} -> HTTP ${r.status}${why}`);
      }
    }
    fs.mkdirSync(p.runDir, { recursive: true, mode: 0o700 });
    const steps = Object.fromEntries([...walks].filter(([k]) => !TEST_PRICES[k]?.follows).map(([k, w]) => [k, w.steps]));
    fs.writeFileSync(p.walkFile, JSON.stringify({ seed: opts.seed, steps }), { mode: 0o600 });
    for (let waited = 0; waited < opts.seconds * 1000 && !STOP.requested; waited += 250) await sleep(250);
  }
  EXIT.reason ??= 'stop requested';
  log('stopping: cancelling the test market-maker orders');
  for (const m of markets) {
    if (!m.swap) {
      await maker.http('DELETE', `/api/v1/orders?symbol=${encodeURIComponent(m.symbol)}`).catch(() => null);
      continue;
    }
    for (const id of (await openFuturesQuoteIds(maker, m).catch(() => null)) ?? []) {
      await maker.http('DELETE', `/api/v1/futures/orders/${encodeURIComponent(id)}`).catch(() => null);
    }
  }
  return 0;
}

// ── TEST tape history (past candles on a fresh stack) ───────────────────────
// Failure it prevents: a wiped stack has no past trades, so a chart asking for 200 fifteen-minute bars shows nothing
// and the chart journeys fail on the stack, not on the app. `history` makes real TEST trades now, through the same
// front door and ledger as the loop (maker post-only, taker IOC at the same price, both labelled LTEST-TAPE-), then
// asks svc-trade's LOCAL TEST route to spread their times back over past buckets
// (services/svc-trade/src/spot/local-test-tape.ts). Only the fill times move. svc-trade refuses unless every fill on
// the market is a tape trade, so this runs on a fresh market before the loop trades, and skips any market that
// already has trades.

export const TAPE_CLIENT_PREFIX = 'LTEST-TAPE-';
export const TAPE_RETIME_ROUTE = '/internal/local-test/tape-retime';
/** Requests a second `history` sends: well below Edge's local budget of 6000 a minute per address (local-stack-services/edge.mjs, EDGE_RATE_LIMIT_MAX), with room left. */
export const HISTORY_REQUESTS_PER_SECOND = 14;
/**
 * Edge's local budget window (local-stack-services/edge.mjs, EDGE_RATE_LIMIT_WINDOW_MS). `history` ends by waiting out
 * the rest of one window after its last request, so whatever runs next on the same address starts with the whole budget
 * (failure it prevents: run 552 on main, the first journey on a shard right after `history` was refused
 * edge.rate_limited once the step stopped ending with an 80-second wait for the first market maker trade).
 */
export const HISTORY_EDGE_WINDOW_MS = 60_000;
/**
 * Markets per `history` batch request. Fewer requests leave Edge's budget room, more lanes side by side keep svc-trade
 * busy. On a 4-core machine (26 Oct), six markets took 6.1 minutes at one request per order, 7.7 in one request for
 * all six, and 4.7 at three per request in two lanes, where svc-trade's own speed sets the pace.
 */
export const HISTORY_MARKETS_PER_REQUEST = 3;

/**
 * Where `trades` tape trades go, `perBar` to a bar of `stepMs`: evenly spaced, the last one in the newest closed bar,
 * which ends where the current bucket starts.
 */
export function tapeWindow({ nowMs, trades, stepMs, perBar = 1 }) {
  if (stepMs % perBar !== 0) throw new Error('the bar length must divide evenly by the trades per bar');
  const gap = stepMs / perBar;
  const end = Math.floor(nowMs / stepMs) * stepMs;
  return { startMs: end - trades * gap, stepMs: gap };
}

async function signedTradePost(stateDir, tradeUrl, route, body) {
  assertActiveLocalStack({ stateDir });
  const secrets = JSON.parse(fs.readFileSync(path.join(stateDir, 'secrets.json'), 'utf8'));
  if (!secrets?.internal) throw new Error('secrets.json has no internal secret');
  let contracts;
  try {
    contracts = await import(pathToFileURL(path.join(REPO, 'packages/contracts/dist/index.js')).href);
  } catch (err) {
    throw new Error(`packages are not built (${err.message}). Run: pnpm local:stack --rebuild`);
  }
  const raw = JSON.stringify(body);
  const res = await fetch(`${tradeUrl}${route}`, {
    redirect: 'error',
    method: 'POST',
    headers: { 'content-type': 'application/json', ...contracts.serviceAuthHeadersForBody('local-test-stack', secrets.internal, raw) },
    body: raw,
    signal: AbortSignal.timeout(60_000),
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

async function runHistory(opts, home) {
  const { paths: p, marker } = assertLocalTarget({ home, urls: [opts.edge] });
  assertActiveLocalStack({ stateDir: p.stateDir });
  if (runningPid(p))
    die(`the test market is running (pid ${runningPid(p)}); history needs a quiet book. Stop it first: pnpm local:market stop`);
  const stepMs = opts.stepMinutes * 60_000;
  const accounts = loadAccounts(p);
  const maker = new EdgeClient(opts.edge, accounts.maker);
  const taker = new EdgeClient(opts.edge, accounts.taker);
  log(`TEST TAPE HISTORY: ${opts.bars} bars of ${opts.stepMinutes}m per market, ${opts.perBar} TEST trades each. ${LABEL}`);
  log(`maker ${await maker.ensureAccount()} (${accounts.maker.handle}); taker ${await taker.ensureAccount()} (${accounts.taker.handle})`);
  save(p, accounts);
  const outbox = path.join(p.stateDir, 'email-outbox.log');
  log(`maker email ${await maker.proveEmail(outbox)}; taker email ${await taker.proveEmail(outbox)}`);

  const wanted = opts.symbols ?? DEFAULT_SYMBOLS;
  // Spot books only: the tape route and the candles it feeds are spot (svc-trade spot/local-test-tape.ts).
  const markets = (await discoverMarkets(maker, wanted)).filter((m) => !m.swap);
  if (markets.length === 0) die(`none of ${wanted.join(', ')} is an active, orderable spot market on this stack`);
  const blockers = await preflight(
    maker,
    markets.map((m) => m.symbol),
  );
  if (blockers.length) {
    for (const b of blockers) log(`  - ${b}`);
    die('the services refuse orders on this stack (reasons above); run local-test-gates.mjs apply and verify first', 3);
  }
  const assets = [...new Set(markets.flatMap((m) => [m.base, m.quote]))];
  await ensureFunds(maker, 'maker', assets, 1);
  await ensureFunds(taker, 'taker', assets, 10);

  let saved = {};
  try {
    saved = JSON.parse(fs.readFileSync(p.walkFile, 'utf8'));
  } catch {
    /* fresh walk */
  }
  const steps = { ...(saved.seed === opts.seed ? saved.steps : {}) };
  const runId = crypto.randomBytes(3).toString('hex');
  let counter = 0;
  // Edge allows each address a fixed budget of requests a minute, and every market here shares 127.0.0.1 (failure it
  // prevents: five markets at full speed ran into edge.rate_limited after about 200 trades each, and the market maker
  // that started next could not even sign in). So requests go out at most HISTORY_REQUESTS_PER_SECOND, and a 429 waits for
  // the time Edge names, then sends the same request again: the same client ids, so svc-trade returns the same orders.
  let nextSlot = 0;
  let lastEdgeAt = 0;
  const pace = async () => {
    const now = Date.now();
    const at = Math.max(now, nextSlot);
    nextSlot = at + Math.ceil(1000 / HISTORY_REQUESTS_PER_SECOND);
    if (at > now) await sleep(at - now);
    lastEdgeAt = Date.now();
  };
  const orderBody = (m, side, price, amount, tif) => ({
    symbol: m.symbol,
    type: 'limit',
    side,
    amount,
    price,
    ...(tif === 'IOC' ? { timeInForce: 'IOC' } : { timeInForce: 'GTC', postOnly: true }),
    clientOrderId: `${TAPE_CLIENT_PREFIX}${runId}-${(counter += 1)}`,
  });
  /** One request with one order per market, through svc-trade's batch door (each item the single-order path). */
  const placeBatch = async (client, orders) => {
    for (let attempt = 1; ; attempt += 1) {
      await pace();
      const r = await client.http('POST', '/api/v1/orders/batch', { orders });
      if (r.status !== 429 || attempt >= 4) return r;
      const wait = Math.min(60, Math.max(1, Number(r.json?.retryAfterSeconds) || 5));
      log(`Edge asked to wait ${wait}s (edge.rate_limited); sending the same orders again then`);
      nextSlot = Math.max(nextSlot, Date.now() + wait * 1000);
    }
  };
  const refusal = (r) => `HTTP ${r.status} ${(r.json?.intafacedCode ?? r.json?.code ?? r.json?.error ?? r.text).toString().slice(0, 160)}`;
  const itemRefusal = (item) =>
    `${item?.status ?? 'no result'} ${(item?.error?.intafacedCode ?? item?.error?.code ?? item?.error?.message ?? '').toString().slice(0, 160)}`;
  /** Each batch item's result, or the whole request's refusal for every item when the request itself was refused. */
  const resultsOf = (r, n) =>
    r.status === 200 && Array.isArray(r.json?.results) && r.json.results.length === n
      ? r.json.results
      : Array.from({ length: n }, () => ({ status: 'refused', error: { message: refusal(r) } }));
  const wantTrades = opts.bars * opts.perBar;

  // Which markets still need history: only a fresh market gets it.
  const books = [];
  for (const m of markets) {
    const tape = await maker.http('GET', `/api/v1/trades/${encodeURIComponent(m.symbol)}?limit=1`, null, { auth: false });
    if (!Array.isArray(tape.json)) {
      log(`${m.symbol}: could not read the public tape (${refusal(tape)}); skipped`);
      books.push({ m, done: false });
      continue;
    }
    if (tape.json.length > 0) {
      log(`${m.symbol}: already has trades, so history is not written (it goes only on a fresh market); skipped`);
      books.push({ m, done: true });
      continue;
    }
    const cfg = TEST_PRICES[m.symbol];
    const walk = createPriceWalk({ seed: opts.seed, symbol: m.symbol, startScaled: toScaled(cfg.start), tickScaled: m.tick });
    if (steps[m.symbol]) walk.advance(steps[m.symbol]);
    books.push({ m, cfg, walk, made: 0, writing: true });
  }

  // Trade n of a few markets goes in one maker request and one taker request (failure it prevents: one request per
  // order, 2 x 420 orders on each of six markets, kept the history waiting on Edge's budget for six minutes). Markets
  // are independent books, so each still gets the same trades, prices and order as one market at a time: the maker's
  // post-only order, then the taker's immediate-or-cancel order at the same price. svc-trade places a batch's items one
  // after another, so the markets are split into lanes of HISTORY_MARKETS_PER_REQUEST that run side by side (all six in
  // one request took longer than one request per order).
  /** Stops one market, and takes any tape order of its own off the book, so the market maker never meets one. */
  const stopMarket = async (b) => {
    b.writing = false;
    await maker.http('DELETE', `/api/v1/orders?symbol=${encodeURIComponent(b.m.symbol)}`).catch(() => null);
  };
  const writeRound = async (n, lane) => {
    if (!lane.some((b) => b.writing)) return false;
    for (const b of lane.filter((x) => x.writing)) {
      [b.level] = buildLadder({
        mid: b.walk.next(),
        tick: b.m.tick,
        lot: b.m.lot,
        minAmount: b.m.minAmount,
        minCost: b.m.minCost,
        levels: 1,
        halfSpreadBps: 6n,
        stepBps: 9n,
        levelNotional: toScaled(b.cfg.notional),
      }).filter((q) => q.side === (crossingSide(n) === 'buy' ? 'sell' : 'buy'));
      if (!b.level) {
        log(`${b.m.symbol}: no TEST tape level for trade ${n}; stopping this market`);
        await stopMarket(b);
      }
    }
    const live = lane.filter((b) => b.writing);
    if (live.length === 0) return false;
    const rested = resultsOf(
      await placeBatch(
        maker,
        live.map((b) => orderBody(b.m, b.level.side, b.level.price, b.level.amount, 'GTC')),
      ),
      live.length,
    );
    const crossing = [];
    for (const [i, b] of live.entries()) {
      if (rested[i]?.status === 'success') {
        crossing.push(b);
        continue;
      }
      // An `unknown` outcome may have rested after all, so the market's tape orders are cancelled either way.
      log(`${b.m.symbol}: TEST tape maker order ${n} refused (${itemRefusal(rested[i])}); stopping this market`);
      await stopMarket(b);
    }
    if (crossing.length === 0) return true;
    const hits = resultsOf(
      await placeBatch(
        taker,
        crossing.map((b) => orderBody(b.m, crossingSide(n), b.level.price, b.level.amount, 'IOC')),
      ),
      crossing.length,
    );
    for (const [i, b] of crossing.entries()) {
      const hit = hits[i];
      if (hit?.status === 'success' && toScaled(String(hit.order?.filled ?? '0')) === toScaled(b.level.amount)) {
        b.made += 1;
        continue;
      }
      log(`${b.m.symbol}: TEST tape trade ${n} did not fill (${itemRefusal(hit)}); stopping this market`);
      await stopMarket(b);
    }
    return true;
  };
  const writing = books.filter((b) => b.writing);
  const laneCount = Math.ceil(writing.length / HISTORY_MARKETS_PER_REQUEST);
  const lanes = Array.from({ length: laneCount }, (_, i) => writing.filter((_, j) => j % laneCount === i));
  await Promise.all(
    lanes.map(async (lane) => {
      try {
        for (let n = 1; n <= wantTrades; n += 1) if (!(await writeRound(n, lane))) break;
      } catch (err) {
        // A request that failed outright (no answer) stops this lane's markets, and takes their tape orders off the book;
        // what each one made is still moved below.
        log(`TEST tape history stopped for ${lane.map((b) => b.m.symbol).join(', ')}: ${err.message}`);
        for (const b of lane) if (b.writing) await stopMarket(b);
      }
    }),
  );

  /** One market's trades moved into the past. Resolves true when every bar was written and moved. */
  const retime = async (b) => {
    if (!b.walk) return b.done;
    steps[b.m.symbol] = b.walk.steps;
    if (b.made === 0) return false;
    const window = tapeWindow({ nowMs: Date.now(), trades: b.made, stepMs, perBar: opts.perBar });
    // One retime at a time: each is a serializable transaction over the shared fills table, and two at once can make
    // one of them fail (Postgres 40001).
    const r = await signedTradePost(p.stateDir, `http://${LOCAL_HOST}:${marker.ports.trade}`, TAPE_RETIME_ROUTE, {
      marketId: b.m.id,
      ...window,
    });
    if (r.status !== 200) {
      log(`${b.m.symbol}: ${b.made} TEST trades made, but svc-trade refused to move them into the past (${refusal(r)})`);
      return false;
    }
    log(
      `${b.m.symbol}: ${r.json.trades} TEST trades now span ${r.json.firstTs} .. ${r.json.lastTs} (${opts.perBar} per ${opts.stepMinutes}m bar)`,
    );
    return b.made === wantTrades;
  };
  const results = [];
  for (const b of books) results.push(await retime(b).catch((err) => (log(`${b.m.symbol}: ${err.message}`), false)));
  fs.mkdirSync(p.runDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(p.walkFile, JSON.stringify({ seed: opts.seed, steps }), { mode: 0o600 });
  const rest = lastEdgeAt === 0 ? 0 : HISTORY_EDGE_WINDOW_MS - (Date.now() - lastEdgeAt);
  if (rest > 0) {
    log(`Waiting ${Math.ceil(rest / 1000)}s for Edge's one-minute budget to start fresh for what runs next`);
    await sleep(rest);
  }
  return results.every(Boolean) ? 0 : 1;
}

// ── The TEST perpetual ──────────────────────────────────────────────────────

/** Leverage the maker quotes the TEST perpetual at: inside the TEST listing's own cap (fixture leverageCap 5). */
export const FUTURES_QUOTE_LEVERAGE = '5';
const LIVE_FUTURES = new Set(['pending', 'held', 'submitting', 'open', 'submit_unknown']);

/**
 * A futures order goes through the futures book (POST /api/v1/futures/orders) and answers to the doors a person's
 * does: a proved email and the identity tier the TEST eligibility rules name (no agreement or quiz gates an open since
 * owner decision 2026-10-27). The maker still acknowledges the ADL notice, which the ADL last-resort pass reads.
 * Hedge mode, so the maker's bids and asks can rest at once. Each step logs what it got; a refusal stays visible, and
 * the quotes then refuse with the same code.
 *
 * The maker's quotes are most of the TEST book's depth, so they sit in the top margin tier of the stack's TEST ladder,
 * and an order that crosses into a higher tier must name it (`confirmTier`, svc-trade `risk-tier-confirm.ts`): the
 * maker accepts the top published tier of each perp (`topMarginTier`).
 */
async function prepareFuturesMaker(maker) {
  const say = (what, r, ok) => log(`maker ${what}: ${ok ? 'ok' : `HTTP ${r.status} ${r.text.slice(0, 160)}`}`);
  const mode = await maker.http('PUT', '/api/v1/futures/position-mode', { mode: 'hedge', clientModeId: 'LTEST-maker-position-mode-hedge' });
  say('position mode hedge', mode, mode.status === 200);
  const adl = await maker.http('POST', '/api/v1/futures/adl-disclosure/ack', {});
  say('ADL notice acknowledged', adl, adl.status === 200);
}

/**
 * The top margin tier the TEST ladder publishes for one perp, which the maker accepts for its quotes; 0 while the tiers
 * cannot be read (unpublished, or the read failed), and the quotes then refuse with the service's own code.
 */
async function topMarginTier(maker, m) {
  const r = await maker.http('GET', `/api/v1/futures/tiers?symbol=${encodeURIComponent(m.symbol)}`);
  const top = r.status === 200 && Array.isArray(r.json?.tiers) ? r.json.tiers.length : 0;
  log(`maker accepts TEST margin tier on ${m.symbol}: ${top > 0 ? `tier ${top}` : `HTTP ${r.status} ${r.text.slice(0, 160)}`}`);
  return top;
}

function placeFutures(client, m, side, price, amount, clientOrderId, confirmTier) {
  return client.http('POST', '/api/v1/futures/orders', {
    symbol: m.symbol,
    side,
    type: 'limit',
    amount,
    price,
    leverage: FUTURES_QUOTE_LEVERAGE,
    clientOrderId,
    ...(confirmTier ? { confirmTier } : {}),
  });
}

/** The maker's live opening quotes on one futures market, or null when they cannot be read. */
async function openFuturesQuoteIds(maker, m) {
  const r = await maker.http('GET', `/api/v1/futures/orders?scope=open&limit=100&symbol=${encodeURIComponent(m.symbol)}`);
  return r.status === 200 && Array.isArray(r.json) ? r.json.filter((o) => !o.reduceOnly).map((o) => o.orderId) : null;
}

// ── Process control ─────────────────────────────────────────────────────────

export const STALE_AFTER_MS = 2 * 60 * 1000;
function readRecord(p) {
  try {
    const rec = JSON.parse(fs.readFileSync(p.pidFile, 'utf8'));
    return Number.isInteger(rec?.pid) ? rec : null;
  } catch {
    return null;
  }
}
function runningPid(p) {
  const rec = readRecord(p);
  if (!rec) return null;
  // Older records stored options only; they may identify this checkout, never a basename match in another checkout.
  const argv = rec.argv ?? [process.execPath, SCRIPT, '__run', ...(rec.args ?? [])];
  return processRecordMatches({ ...rec, argv }, readProcessIdentity(rec.pid)) ? rec.pid : null;
}

/**
 * What `status` and `local:stack status` show. The pid file is the record of "it should be running": start writes
 * it, only an explicit `stop` removes it. So a record whose process is gone means it died on its own.
 *   state: 'ok' | 'stale' (alive, but no log line for 2+ minutes) | 'down' (should run, does not) | 'off' (never started or stopped)
 */
export function marketStatus({ home = os.homedir(), now = Date.now() } = {}) {
  const p = stackPaths(home);
  const rec = readRecord(p);
  if (!rec) return { state: 'off', pid: null, ageMs: null, text: 'not started (pnpm local:market)' };
  let ageMs = null;
  try {
    ageMs = Math.max(0, now - fs.statSync(p.log).mtimeMs);
  } catch {
    /* no log yet */
  }
  const ago = ageMs === null ? 'no log yet' : `last log ${fmtAge(ageMs)} ago`;
  const pid = runningPid(p);
  if (!pid)
    return { state: 'down', pid: rec.pid, ageMs, text: `DOWN (was running, ${ago}; pnpm local:market ensure restarts it; why: ${p.log})` };
  if (ageMs === null || ageMs > STALE_AFTER_MS) return { state: 'stale', pid, ageMs, text: `STALE (${ago}; log ${p.log})` };
  return { state: 'ok', pid, ageMs, text: `ok (${ago})` };
}
function fmtAge(ms) {
  const s = Math.round(ms / 1000);
  return s < 120 ? `${s}s` : s < 7200 ? `${Math.round(s / 60)}m` : `${Math.round(s / 3600)}h`;
}

/** One start at a time (failure it prevents: two copies quoting over each other). Stale if its holder is gone or it is over a minute old. */
function acquireStartLock(p) {
  const lock = path.join(p.runDir, 'market.lock');
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      fs.writeFileSync(lock, String(process.pid), { flag: 'wx', mode: 0o600 });
      return () => fs.rmSync(lock, { force: true });
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      let holderAlive = false;
      try {
        const holder = Number(fs.readFileSync(lock, 'utf8'));
        process.kill(holder, 0);
        holderAlive = holder !== process.pid && Date.now() - fs.statSync(lock).mtimeMs < 60_000;
      } catch {
        /* holder gone or lock unreadable */
      }
      if (holderAlive) return null;
      fs.rmSync(lock, { force: true });
    }
  }
  return null;
}

async function startBackground(p, args, { wait }) {
  fs.mkdirSync(p.runDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.dirname(p.log), { recursive: true, mode: 0o700 });
  const release = acquireStartLock(p);
  if (!release) return console.log('another start is in progress; not starting a second copy');
  try {
    if (runningPid(p)) return console.log(`already running (pid ${runningPid(p)}); log ${p.log}`);
    const fd = fs.openSync(p.log, 'a', 0o600);
    const argv = [process.execPath, SCRIPT, '__run', ...args];
    const child = spawn(argv[0], argv.slice(1), {
      cwd: REPO,
      detached: true,
      stdio: ['ignore', fd, fd],
      env: { PATH: process.env.PATH, HOME: os.homedir(), LOCAL_STACK_STATE: p.stateDir },
    });
    child.unref();
    fs.closeSync(fd);
    fs.writeFileSync(p.pidFile, JSON.stringify({ pid: child.pid, startedAt: nowIso(), args, argv }), { mode: 0o600 });
    console.log(`test market starting (pid ${child.pid}). Watch: tail -f ${p.log}`);
  } finally {
    release();
  }
  if (!wait) return;
  await sleep(6000);
  const tail = fs.readFileSync(p.log, 'utf8').trim().split('\n').slice(-6).join('\n');
  console.log(tail);
  if (!runningPid(p)) console.log('(it exited; the lines above say why)');
}

async function main() {
  const [cmd = 'start', ...rest] = process.argv.slice(2);
  const opts = parseArgs(rest.filter((a) => a !== '__run'));
  let guard;
  try {
    guard = assertLocalTarget({ urls: [opts.edge] });
  } catch (err) {
    if (err instanceof GuardError) die(err.message);
    throw err;
  }
  const p = guard.paths;
  if (cmd === '__run') {
    ECHO = false;
    let code = 1;
    try {
      code = await runLoop(opts, os.homedir());
    } catch (err) {
      EXIT.reason = `crashed: ${err?.stack ?? err}`;
      log(`FATAL ${EXIT.reason}`);
    }
    process.exit(code);
  }
  if (cmd === 'stop') {
    const pid = runningPid(p);
    if (!pid) {
      const had = readRecord(p);
      fs.rmSync(p.pidFile, { force: true });
      return console.log(had ? 'test market was already down; forgot it, so ensure will not restart it' : 'test market is not running');
    }
    process.kill(pid, 'SIGTERM');
    for (let i = 0; i < 40 && runningPid(p); i += 1) await sleep(500);
    if (runningPid(p)) return console.log(`pid ${pid} is still cancelling orders; check ${p.log}`);
    fs.rmSync(p.pidFile, { force: true });
    return console.log('test market stopped, resting test orders cancelled');
  }
  if (cmd === 'status') {
    const st = marketStatus();
    console.log(`test market: ${st.text}${st.pid ? `; pid ${st.pid}` : ''}`);
    process.exitCode = st.state === 'down' || st.state === 'stale' ? 1 : 0;
    return;
  }
  if (cmd === 'check' || opts.foreground) {
    // Failure it prevents: a foreground run cancels and re-places the same account's orders as the background copy.
    if (runningPid(p)) die(`the background test market is running (pid ${runningPid(p)}); stop it first (pnpm local:market stop)`);
    process.exit(await runLoop({ ...opts, ...(cmd === 'check' ? { seconds: 2 } : {}) }, os.homedir()));
  }
  if (cmd === 'history') process.exit(await runHistory(opts, os.homedir()));
  if (cmd === 'ensure') {
    const rec = readRecord(p);
    if (runningPid(p)) return console.log(`already running (pid ${runningPid(p)})`);
    if (!rec) return console.log('not started; leaving it off (pnpm local:market starts it)');
    console.log(`was running (pid ${rec.pid}) and is not now; starting it again with the same options`);
    return startBackground(p, rec.args ?? [], { wait: false });
  }
  if (cmd !== 'start') die(`unknown command "${cmd}". Use: start | stop | status | ensure | check | history`, 2);
  await startBackground(p, rest, { wait: true });
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) await main();
