/**
 * Execution room arithmetic: the schedule plan, the scaled ladder, the iceberg review, client ids and the blotter.
 * Pure and React-free. Money is a decimal string in and out (exact scaled bigint in between); counts and milliseconds are
 * plain numbers. Unknown is `null`, never zero. These numbers are what the room shows before anything is sent; the
 * service stays the authority and may round or refuse differently.
 */
import type { Order } from '../../../features/trade/trade-api';
import { add, dec, ratio, str, sub, times } from '../../../data/decimal';
import { floorToStep, minus, notional, onStep, positive, priceLadder, splitEqual, splitWeighted } from '../rooms/math';
import type { BatchItem } from '../rooms/api';
import type { Pending } from '../buy/write-lock';

export type Side = 'buy' | 'sell';

/* ------------------------------------------------------------------ create blocker */

export type CreateBlocker = 'Scheduler unknown' | 'Scheduler off block' | 'Market closed block';

/**
 * Why the schedule form cannot be sent, as its copy key, or null. An unread policy or a stopped slice scheduler blocks
 * first: a schedule created then would sit active and place nothing.
 */
export function createBlocker(jobsEnabled: boolean | null, marketOpen: boolean): CreateBlocker | null {
  if (jobsEnabled === null) return 'Scheduler unknown';
  if (!jobsEnabled) return 'Scheduler off block';
  return marketOpen ? null : 'Market closed block';
}

/* ------------------------------------------------------------------ client ids */

/** A short random token that names one intent. It is made once per intent, so a re-send reuses the same ids. */
export function newNonce(): string {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 12);
}
export const algoClientId = (nonce: string): string => `algo-${nonce}`;
export const SCALED_TAG = 'scl-';
export const scaledPrefix = (nonce: string): string => `${SCALED_TAG}${nonce}-`;
export const scaledId = (nonce: string, index: number): string => `${scaledPrefix(nonce)}${index}`;
export const matchesPrefix = (clientOrderId: string | null | undefined, prefix: string): boolean =>
  Boolean(clientOrderId) && clientOrderId!.startsWith(prefix);
export const isScaledId = (clientOrderId: string | null | undefined): boolean => matchesPrefix(clientOrderId, SCALED_TAG);
/** `scl-<nonce>-` of an id placed by this room, or null for any other id. */
export function scaledGroupOf(clientOrderId: string | null | undefined): string | null {
  const found = /^(scl-[A-Za-z0-9]+-)\d+$/.exec(clientOrderId ?? '');
  return found ? found[1]! : null;
}

/**
 * The device note `trade-pending:<user>` is shared with the spot desk, Buy and Convert. A room's "Check status" may release
 * only the note it wrote itself: scaled batches (`place` with a `scl-` id), algo requests, and single-order cancels.
 * Anything else keeps its lock until the screen that owns it checks it.
 */
export function ownsNote(room: 'scaled' | 'algo' | 'execCancel', pending: Pick<Pending, 'kind' | 'id'>): boolean {
  if (room === 'scaled') return pending.kind === 'place' && pending.id.startsWith(SCALED_TAG);
  if (room === 'algo') return pending.kind === 'algo';
  return pending.kind === 'cancel';
}

/* ------------------------------------------------------------------ schedule (TWAP, VWAP, POV) */

/** The room refuses a plan with more slices than this, so one typo cannot ask for thousands of child orders. */
export const MAX_SLICES = 500;
export const MIN_DURATION_MS = 1_000;
export const MAX_DURATION_MS = 86_400_000;
export const DURATION_PRESETS: ReadonlyArray<{ id: '5m' | '15m' | '1h' | '4h'; ms: number }> = [
  { id: '5m', ms: 300_000 },
  { id: '15m', ms: 900_000 },
  { id: '1h', ms: 3_600_000 },
  { id: '4h', ms: 14_400_000 },
];

/** Twelve slices, on whole seconds, never longer than the schedule itself. */
export function defaultIntervalMs(durationMs: number): number {
  const wholeSeconds = Math.floor(durationMs / 12 / 1000) * 1000;
  return Math.min(durationMs, Math.max(1000, wholeSeconds));
}

export type PlanProblem =
  'total' | 'lot' | 'duration' | 'interval' | 'tooManySlices' | 'sliceTooSmall' | 'sliceBelowMin' | 'limit' | 'participation';

export interface PlanDraft {
  kind: 'twap' | 'vwap' | 'pov';
  total: string;
  durationMs: number | null;
  intervalMs: number | null;
  lot: string | null;
  tick: string | null;
  minAmount: string | null;
  /** Empty text means no limit: slices go in at the market. */
  limit: string;
  last: string | null;
  taker: string | null;
  participationBps: number | null;
  startMs: number;
}

export interface Plan {
  slices: number;
  perSlice: string;
  lastSlice: string;
  endsAt: number;
  /** Estimate at the limit price, else at the last price. Not a quote. */
  estNotional: string | null;
  /** Upper estimate: the whole estimate at the taker rate. */
  estFee: string | null;
}

export function planSchedule(draft: PlanDraft): { plan: Plan | null; problems: PlanProblem[] } {
  const problems: PlanProblem[] = [];
  const total = positive(draft.total);
  if (total === null) problems.push('total');
  else if (draft.lot !== null && !onStep(draft.total, draft.lot)) problems.push('lot');
  const { durationMs, intervalMs } = draft;
  if (durationMs === null || durationMs < MIN_DURATION_MS || durationMs > MAX_DURATION_MS) problems.push('duration');
  if (intervalMs === null || intervalMs < MIN_DURATION_MS || (durationMs !== null && intervalMs > durationMs)) problems.push('interval');
  if (draft.limit.trim() !== '') {
    const limit = positive(draft.limit);
    if (limit === null || (draft.tick !== null && !onStep(draft.limit, draft.tick))) problems.push('limit');
  }
  if (draft.kind === 'pov' && (draft.participationBps === null || draft.participationBps < 1 || draft.participationBps > 10_000))
    problems.push('participation');
  if (problems.length > 0 || durationMs === null || intervalMs === null) return { plan: null, problems };

  const slices = Math.ceil(durationMs / intervalMs);
  if (slices > MAX_SLICES) return { plan: null, problems: ['tooManySlices'] };
  const parts = draft.lot === null ? null : splitEqual(draft.total, slices, draft.lot);
  if (parts === null) return { plan: null, problems: ['sliceTooSmall'] };
  if (draft.minAmount !== null && parts.some((p) => dec(p)! < (dec(draft.minAmount) ?? 0n)))
    return { plan: null, problems: ['sliceBelowMin'] };
  const at = draft.limit.trim() !== '' ? draft.limit : draft.last;
  const estNotional = notional(at, draft.total);
  const rate = dec(draft.taker);
  const base = dec(estNotional);
  return {
    problems,
    plan: {
      slices,
      perSlice: parts[0]!,
      lastSlice: parts[parts.length - 1]!,
      endsAt: draft.startMs + durationMs,
      estNotional,
      estFee: rate === null || base === null ? null : str(times(base, rate)),
    },
  };
}

/* ------------------------------------------------------------------ iceberg */

export type IcebergProblem = 'total' | 'display' | 'displayTooBig' | 'lot' | 'price';

export interface IcebergReview {
  problems: IcebergProblem[];
  visible: string | null;
  hidden: string | null;
  /** ceil(total / display), a whole number as text. */
  refills: string | null;
  /** Limit price x total. */
  hold: string | null;
  /** One fifteenth of the total, down to the lot: a venue reference (Kraken), not a platform rule. */
  referenceMin: string | null;
}

export function reviewIceberg(input: {
  total: string;
  display: string;
  price: string;
  lot: string | null;
  tick: string | null;
}): IcebergReview {
  const problems: IcebergProblem[] = [];
  const total = positive(input.total);
  const display = positive(input.display);
  const price = positive(input.price);
  if (total === null) problems.push('total');
  if (display === null) problems.push('display');
  else if (total !== null && display >= total) problems.push('displayTooBig');
  if (price === null || (input.tick !== null && !onStep(input.price, input.tick))) problems.push('price');
  if (
    input.lot !== null &&
    ((total !== null && !onStep(input.total, input.lot)) || (display !== null && !onStep(input.display, input.lot)))
  )
    problems.push('lot');
  const ok = total !== null && display !== null && display < total;
  return {
    problems,
    visible: ok ? input.display : null,
    hidden: ok ? minus(input.total, input.display) : null,
    refills: ok ? ((total + display - 1n) / display).toString() : null,
    hold: price !== null && total !== null ? notional(input.price, input.total) : null,
    referenceMin: total !== null && input.lot !== null ? floorToStep(str(total / 15n), input.lot) : null,
  };
}

/* ------------------------------------------------------------------ scaled ladder */

export type Distribution = 'equal' | 'ascending' | 'descending' | 'ratio';
export type LadderProblem = 'total' | 'lot' | 'count' | 'range' | 'samePrices' | 'tooSmall' | 'ratio';

export interface LadderInput {
  side: Side;
  total: string;
  count: number | null;
  start: string;
  end: string;
  distribution: Distribution;
  /** Last size over first size, a whole number 1-100, for the ratio distribution. */
  ratio: number | null;
  tick: string | null;
  lot: string | null;
  minAmount: string | null;
  minCost: string | null;
  taker: string | null;
  maker: string | null;
  freeQuote: string | null;
  freeBase: string | null;
}

export interface LadderRow {
  index: number;
  price: string;
  size: string;
  notional: string;
  cumSize: string;
  /** Quote asset for a buy, base asset for a sell. */
  cumHold: string;
  belowMin: boolean;
}

export interface Ladder {
  rows: LadderRow[];
  totalSize: string;
  totalNotional: string;
  avgPrice: string | null;
  holdAsset: 'quote' | 'base';
  hold: string;
  feeMaker: string | null;
  feeTaker: string | null;
  /** The part of the last order that comes from lot rounding of the others (equal split only reads 0 when it divides). */
  residual: string | null;
  freeAfter: string | null;
  short: boolean;
}

export const MIN_ORDERS = 2;
export const MAX_ORDERS = 100;

function weightsOf(input: LadderInput, count: number): number[] | null {
  if (input.distribution === 'equal') return null;
  const up = Array.from({ length: count }, (_, i) => i + 1);
  if (input.distribution === 'ascending') return up;
  if (input.distribution === 'descending') return up.reverse();
  const r = input.ratio ?? 0;
  // Linear from 1 to r, scaled to whole numbers: weight i = (n-1) + (r-1)*i keeps the last/first ratio exactly r.
  return Array.from({ length: count }, (_, i) => count - 1 + (r - 1) * i);
}

export function buildLadder(input: LadderInput): { ladder: Ladder | null; problems: LadderProblem[] } {
  const problems: LadderProblem[] = [];
  const total = positive(input.total);
  if (total === null) problems.push('total');
  else if (input.lot !== null && !onStep(input.total, input.lot)) problems.push('lot');
  const count = input.count;
  if (count === null || count < MIN_ORDERS || count > MAX_ORDERS) problems.push('count');
  if (positive(input.start) === null || positive(input.end) === null) problems.push('range');
  if (input.distribution === 'ratio' && (input.ratio === null || input.ratio < 1 || input.ratio > 100)) problems.push('ratio');
  if (problems.length > 0 || count === null || input.lot === null || input.tick === null) return { ladder: null, problems };

  const prices = priceLadder(input.start, input.end, count, input.tick);
  if (prices === null) return { ladder: null, problems: ['range'] };
  if (new Set(prices).size < prices.length) return { ladder: null, problems: ['samePrices'] };
  const weights = weightsOf(input, count);
  const sizes = weights === null ? splitEqual(input.total, count, input.lot) : splitWeighted(input.total, weights, input.lot);
  if (sizes === null) return { ladder: null, problems: ['tooSmall'] };

  const min = dec(input.minAmount);
  const minCost = dec(input.minCost);
  let cumSize = 0n;
  let cumNotional = 0n;
  const rows: LadderRow[] = prices.map((price, i) => {
    const size = dec(sizes[i])!;
    const value = times(dec(price)!, size);
    cumSize = add(cumSize, size);
    cumNotional = add(cumNotional, value);
    return {
      index: i + 1,
      price,
      size: sizes[i]!,
      notional: str(value),
      cumSize: str(cumSize),
      cumHold: str(input.side === 'buy' ? cumNotional : cumSize),
      belowMin: (min !== null && size < min) || (minCost !== null && value < minCost),
    };
  });

  const maker = dec(input.maker);
  const taker = dec(input.taker);
  const holdAsset = input.side === 'buy' ? 'quote' : 'base';
  const hold = input.side === 'buy' ? cumNotional : cumSize;
  const free = dec(holdAsset === 'quote' ? input.freeQuote : input.freeBase);
  const lastShare =
    weights === null ? total! / BigInt(count) : (total! * BigInt(weights[count - 1]!)) / BigInt(weights.reduce((a, b) => a + b, 0));
  const lot = dec(input.lot)!;
  return {
    problems,
    ladder: {
      rows,
      totalSize: str(cumSize),
      totalNotional: str(cumNotional),
      avgPrice: (() => {
        const r = ratio(cumNotional, cumSize);
        return r === null ? null : str(r);
      })(),
      holdAsset,
      hold: str(hold),
      feeMaker: maker === null ? null : str(times(cumNotional, maker)),
      feeTaker: taker === null ? null : str(times(cumNotional, taker)),
      residual: str(sub(dec(sizes[count - 1])!, (lastShare / lot) * lot)),
      freeAfter: free === null ? null : str(sub(free, hold)),
      short: free !== null && free < hold,
    },
  };
}

/* ------------------------------------------------------------------ scaled results and recovery */

export interface BatchSummary {
  placed: number;
  refused: number;
  unknown: number;
}

export function summarizeBatch(results: readonly BatchItem[]): BatchSummary {
  return {
    placed: results.filter((r) => r.status === 'success').length,
    refused: results.filter((r) => r.status === 'refused').length,
    unknown: results.filter((r) => r.status === 'unknown').length,
  };
}

export interface GroupOrder {
  index: number;
  clientOrderId: string;
  order: Order | null;
}

/** Which of the `count` orders of one ladder the service has, read by id from the open and closed lists. */
export function findGroup(nonce: string, count: number, lists: ReadonlyArray<readonly Order[]>): GroupOrder[] {
  const all = lists.flat();
  return Array.from({ length: count }, (_, i) => {
    const clientOrderId = scaledId(nonce, i + 1);
    return { index: i + 1, clientOrderId, order: all.find((o) => o.clientOrderId === clientOrderId) ?? null };
  });
}

export const isLive = (order: Order): boolean => order.status === 'open' || order.recoveryRequired;

/** A whole number typed as digits (a count or a number of seconds). Anything else is null. */
export function wholeNumber(text: string): number | null {
  return /^\d{1,7}$/.test(text.trim()) ? parseInt(text.trim(), 10) : null;
}
