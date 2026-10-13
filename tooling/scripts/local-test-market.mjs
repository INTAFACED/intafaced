#!/usr/bin/env node
/**
 * LOCAL TEST MARKET — makes Trade look alive on the LOCAL test stack only.
 *
 *   pnpm local:market                start (background, safe to re-run); prints what it found
 *   pnpm local:market:stop           stop it and cancel the test market-maker's resting orders
 *   node tooling/scripts/local-test-market.mjs status | check
 *
 * What it does, every few seconds, for each published market it has a TEST PRICE for:
 *   1. moves a deterministic, seedable synthetic price (integer arithmetic, no float money);
 *   2. as the labelled test account `test_market_maker`, cancels and re-places a ladder of
 *      post-only bids and asks around that price;
 *   3. now and then, a second labelled account `test_taker` crosses the best level with a
 *      small immediate-or-cancel order, so trades (and therefore candles) exist.
 *
 * Every order goes through the real front door (Edge /api/v1 -> svc-trade -> svc-matching),
 * and every balance is a real ledger entry: funding reuses `local:fund` (svc-ledger deposit
 * recipe, rail ref LOCAL-TEST-...). Nothing here writes a balance, a fill or a price into any
 * database. Prices are TEST PRICES: invented starting points, not a market feed.
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
  const stateDir = path.join(home, '.intafaced', 'local-test-stack');
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
  'XAU/USD': { start: '2650', notional: '3000' },
  'XAG/USD': { start: '31', notional: '1500' },
  'WTI/USD': { start: '72', notional: '1500' },
  'BRENT/USD': { start: '76', notional: '1500' },
  'NATGAS/USD': { start: '2.8', notional: '1500' },
};
const DEFAULT_SYMBOLS = ['BTC/USDT', 'BTC/USDC', 'ETH/USDT', 'ETH/USDC', 'IFC/USDT'];
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
  process.exit(code);
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
    if (auth && (!this.token || Date.now() - this.tokenAt > 8 * 60_000)) await this.login();
    const headers = { origin: DEFAULT_CUSTOMER_ORIGIN, ...(body ? { 'content-type': 'application/json' } : {}) };
    if (auth) headers.authorization = `Bearer ${this.token}`;
    const res = await fetch(`${this.edge}${route}`, {
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
      { identifier: this.account.email, password: this.account.password },
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
      { identifier: this.account.email, password: this.account.password },
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
      { handle: this.account.handle, email: this.account.email, password: this.account.password },
      { auth: false },
    );
    const data = reg.json?.result?.data;
    if (!data?.accessToken) throw new Error(`could not register ${this.account.handle} (${reg.status}): ${reg.text.slice(0, 200)}`);
    this.token = data.accessToken;
    this.tokenAt = Date.now();
    this.account.userId = data.userId;
    return 'created';
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
  const edgeHealth = await fetch(`${maker.edge.replace(/\/+$/, '')}/health`, { signal: AbortSignal.timeout(10_000) }).catch(() => null);
  if (!edgeHealth) blockers.push('edge is not answering on its local port. Run: pnpm local:stack');
  // Gate 1: Edge refuses every NEW order unless matching's /health carries a halt flag.
  const marker = JSON.parse(fs.readFileSync(stackPaths().marker, 'utf8'));
  const matchingUrl = `http://${LOCAL_HOST}:${marker.ports.matching}`;
  const mh = await fetch(`${matchingUrl}/health`, { signal: AbortSignal.timeout(10_000) })
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

// ── Funding (reuses local:fund: real svc-ledger deposit, LOCAL-TEST- rail ref) ─

async function ensureFunds(client, who, assets, divisor) {
  const bal = await client.http('GET', '/api/v1/account/balance');
  const have = bal.json?.balances ?? {};
  for (const asset of assets) {
    const target = toScaled(FUND_TO[asset] ?? '0') / BigInt(divisor);
    if (target === 0n) continue;
    const free = toScaled(have[asset]?.free ?? '0');
    if (free * 2n >= target) continue;
    const ref = `MM-${who}-${asset}-${nowIso().slice(0, 13).replace(/[-:T]/g, '')}`;
    const r = spawnSync(process.execPath, [STACK_SCRIPT, 'fund', client.account.userId, asset, fromScaled(target), '--ref', ref], {
      encoding: 'utf8',
    });
    if (r.status !== 0) throw new Error(`local:fund ${asset} failed: ${(r.stderr || r.stdout).trim().slice(0, 300)}`);
    log(`funded ${who} ${fromScaled(target)} ${asset} through the real ledger (TEST FUNDS, rail ref LOCAL-TEST-${ref})`);
  }
}

// ── The loop ────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const opts = { seed: '1013', seconds: 8, levels: 3, symbols: null, foreground: false, edge: DEFAULT_EDGE };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--seed') opts.seed = argv[++i];
    else if (a === '--interval') opts.seconds = Number(argv[++i]);
    else if (a === '--levels') opts.levels = Number(argv[++i]);
    else if (a === '--markets') opts.symbols = argv[++i] === 'all' ? Object.keys(TEST_PRICES) : argv[i].split(',');
    else if (a === '--edge-url') opts.edge = argv[++i];
    else if (a === '--foreground') opts.foreground = true;
  }
  if (!Number.isInteger(opts.seconds) || opts.seconds < 2) die('--interval must be a whole number of seconds, at least 2', 2);
  if (!Number.isInteger(opts.levels) || opts.levels < 1 || opts.levels > 10) die('--levels must be 1..10', 2);
  return opts;
}

async function discoverMarkets(edge, wanted) {
  const res = await edge.http('GET', '/api/v1/markets?limit=500', null, { auth: false });
  if (!Array.isArray(res.json)) throw new Error(`could not list markets (${res.status})`);
  return res.json
    .filter((m) => m.active && m.orderable && m.spot && !m.paper && TEST_PRICES[m.symbol] && wanted.includes(m.symbol))
    .map((m) => ({
      symbol: m.symbol,
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
  LOG_FILE = p.log;
  fs.mkdirSync(path.dirname(p.log), { recursive: true, mode: 0o700 });
  const accounts = loadAccounts(p);
  const maker = new EdgeClient(opts.edge, accounts.maker);
  const taker = new EdgeClient(opts.edge, accounts.taker);
  log(`${LABEL}. seed=${opts.seed}, requote every ${opts.seconds}s`);
  log(`maker ${await maker.ensureAccount()} (${accounts.maker.handle}); taker ${await taker.ensureAccount()} (${accounts.taker.handle})`);
  save(p, accounts);

  const wanted = opts.symbols ?? DEFAULT_SYMBOLS;
  const markets = await discoverMarkets(maker, wanted);
  if (markets.length === 0) die(`none of ${wanted.join(', ')} is an active, orderable spot market on this stack`);
  const blockers = await preflight(
    maker,
    markets.map((m) => m.symbol),
  );
  if (blockers.length) {
    log('NOT QUOTING. The services refuse orders on this stack for these reasons:');
    for (const b of blockers) log(`  - ${b}`);
    return 3;
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
  const walks = new Map();
  for (const m of markets) {
    const cfg = TEST_PRICES[m.symbol];
    const walk = createPriceWalk({ seed: opts.seed, symbol: m.symbol, startScaled: toScaled(cfg.start), tickScaled: m.tick });
    if (saved.seed === opts.seed && saved.steps?.[m.symbol]) walk.advance(saved.steps[m.symbol]); // resume the same series
    walks.set(m.symbol, walk);
    log(`${m.symbol}: TEST PRICE reference ${cfg.start} ${m.quote}, walking from step ${walk.steps} at ${fromScaled(walk.current())}`);
  }

  let stopping = false;
  const stop = () => {
    stopping = true;
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  const runId = crypto.randomBytes(3).toString('hex');
  let counter = 0;
  let cycle = 0;
  const place = (client, m, side, price, amount, tif) =>
    client.http('POST', '/api/v1/orders', {
      symbol: m.symbol,
      type: 'limit',
      side,
      amount,
      price,
      ...(tif === 'IOC' ? { timeInForce: 'IOC' } : { timeInForce: 'GTC', postOnly: true }),
      clientOrderId: `LTEST-${runId}-${(counter += 1)}`,
    });

  while (!stopping) {
    cycle += 1;
    for (const m of markets) {
      const walk = walks.get(m.symbol);
      const mid = walk.next();
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
      await maker.http('DELETE', `/api/v1/orders?symbol=${encodeURIComponent(m.symbol)}`);
      let rested = 0;
      let refused = null;
      for (const q of ladder) {
        const r = await place(maker, m, q.side, q.price, q.amount, 'GTC');
        if (r.status === 201) rested += 1;
        else refused = `${r.status} ${(r.json?.intafacedCode ?? r.json?.code ?? r.json?.error ?? r.text).toString().slice(0, 120)}`;
      }
      log(
        `${m.symbol} TEST PRICE mid ${fromScaled(mid)} ${m.quote}: ${rested}/${ladder.length} quotes resting${refused ? `; last refusal ${refused}` : ''}`,
      );
      if (cycle % 3 === 0 && rested > 0 && (cycle / 3 + m.symbol.length) % 2 === 0) {
        const side = (cycle / 3) % 2 === 0 ? 'buy' : 'sell';
        const best = ladder.find((q) => q.level === 0 && q.side === (side === 'buy' ? 'sell' : 'buy'));
        const r = await place(taker, m, side, best.price, best.amount, 'IOC');
        log(`${m.symbol} crossing trade by test_taker: ${side} ${best.amount} @ ${best.price} -> HTTP ${r.status}`);
      }
    }
    fs.mkdirSync(p.runDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(p.walkFile, JSON.stringify({ seed: opts.seed, steps: Object.fromEntries([...walks].map(([k, w]) => [k, w.steps])) }), {
      mode: 0o600,
    });
    for (let waited = 0; waited < opts.seconds * 1000 && !stopping; waited += 250) await sleep(250);
  }
  log('stopping: cancelling the test market-maker orders');
  for (const m of markets) await maker.http('DELETE', `/api/v1/orders?symbol=${encodeURIComponent(m.symbol)}`).catch(() => null);
  return 0;
}

// ── Process control ─────────────────────────────────────────────────────────

const psCommand = (pid) => spawnSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' }).stdout.trim();
function runningPid(p) {
  try {
    const rec = JSON.parse(fs.readFileSync(p.pidFile, 'utf8'));
    const cmd = psCommand(rec.pid);
    return cmd.includes(SCRIPT) && cmd.includes('__run') ? rec.pid : null;
  } catch {
    return null;
  }
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
    process.exit(await runLoop(opts, os.homedir()));
  }
  if (cmd === 'stop') {
    const pid = runningPid(p);
    if (!pid) return console.log('test market is not running');
    process.kill(pid, 'SIGTERM');
    for (let i = 0; i < 40 && runningPid(p); i += 1) await sleep(500);
    return console.log(
      runningPid(p) ? `pid ${pid} is still cancelling orders; check ${p.log}` : 'test market stopped, resting test orders cancelled',
    );
  }
  if (cmd === 'status') {
    const pid = runningPid(p);
    console.log(pid ? `running (pid ${pid}); log ${p.log}` : 'not running');
    return;
  }
  if (cmd === 'check' || opts.foreground)
    process.exit(await runLoop({ ...opts, ...(cmd === 'check' ? { seconds: 2 } : {}) }, os.homedir()));
  if (cmd !== 'start') die(`unknown command "${cmd}". Use: start | stop | status | check`, 2);
  if (runningPid(p)) return console.log(`already running (pid ${runningPid(p)}); log ${p.log}`);
  fs.mkdirSync(p.runDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.dirname(p.log), { recursive: true, mode: 0o700 });
  const fd = fs.openSync(p.log, 'a', 0o600);
  const child = spawn(process.execPath, [SCRIPT, '__run', ...rest], {
    cwd: REPO,
    detached: true,
    stdio: ['ignore', fd, fd],
    env: { PATH: process.env.PATH, HOME: os.homedir() },
  });
  child.unref();
  fs.writeFileSync(p.pidFile, JSON.stringify({ pid: child.pid, startedAt: nowIso() }), { mode: 0o600 });
  console.log(`test market starting (pid ${child.pid}). Watch: tail -f ${p.log}`);
  await sleep(6000);
  const tail = fs.readFileSync(p.log, 'utf8').trim().split('\n').slice(-6).join('\n');
  console.log(tail);
  if (!runningPid(p)) console.log('(it exited; the lines above say why)');
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) await main();
