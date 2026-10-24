/**
 * Pure futures maths for the Futures and Margin rooms. Money is an exact scaled bigint (data/decimal.ts), never a JS number.
 * Unknown input gives `null`, never 0: a position without a published maintenance margin has no health figure.
 *
 * Nothing here predicts what the service will do. The service owns the liquidation price, the margin it will take and the
 * fee; these helpers only add, compare and describe what the service already published (TRFUT-SPEC §2).
 */
import type { Position } from '@intafaced/exchange-contract/schemas';
import {
  dec,
  decOrNull,
  ratio,
  sub,
  add,
  times,
  toFixedString,
  ZERO,
  compare,
  str,
  compareDecimal,
  roundScaled,
  type Scaled,
} from '../../../data/decimal';

export type Band = 'ok' | 'watch' | 'danger' | 'liquidation' | 'unknown';
export type PositionState = 'open' | 'closing' | 'closed' | 'liquidated' | 'unknown';

/** Binance Margin Ratio bands: maintenance / equity, liquidation at 100%, "stay below 80%" (LANDSCAPE A.1.2). */
export const BAND_WATCH_PCT = 50n;
export const BAND_DANGER_PCT = 80n;

export function stateOf(position: Position): PositionState {
  return position.status === 'open' || position.status === 'closing' || position.status === 'closed' || position.status === 'liquidated'
    ? position.status
    : 'unknown';
}

/** A position the customer can still act on. */
export function isLive(position: Position): boolean {
  const state = stateOf(position);
  return state === 'open' || state === 'closing';
}

export interface Health {
  /** Maintenance margin as a percent of equity at 2 places ("37.50"); null when not computable. */
  marginRatioPct: string | null;
  /** Equity (collateral + unrealised PnL) as an exact decimal. */
  equity: string | null;
  band: Band;
  /** Why the figure is unknown, in a short phrase for a tooltip; null when known. */
  unknownWhy: 'maintenance' | 'collateral' | 'pnl' | 'equity' | null;
}

/**
 * Margin ratio = maintenance margin / (collateral + unrealised PnL). At or above 100% the position is liquidatable.
 * Needs three published fields; any missing one is "unknown" and says which.
 */
export function healthOf(position: Position): Health {
  const maintenance = dec(position.maintenanceMargin);
  const collateral = dec(position.collateral);
  const pnl = dec(position.unrealizedPnl);
  if (collateral === null) return { marginRatioPct: null, equity: null, band: 'unknown', unknownWhy: 'collateral' };
  if (pnl === null) return { marginRatioPct: null, equity: null, band: 'unknown', unknownWhy: 'pnl' };
  const equity = add(collateral, pnl);
  if (maintenance === null) return { marginRatioPct: null, equity: str(equity), band: 'unknown', unknownWhy: 'maintenance' };
  if (equity <= ZERO) return { marginRatioPct: '100.00', equity: str(equity), band: 'liquidation', unknownWhy: null };
  const r = ratio(maintenance, equity);
  if (r === null) return { marginRatioPct: null, equity: str(equity), band: 'unknown', unknownWhy: 'equity' };
  const pct = times(r, 100n * 10n ** 18n);
  const whole = pct / 10n ** 18n;
  const band: Band = whole >= 100n ? 'liquidation' : whole >= BAND_DANGER_PCT ? 'danger' : whole >= BAND_WATCH_PCT ? 'watch' : 'ok';
  return { marginRatioPct: toFixedString(pct, 2), equity: str(equity), band, unknownWhy: null };
}

/** Distance from the mark to the liquidation price, as a percent of the mark at 2 places. Null when either is unknown. */
export function liquidationDistancePct(position: Position): string | null {
  const mark = dec(position.markPrice);
  const liq = dec(position.liquidationPrice);
  if (mark === null || liq === null || mark <= ZERO) return null;
  const gap = position.side === 'long' ? sub(mark, liq) : sub(liq, mark);
  const r = ratio(gap, mark);
  return r === null ? null : toFixedString(times(r, 100n * 10n ** 18n), 2);
}

export interface Totals {
  count: number;
  collateral: string | null;
  unrealizedPnl: string | null;
  /** Worst band across positions; unknown only when no position has a known band. */
  worst: Band;
}

const bandRank: Record<Band, number> = { unknown: 0, ok: 1, watch: 2, danger: 3, liquidation: 4 };

/** Sums over live positions. A total whose parts include an unknown is null, not a partial sum. */
export function totalsOf(positions: readonly Position[]): Totals {
  const live = positions.filter(isLive);
  let collateral: Scaled | null = ZERO;
  let pnl: Scaled | null = ZERO;
  let worst: Band = 'unknown';
  for (const p of live) {
    const c = dec(p.collateral);
    const u = dec(p.unrealizedPnl);
    collateral = collateral === null || c === null ? null : add(collateral, c);
    pnl = pnl === null || u === null ? null : add(pnl, u);
    const band = healthOf(p).band;
    if (bandRank[band] > bandRank[worst]) worst = band;
  }
  return { count: live.length, collateral: decOrNull(collateral), unrealizedPnl: decOrNull(pnl), worst };
}

export interface PreviewCost {
  orderValue: string | null;
  initialMargin: string | null;
  estimatedFee: string | null;
  /** Initial margin + fee: what leaves the free balance now. Null if either part is unknown. */
  totalToCommit: string | null;
  /** Free balance minus total to commit; may be negative. Null if either is unknown. */
  freeAfter: string | null;
  insufficient: boolean | null;
}

export function allInCost(
  preview: { orderValue: string | null; initialMargin: string | null; estimatedFee: string | null } | null,
  freeBalance: string | null,
): PreviewCost {
  const margin = dec(preview?.initialMargin);
  const fee = dec(preview?.estimatedFee);
  const total = margin === null || fee === null ? null : add(margin, fee);
  const free = dec(freeBalance);
  const after = total === null || free === null ? null : sub(free, total);
  return {
    orderValue: preview?.orderValue ?? null,
    initialMargin: preview?.initialMargin ?? null,
    estimatedFee: preview?.estimatedFee ?? null,
    totalToCommit: decOrNull(total),
    freeAfter: decOrNull(after),
    insufficient: after === null ? null : after < ZERO,
  };
}

/**
 * Funding payment estimate for the next period: notional x rate. A positive rate means longs pay shorts, so a long
 * shows a negative number. Null if the rate or the notional is unknown. It is an estimate and the screen says so.
 */
export function fundingEstimate(position: Position, rate: string | null): string | null {
  const r = dec(rate);
  const n = dec(position.notional);
  if (r === null || n === null) return null;
  const pay = times(n, r);
  return str(position.side === 'long' ? sub(ZERO, pay) : pay);
}

/** Size that the free balance could carry at the given leverage and mark (estimate; the service preview decides). */
export function maxSizeEstimate(freeBalance: string | null, leverage: string | null, mark: string | null): string | null {
  const free = dec(freeBalance);
  const lev = dec(leverage);
  const m = dec(mark);
  if (free === null || lev === null || m === null || lev <= ZERO || m <= ZERO || free <= ZERO) return null;
  const q = ratio(times(free, lev), m);
  return q === null ? null : str(roundScaled(q, 6, 'down'));
}

/** `pct`% of a size, truncated to `places` so the size never exceeds the estimate. */
export function percentOfSize(size: string | null, pct: number, places: number): string | null {
  const s = dec(size);
  if (s === null || !Number.isInteger(pct) || pct < 0 || pct > 100) return null;
  const part = (s * BigInt(pct)) / 100n;
  const unit = 10n ** BigInt(18 - Math.max(0, Math.min(18, places)));
  return str((part / unit) * unit);
}

/** Preset leverage buttons clipped to the published cap; none when the cap is unknown. */
export function leveragePresets(cap: string | null, presets: readonly number[] = [1, 2, 3, 5, 10, 20, 50]): string[] {
  const c = dec(cap);
  if (c === null) return [];
  return presets.filter((x) => compare(BigInt(x) * 10n ** 18n, c) <= 0).map(String);
}

/** Age check for a poll result. `asOf` and `now` are epoch ms. Unknown age is stale: never claim fresh without a time. */
export function isStale(asOf: number | null | undefined, now: number, limitMs: number): boolean {
  return asOf === null || asOf === undefined || now - asOf > limitMs;
}

/** Stable order so rows do not jump while the trader is aiming (Kraken Pro complaint, LANDSCAPE A.8): oldest open first. */
export function stableOrder(positions: readonly Position[]): Position[] {
  return [...positions].sort((a, b) => a.timestamp - b.timestamp || (a.id ?? '').localeCompare(b.id ?? ''));
}

/** Positions "Close all" would send, in the order they would be sent. Closing ones are included: the same key is re-sent. */
export function closeAllPlan(positions: readonly Position[]): Position[] {
  return stableOrder(positions.filter((p) => isLive(p) && p.id !== null));
}

/** Health in basis points from a delivered margin call, as a percent at 2 places ("62.50"). */
export function bpsToPct(bps: number): string {
  return toFixedString(BigInt(Math.trunc(bps)) * 10n ** 16n, 2);
}

/** The request identity for a margin/leverage change: stable for one intent, new for a new intent. */
export function adjustmentId(kind: 'margin-add' | 'margin-reduce' | 'leverage', positionId: string, value: string, nonce: string): string {
  return `${kind}:${positionId}:${value}:${nonce}`.slice(0, 120);
}

/** Open and close identities. Close is the service's stable key shape so a retry returns the original result. */
export function openId(nonce: string): string {
  return `open:${nonce}`.slice(0, 64);
}

/** A reduce-only order's own key: it can never open, so it is not keyed as an open. */
export function reduceId(nonce: string): string {
  return `reduce:${nonce}`.slice(0, 64);
}

/** The most at-risk live position: highest band, then highest margin ratio. Unknown when no live position has a known band. */
export function worstHealth(positions: readonly Position[]): Health & { positionId: string | null } {
  let worst: (Health & { positionId: string | null }) | null = null;
  for (const p of positions.filter(isLive)) {
    const h = healthOf(p);
    const better =
      worst === null ||
      bandRank[h.band] > bandRank[worst.band] ||
      (h.band === worst.band && compareDecimal(h.marginRatioPct, worst.marginRatioPct) === 1);
    if (better) worst = { ...h, positionId: p.id };
  }
  return worst ?? { marginRatioPct: null, equity: null, band: 'unknown', unknownWhy: null, positionId: null };
}
