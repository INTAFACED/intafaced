/**
 * PURE ARITHMETIC FOR FUTURES ORDERS THROUGH svc-matching (futures ADR slice 6, phase 1).
 *
 * docs/adr/2026-10-20-futures-matched-traders.md sections 1 and 8. Nothing here posts, reads a row or calls the
 * engine: it turns a mark, a band, a limit and a fill into the amounts the margin book posts.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE ROUNDING IS CHOSEN SO A HOLD CAN NEVER BE SHORT
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * An order's margin need is a function of its CUMULATIVE filled quantity `F` and its cumulative adverse
 * distance `N` (the sum of `qty × adverse(fillPrice)`, kept exact at scale 10^36):
 *
 *   need(F, N) = initialMargin(F, mark, leverage) + ceil(N / SCALE)
 *
 * Each fill posts `need(after) − need(before)`. Those differences telescope, so the sum of every fill's post is
 * exactly `need(total filled, total adverse)`. The hold is `need(qty, qty × adverse(limit))`, and because every
 * fill prices within its own limit, `N ≤ qty × adverse(limit)` and `need(total) ≤ hold` at every step. No
 * per-fill rounding is summed, so no fill can ask the hold for a unit it does not have.
 *
 * `adverse(side, price, mark)` is the distance the trader would lose at the mark if the fill were marked against
 * them: `max(0, price − mark)` for a buy and `max(0, mark − price)` for a sell. A fill at the mark owes only the
 * initial margin; a fill at a better price than its limit owes less than the hold, and the rest is released when
 * the order is finished.
 */
import { SCALE, parseAmount, type Amount } from '@intafaced/ledger-client';
import { initialMargin } from './initial-margin.js';

export { SCALE };

export type OrderSide = 'buy' | 'sell';

/** Refused when the owner has not named a band. Never invented. */
export const FUTURES_PRICE_BAND_UNSET = 'trade.futures_price_band_unset' as const;

/**
 * The owner's band: a fraction of the mark, as a decimal string. Empty means unset. A value that is not a
 * fraction strictly between 0 and 1 is a typo somebody made, and it is an error at boot, not a silent default.
 */
export function parsePriceBand(raw: string | undefined | null): Amount | null {
  const text = (raw ?? '').trim();
  if (text === '') return null;
  const band = parseAmount(text);
  if (band <= 0n || band >= SCALE) {
    throw new Error('TRADE_FUTURES_PRICE_BAND must be a decimal fraction above 0 and below 1, or empty');
  }
  return band;
}

export interface PriceBand {
  readonly low: Amount;
  readonly high: Amount;
}

/** The band around the mark. `low` is strictly positive whenever the band is below 1. */
export function priceBandAround(mark: Amount, band: Amount): PriceBand {
  const delta = (mark * band) / SCALE;
  return { low: mark - delta, high: mark + delta };
}

export function limitWithinBand(limit: Amount, band: PriceBand): boolean {
  return limit >= band.low && limit <= band.high;
}

/** A market order is an IOC limit at the band edge on its own side, so it never fills outside the band. */
export function protectiveLimit(side: OrderSide, band: PriceBand): Amount {
  return side === 'buy' ? band.high : band.low;
}

/** How far a price is worse than the mark for this side. Zero when it is at or better than the mark. */
export function adverseDistance(side: OrderSide, price: Amount, mark: Amount): Amount {
  if (side === 'buy') return price > mark ? price - mark : 0n;
  return mark > price ? mark - price : 0n;
}

/** A fill prices within its own order's limit: at or below a buy limit, at or above a sell limit. */
export function fillWithinLimit(side: OrderSide, price: Amount, limit: Amount): boolean {
  return side === 'buy' ? price <= limit : price >= limit;
}

/** `qty × adverse(price)`, exact, at scale 10^36. */
export function adverseNumerator(side: OrderSide, qty: Amount, price: Amount, mark: Amount): bigint {
  return qty * adverseDistance(side, price, mark);
}

export interface MarginNeedInput {
  /** Cumulative filled quantity, scaled. */
  readonly filled: Amount;
  /** Cumulative `qty × adverse`, at scale 10^36. */
  readonly adverseNum: bigint;
  readonly mark: Amount;
  readonly leverage: Amount;
}

/** Margin the cumulative fills need at the mark, with the adverse distance on top. Monotone in both inputs. */
export function marginNeed(input: MarginNeedInput): Amount {
  if (input.filled === 0n) return 0n;
  const initial = initialMargin({ size: input.filled, entryPrice: input.mark, leverage: input.leverage });
  const adverse = (input.adverseNum + SCALE - 1n) / SCALE;
  return initial + adverse;
}

/** The whole hold for an order of `qty` resting at `limit`. */
export function orderHoldAmount(input: { side: OrderSide; qty: Amount; limit: Amount; mark: Amount; leverage: Amount }): Amount {
  return marginNeed({
    filled: input.qty,
    adverseNum: adverseNumerator(input.side, input.qty, input.limit, input.mark),
    mark: input.mark,
    leverage: input.leverage,
  });
}

export interface FillMarginResult {
  /** New cumulative filled quantity. */
  readonly filled: Amount;
  /** New cumulative adverse numerator. */
  readonly adverseNum: bigint;
  /** New cumulative margin need. */
  readonly need: Amount;
  /** What this fill moves from the order hold into the position's collateral. Never negative. */
  readonly amount: Amount;
}

/** The margin one fill moves, from the order's cumulative state before it. */
export function fillMargin(
  before: { filled: Amount; adverseNum: bigint },
  fill: { side: OrderSide; qty: Amount; price: Amount; mark: Amount; leverage: Amount },
): FillMarginResult {
  const filled = before.filled + fill.qty;
  const adverseNum = before.adverseNum + adverseNumerator(fill.side, fill.qty, fill.price, fill.mark);
  const need = marginNeed({ filled, adverseNum, mark: fill.mark, leverage: fill.leverage });
  const previous = marginNeed({ filled: before.filled, adverseNum: before.adverseNum, mark: fill.mark, leverage: fill.leverage });
  if (need < previous) throw new Error('futures order margin need fell on a fill — the rounding invariant is broken');
  return { filled, adverseNum, need, amount: need - previous };
}

/** Entry price after a fill: the size-weighted average, floored, as `storedEntryAfterFill` does. */
export function weightedEntry(position: { size: Amount; entryPrice: Amount }, fill: { qty: Amount; price: Amount }): Amount {
  if (position.size === 0n) return fill.price;
  return (position.size * position.entryPrice + fill.qty * fill.price) / (position.size + fill.qty);
}
