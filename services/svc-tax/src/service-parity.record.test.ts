import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { parseAmount } from '@intafaced/ledger-client';
import type { BankOwnSpacesPort, TradeVenueAccountActivity, TradeVenueActivityPort } from '@intafaced/contracts';
import { TAX_PROCEDURES } from '@intafaced/contracts/tax-procedures';
import { createMemoryBasisStore } from './basis-store.js';
import { createMemoryChoiceStore, type ChoiceStore } from './choices.js';
import { TaxError } from './codes.js';
import type { AccountLine, HistoryEntry, TaxBalance, TaxLedgerReads, TradeFills } from './ledger-reads.js';
import type { CloseSeriesSource, PriceAtTime, SeriesTimeframe } from './prices.js';
import { SERIES_TIMEFRAME_MS } from './prices.js';
import { TaxService, type DepositBasisPolicy } from './tax-service.js';

/**
 * SERVICE PARITY. A seeded corpus of scenarios: a ledger, spaces, a venue, prices, candles, stores and a list of calls,
 * each run against the TypeScript TaxService with in-memory fakes, every answer kept as the router sends it (parsed
 * through its record's output schema) or as its refusal. `crates/svc-tax/tests/service_parity.rs` runs the same
 * scenarios against the Rust TaxService and must match every one byte for byte.
 *
 * `RECORD_SERVICE_PARITY=1 TZ=UTC pnpm --filter @intafaced/svc-tax exec vitest run src/service-parity.record.test.ts`
 * writes the golden; without the flag this test holds the TypeScript service to it.
 */

// The golden is JSON Lines in shards, each a reviewable size: a header line, then one scenario per line.
const GOLDEN_DIR = fileURLToPath(new URL('../../../crates/svc-tax/tests/fixtures/service-parity/', import.meta.url));
const PER_SHARD = 25;
const shardPath = (k: number) => `${GOLDEN_DIR}${String(k).padStart(2, '0')}.jsonl`;
const SEED = 0x5eed_7a11;
const SCENARIOS = 400;
const USER = 'u-7f3a';
const NOW = '2026-06-30T12:34:56.789Z';
/** Answers longer than this many characters are stored as their SHA-256 and length. */
const BIG = 256;

// ── A small seeded generator ─────────────────────────────────────────────────────────────────────────────────────────

function rngOf(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1));
  const pick = <T>(xs: readonly T[]): T => xs[int(0, xs.length - 1)]!;
  const chance = (p: number) => next() < p;
  /** A positive decimal string: a whole part up to `max`, up to `places` places, never zero. */
  const dec = (max: number, places: number) => {
    const whole = int(0, max);
    const frac = Array.from({ length: int(0, places) }, () => String(int(0, 9))).join('');
    const text = frac.replace(/0+$/, '') === '' ? String(whole) : `${whole}.${frac.replace(/0+$/, '')}`;
    return text === '0' ? '0.5' : text;
  };
  return { next, int, pick, chance, dec };
}

type Rng = ReturnType<typeof rngOf>;

const COINS = ['BTC', 'ETH', 'SOL', 'eth'] as const;
const PAR = ['USDT', 'USDC', 'USD', 'usdt'] as const;
const HOUR = 3_600_000;

// ── The scenario shape, as the golden stores it (every amount a decimal string, every time ISO) ─────────────────────

interface Leg {
  assetId: string;
  amount: string;
}
interface FillRow {
  txId: string;
  postedAt: string;
  received: Leg;
  paid: Leg | null;
  fee: string | null;
  feeAssetId?: string;
}
interface LineRow {
  txId: string;
  postedAt: string;
  assetId: string;
  amount: string;
  reason: string;
  direction: 'debit' | 'credit';
}
interface Scenario {
  name: string;
  now: string;
  mapRaw: string;
  historyYears: number | null;
  depositBasis: DepositBasisPolicy | null;
  balances: Array<{ assetId: string; kind: string; purpose: string | null; amount: string }>;
  history: Record<string, Array<{ txId: string; reason: string; direction: 'debit' | 'credit'; amount: string; postedAt: string }>>;
  subAccounts: Record<string, Array<Record<string, string | null>>> | null;
  /** null: no fill reader; 'fail': the reader throws. */
  tradeFills:
    | null
    | 'fail'
    | {
        fills: FillRow[];
        truncated: boolean;
        outsideInflows: string[];
        inflows?: Array<Omit<LineRow, 'direction'>>;
        outflows?: LineRow[];
        withdrawalHolds?: Array<{ purpose: string; lines: LineRow[] }>;
      };
  spaceHistory: null | 'fail' | { lines: Array<LineRow & { spaceId: string }>; truncated: boolean };
  prices: null | Record<string, 'fail' | { price: string; market: string; timeframe: '1m' | '1h' | '1d' }>;
  closes: null | Record<string, 'fail' | null | { market: string; base: string; step: string }>;
  basis: boolean;
  choices: null | 'ok' | 'fail';
  spaces: null | 'unavailable' | Array<{ spaceId: string; assetId: string; name: string; archived: boolean }>;
  venue: null | 'off' | 'unavailable' | { test: boolean; accounts: TradeVenueAccountActivity[] };
  calls: Array<{ op: string; input: Record<string, unknown> }>;
  results?: Array<
    { ok: unknown } | { okSha256: string; bytes: number } | { refused: { code: string; message: string } } | { internal: string }
  >;
  constructError?: { code: string; message: string };
}

const iso = (ms: number) => new Date(ms).toISOString();

function generate(rng: Rng, index: number): Scenario {
  const { int, pick, chance, dec } = rng;
  const now = Date.parse(NOW);
  // Most activity in the last two months, so the result over time can be drawn; some much older.
  let clock = now - int(1, 60) * 24 * HOUR - (chance(0.15) ? 400 * 24 * HOUR : 0);
  const tick = () => {
    clock += int(0, 3) === 0 ? 0 : int(1, 40) * HOUR + int(0, 59) * 60_000;
    return iso(Math.min(clock, now - 60_000));
  };
  const txName = (n: number) => pick(['tx-', 'tx_', 'TX-', 'tx', 'a:', 'b-'])! + n;
  let n = 0;
  const coins = COINS.slice(0, int(1, COINS.length));
  const holdings = new Map<string, number>();
  const fills: FillRow[] = [];
  const buys: Array<{ txId: string; assetId: string }> = [];
  const sells: Array<{ txId: string; assetId: string; day: string }> = [];
  const fillCount = int(0, 12);
  for (let k = 0; k < fillCount; k++) {
    const postedAt = tick();
    const txId = chance(0.1) && fills.length > 0 ? fills[fills.length - 1]!.txId : txName(n++);
    const coin = pick(coins);
    const par = pick(PAR);
    const kind = pick(['buy', 'buy', 'buy', 'sell', 'sell', 'swap', 'self', 'unpaid'] as const);
    const feeKind = pick(['received', 'unknown', 'null', 'paid', 'zero'] as const);
    const qty = dec(3, 6);
    const value = dec(60_000, 2);
    let fill: FillRow;
    if (kind === 'buy') {
      fill = { txId, postedAt, received: { assetId: coin, amount: qty }, paid: { assetId: par, amount: value }, fee: null };
      buys.push({ txId, assetId: coin });
      holdings.set(coin, (holdings.get(coin) ?? 0) + Number(qty));
    } else if (kind === 'sell') {
      fill = { txId, postedAt, received: { assetId: par, amount: value }, paid: { assetId: coin, amount: qty }, fee: null };
      sells.push({ txId, assetId: coin, day: postedAt.slice(0, 10) });
      holdings.set(coin, (holdings.get(coin) ?? 0) - Number(qty));
    } else if (kind === 'swap') {
      const other = pick(COINS.filter((c) => c !== coin));
      fill = { txId, postedAt, received: { assetId: other, amount: dec(20, 5) }, paid: { assetId: coin, amount: qty }, fee: null };
      buys.push({ txId, assetId: other });
      sells.push({ txId, assetId: coin, day: postedAt.slice(0, 10) });
    } else if (kind === 'self') {
      fill = { txId, postedAt, received: { assetId: 'USDC', amount: value }, paid: { assetId: 'USDT', amount: value }, fee: '0' };
    } else {
      fill = { txId, postedAt, received: { assetId: coin, amount: qty }, paid: null, fee: null };
      buys.push({ txId, assetId: coin });
    }
    if (feeKind === 'received') fill.fee = dec(0, 6);
    else if (feeKind === 'zero') fill.fee = '0';
    else if (feeKind === 'paid' && fill.paid !== null) {
      fill.fee = dec(5, 4);
      fill.feeAssetId = fill.paid.assetId;
    } else if (feeKind === 'null') fill.fee = null;
    fills.push(fill);
  }

  const newReader = chance(0.65);
  const spaceIds = Array.from({ length: newReader ? int(0, 2) : 0 }, (_, k) => `0000000${k}-1111-4111-8111-11111111111${k}`);
  const inflows: Array<Omit<LineRow, 'direction'>> = [];
  const outflows: LineRow[] = [];
  const spaceLines: Array<LineRow & { spaceId: string }> = [];
  const holds: Array<{ purpose: string; lines: LineRow[] }> = [];
  const balances: Scenario['balances'] = [];
  if (newReader) {
    for (let k = int(0, 5); k > 0; k--) {
      const assetId = pick([...coins, 'USDT']);
      inflows.push({
        txId: txName(n++),
        postedAt: tick(),
        assetId,
        amount: dec(4, 5),
        reason: pick([
          'deposit.crypto',
          'bank.earn.interest',
          'staking.reward',
          'bank.transfer.in',
          'identity.sub_account.transfer',
          'pay.received',
          'other.thing',
          'venue.transfer_in',
        ]),
      });
    }
    for (let k = spaceIds.length === 0 ? 0 : int(0, 5); k > 0; k--) {
      const spaceId = pick(spaceIds);
      const assetId = pick(coins);
      const amount = dec(2, 4);
      const txId = txName(n++);
      const postedAt = tick();
      const shape = pick(['in', 'out', 'between', 'deposit', 'mismatch', 'leave'] as const);
      if (shape === 'in') {
        outflows.push({ txId, postedAt, assetId, amount, reason: 'bank.transfer.to_space', direction: 'credit' });
        spaceLines.push({ spaceId, txId, postedAt, assetId, amount, reason: 'bank.transfer.to_space', direction: 'debit' });
      } else if (shape === 'out') {
        inflows.push({ txId, postedAt, assetId, amount, reason: 'bank.transfer.from_space' });
        spaceLines.push({ spaceId, txId, postedAt, assetId, amount, reason: 'bank.transfer.from_space', direction: 'credit' });
      } else if (shape === 'between' && spaceIds.length > 1) {
        spaceLines.push({ spaceId: spaceIds[0]!, txId, postedAt, assetId, amount, reason: 'bank.transfer.space', direction: 'credit' });
        spaceLines.push({ spaceId: spaceIds[1]!, txId, postedAt, assetId, amount, reason: 'bank.transfer.space', direction: 'debit' });
      } else if (shape === 'deposit') {
        spaceLines.push({ spaceId, txId, postedAt, assetId, amount, reason: 'deposit.crypto', direction: 'debit' });
      } else if (shape === 'mismatch') {
        outflows.push({ txId, postedAt, assetId, amount, reason: 'bank.transfer.to_space', direction: 'credit' });
        spaceLines.push({ spaceId, txId, postedAt, assetId, amount: dec(2, 4), reason: 'bank.transfer.to_space', direction: 'debit' });
      } else {
        spaceLines.push({ spaceId, txId, postedAt, assetId, amount, reason: 'bank.transfer.out', direction: 'credit' });
      }
    }
    for (let k = int(0, 2); k > 0; k--) {
      const id = `w${n++}`;
      const assetId = pick([...coins, 'USDC']);
      const amount = dec(2, 4);
      const lines: LineRow[] = [{ txId: txName(n++), postedAt: tick(), assetId, amount, reason: 'withdraw.held', direction: 'debit' }];
      const end = pick(['settled', 'reversed', 'partial', 'pending'] as const);
      if (end === 'settled')
        lines.push({ txId: txName(n++), postedAt: tick(), assetId, amount, reason: 'withdraw.settled', direction: 'credit' });
      if (end === 'reversed')
        lines.push({ txId: txName(n++), postedAt: tick(), assetId, amount, reason: 'withdraw.reversed', direction: 'credit' });
      if (end === 'partial') {
        const back = (Number(amount) / 3).toFixed(4);
        lines.push({ txId: txName(n++), postedAt: tick(), assetId, amount: back, reason: 'withdraw.reversed', direction: 'credit' });
      }
      holds.push({ purpose: chance(0.9) ? `withdraw:${id}` : `order:${id}`, lines });
      if (end === 'pending') balances.push({ assetId, kind: 'hold', purpose: `withdraw:${id}`, amount });
    }
  }

  for (const [coin, qty] of holdings) {
    const held = chance(0.75) ? qty : qty + (chance(0.5) ? 0.5 : -0.25);
    if (held > 0) balances.push({ assetId: coin, kind: 'available', purpose: null, amount: held.toFixed(6) });
  }
  for (const line of inflows)
    if (chance(0.7) && line.assetId !== 'USDT')
      balances.push({ assetId: line.assetId, kind: 'available', purpose: null, amount: line.amount });
  if (chance(0.5)) balances.push({ assetId: 'USDT', kind: 'available', purpose: null, amount: dec(9000, 2) });
  if (chance(0.2)) balances.push({ assetId: pick(coins), kind: 'order', purpose: 'order:1', amount: dec(1, 3) });

  const history: Scenario['history'] = {};
  for (const b of balances) {
    if (b.kind !== 'available' || history[b.assetId]) continue;
    history[b.assetId] = Array.from({ length: int(0, 4) }, () => ({
      txId: txName(n++),
      reason: pick(['deposit.crypto', 'trade.fill', 'withdraw.settled']),
      direction: pick(['debit', 'debit', 'credit'] as const),
      amount: chance(0.1) ? '0' : dec(3, 4),
      postedAt: tick(),
    }));
  }

  const tradeFills: Scenario['tradeFills'] = chance(0.06)
    ? null
    : chance(0.03)
      ? 'fail'
      : {
          fills,
          truncated: chance(0.08),
          outsideInflows: chance(0.15) ? [pick([...coins, 'USDT'])].sort() : [],
          ...(newReader ? { inflows, outflows, withdrawalHolds: holds } : {}),
        };

  const prices: Scenario['prices'] = chance(0.15)
    ? null
    : Object.fromEntries(
        coins
          .filter(() => chance(0.85))
          .map((c) => [
            c,
            chance(0.1)
              ? 'fail'
              : { price: dec(70_000, 3), market: `${c.toUpperCase()}/USDT`, timeframe: pick(['1m', '1h', '1d'] as const) },
          ]),
      );
  const closes: Scenario['closes'] = chance(0.1)
    ? null
    : Object.fromEntries(
        coins.map((c) => [
          c,
          chance(0.07) ? 'fail' : chance(0.1) ? null : { market: `${c.toUpperCase()}/USDT`, base: dec(60_000, 2), step: dec(200, 2) },
        ]),
      );

  const spaces: Scenario['spaces'] =
    spaceIds.length > 0
      ? chance(0.1)
        ? 'unavailable'
        : spaceIds.map((spaceId, k) => ({ spaceId, assetId: pick(coins), name: `Space ${k}`, archived: chance(0.2) }))
      : chance(0.4)
        ? null
        : chance(0.2)
          ? 'unavailable'
          : [];

  const venue = chance(0.3)
    ? venueOf(
        rng,
        () => tick(),
        () => n++,
      )
    : null;
  const subAccounts = chance(0.3)
    ? Object.fromEntries(
        Array.from({ length: int(1, 2) }, (_, k) => [
          `sub-${k}`,
          Array.from({ length: int(0, 3) }, (_, j) => ({
            id: `l${j}`,
            kind: pick(['fill', 'convert']),
            postedAt: tick(),
            assetId: pick(coins),
            qty: dec(2, 3),
            fee: chance(0.5) ? dec(0, 4) : null,
            makerRebate: chance(0.3) ? dec(0, 4) : null,
            costBasis: chance(0.7) ? dec(5000, 2) : null,
            proceeds: chance(0.7) ? dec(5000, 2) : null,
          })),
        ]),
      )
    : null;

  // The calls: settings and basis writes between reads, so a later read shows what an earlier write did.
  const calls: Scenario['calls'] = [];
  const methods = ['FIFO', 'LIFO', 'HIFO', 'AVERAGE'] as const;
  const lotIds = [
    ...buys.map((b) => `lot:${b.txId}:${b.assetId}`),
    ...inflows.map((l) => `lot:${l.txId}:${l.assetId}`),
    ...spaceLines.map((l) => `lot:${l.txId}:${l.assetId}`),
  ];
  const callCount = int(2, 9);
  for (let k = 0; k < callCount; k++) {
    const op = pick([
      'lotBook',
      'lotBook',
      'lotBook',
      'missingBasis',
      'pnlOverTime',
      'pnlOverTime',
      'setLotMethod',
      'setDayMethod',
      'pickSaleLot',
      'setIncludeTransfers',
      'basisOverrideSet',
      'basisOverrideSet',
      'basisOverrideRemove',
      'exportPreview',
      'exportPack',
    ] as const);
    if (op === 'lotBook' || op === 'missingBasis') calls.push({ op, input: chance(0.5) ? {} : { method: pick(methods) } });
    else if (op === 'pnlOverTime') calls.push({ op, input: pnlInput(rng, now) });
    else if (op === 'setLotMethod')
      calls.push({ op, input: { assetId: chance(0.5) ? null : pick(coins), method: chance(0.15) ? null : pick(methods) } });
    else if (op === 'setDayMethod') {
      const day = sells.length > 0 && chance(0.8) ? pick(sells).day : '2026-05-05';
      calls.push({ op, input: { day, assetId: chance(0.5) ? null : pick(coins), method: chance(0.15) ? null : pick(methods) } });
    } else if (op === 'pickSaleLot') {
      const sale = sells.length > 0 ? pick(sells) : { txId: 'tx-none', assetId: 'BTC' };
      const lot = lotIds.length > 0 && chance(0.85) ? pick(lotIds) : `lot:nope:${sale.assetId}`;
      calls.push({ op, input: { saleTxId: sale.txId, assetId: sale.assetId, lotId: chance(0.15) ? null : lot } });
    } else if (op === 'setIncludeTransfers') calls.push({ op, input: { include: pick([true, false, false, null]) } });
    else if (op === 'basisOverrideSet') calls.push({ op, input: basisInput(rng, lotIds) });
    else if (op === 'basisOverrideRemove')
      calls.push({
        op,
        input: { lotId: lotIds.length > 0 && chance(0.8) ? pick(lotIds) : pick(['  ', 'lot:nope:BTC', `manual:${USER}:m1`]) },
      });
    else
      calls.push({
        op,
        input: {
          region: pick(['DE', 'de ', 'FR', 'XX', '']),
          lotMethod: pick(['FIFO', 'LIFO', 'HIFO', 'AVERAGE']),
          ...(chance(0.08) ? { complete: true } : chance(0.3) ? { complete: false } : {}),
        },
      });
  }
  calls.push({ op: 'lotBook', input: {} });
  if (chance(0.5)) calls.push({ op: 'pnlOverTime', input: pnlInput(rng, now) });

  return {
    name: `scenario-${index}`,
    now: NOW,
    mapRaw: pick(['', '["DE"]', '{"DE":{},"FR":{}}', '[]', ...(chance(0.05) ? ['[de]'] : [])]),
    historyYears: pick([null, 1, 3, 10, 0, 101]),
    depositBasis: pick([null, 'market', 'customer'] as const),
    balances,
    history,
    subAccounts,
    tradeFills,
    spaceHistory:
      spaceIds.length > 0 ? (chance(0.08) ? 'fail' : chance(0.1) ? null : { lines: spaceLines, truncated: chance(0.08) }) : null,
    prices,
    closes,
    basis: chance(0.8),
    choices: chance(0.15) ? null : chance(0.08) ? 'fail' : 'ok',
    spaces,
    venue,
    calls,
  };
}

function pnlInput(rng: Rng, now: number): Record<string, unknown> {
  const { int, pick, chance } = rng;
  const span = pick([HOUR * 6, 24 * HOUR, 7 * 24 * HOUR, 30 * 24 * HOUR, 75 * 24 * HOUR, 200 * 24 * HOUR, 3000 * 24 * HOUR]);
  const end = chance(0.5) ? now + (chance(0.3) ? HOUR : 0) : now - int(0, 20) * 24 * HOUR - int(0, 23) * HOUR;
  const from = chance(0.05) ? end + HOUR : end - span;
  const offset = pick([0, 0, 480, -300, 330, 840, -840, 525]);
  const sign = offset >= 0 ? '+' : '-';
  const abs = Math.abs(offset);
  const withOffset = (ms: number) =>
    chance(0.3)
      ? `${new Date(ms + offset * 60_000).toISOString().slice(0, 19)}${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`
      : iso(ms);
  return { from: withOffset(from), ...(chance(0.6) ? { to: withOffset(end) } : {}), utcOffsetMinutes: offset };
}

function basisInput(rng: Rng, lotIds: string[]): Record<string, unknown> {
  const { pick, chance, dec } = rng;
  const shape = pick(['override', 'override', 'override', 'manual', 'manual', 'bad'] as const);
  if (shape === 'override')
    return {
      lotId: lotIds.length > 0 && chance(0.85) ? pick(lotIds) : 'lot:nope:BTC',
      pricePerUnit: chance(0.9) ? dec(50_000, 3) : pick(['0', '-1', '1e3']),
      date: pick(['2026-03-01', '2026-03-01T10:00:00Z', '2026-02-30', ' 2026-04-01T00:00:00.123456+08:00 ']),
      sourceNote: pick(['exchange statement', '  broker  ']),
    };
  if (shape === 'manual')
    return {
      lotId: pick([`manual:${USER}:m1`, `manual:${USER}:m2`, `manual:someone:m1`, `manual:${USER}:-bad`]),
      pricePerUnit: dec(3000, 2),
      date: '2025-12-31',
      sourceNote: 'paper wallet',
      ...(chance(0.9) ? { assetId: pick(['BTC', 'ETH']) } : {}),
      ...(chance(0.9) ? { qty: pick([dec(3, 3), '0', 'x']) } : {}),
    };
  return pick([
    { lotId: '', pricePerUnit: '1', date: '2026-01-01', sourceNote: 'n' },
    { lotId: 'lot:x:BTC', pricePerUnit: ' ', date: '2026-01-01', sourceNote: 'n' },
    { lotId: 'lot:x:BTC', pricePerUnit: '1', date: '', sourceNote: 'n' },
    { lotId: 'lot:x:BTC', pricePerUnit: '1', date: 'not-a-date', sourceNote: 'n' },
    { lotId: 'lot:x:BTC', pricePerUnit: '1', date: '2026-01-01', sourceNote: '' },
    { lotId: 'lot:x:BTC', pricePerUnit: '1', date: '2026-01-01', sourceNote: 'n', assetId: 'BTC' },
    { lotId: 'lot:x:BTC', pricePerUnit: '1.0000000000000000001', date: '2026-01-01', sourceNote: 'n' },
  ]);
}

function venueOf(rng: Rng, tick: () => string, next: () => number): Scenario['venue'] {
  const { int, pick, chance, dec } = rng;
  if (chance(0.15)) return 'off';
  if (chance(0.15)) return 'unavailable';
  const owner = `0x${'ab12'.repeat(10)}`;
  const accounts: TradeVenueAccountActivity[] = [];
  const subs = chance(0.5) ? ['7'] : [];
  const account = (subAccount: string | null): TradeVenueAccountActivity => {
    const fills = Array.from({ length: int(0, 5) }, () => {
      const base = pick(['BTC', 'ETH']);
      const quote = pick(['USDC', 'USDT']);
      return {
        fillId: `f${next()}`,
        symbol: `${base}/${quote}`,
        base,
        quote,
        side: pick(['buy', 'buy', 'sell'] as const),
        price: dec(60_000, 2),
        amount: dec(2, 5),
        fee: dec(0, 6),
        feeAsset: pick([base, quote, 'HYPE']),
        filledAt: tick(),
      };
    });
    const held = new Map<string, number>();
    for (const f of fills) {
      const sign = f.side === 'buy' ? 1 : -1;
      held.set(f.base, (held.get(f.base) ?? 0) + sign * Number(f.amount));
    }
    return {
      venueId: pick(['hl', 'hl-test']),
      owner,
      subAccount,
      balances: [...held]
        .filter(([, q]) => q > 0)
        .map(([asset, q]) => ({ asset, total: chance(0.7) ? q.toFixed(5) : (q + 0.1).toFixed(5) }))
        .concat(chance(0.5) ? [{ asset: 'USDC', total: dec(1000, 2) }] : []),
      fills,
      ...(subAccount === null && subs.length > 0
        ? {
            transfers: Array.from({ length: int(0, 3) }, () => ({
              moveId: `m${next()}`,
              subAccount: subs[0]!,
              direction: pick(['into_sub_account', 'into_sub_account', 'out_of_sub_account'] as const),
              asset: pick(['BTC', 'ETH']),
              amount: dec(1, 4),
              settledAt: tick(),
            })),
          }
        : {}),
      ...(chance(0.5)
        ? {
            arrivals: Array.from({ length: int(0, 2) }, () => ({
              arrivalId: `a${next()}`,
              kind: pick(['deposit', 'transfer_in'] as const),
              asset: pick(['BTC', 'ETH', 'USDC']),
              amount: dec(1, 4),
              arrivedAt: tick(),
            })),
          }
        : {}),
      asOf: tick(),
    };
  };
  accounts.push(account(null));
  for (const s of subs) accounts.push(account(s));
  if (chance(0.3)) accounts.reverse();
  return { test: chance(0.5), accounts };
}

// ── Fakes over a scenario ───────────────────────────────────────────────────────────────────────────────────────────

const line = (l: LineRow): AccountLine => ({ ...l, amount: parseAmount(l.amount), postedAt: new Date(l.postedAt) });

function service(s: Scenario): TaxService {
  const reads: TaxLedgerReads = {
    async balances(ownerType, ownerId): Promise<TaxBalance[]> {
      return s.balances.map((b, k) => ({
        account: {
          ownerType,
          ownerId,
          assetId: b.assetId,
          kind: b.kind as 'available',
          ...(b.purpose === null ? {} : { purpose: b.purpose }),
        },
        accountId: `acc-${k}`,
        amount: parseAmount(b.amount),
      }));
    },
    async history(account): Promise<HistoryEntry[]> {
      return (s.history[account.assetId] ?? []).map((e) => ({
        txId: e.txId,
        module: 'ledger',
        reason: e.reason,
        direction: e.direction,
        amount: parseAmount(e.amount),
        postedAt: new Date(e.postedAt),
      }));
    },
  };
  const filled = s.tradeFills;
  if (filled !== null) {
    reads.tradeFills = async (): Promise<TradeFills> => {
      if (filled === 'fail') throw new TaxError('tax.ledger_history_unavailable', 'the ledger did not answer');
      return {
        fills: filled.fills.map((f) => ({
          txId: f.txId,
          postedAt: new Date(f.postedAt),
          received: { assetId: f.received.assetId, amount: parseAmount(f.received.amount) },
          paid: f.paid === null ? null : { assetId: f.paid.assetId, amount: parseAmount(f.paid.amount) },
          fee: f.fee === null ? null : parseAmount(f.fee),
          ...(f.feeAssetId === undefined ? {} : { feeAssetId: f.feeAssetId }),
        })),
        truncated: filled.truncated,
        outsideInflows: new Set(filled.outsideInflows),
        ...(filled.inflows === undefined
          ? {}
          : {
              inflows: filled.inflows.map((l) => ({ ...l, amount: parseAmount(l.amount), postedAt: new Date(l.postedAt) })),
              outflows: (filled.outflows ?? []).map(line),
              withdrawalHolds: (filled.withdrawalHolds ?? []).map((h) => ({ purpose: h.purpose, lines: h.lines.map(line) })),
            }),
      };
    };
  }
  const spaceHistory = s.spaceHistory;
  if (spaceHistory !== null) {
    reads.spaceHistory = async (ids) => {
      if (spaceHistory === 'fail') throw new Error('space history down');
      return {
        lines: spaceHistory.lines.filter((l) => ids.includes(l.spaceId)).map((l) => ({ ...line(l), spaceId: l.spaceId })),
        truncated: spaceHistory.truncated,
      };
    };
  }
  const subs = s.subAccounts;
  if (subs !== null) {
    reads.subAccountIds = async () => Object.keys(subs);
    reads.subAccountActivity = async (id) =>
      (subs[id] ?? []).map((l) => ({
        id: l.id!,
        kind: l.kind as 'fill',
        postedAt: new Date(l.postedAt!),
        assetId: l.assetId!,
        qty: parseAmount(l.qty!),
        fee: l.fee === null ? null : parseAmount(l.fee!),
        makerRebate: l.makerRebate === null ? null : parseAmount(l.makerRebate!),
        costBasis: l.costBasis === null ? null : parseAmount(l.costBasis!),
        proceeds: l.proceeds === null ? null : parseAmount(l.proceeds!),
      }));
  }
  const priceTable = s.prices;
  const prices: PriceAtTime | undefined =
    priceTable === null
      ? undefined
      : {
          async priceAt(assetId, at) {
            const p = priceTable[assetId];
            if (p === undefined) return null;
            if (p === 'fail') throw new Error('market data down');
            return {
              price: parseAmount(p.price),
              market: p.market,
              timeframe: p.timeframe,
              candleAt: new Date(Math.floor(at.getTime() / 60_000) * 60_000),
            };
          },
        };
  const closeTable = s.closes;
  const closes: CloseSeriesSource | undefined =
    closeTable === null
      ? undefined
      : {
          async closes(assetId, timeframe: SeriesTimeframe, from, to) {
            const c = closeTable[assetId];
            if (c === undefined || c === null) return null;
            if (c === 'fail') throw new Error('candles down');
            return { market: c.market, candles: candlesOf(c.base, c.step, timeframe, from.getTime(), to.getTime()) };
          },
        };
  let choices: ChoiceStore | undefined;
  if (s.choices !== null) {
    const store = createMemoryChoiceStore();
    choices = s.choices === 'fail' ? { ...store, read: async () => Promise.reject(new Error('choices down')) } : store;
  }
  const spaceList = s.spaces;
  const spaces: BankOwnSpacesPort | undefined =
    spaceList === null
      ? undefined
      : {
          async list() {
            return spaceList === 'unavailable'
              ? { state: 'unavailable', code: 'bank.own_spaces_unavailable' }
              : { state: 'read', spaces: spaceList as never };
          },
        };
  const v = s.venue;
  const venue: TradeVenueActivityPort | undefined =
    v === null
      ? undefined
      : {
          async read() {
            if (v === 'off') return { state: 'off' };
            if (v === 'unavailable') return { state: 'unavailable', code: 'trade.venue_activity_unavailable' };
            return { state: 'read', test: v.test, accounts: v.accounts };
          },
        };
  return new TaxService({
    mapRaw: s.mapRaw,
    reads,
    lake: { status: 'absent', code: 'tax.data_lake_unavailable' },
    indexer: { status: 'configured', code: 'tax.indexer_unprobed' },
    ...(s.historyYears === null ? {} : { historyYears: s.historyYears }),
    now: () => new Date(s.now),
    ...(s.depositBasis === null ? {} : { depositBasis: s.depositBasis }),
    ...(prices ? { prices } : {}),
    ...(closes ? { closes } : {}),
    ...(s.basis ? { basis: createMemoryBasisStore() } : {}),
    ...(choices ? { choices } : {}),
    ...(spaces ? { spaces } : {}),
    ...(venue ? { venue } : {}),
  });
}

/** One candle per step from the one before `from` to `to`: `base + (index mod 13) * step`, the same in Rust. */
function candlesOf(base: string, step: string, timeframe: SeriesTimeframe, from: number, to: number): Array<[number, bigint]> {
  const ms = SERIES_TIMEFRAME_MS[timeframe];
  const out: Array<[number, bigint]> = [];
  for (let t = Math.floor(from / ms) * ms - ms; t <= to; t += ms) {
    out.push([t, parseAmount(base) + BigInt(Math.floor(t / ms) % 13) * parseAmount(step)]);
  }
  return out;
}

const RECORD = Object.fromEntries(TAX_PROCEDURES.map((r) => [r.name, r]));

async function run(s: Scenario): Promise<Scenario> {
  let tax: TaxService;
  try {
    tax = service(s);
  } catch (err) {
    if (err instanceof TaxError) return { ...s, constructError: { code: err.code, message: err.message } };
    throw err;
  }
  const results: NonNullable<Scenario['results']> = [];
  for (const call of s.calls) {
    // Each field read below, typed `never` so it passes to whichever call takes it (the inputs come from the generator).
    type Field =
      | 'method'
      | 'from'
      | 'to'
      | 'utcOffsetMinutes'
      | 'lotId'
      | 'assetId'
      | 'day'
      | 'saleTxId'
      | 'include'
      | 'region'
      | 'lotMethod'
      | 'complete';
    const fields: { readonly [K in Field]: never } = call.input as never;
    const i = fields;
    const userId = USER;
    try {
      let out: unknown;
      switch (call.op) {
        case 'lotBook':
          out = await tax.lotBook({ userId, ...(i.method === undefined ? {} : { method: i.method }) });
          break;
        case 'missingBasis':
          out = await tax.missingBasis({ userId, ...(i.method === undefined ? {} : { method: i.method }) });
          break;
        case 'pnlOverTime':
          out = await tax.pnlOverTime({
            userId,
            from: i.from,
            ...(i.to === undefined ? {} : { to: i.to }),
            utcOffsetMinutes: i.utcOffsetMinutes,
          });
          break;
        case 'basisOverrideSet':
          out = await tax.basisOverrideSet({
            userId,
            ...(call.input as Omit<Parameters<TaxService['basisOverrideSet']>[0], 'userId'>),
          });
          break;
        case 'basisOverrideRemove':
          out = await tax.basisOverrideRemove({ userId, lotId: i.lotId });
          break;
        case 'setLotMethod':
          await tax.setLotMethod({ userId, assetId: i.assetId, method: i.method });
          out = { saved: true };
          break;
        case 'setDayMethod':
          await tax.setDayMethod({ userId, day: i.day, assetId: i.assetId, method: i.method });
          out = { saved: true };
          break;
        case 'pickSaleLot':
          await tax.pickSaleLot({ userId, saleTxId: i.saleTxId, assetId: i.assetId, lotId: i.lotId });
          out = { saved: true };
          break;
        case 'setIncludeTransfers':
          await tax.setIncludeTransfers({ userId, include: i.include });
          out = { saved: true };
          break;
        case 'exportPreview':
          out = await tax.exportPreview({ userId, region: i.region, lotMethod: i.lotMethod, complete: i.complete });
          break;
        case 'exportPack':
          out = await tax.exportPack({ userId, region: i.region, lotMethod: i.lotMethod, complete: i.complete });
          break;
        default:
          throw new Error(`unknown op ${call.op}`);
      }
      const name =
        call.op === 'basisOverrideSet'
          ? 'tax.basisOverride.set'
          : call.op === 'basisOverrideRemove'
            ? 'tax.basisOverride.remove'
            : `tax.${call.op}`;
      // As the router sends it: parsed through the record's output schema (key order, unknown keys dropped).
      const answer = RECORD[name]!.output.parse(out);
      const text = JSON.stringify(answer);
      // A long answer (a chart's points, a big book) is kept as its hash and length: still byte for byte, in less room.
      results.push(text.length > BIG ? { okSha256: createHash('sha256').update(text).digest('hex'), bytes: text.length } : { ok: answer });
    } catch (err) {
      if (err instanceof TaxError) results.push({ refused: { code: err.code, message: err.message } });
      else results.push({ internal: err instanceof Error ? err.message : String(err) });
    }
  }
  return { ...s, results };
}

describe('service parity golden', () => {
  beforeAll(() => {
    // The book without a `now` (the old fill reader) reads the wall clock: it is the scenario's clock here.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(NOW));
  });
  afterAll(() => {
    vi.useRealTimers();
  });

  it('every scenario answers as recorded', async () => {
    const rng = rngOf(SEED);
    const scenarios = Array.from({ length: SCENARIOS }, (_, k) => generate(rng, k));
    const recorded: Scenario[] = [];
    for (const s of scenarios) recorded.push(await run(s));
    const shards = Array.from({ length: Math.ceil(recorded.length / PER_SHARD) }, (_, k) =>
      [
        { rngSeed: SEED, user: USER, shard: k, of: Math.ceil(recorded.length / PER_SHARD) },
        ...recorded.slice(k * PER_SHARD, (k + 1) * PER_SHARD),
      ]
        .map((line) => `${JSON.stringify(line)}\n`)
        .join(''),
    );
    if (process.env.RECORD_SERVICE_PARITY === '1') {
      mkdirSync(GOLDEN_DIR, { recursive: true });
      shards.forEach((text, k) => writeFileSync(shardPath(k), text));
      return;
    }
    shards.forEach((text, k) => {
      expect(existsSync(shardPath(k))).toBe(true);
      expect(text).toBe(readFileSync(shardPath(k), 'utf8'));
    });
  });
});
