import { formatAmount, mul, parseAmount, type Amount } from '@intafaced/ledger-client';
import type {
  BankValueBridge,
  BankValueOverTime,
  LedgerHoldingsHistory,
  LedgerHoldingsHistoryBucket,
  ValueSeriesInterval,
} from '@intafaced/contracts';
import { classify, type ActivityKind } from '../activity/activity-kind.js';
import { SERIES_TIMEFRAME_MS, closeAt, type CloseSeries } from './candles.js';
import { PAR_ASSETS } from './valuation.js';

/**
 * VALUE OVER TIME (J-portfolio-05 #6-#7), worked out from the ledger's holdings history, never stored.
 *
 * The holdings at a moment T on the ledger's time grid are what is held now less every movement from T on, summed over
 * the customer's main account and named Spaces (the accounts the Money total counts). Each moment is valued at the close
 * of the last candle that had ended by T (only the live end may use the candle still open); USDT, USDC and USD count as
 * 1 USD. A coin held at T with no price leaves that moment missing, with the coin named.
 *
 * The bridge between the first and last moments values each movement at the close by the end of its bucket, and sorts it
 * by the ledger's own reason (the activity kinds): deposits and withdrawals crossed the platform's edge, fees are fees,
 * trades are left to the market move, and everything else is another flow. Moves between the customer's own accounts net
 * to zero, because both halves are one transaction in one bucket under one reason.
 */

const MAX_POINTS = 400;
/** svc-trade answers a window only whole, at most 720 candles to now; one candle back from the start and one spare. */
const MAX_CANDLES_TO_NOW = 718;
const INTERVALS: readonly ValueSeriesInterval[] = ['5m', '1h', '4h', '1d', '1w'];
const DAY_SECONDS = 86_400;

/** The finest candle size whose points fit a chart and whose window to now fits one read; null when none does. */
export function chooseInterval(from: Date, to: Date, now: Date): ValueSeriesInterval | null {
  for (const interval of INTERVALS) {
    const ms = SERIES_TIMEFRAME_MS[interval];
    if ((to.getTime() - from.getTime()) / ms <= MAX_POINTS && (now.getTime() - from.getTime()) / ms <= MAX_CANDLES_TO_NOW) return interval;
  }
  return null;
}

/** The ledger bucket a series reads: the interval itself, up to a day (a week is read in days; weeks start on day edges). */
export function bucketOf(interval: ValueSeriesInterval): LedgerHoldingsHistoryBucket {
  return Math.min(SERIES_TIMEFRAME_MS[interval] / 1000, DAY_SECONDS) as LedgerHoldingsHistoryBucket;
}

/**
 * The moments drawn, on the ledger's grid: the start (the bucket `from` falls in), every interval edge after it, and the
 * end: now when the range runs to now, else the last bucket edge at or before `to`. Null when that leaves no span.
 */
export function gridOf(from: Date, to: Date, now: Date, interval: ValueSeriesInterval): { samples: Date[]; live: boolean } | null {
  const bucketMs = bucketOf(interval) * 1000;
  const frameMs = SERIES_TIMEFRAME_MS[interval];
  const live = to.getTime() >= now.getTime();
  const start = Math.floor(from.getTime() / bucketMs) * bucketMs;
  const end = live ? now.getTime() : Math.floor(to.getTime() / bucketMs) * bucketMs;
  if (!(end > start)) return null;
  const samples = [new Date(start)];
  for (let t = Math.floor(start / frameMs) * frameMs + frameMs; t < end; t += frameMs) samples.push(new Date(t));
  samples.push(new Date(end));
  return { samples, live };
}

type Leg = 'deposits' | 'withdrawals' | 'fees' | 'otherFlows' | null;

/** Which bridge leg a ledger reason feeds: trades and order reservations feed none (they are the market move). */
function legOf(kind: ActivityKind): Leg {
  switch (kind) {
    case 'deposit':
    case 'welcome_funds':
      return 'deposits';
    case 'withdrawal':
      return 'withdrawals';
    case 'fee':
      return 'fees';
    case 'trade':
    case 'order_hold':
    case 'order_release':
      return null;
    default:
      return 'otherFlows';
  }
}

interface Row {
  readonly assetId: string;
  readonly leg: Leg;
  readonly bucketStart: number;
  readonly net: Amount;
  readonly fee: Amount;
}

export interface ValueInputs {
  /** One answer per account owner (main account, then each named Space), all read from the same start and bucket. */
  readonly histories: readonly LedgerHoldingsHistory[];
  readonly interval: ValueSeriesInterval;
  readonly samples: readonly Date[];
  readonly live: boolean;
  /** Each non-dollar coin's candles in the interval's size; null: the coin has no market. */
  readonly closes: ReadonlyMap<string, CloseSeries | null>;
}

/** Every coin that is not a dollar coin, held at any point or moved in the range: the coins a price is read for. */
export function coinsOf(histories: readonly LedgerHoldingsHistory[]): string[] {
  const coins = new Set<string>();
  for (const h of histories) {
    for (const row of h.holdings) coins.add(row.assetId.toUpperCase());
    for (const row of h.movements) coins.add(row.assetId.toUpperCase());
  }
  return [...coins].filter((c) => !PAR_ASSETS.has(c)).sort();
}

export function valueOverTime(input: ValueInputs): BankValueOverTime {
  const { interval, samples, live } = input;
  const bucketMs = bucketOf(interval) * 1000;
  const end = samples[samples.length - 1]!.getTime();

  const now = new Map<string, Amount>();
  const rows: Row[] = [];
  for (const h of input.histories) {
    for (const holding of h.holdings) {
      const assetId = holding.assetId.toUpperCase();
      now.set(assetId, (now.get(assetId) ?? 0n) + parseAmount(holding.amount));
    }
    for (const m of h.movements) {
      const inflow = parseAmount(m.inflow);
      const outflow = parseAmount(m.outflow);
      rows.push({
        assetId: m.assetId.toUpperCase(),
        leg: legOf(classify({ module: m.module, reason: m.reason, direction: inflow >= outflow ? 'debit' : 'credit' })),
        bucketStart: Date.parse(m.bucketStart),
        net: inflow - outflow,
        fee: parseAmount(m.fee),
      });
    }
  }

  const priceAt = (assetId: string, at: number, liveEnd: boolean): Amount | null => {
    if (PAR_ASSETS.has(assetId)) return parseAmount('1');
    const series = input.closes.get(assetId) ?? null;
    return series === null ? null : closeAt(series, interval, at, liveEnd);
  };

  // Holdings at each moment, newest first: from what is held now, take back every movement from that moment on. A live
  // end is the read itself; a past end is a bucket edge, so the rows from it on come off too.
  const byNewest = [...rows].sort((a, b) => b.bucketStart - a.bucketStart);
  const held = new Map(now);
  let next = 0;
  const holdingsAt: Array<Map<string, Amount>> = new Array(samples.length);
  for (let i = samples.length - 1; i >= 0; i--) {
    const t = samples[i]!.getTime();
    const isLiveEnd = live && i === samples.length - 1;
    while (!isLiveEnd && next < byNewest.length && byNewest[next]!.bucketStart >= t) {
      const row = byNewest[next++]!;
      held.set(row.assetId, (held.get(row.assetId) ?? 0n) - row.net);
    }
    holdingsAt[i] = new Map(held);
  }

  const valueOf = (holdings: Map<string, Amount>, at: number, liveEnd: boolean) => {
    let total: Amount = 0n;
    const missing: Array<{ assetId: string; reason: 'no_price' }> = [];
    for (const [assetId, qty] of [...holdings].sort(([a], [b]) => a.localeCompare(b))) {
      if (qty === 0n) continue;
      const price = priceAt(assetId, at, liveEnd);
      if (price === null) missing.push({ assetId, reason: 'no_price' });
      else total += mul(qty, price);
    }
    return { value: missing.length === 0 ? total : null, missing };
  };

  const values = samples.map((at, i) => valueOf(holdingsAt[i]!, at.getTime(), live && i === samples.length - 1));
  const points = samples.map((at, i) => ({
    at: at.toISOString(),
    valueUsd: values[i]!.value === null ? null : formatAmount(values[i]!.value!),
    missing: values[i]!.missing,
  }));

  return {
    from: samples[0]!.toISOString(),
    to: samples[samples.length - 1]!.toISOString(),
    interval,
    points,
    // A past end is a bucket edge: what moved from it on is after the range.
    bridge: bridgeOf(live ? rows : rows.filter((row) => row.bucketStart < end), values[0]!, values[values.length - 1]!, (row) => {
      // A movement is valued by the end of its bucket; the bucket holding now is the live end.
      const bucketEnd = row.bucketStart + bucketMs;
      return bucketEnd >= end ? priceAt(row.assetId, end, live) : priceAt(row.assetId, bucketEnd, false);
    }),
  };
}

function bridgeOf(
  rows: readonly Row[],
  opening: { value: Amount | null; missing: Array<{ assetId: string; reason: 'no_price' }> },
  closing: { value: Amount | null; missing: Array<{ assetId: string; reason: 'no_price' }> },
  priceOf: (row: Row) => Amount | null,
): BankValueBridge {
  const legs = { deposits: 0n, withdrawals: 0n, fees: 0n, otherFlows: 0n };
  const missing = new Map<string, { assetId: string; reason: 'no_price' }>();
  for (const m of [...opening.missing, ...closing.missing]) missing.set(m.assetId, m);
  for (const row of rows) {
    if (row.leg === null && row.fee === 0n) continue;
    const price = priceOf(row);
    if (price === null) {
      missing.set(row.assetId, { assetId: row.assetId, reason: 'no_price' });
      continue;
    }
    if (row.leg === 'deposits') legs.deposits += mul(row.net, price);
    else if (row.leg === 'withdrawals') legs.withdrawals -= mul(row.net, price);
    else if (row.leg === 'fees') legs.fees -= mul(row.net, price);
    else if (row.leg === 'otherFlows') legs.otherFlows += mul(row.net, price);
    // The trading fee taken from a fill's receiving line, in that line's coin.
    legs.fees += mul(row.fee, price);
  }
  const known = missing.size === 0 && opening.value !== null && closing.value !== null;
  const usd = (v: Amount) => (known ? formatAmount(v) : null);
  const marketMove = known ? closing.value! - opening.value! - legs.deposits + legs.withdrawals + legs.fees - legs.otherFlows : 0n;
  return {
    openingUsd: opening.value === null ? null : formatAmount(opening.value),
    depositsUsd: usd(legs.deposits),
    withdrawalsUsd: usd(legs.withdrawals),
    feesUsd: usd(legs.fees),
    otherFlowsUsd: usd(legs.otherFlows),
    marketMoveUsd: usd(marketMove),
    closingUsd: closing.value === null ? null : formatAmount(closing.value),
    missing: [...missing.values()].sort((a, b) => a.assetId.localeCompare(b.assetId)),
  };
}
