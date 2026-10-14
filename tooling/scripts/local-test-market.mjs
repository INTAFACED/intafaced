#!/usr/bin/env node
/**
 * LOCAL TEST MARKET — makes Trade look like a busy exchange on the LOCAL test stack only.
 *
 *   pnpm local:market                start (background, safe to re-run); prints what it found
 *   pnpm local:market status         pid, ok / STALE / DOWN, and the age of its last log line
 *   pnpm local:market ensure          start it again only if it was started before and is not running now
 *   pnpm local:market stop           stop it, cancel its resting orders, and forget it (ensure then leaves it off)
 *                                    (pnpm local:market:stop is the same as stop)
 *   pnpm local:market plan           print the pairs, depth and load budget (no network, changes nothing)
 *   node tooling/scripts/local-test-market.mjs check
 *
 * Options (saved with the start, so `ensure` restarts with the same ones):
 *   --markets all|A/B,C/D   which pairs (default: every pair in local-test-pairs.mjs that is listed and open)
 *   --levels N              price levels per side (default 20)
 *   --interval S            seconds between re-quotes of one market (default 30)
 *   --trades R              test-taker orders per second across all markets (default 2; 0 = no trades)
 *   --ops N                 market-maker order placements plus cancels per second, all markets (default 3)
 *   --max-rpm N             hard cap on HTTP requests per minute to Edge (default 360; Edge allows 1200 per IP)
 *   --seed N, --no-warmup
 *
 * What it does, for each listed, open pair it has a TEST PRICE for (see tooling/scripts/local-test-pairs.mjs):
 *   1. moves a deterministic, seedable synthetic price with mild volatility clustering (integer arithmetic,
 *      no float money);
 *   2. as the labelled test account `test_market_maker`, keeps about 20 post-only bids and asks on a fixed
 *      price grid with varied sizes. It changes only the levels the price move made stale, a few orders per
 *      re-quote, instead of cancelling and re-placing the whole book;
 *   3. as the labelled account `test_taker`, crosses the book with immediate-or-cancel orders of varied size,
 *      both sides, a couple per second, so the tape, 24 h volume, change and sparklines move.
 *
 * Every order goes through the real front door (Edge /api/v1 -> svc-trade -> svc-matching),
 * and every balance is a real ledger entry: funding reuses `local:fund` (svc-ledger deposit
 * recipe, rail ref LOCAL-TEST-...). Nothing here writes a balance, a fill or a price into any
 * database. Prices are TEST PRICES: invented starting points, not a market feed.
 *
 * Load: one request in flight at a time, a budget of ledger-touching orders per second, a hard cap on requests
 * per minute, and a governor that slows everything down while Edge answers slowly, with 5xx, or with 429.
 *
 * Containment (failure it prevents: quoting or funding against a real environment): refuses
 * unless the local test stack's state directory and LOCAL-TEST-STACK.json marker exist and
 * every target URL is http://127.0.0.1:<a port the marker lists>.
 *
 * Preflight: three gates in the current services stop any order on a fresh local stack (see
 * docs/LOCAL-TEST-STACK.md, "Living test market"). This script reads them with GET requests, names each
 * one, and quotes only the markets that pass; the rest are checked again every two minutes, so listing a pair
 * (pnpm local:market:list) and opening it (local-test-gates.mjs apply) is enough to bring it in.
 *
 * Docs: docs/LOCAL-TEST-STACK.md
 */
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { rotateAll, rotateLog } from './local-test-logs.mjs';
import { LOCAL_PAIRS, pairBySymbol } from './local-test-pairs.mjs';

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

/** A unit fraction fixed by (seed, symbol, side, price): the same grid point always gets the same size roll. */
function unitHash(seed, symbol, side, price, salt) {
  return crypto.createHash('sha256').update(`${seed}:${symbol}:${side}:${price}:${salt}`).digest().readUInt32LE(0) / 4294967296;
}

/**
 * A bounded random walk with gentle pull back to the starting reference, in whole
 * basis points on a scaled bigint price, snapped to the market tick. Same seed + symbol +
 * start gives the same series. `startScaled` is a TEST PRICE.
 *
 * Volatility clusters: a hidden `vol` between 0.25 and 1 scales the largest step, and a big move raises
 * it for the next several steps (calm stretches and busy stretches, like a real tape). It is part of the
 * seeded series, so the same seed still gives the same prices.
 */
export function createPriceWalk({ seed, symbol, startScaled, tickScaled, maxStepBps = 12n, bandBps = 2000n }) {
  const rand = rngFor(String(seed), symbol);
  let price = floorTo(startScaled, tickScaled);
  let steps = 0;
  let vol = 0.6;
  const lo = floorTo((startScaled * (10000n - bandBps)) / 10000n, tickScaled);
  const hi = ceilTo((startScaled * (10000n + bandBps)) / 10000n, tickScaled);
  return {
    get steps() {
      return steps;
    },
    get vol() {
      return vol;
    },
    current: () => price,
    next() {
      const reach = Math.max(1, Math.round(Number(maxStepBps) * vol));
      const span = reach * 2 + 1;
      const move = BigInt(Math.floor(rand() * span) - reach);
      // Mean-reverting hidden volatility: a big move lifts it, a small one lowers it, and it drifts on its own.
      vol = Math.min(1, Math.max(0.25, vol + 0.05 * (0.6 - vol) + 0.1 * (Math.abs(Number(move)) / reach - 0.5) + 0.12 * (rand() - 0.5)));
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

// ── The book: a fixed price grid, varied sizes (exported for tests) ──────────

/**
 * Grid step for a market: `gridCbps` hundredths of a basis point of the STARTING price (a constant, so the grid
 * never moves), at least one tick and always a whole number of ticks. A fixed grid is what lets a price move
 * keep most resting orders where they are.
 */
export function gridStepFor({ start, tick, gridCbps }) {
  const raw = floorTo((start * gridCbps) / 1_000_000n, tick);
  return raw < tick ? tick : raw;
}

/**
 * The prices the book should hold around `mid`: bids on grid points at or under mid minus half the spread, asks
 * on grid points at or over mid plus half the spread, `levels` of each, inner first.
 */
export function targetBook({ mid, step, halfSpreadCbps, levels }) {
  const off = (mid * halfSpreadCbps) / 1_000_000n;
  let bestBid = floorTo(mid - off, step);
  if (bestBid <= 0n) bestBid = step;
  let bestAsk = ceilTo(mid + off, step);
  if (bestAsk <= bestBid) bestAsk = bestBid + step;
  const bids = [];
  const asks = [];
  for (let k = 0; k < levels; k += 1) {
    const b = bestBid - BigInt(k) * step;
    if (b > 0n) bids.push(b);
    asks.push(bestAsk + BigInt(k) * step);
  }
  return { bestBid, bestAsk, bids, asks };
}

/**
 * Size of the order at one grid point: a notional (quote units) times a varied, repeatable multiplier, divided by
 * the price. Mostly small and medium, now and then a "wall" three to five times larger, growing a little with
 * distance from the touch. Rounded to the lot and raised to the market's minimum amount and cost.
 */
export function levelSize({ seed, symbol, side, price, rank, notional, lot, minAmount, minCost }) {
  const u = unitHash(seed, symbol, side, price, 'a');
  const w = unitHash(seed, symbol, side, price, 'b');
  let mult = 0.25 + 1.75 * u * u + 0.5 * u;
  if (w > 0.9) mult *= 2.5 + (w - 0.9) * 25;
  mult *= 1 + rank * 0.04;
  const m1000 = BigInt(Math.max(1, Math.round(mult * 1000)));
  let amount = floorTo((notional * m1000 * ONE) / (price * 1000n), lot);
  if (amount < minAmount) amount = ceilTo(minAmount, lot);
  if ((price * amount) / ONE < minCost) amount = ceilTo((minCost * 12n * ONE) / (10n * price), lot);
  return amount;
}

/**
 * What to change so the resting orders match the target book, with as few orders touched as possible.
 *   resting   [{ id, side, price }] (price a scaled bigint)
 * Cancel first (an order on the wrong side of the new touch would be crossed by our own new quotes), and only
 * those: bids above the new best bid, asks below the new best ask, off-grid or duplicate prices (a different run's
 * leftovers), and depth beyond `levels + maxExtra` (kept on purpose, so a price that wanders back finds its
 * orders still there). Then place the grid points that are missing, inner first, alternating sides.
 * More than `massCancelOver` cancels means the book is far off: cancel the symbol's orders in one call and rebuild.
 */
export function planRefresh({ target, resting, step, levels, maxExtra = 8, capCancels = 12, capPlaces = 12, massCancelOver = 16 }) {
  const bidsR = resting.filter((r) => r.side === 'buy');
  const asksR = resting.filter((r) => r.side === 'sell');
  const wrongSide = [...bidsR.filter((r) => r.price > target.bestBid), ...asksR.filter((r) => r.price < target.bestAsk)];
  const wrongSet = new Set(wrongSide);
  const offGrid = resting.filter((r) => !wrongSet.has(r) && r.price % step !== 0n);
  const offSet = new Set(offGrid);
  const keep = (list, better) => {
    const seen = new Set();
    const kept = [];
    const dupes = [];
    for (const r of list
      .filter((x) => !wrongSet.has(x) && !offSet.has(x))
      .sort((a, b) => (a.price === b.price ? 0 : better(a, b) ? -1 : 1))) {
      if (seen.has(r.price)) dupes.push(r);
      else {
        seen.add(r.price);
        kept.push(r);
      }
    }
    return { kept, dupes };
  };
  const bids = keep(bidsR, (a, b) => a.price > b.price);
  const asks = keep(asksR, (a, b) => a.price < b.price);
  const limit = levels + maxExtra;
  const excess = [...bids.dupes, ...asks.dupes, ...bids.kept.slice(limit), ...asks.kept.slice(limit)];
  const wanted = (side, kept) => {
    const have = new Set(kept.map((r) => r.price));
    return (side === 'buy' ? target.bids : target.asks).map((price, rank) => ({ side, price, rank })).filter((q) => !have.has(q.price));
  };
  const cancelCount = wrongSide.length + offGrid.length + excess.length;
  if (cancelCount > massCancelOver) {
    const all = [
      ...target.bids.map((price, rank) => ({ side: 'buy', price, rank })),
      ...target.asks.map((price, rank) => ({ side: 'sell', price, rank })),
    ];
    all.sort((a, b) => a.rank - b.rank || (a.side === 'buy' ? -1 : 1));
    return { massCancel: true, cancels: [], places: all.slice(0, capPlaces), deferred: all.length > capPlaces };
  }
  const missing = [...wanted('buy', bids.kept), ...wanted('sell', asks.kept)].sort(
    (a, b) => a.rank - b.rank || (a.side === 'buy' ? -1 : 1),
  );
  const cancelsAll = [...wrongSide, ...offGrid, ...excess];
  const cancels = cancelsAll.slice(0, capCancels);
  // An uncancelled wrong-side order would make a new quote cross it: cancel first, place on the next pass.
  const blocked = wrongSide.length > cancels.filter((c) => wrongSet.has(c)).length;
  const places = blocked ? [] : missing.slice(0, capPlaces);
  return { massCancel: false, cancels, places, deferred: cancels.length < cancelsAll.length || places.length < missing.length };
}

/**
 * A crossing immediate-or-cancel order against the visible book. `book` is best-first on each side:
 * { asks: [{ price, amount }], bids: [...] } (scaled bigints). Mostly small prints (5-45% of the touch), some
 * that sweep one to three levels, a few large ones, never more than `maxNotional` or 80% of the first levels.
 * Returns null when the book is too thin to trade against.
 */
export function planCross({ side, book, rand, lot, minAmount, minCost, maxNotional, maxLevels = 5 }) {
  const levels = (side === 'buy' ? book.asks : book.bids).slice(0, maxLevels);
  if (levels.length < 2) return null;
  const top = levels[0];
  const roll = rand();
  const pct =
    roll < 0.7
      ? 5n + BigInt(Math.floor(rand() * 40))
      : roll < 0.92
        ? 100n + BigInt(Math.floor(rand() * 150))
        : 300n + BigInt(Math.floor(rand() * 400));
  const depth = levels.reduce((s, l) => s + l.amount, 0n);
  let want = (top.amount * pct) / 100n;
  if (want > (depth * 8n) / 10n) want = (depth * 8n) / 10n;
  const cap = (maxNotional * ONE) / top.price;
  if (want > cap) want = cap;
  let amount = floorTo(want, lot);
  if (amount < minAmount) amount = ceilTo(minAmount, lot);
  if ((top.price * amount) / ONE < minCost) amount = ceilTo((minCost * 12n * ONE) / (10n * top.price), lot);
  let acc = 0n;
  let limit = top.price;
  let touched = 0;
  for (const l of levels) {
    limit = l.price;
    acc += l.amount;
    touched += 1;
    if (acc >= amount) break;
  }
  if (acc < amount) amount = floorTo(acc, lot);
  if (amount < minAmount) return null;
  return { side, price: fromScaled(limit), amount: fromScaled(amount), touched };
}

/**
 * Which way the taker trades next. Random, but pulled back toward flat: `net` is what it has bought minus sold
 * (base units, scaled) and `cap` the size at which it strongly prefers to sell. Failure it prevents: a taker that
 * only ever buys runs out of the quote asset and every order gets 400 (it happened); one that strictly alternates
 * prints a tape that looks scripted.
 */
export function pickSide(net, cap, rand) {
  const x = cap > 0n ? Math.max(-1, Math.min(1, Number((net * 1000n) / cap) / 1000)) : 0;
  return rand() < 0.5 - 0.45 * x ? 'buy' : 'sell';
}

// ── Load control (exported for tests) ───────────────────────────────────────

/**
 * Token buckets for ledger-touching orders (each placement, cancel or taker order costs one), scaled down while
 * the stack is struggling. Failure it prevents: the market keeps its pace while the ledger answers in 15 seconds
 * and a loaded machine gets worse. A bad answer (5xx, 429, or slower than `slowMs` per order) cuts the scale to
 * 60% (floor 15%); twenty quiet seconds win back 20% at a time. Tokens may go negative: a big cancel is paid
 * for by waiting afterwards.
 */
export class Governor {
  constructor({ makerPerSec, takerPerSec, now = Date.now, slowMs = 3000, burstSeconds = 4 }) {
    this.now = now;
    this.slowMs = slowMs;
    this.scale = 1;
    this.pausedUntil = 0;
    this.lastChange = now();
    const t = now();
    this.buckets = {
      maker: { rate: makerPerSec, burst: Math.max(4, makerPerSec * burstSeconds), tokens: Math.min(4, makerPerSec * burstSeconds), at: t },
      taker: { rate: takerPerSec, burst: Math.max(2, takerPerSec * burstSeconds), tokens: Math.min(2, takerPerSec * burstSeconds), at: t },
    };
  }
  refill(kind) {
    const b = this.buckets[kind];
    const t = this.now();
    b.tokens = Math.min(b.burst, b.tokens + ((t - b.at) / 1000) * b.rate * this.scale);
    b.at = t;
    return b;
  }
  /** Whole tokens available now (never negative). */
  available(kind) {
    return Math.max(0, Math.floor(this.refill(kind).tokens));
  }
  take(kind, n = 1) {
    this.refill(kind).tokens -= n;
  }
  /** Feed in how a request went. `items` is how many orders it carried (a slow batch of ten is not ten times slow). */
  observe({ ms, status, items = 1, retryAfterS = 0 }) {
    const t = this.now();
    const bad = status === 429 || status >= 500 || ms / Math.max(1, items) > this.slowMs;
    if (bad) {
      this.scale = Math.max(0.15, this.scale * 0.6);
      this.lastChange = t;
      if (status === 429) this.pausedUntil = Math.max(this.pausedUntil, t + Math.max(1, retryAfterS) * 1000);
    } else if (this.scale < 1 && t - this.lastChange > 20_000) {
      this.scale = Math.min(1, this.scale * 1.2);
      this.lastChange = t;
    }
    return bad;
  }
}

/** At most `maxPerMinute` requests in any 60 s window (Edge allows 1200 per IP per minute, and the app shares it). */
export class RequestBudget {
  constructor(maxPerMinute, now = Date.now) {
    this.max = maxPerMinute;
    this.now = now;
    this.stamps = [];
  }
  /** How many ms until one more request fits; 0 if it fits now. */
  waitMs() {
    const t = this.now();
    while (this.stamps.length && t - this.stamps[0] >= 60_000) this.stamps.shift();
    return this.stamps.length < this.max ? 0 : this.stamps[0] + 60_000 - t + 5;
  }
  record() {
    this.stamps.push(this.now());
  }
  get lastMinute() {
    this.waitMs();
    return this.stamps.length;
  }
}

// ── TEST PRICE table: invented, illustrative starting points ────────────────
// Not a feed and not quotes. The crypto pairs come from local-test-pairs.mjs (one table, shared with the
// listing script). The commodities are listed in the production catalogue already; they are quoted only with
// `--markets all` and use the generic settings below.
const COMMODITY_PRICES = {
  'XAU/USD': { start: '2650', notional: '3000' },
  'XAG/USD': { start: '31', notional: '1500' },
  'WTI/USD': { start: '72', notional: '1500' },
  'BRENT/USD': { start: '76', notional: '1500' },
  'NATGAS/USD': { start: '2.8', notional: '1500' },
};
export const TEST_PRICES = {
  ...Object.fromEntries(LOCAL_PAIRS.map((p) => [p.symbol, { start: p.start, notional: String(p.notional) }])),
  ...COMMODITY_PRICES,
};
const DEFAULT_SYMBOLS = LOCAL_PAIRS.map((p) => p.symbol);

/** Per-market settings: the pairs table, or generic values for a market that is only in TEST_PRICES. */
export function pairConfig(symbol) {
  const p = pairBySymbol(symbol);
  const t = TEST_PRICES[symbol];
  if (!t) return null;
  return {
    start: t.start,
    notional: t.notional,
    weight: p?.weight ?? 0.5,
    gridCbps: BigInt(Math.round((p?.gridBps ?? 4) * 100)),
    halfSpreadCbps: BigInt(Math.round(((p?.gridBps ?? 4) * 100) / 2)),
    maxStepBps: BigInt(Math.round(p?.stepBps ?? 8)),
  };
}

// Funded to at least this level by `local:fund` (real ledger deposits, LOCAL-TEST- rail refs); the taker gets a tenth.
// The crypto assets are sized from the pairs actually quoted (fundTargets); these cover the rest.
const FUND_TO = {
  USD: '1000000',
  XAU: '100',
  XAG: '5000',
  WTI: '5000',
  BRENT: '5000',
  NATGAS: '100000',
};
const BOOK_EXTRA = 8; // levels kept beyond `levels` before the outermost are cancelled

/**
 * How much of each asset the maker needs: for every market, about twice the average book depth on each side
 * (quote for the bids, base for the asks), three times over for headroom (taker fills, a price move of up to 20%,
 * the extra depth), rounded up to two significant digits. `markets`: [{ base, quote, notional, start, levels }]
 * with scaled bigints for notional and start.
 */
export function fundTargets(markets, floor = FUND_TO) {
  const need = new Map();
  const add = (asset, v) => need.set(asset, (need.get(asset) ?? 0n) + v);
  for (const m of markets) {
    const side = m.notional * BigInt(m.levels + BOOK_EXTRA) * 2n * 3n;
    add(m.quote, side);
    add(m.base, (side * ONE) / m.start);
  }
  const out = new Map();
  for (const [asset, v] of need) {
    const digits = v.toString().length;
    const unit = digits > 2 ? 10n ** BigInt(digits - 2) : 1n;
    const rounded = ceilTo(v, unit);
    const least = asset in floor ? toScaled(floor[asset]) : 0n;
    out.set(asset, rounded > least ? rounded : least);
  }
  return out;
}

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
  constructor(edge, account, ctx = null) {
    this.edge = edge;
    this.account = account;
    this.ctx = ctx; // { governor, budget, stats }: shared by both accounts, so the limits are for the market as a whole
    this.token = null;
    this.tokenAt = 0;
  }
  async http(method, route, body, { auth = true, items = 1, timeoutMs = 30_000 } = {}) {
    if (auth && (!this.token || Date.now() - this.tokenAt > 8 * 60_000)) await this.login();
    const headers = { origin: DEFAULT_CUSTOMER_ORIGIN, ...(body ? { 'content-type': 'application/json' } : {}) };
    if (auth) headers.authorization = `Bearer ${this.token}`;
    const { ctx } = this;
    if (ctx) {
      // One request at a time (the caller awaits), inside the per-minute cap, and not during a 429 pause.
      for (;;) {
        const t = Date.now();
        const wait = Math.max(ctx.budget.waitMs(), ctx.governor.pausedUntil - t);
        if (wait <= 0 || STOP.requested) break;
        await sleep(Math.min(wait, 1000));
      }
      ctx.budget.record();
      ctx.stats.requests += 1;
    }
    const t0 = Date.now();
    let res;
    let text;
    try {
      res = await fetch(`${this.edge}${route}`, {
        redirect: 'error',
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });
      text = await res.text();
    } catch (err) {
      ctx?.governor.observe({ ms: Date.now() - t0, status: 599, items });
      if (ctx) ctx.stats.errors += 1;
      throw err;
    }
    const ms = Date.now() - t0;
    if (ctx) {
      const bad = ctx.governor.observe({ ms, status: res.status, items, retryAfterS: Number(res.headers.get('retry-after')) || 0 });
      ctx.stats.latencyMs += ms;
      if (bad) ctx.stats.slow += 1;
    }
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

/** Gate 1 and the front door: problems that stop every market. */
async function preflightGlobal(maker) {
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
  return blockers;
}

/** Gate 2 + 3 for one market, as the same account would be judged. Returns the reason text, or null if it may quote. */
async function preflightMarket(maker, symbol) {
  const res = await maker.http('GET', `/api/v1/account/market-lifecycle/${encodeURIComponent(symbol)}`);
  const snap = res.json;
  if (snap?.allowedActions?.includes?.('PLACE_POST_ONLY')) return null;
  const reason = snap?.reasonCode ?? `http_${res.status}`;
  if (reason === 'trade.lifecycle_authority_unavailable')
    return `GATE 2: no market-lifecycle publication exists for ${symbol} (reason ${reason}); trade refuses every order (services/svc-trade/src/spot/trade-service.ts:757, services/svc-trade/src/market-lifecycle.ts:445). Publication is owner/legal approval evidence; this script does not invent it. LOCAL TEST stand-in: node tooling/scripts/local-test-gates.mjs apply`;
  if (reason === 'trade.matching_market_missing')
    return `GATE 3: matching holds no book for ${symbol} yet, and trade will not admit the first order until it does (services/svc-trade/src/market-lifecycle.ts:476-486; a book is only created by a submit, services/svc-matching/src/engine/engine.ts:254). LOCAL TEST stand-in: node tooling/scripts/local-test-gates.mjs apply`;
  return `market lifecycle refuses PLACE_POST_ONLY for ${symbol}: ${reason}`;
}

// ── Funding (reuses local:fund: real svc-ledger deposit, LOCAL-TEST- rail ref) ─

/** Runs `local:fund` without blocking the loop. Returns when the ledger has booked the deposit. */
function fundThroughLedger(userId, asset, amount, ref) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [STACK_SCRIPT, 'fund', userId, asset, amount, '--ref', ref], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`local:fund ${asset} failed: ${out.trim().slice(0, 300)}`))));
  });
}

/**
 * Keeps one account stocked: reads its balance now and then, and tops any asset under half its target back up
 * through the real ledger (LOCAL-TEST- rail refs, TEST FUNDS). The taker's target is a tenth of the maker's.
 * Failure it prevents: the taker drained its quote asset and every order got 400 (#4680). A balance read costs
 * one request a minute per account, not two per trade.
 */
class FundKeeper {
  constructor({ client, who, divisor, targets, fund }) {
    this.client = client;
    this.who = who;
    this.divisor = BigInt(divisor);
    this.targets = targets;
    this.fund = fund;
    this.checkedAt = 0;
    this.flagged = false;
    this.failed = new Set();
  }
  /** Ask for a check on the next pass (an order was refused for funds). */
  flag() {
    this.flagged = true;
  }
  due(now) {
    return now - this.checkedAt > 60_000 || (this.flagged && now - this.checkedAt > 20_000);
  }
  async check(assets, now = Date.now()) {
    this.checkedAt = now;
    this.flagged = false;
    const bal = await this.client.http('GET', '/api/v1/account/balance');
    const have = bal.json?.balances ?? {};
    for (const asset of assets) {
      const target = (this.targets.get(asset) ?? 0n) / this.divisor;
      if (target === 0n || this.failed.has(asset)) continue;
      const free = toScaledFloor(have[asset]?.free ?? '0');
      if (free * 2n >= target) continue;
      // Minute precision: a second top-up in the same hour must not be a ledger no-op.
      const ref = `MM-${this.who}-${asset}-${nowIso().slice(0, 16).replace(/[-:T]/g, '')}`;
      try {
        await this.fund(this.client.account.userId, asset, fromScaled(target), ref);
        log(`funded ${this.who} ${fromScaled(target)} ${asset} through the real ledger (TEST FUNDS, rail ref LOCAL-TEST-${ref})`);
      } catch (err) {
        this.failed.add(asset);
        log(`could not fund ${this.who} ${asset}: ${err.message}`);
      }
    }
  }
}

// ── The loop ────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const opts = {
    seed: '1013',
    seconds: 30,
    levels: 20,
    trades: 2,
    ops: 3,
    maxRpm: 360,
    warmup: true,
    symbols: null,
    foreground: false,
    edge: DEFAULT_EDGE,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--seed') opts.seed = argv[++i];
    else if (a === '--interval') opts.seconds = Number(argv[++i]);
    else if (a === '--levels') opts.levels = Number(argv[++i]);
    else if (a === '--trades') opts.trades = Number(argv[++i]);
    else if (a === '--ops') opts.ops = Number(argv[++i]);
    else if (a === '--max-rpm') opts.maxRpm = Number(argv[++i]);
    else if (a === '--no-warmup') opts.warmup = false;
    else if (a === '--markets') opts.symbols = argv[++i] === 'all' ? Object.keys(TEST_PRICES) : argv[i].split(',');
    else if (a === '--edge-url') opts.edge = argv[++i];
    else if (a === '--foreground') opts.foreground = true;
    else if (!a.startsWith('--'))
      // Failure it prevents: `pnpm local:market status` used to be `start status` and started a second copy.
      die(`unexpected argument "${a}". Commands: start | stop | status | ensure | plan | check (for example: pnpm local:market ${a})`, 2);
  }
  if (!Number.isInteger(opts.seconds) || opts.seconds < 2) die('--interval must be a whole number of seconds, at least 2', 2);
  if (!Number.isInteger(opts.levels) || opts.levels < 1 || opts.levels > 40) die('--levels must be 1..40', 2);
  if (!Number.isFinite(opts.trades) || opts.trades < 0 || opts.trades > 10) die('--trades must be 0..10 orders per second', 2);
  if (!Number.isFinite(opts.ops) || opts.ops < 0.5 || opts.ops > 30) die('--ops must be 0.5..30 orders per second', 2);
  if (!Number.isInteger(opts.maxRpm) || opts.maxRpm < 30 || opts.maxRpm > 900)
    die('--max-rpm must be a whole number, 30..900 (Edge allows 1200 per IP)', 2);
  opts.refreshMs = opts.seconds * 1000;
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

// The code alone said only "LedgerError" for a frozen ledger and for an empty balance alike: add the message.
const errCode = (r) => {
  const code = (r.json?.intafacedCode ?? r.json?.code ?? r.json?.error ?? r.text).toString();
  const msg = typeof r.json?.message === 'string' && r.json.message !== code ? `: ${r.json.message}` : '';
  return `${code}${msg}`.slice(0, 160);
};

/**
 * Is the ledger accepting posts? svc-ledger's /health carries `postingEnabled`. Posting switches off when the
 * scheduled reconciliation fails or throws (an operator freeze does the same), and then EVERY order is refused
 * with 400 LedgerError. Failure it prevents: on 14 Oct the hourly reconcile hit the ledger's 15 s statement
 * timeout (its proof reads every ledger entry: 464,000 of them, left by an earlier version of this market that
 * cancelled and re-placed every order every few seconds), froze posting, and the market sent about 1,800 orders
 * an hour into the refusal for hours without saying why.
 */
export function ledgerPosting(healthText) {
  let h = null;
  try {
    h = JSON.parse(healthText);
  } catch {
    /* not JSON: unknown, not frozen */
  }
  if (h && h.postingEnabled === false)
    return {
      frozen: true,
      text: `LEDGER POSTING IS FROZEN (${h.frozenReason ?? 'no reason given'}, by ${h.frozenBy ?? 'unknown'}); every order is refused until an operator thaws it`,
    };
  return { frozen: false, text: 'ledger is accepting posts' };
}

async function ledgerState() {
  try {
    const marker = JSON.parse(fs.readFileSync(stackPaths().marker, 'utf8'));
    const res = await fetch(`http://${LOCAL_HOST}:${marker.ports.ledger}/health`, { redirect: 'error', signal: AbortSignal.timeout(5000) });
    return ledgerPosting(await res.text());
  } catch {
    return { frozen: false, text: 'ledger health unreadable' };
  }
}

/** Orders as the book wants them: best first on each side, remaining size. */
function deriveBook(rest) {
  const bids = rest
    .filter((r) => r.side === 'buy' && r.remaining > 0n)
    .sort((a, b) => (a.price === b.price ? 0 : a.price > b.price ? -1 : 1));
  const asks = rest
    .filter((r) => r.side === 'sell' && r.remaining > 0n)
    .sort((a, b) => (a.price === b.price ? 0 : a.price < b.price ? -1 : 1));
  return {
    bids: bids.map((r) => ({ price: r.price, amount: r.remaining })),
    asks: asks.map((r) => ({ price: r.price, amount: r.remaining })),
  };
}

export async function runLoop(opts, home, deps = {}) {
  const { paths: p } = assertLocalTarget({ home, urls: [opts.edge] });
  installExitLogging(p.log, { echo: ECHO });
  const fund = deps.fund ?? fundThroughLedger;
  const governor = new Governor({ makerPerSec: opts.ops, takerPerSec: opts.trades, slowMs: opts.slowMs });
  const budget = new RequestBudget(opts.maxRpm);
  const stats = { requests: 0, errors: 0, slow: 0, latencyMs: 0, placed: 0, cancelled: 0, refused: 0, trades: 0, prints: 0, refreshes: 0 };
  const ctx = { governor, budget, stats };
  const accounts = loadAccounts(p);
  const maker = new EdgeClient(opts.edge, accounts.maker, ctx);
  const taker = new EdgeClient(opts.edge, accounts.taker, ctx);
  log(`${LABEL}. seed=${opts.seed}, requote each market every ${opts.seconds}s, ${opts.levels} levels a side`);
  log(
    `load budget: ${opts.ops} maker orders/s, ${opts.trades} taker orders/s, at most ${opts.maxRpm} requests/min (Edge allows 1200 per IP); governor slows down on 5xx, 429 or slow answers`,
  );
  log(`maker ${await maker.ensureAccount()} (${accounts.maker.handle}); taker ${await taker.ensureAccount()} (${accounts.taker.handle})`);
  save(p, accounts);

  const wanted = opts.symbols ?? DEFAULT_SYMBOLS;
  const blockers = await preflightGlobal(maker);
  if (blockers.length) {
    EXIT.reason = 'preflight refused (services refuse orders on this stack)';
    log('NOT QUOTING. The services refuse orders on this stack for these reasons:');
    for (const b of blockers) log(`  - ${b}`);
    return 3;
  }

  for (let waited = false, st = await ledgerState(); st.frozen && !STOP.requested; st = await ledgerState()) {
    // Funding and every order would be refused: wait here, loudly, instead of dropping every market.
    if (!waited) log(`WAITING. ${st.text}. Nothing is sent until it is thawed; checking every 10s.`);
    waited = true;
    await sleep(Math.min(10_000, opts.ledgerCheckMs ?? 10_000));
  }
  rotateLog(p.log);

  let saved = {};
  try {
    saved = JSON.parse(fs.readFileSync(p.walkFile, 'utf8'));
  } catch {
    /* fresh walk */
  }

  const states = new Map(); // symbol -> live market state (quoting)
  const waiting = new Map(); // symbol -> why it is not quoting yet
  let known = []; // listed, open-for-trade markets, whether or not they pass preflight yet

  const makerTargets = () =>
    fundTargets(
      [...states.values()].map((s) => ({
        base: s.m.base,
        quote: s.m.quote,
        notional: toScaled(s.cfg.notional),
        start: toScaled(s.cfg.start),
        levels: opts.levels,
      })),
    );
  const makerFunds = new FundKeeper({ client: maker, who: 'maker', divisor: 1, targets: new Map(), fund });
  const takerFunds = new FundKeeper({ client: taker, who: 'taker', divisor: 10, targets: new Map(), fund });
  const assetsOf = () => [...new Set([...states.values()].flatMap((s) => [s.m.base, s.m.quote]))];

  /** Find listed markets not yet quoting, check their gates, fund them, and start quoting those that pass. */
  async function admit() {
    known = await discoverMarkets(maker, wanted);
    const listedSet = new Set(known.map((m) => m.symbol));
    const fresh = [];
    for (const m of known) {
      if (states.has(m.symbol)) continue;
      const reason = await preflightMarket(maker, m.symbol);
      if (reason) {
        if (waiting.get(m.symbol) !== reason) log(`${m.symbol}: not quoting yet. ${reason}`);
        waiting.set(m.symbol, reason);
        continue;
      }
      fresh.push(m);
    }
    for (const symbol of wanted) {
      if (!listedSet.has(symbol) && !waiting.has(symbol) && TEST_PRICES[symbol]) {
        waiting.set(symbol, 'not listed');
        log(`${symbol}: not listed on this stack, so not quoting. List it with: pnpm local:market:list`);
      }
    }
    if (!fresh.length) return 0;
    for (const m of fresh) {
      const cfg = pairConfig(m.symbol);
      const walk = createPriceWalk({
        seed: opts.seed,
        symbol: m.symbol,
        startScaled: toScaled(cfg.start),
        tickScaled: m.tick,
        maxStepBps: cfg.maxStepBps,
      });
      if (saved.seed === opts.seed && saved.steps?.[m.symbol]) walk.advance(saved.steps[m.symbol]); // resume the same series
      const step = gridStepFor({ start: toScaled(cfg.start), tick: m.tick, gridCbps: cfg.gridCbps });
      states.set(m.symbol, {
        m,
        cfg,
        walk,
        step,
        mid: walk.current(),
        rest: [],
        book: { bids: [], asks: [] },
        nextAt: 0,
        warm: opts.warmup ? 2 : 0,
        net: 0n,
        netCap: (toScaled(cfg.notional) * 6n * ONE) / toScaled(cfg.start),
        maxNotional: toScaled(cfg.notional) * 6n,
        refreshes: 0,
        depth: 0,
        followUp: false,
      });
      waiting.delete(m.symbol);
      log(
        `${m.symbol}: TEST PRICE reference ${cfg.start} ${m.quote}, walking from step ${walk.steps} at ${fromScaled(walk.current())}; grid ${fromScaled(step)}, depth unit ${cfg.notional} ${m.quote}`,
      );
    }
    makerFunds.targets = makerTargets();
    takerFunds.targets = makerFunds.targets;
    const assets = assetsOf();
    await makerFunds.check(assets);
    await takerFunds.check(assets);
    // A market whose assets could not be funded would only draw 400s: leave it out and say so.
    for (const [symbol, s] of states) {
      if ([s.m.base, s.m.quote].some((a) => makerFunds.failed.has(a))) {
        states.delete(symbol);
        waiting.set(symbol, 'could not be funded');
        log(`${symbol}: dropped, an asset could not be funded (is it listed in the ledger? pnpm local:market:list)`);
      }
    }
    return fresh.length;
  }

  await admit();
  if (states.size === 0) {
    EXIT.reason = 'preflight refused (services refuse orders on this stack)';
    log('NOT QUOTING. No market passed the gates:');
    for (const [symbol, why] of waiting) log(`  - ${symbol}: ${why}`);
    return 3;
  }
  log(`quoting ${states.size} markets${waiting.size ? `; ${waiting.size} waiting (${[...waiting.keys()].join(', ')})` : ''}`);

  const runId = crypto.randomBytes(3).toString('hex');
  let counter = 0;
  const clientId = () => `LTEST-${runId}-${(counter += 1)}`;
  const refusals = new Map();
  const noteRefusal = (what, r) => {
    stats.refused += 1;
    const key = `${what} ${errCode(r)}`;
    refusals.set(key, (refusals.get(key) ?? 0) + 1);
    if (/insufficient/i.test(key)) {
      makerFunds.flag();
      takerFunds.flag();
    }
  };
  const enc = encodeURIComponent;

  // One re-quote of one market: read what rests, move the price, change only what the move made stale.
  async function refresh(st, avail) {
    const { m, cfg } = st;
    if (!st.followUp) st.mid = st.walk.next(); // a follow-up pass finishes the last move, it does not make a new one
    const open = await maker.http('GET', `/api/v1/orders/open?symbol=${enc(m.symbol)}&limit=500`);
    if (open.status !== 200 || !Array.isArray(open.json)) {
      noteRefusal(`${m.symbol} read open orders`, open);
      return;
    }
    let rest = [];
    for (const o of open.json) {
      try {
        if (o.status === 'open' && o.price && o.id)
          rest.push({ id: o.id, side: o.side, price: toScaled(o.price), remaining: toScaledFloor(o.remaining ?? o.amount) });
      } catch {
        /* an order this script cannot read is left alone */
      }
    }
    const target = targetBook({ mid: st.mid, step: st.step, halfSpreadCbps: cfg.halfSpreadCbps, levels: opts.levels });
    const budgetOps = Math.min(16, Math.max(2, avail));
    const plan = planRefresh({
      target,
      resting: rest,
      step: st.step,
      levels: opts.levels,
      maxExtra: BOOK_EXTRA,
      capCancels: budgetOps,
      capPlaces: budgetOps,
    });
    let ops = 0;
    if (plan.massCancel) {
      const r = await maker.http('DELETE', `/api/v1/orders?symbol=${enc(m.symbol)}`, null, {
        items: Math.max(1, rest.length),
        timeoutMs: 120_000,
      });
      if (r.status === 200) {
        ops += rest.length;
        stats.cancelled += rest.length;
        rest = [];
      } else noteRefusal(`${m.symbol} cancel all`, r);
    } else {
      for (const c of plan.cancels) {
        const r = await maker.http('DELETE', `/api/v1/orders/${enc(c.id)}`);
        ops += 1;
        if (r.status === 200 || r.status === 404) {
          stats.cancelled += 1;
          rest = rest.filter((x) => x.id !== c.id);
        } else noteRefusal(`${m.symbol} cancel`, r);
      }
    }
    const room = Math.max(0, budgetOps - (plan.massCancel ? 0 : plan.cancels.length));
    const places = plan.massCancel ? plan.places.slice(0, budgetOps) : plan.places.slice(0, room);
    for (let i = 0; i < places.length; i += 10) {
      const chunk = places.slice(i, i + 10).map((q) => ({
        q,
        amount: levelSize({
          seed: opts.seed,
          symbol: m.symbol,
          side: q.side,
          price: q.price,
          rank: q.rank,
          notional: toScaled(cfg.notional),
          lot: m.lot,
          minAmount: m.minAmount,
          minCost: m.minCost,
        }),
      }));
      const r = await maker.http(
        'POST',
        '/api/v1/orders/batch',
        {
          orders: chunk.map((c) => ({
            symbol: m.symbol,
            type: 'limit',
            side: c.q.side,
            amount: fromScaled(c.amount),
            price: fromScaled(c.q.price),
            timeInForce: 'GTC',
            postOnly: true,
            clientOrderId: clientId(),
          })),
        },
        { items: chunk.length, timeoutMs: 120_000 },
      );
      ops += chunk.length;
      if (r.status !== 200 || !Array.isArray(r.json?.results)) {
        noteRefusal(`${m.symbol} place batch`, r);
        continue;
      }
      for (const res of r.json.results) {
        const c = chunk[res.index];
        if (res.status === 'success' && res.order?.id && c) {
          stats.placed += 1;
          if (res.order.status === 'open' || res.order.status === undefined)
            rest.push({
              id: res.order.id,
              side: c.q.side,
              price: c.q.price,
              remaining: toScaledFloor(res.order.remaining ?? res.order.amount),
            });
        } else noteRefusal(`${m.symbol} place`, { json: res.error ?? res, text: JSON.stringify(res).slice(0, 120) });
      }
    }
    governor.take('maker', ops);
    st.rest = rest;
    st.book = deriveBook(rest);
    st.depth = Math.min(st.book.bids.length, st.book.asks.length);
    st.refreshes += 1;
    stats.refreshes += 1;
    const more = plan.deferred || (!plan.massCancel && places.length < plan.places.length);
    st.followUp = more;
    st.nextAt = Date.now() + (more ? 1500 : opts.refreshMs * (0.7 + Math.random() * 0.6));
  }

  // One taker order against the book as last read, then the local copy of the book is brought up to date.
  async function trade() {
    const ready = [...states.values()].filter((s) => (s.depth ?? 0) >= 5);
    if (!ready.length) return false;
    const weights = ready.map((s) => s.cfg.weight * (s.warm > 0 ? 6 : 1));
    let pick = Math.random() * weights.reduce((a, b) => a + b, 0);
    const st = ready.find((_, i) => (pick -= weights[i]) <= 0) ?? ready[0];
    const side = pickSide(st.net, st.netCap, Math.random);
    const plan = planCross({
      side,
      book: st.book,
      rand: Math.random,
      lot: st.m.lot,
      minAmount: st.m.minAmount,
      minCost: st.m.minCost,
      maxNotional: st.maxNotional,
    });
    if (!plan) return false;
    governor.take('taker', 1);
    const r = await taker.http('POST', '/api/v1/orders', {
      symbol: st.m.symbol,
      type: 'limit',
      side,
      amount: plan.amount,
      price: plan.price,
      timeInForce: 'IOC',
      clientOrderId: clientId(),
    });
    if (r.status !== 201) {
      noteRefusal(`${st.m.symbol} taker ${side}`, r);
      return true;
    }
    const filled = toScaledFloor(r.json?.filled ?? '0');
    if (filled > 0n) {
      stats.trades += 1;
      st.warm = Math.max(0, st.warm - 1);
      st.net += side === 'buy' ? filled : -filled;
      // Take the filled amount off the touch, level by level, so the next order sees roughly what is left.
      let left = filled;
      const levels = side === 'buy' ? st.book.asks : st.book.bids;
      while (left > 0n && levels.length) {
        const l = levels[0];
        stats.prints += 1;
        if (l.amount > left) {
          l.amount -= left;
          left = 0n;
        } else {
          left -= l.amount;
          levels.shift();
        }
      }
      st.depth = Math.min(st.book.bids.length, st.book.asks.length);
    }
    return true;
  }

  let lastBeat = Date.now();
  let beatAt = { ...stats, at: lastBeat };
  let lastSave = 0;
  let lastAdmit = Date.now();
  let nextTradeAt = Date.now();
  let lastRotate = 0;
  let lastLedger = Date.now();
  const ledgerCheckMs = opts.ledgerCheckMs ?? 30_000;
  let ledgerFrozen = false;
  let consecutiveErrors = 0;
  // A re-quote costs a read and a batch whatever it changes, so wait until a few orders' worth of budget has built up.
  const minRefreshOps = Math.min(6, Math.floor(governor.buckets.maker.burst));

  function heartbeat(now) {
    const mins = Math.max(0.01, (now - beatAt.at) / 60_000);
    const d = (k) => stats[k] - beatAt[k];
    const quoted = [...states.values()];
    const resting = quoted.reduce((s, x) => s + x.rest.length, 0);
    const shallow = quoted.filter((x) => (x.depth ?? 0) < Math.min(opts.levels, 10)).length;
    const top = [...refusals]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([k, n]) => `${n}x ${k}`);
    log(
      `HEARTBEAT ${quoted.length} markets quoting, ${resting} orders resting (${shallow} markets still filling); last ${mins.toFixed(1)}m: ` +
        `${d('requests')} requests (${Math.round(d('requests') / mins)}/min, cap ${opts.maxRpm}), ${d('placed')} placed, ${d('cancelled')} cancelled, ` +
        `${d('trades')} taker orders, ${d('prints')} prints, ${d('refused')} refused, ${d('errors')} errors; ` +
        `avg latency ${d('requests') ? Math.round((stats.latencyMs - beatAt.latencyMs) / d('requests')) : 0}ms, governor ${Math.round(governor.scale * 100)}%` +
        (top.length ? `; refusals: ${top.join(', ')}` : ''),
    );
    refusals.clear();
    beatAt = { ...stats, at: now };
  }

  while (!STOP.requested) {
    const now = Date.now();
    try {
      if (now - lastBeat >= 30_000) {
        lastBeat = now;
        heartbeat(now);
      }
      if (now - lastRotate >= 300_000) {
        lastRotate = now;
        for (const r of rotateAll(path.dirname(p.log)))
          log(`rotated ${path.basename(r.file)} (${Math.round(r.bytes / 1048576)} MB; newest 50 MB kept as .1, 3 files at most)`);
      }
      if (now - lastLedger >= (ledgerFrozen ? Math.min(10_000, ledgerCheckMs) : ledgerCheckMs)) {
        lastLedger = now;
        const st = await ledgerState();
        if (st.frozen !== ledgerFrozen) log(st.frozen ? `PAUSED. ${st.text}. Not sending orders.` : `RESUMED. ${st.text}.`);
        ledgerFrozen = st.frozen;
      }
      if (ledgerFrozen) {
        await sleep(2000);
        continue;
      }
      if (now - lastSave >= 15_000) {
        lastSave = now;
        fs.mkdirSync(p.runDir, { recursive: true, mode: 0o700 });
        fs.writeFileSync(
          p.walkFile,
          JSON.stringify({ seed: opts.seed, steps: Object.fromEntries([...states].map(([k, s]) => [k, s.walk.steps])) }),
          {
            mode: 0o600,
          },
        );
      }
      if (makerFunds.due(now)) {
        await makerFunds.check(assetsOf(), now);
        await takerFunds.check(assetsOf(), now);
        continue;
      }
      if (now - lastAdmit >= 120_000 && waiting.size > 0) {
        lastAdmit = now;
        if ((await admit()) > 0) log(`quoting ${states.size} markets`);
        continue;
      }
      let did = false;
      if (opts.trades > 0 && now >= nextTradeAt && governor.available('taker') >= 1) {
        did = await trade();
        nextTradeAt = Date.now() + (-Math.log(1 - Math.random()) * 1000) / (opts.trades * governor.scale); // a random gap with the right average
      }
      if (!did) {
        const avail = governor.available('maker');
        if (avail >= minRefreshOps) {
          const due = [...states.values()].filter((s) => s.nextAt <= now).sort((a, b) => a.nextAt - b.nextAt)[0];
          if (due) {
            await refresh(due, avail);
            did = true;
          }
        }
      }
      consecutiveErrors = 0;
      if (!did) await sleep(150);
    } catch (err) {
      consecutiveErrors += 1;
      log(`error (${consecutiveErrors}): ${String(err?.message ?? err).slice(0, 200)}`);
      if (consecutiveErrors >= 25) throw err; // let the supervisor restart a loop that cannot recover
      await sleep(Math.min(10_000, 500 * consecutiveErrors));
    }
  }
  EXIT.reason ??= 'stop requested';
  log('stopping: cancelling the test market-maker orders');
  for (const s of states.values())
    await maker.http('DELETE', `/api/v1/orders?symbol=${enc(s.m.symbol)}`, null, { timeoutMs: 120_000 }).catch(() => null);
  return 0;
}

// ── Process control ─────────────────────────────────────────────────────────

export const STALE_AFTER_MS = 2 * 60 * 1000;
const psCommand = (pid) => spawnSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' }).stdout.trim();
// Matched on the file name, not the full path: a copy started from another checkout or worktree is still the market.
const isMarketCommand = (cmd) => cmd.includes('local-test-market.mjs') && cmd.includes('__run');
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
  return rec && isMarketCommand(psCommand(rec.pid)) ? rec.pid : null;
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
    const child = spawn(process.execPath, [SCRIPT, '__run', ...args], {
      cwd: REPO,
      detached: true,
      stdio: ['ignore', fd, fd],
      env: { PATH: process.env.PATH, HOME: os.homedir() },
    });
    child.unref();
    fs.closeSync(fd);
    fs.writeFileSync(p.pidFile, JSON.stringify({ pid: child.pid, startedAt: nowIso(), args }), { mode: 0o600 });
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

/** What `plan` prints: the pairs, how deep the book gets, and the load budget. Reads nothing from the stack. */
export function describePlan(opts) {
  const wanted = opts.symbols ?? DEFAULT_SYMBOLS;
  const lines = [];
  const rows = wanted.filter((s) => TEST_PRICES[s]).map((s) => ({ symbol: s, cfg: pairConfig(s), pair: pairBySymbol(s) }));
  lines.push(
    `LOCAL TEST MARKET plan: ${rows.length} pairs, ${opts.levels} levels a side (${rows.length * opts.levels * 2} resting orders when full)`,
  );
  lines.push('symbol      TEST PRICE   tick       lot       level (quote)  grid   spread       trade share');
  const totalWeight = rows.reduce((a, r) => a + r.cfg.weight, 0);
  for (const r of rows)
    lines.push(
      `${r.symbol.padEnd(11)} ${r.cfg.start.padStart(10)}   ${(r.pair?.tick ?? '-').padEnd(9)}  ${(r.pair?.lot ?? '-').padEnd(8)}  ${r.cfg.notional.padStart(12)}   ${(Number(r.cfg.gridCbps) / 100).toFixed(1)}bp  ${(Number(r.cfg.gridCbps) / 100).toFixed(1)}-${((2 * Number(r.cfg.gridCbps)) / 100).toFixed(1)}bp   ${((100 * r.cfg.weight) / totalWeight).toFixed(1)}%`,
    );
  const seedMin = (rows.length * opts.levels * 2) / opts.ops / 60;
  lines.push('');
  lines.push(
    `load budget: maker ${opts.ops} orders/s (each placement or cancel is one ledger post), taker ${opts.trades} orders/s, at most ${opts.maxRpm} requests/min to Edge (its limit is 1200/min per IP, shared with the app)`,
  );
  lines.push(
    `one request at a time; the governor cuts all rates to 60% on any 5xx, 429 or answer slower than 3s per order, and wins them back slowly`,
  );
  lines.push(
    `first fill of an empty book takes about ${seedMin.toFixed(1)} minutes at that rate; after that a re-quote of each market every ${opts.seconds}s changes only the levels the price move made stale`,
  );
  const targets = fundTargets(
    rows.map((r) => ({
      base: pairBySymbol(r.symbol)?.base ?? r.symbol.split('/')[0],
      quote: r.symbol.split('/')[1],
      notional: toScaled(r.cfg.notional),
      start: toScaled(r.cfg.start),
      levels: opts.levels,
    })),
  );
  lines.push(
    `test funds the maker is kept stocked with (real ledger deposits, LOCAL-TEST rail; taker gets a tenth): ${[...targets].map(([a, v]) => `${fromScaled(v)} ${a}`).join(', ')}`,
  );
  return lines.join('\n');
}

async function main() {
  const [cmd = 'start', ...rest] = process.argv.slice(2);
  const opts = parseArgs(rest.filter((a) => a !== '__run'));
  if (cmd === 'plan') return console.log(describePlan(opts)); // no stack needed: it reads nothing
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
    for (let i = 0; i < 120 && runningPid(p); i += 1) await sleep(500); // cancelling hundreds of orders takes a while
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
    process.exit(await runLoop(opts, os.homedir()));
  }
  if (cmd === 'ensure') {
    const rec = readRecord(p);
    if (runningPid(p)) return console.log(`already running (pid ${runningPid(p)})`);
    if (!rec) return console.log('not started; leaving it off (pnpm local:market starts it)');
    console.log(`was running (pid ${rec.pid}) and is not now; starting it again with the same options`);
    return startBackground(p, rec.args ?? [], { wait: false });
  }
  if (cmd !== 'start') die(`unknown command "${cmd}". Use: start | stop | status | ensure | plan | check`, 2);
  await startBackground(p, rest, { wait: true });
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) await main();
