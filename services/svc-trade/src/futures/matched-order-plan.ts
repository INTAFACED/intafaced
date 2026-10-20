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
import { SCALE, parseAmount, recipes, type Amount, type PostRequest } from '@intafaced/ledger-client';
import { proportionalCloseFigures } from './desk-quantity.js';
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

// ─────────────────────────────────────────────────────────────────────────────
// REDUCE-ONLY ORDERS (futures ADR slice 6b)
// ─────────────────────────────────────────────────────────────────────────────

export type PositionSide = 'long' | 'short';

/** The order side that shrinks a position: a sell reduces a long, a buy reduces a short. */
export function reducingSide(position: PositionSide): OrderSide {
  return position === 'long' ? 'sell' : 'buy';
}

/**
 * The position's bankruptcy price: where its loss equals its margin (ADR section 1).
 *
 * `margin × SCALE / size` is the distance, floored, so the price is rounded TOWARD the entry: up for a long, down
 * for a short. The loss at the rounded price is then at most the margin, never a unit more. A long whose margin is
 * at least its notional has no bankruptcy price above zero; zero is returned and any positive price is inside it.
 */
export function bankruptcyPrice(position: { side: PositionSide; size: Amount; entryPrice: Amount; margin: Amount }): Amount {
  if (position.size <= 0n) throw new Error('bankruptcy price of an empty position');
  if (position.margin < 0n) throw new Error('bankruptcy price of a position with negative margin');
  const distance = (position.margin * SCALE) / position.size;
  if (position.side === 'short') return position.entryPrice + distance;
  return position.entryPrice > distance ? position.entryPrice - distance : 0n;
}

/** A reduce price is inside the bound when it is at or above a long's bankruptcy price, at or below a short's. */
export function withinBankruptcy(position: PositionSide, price: Amount, bankruptcy: Amount): boolean {
  return position === 'long' ? price >= bankruptcy : price <= bankruptcy;
}

/**
 * The limit a market reduce gets: the band edge on its own side, pulled in to the bankruptcy price when that is
 * nearer. Null when the bankruptcy price lies beyond the far edge of the band, so no price inside the band is
 * inside the bound either.
 */
export function marketReduceLimit(position: PositionSide, band: PriceBand, bankruptcy: Amount): Amount | null {
  if (position === 'long') {
    const limit = bankruptcy > band.low ? bankruptcy : band.low;
    return limit <= band.high ? limit : null;
  }
  const limit = bankruptcy < band.high ? bankruptcy : band.high;
  return limit >= band.low ? limit : null;
}

/**
 * What one reduce fill does to its position, in the margin book's terms.
 *
 * The realised PnL is `proportionalCloseFigures`, the same formula a partial close at the mark posts (floor on the
 * true value: a gain credited down, a loss charged up), here at the fill price.
 *
 * The margin split differs from the partial close in one direction only: the remainder keeps the CEILING of its
 * proportional share, so a fill whose loss fits its own share never lowers the margin per unit left on the
 * position, and the bankruptcy price a resting reduce order was bounded by stays valid. A loss bigger than the
 * slice's share (the charge-up rounding at the bound, one unit) is taken from the remainder's margin, never from the
 * insurance fund.
 *
 * THE ROUNDING AT THE BOUND. Each such fill can leave the remainder one unit (10^-18) short of its own loss at the
 * bound, so after `k` of them a fill exactly at the bound can owe up to `k` units more than the whole margin. The
 * bound promises the trader that a reduce inside it never loses more than the margin (ADR section 1), so that much
 * is not booked: `roundingAllowance` is how many earlier reduce fills the position has had, and an excess within it
 * is `unbooked`, never drawn from insurance. A bigger excess is a real loss past the bound (the margin fell after the
 * order was placed) and is left as `fromInsurance` for the caller to bound against the fund's live balance.
 */
export interface ReduceFillPlan {
  readonly realizedPnl: Amount;
  readonly profit: Amount;
  /** Loss paid from the position's collateral pot into the clearing pot. */
  readonly fromMargin: Amount;
  /** Loss beyond the whole margin and beyond the rounding allowance: a real loss past the bound. */
  readonly fromInsurance: Amount;
  /** Charge-up rounding beyond the whole margin, at most `roundingAllowance` units, not booked. */
  readonly unbooked: Amount;
  /** Margin returned from the pot to the trader's available balance. */
  readonly release: Amount;
  /** Everything that leaves the collateral pot: `fromMargin + release`. */
  readonly potOut: Amount;
  /** What `margin_initial` loses. */
  readonly initialOut: Amount;
  readonly remainQty: Amount;
  readonly remainMargin: Amount;
  readonly remainInitial: Amount;
  /** The fill takes the whole position: the row closes. */
  readonly closes: boolean;
}

export function planReduceFill(input: {
  side: PositionSide;
  size: Amount;
  entryPrice: Amount;
  margin: Amount;
  marginInitial: Amount;
  qty: Amount;
  price: Amount;
  /** Units of rounding past the whole margin left unbooked: the number of earlier reduce fills on the position. */
  roundingAllowance?: bigint;
}): ReduceFillPlan {
  if (input.qty <= 0n || input.qty > input.size) throw new Error('a reduce fill must take a slice of its position');
  if (input.price <= 0n) throw new Error('a reduce fill needs a positive price');
  if (input.margin < 0n || input.marginInitial < 0n) throw new Error('a position margin is never negative');
  const figures = proportionalCloseFigures({
    side: input.side,
    size: input.size,
    closeQty: input.qty,
    entryPrice: input.entryPrice,
    exitPrice: input.price,
    margin: input.margin,
    marginInitial: input.marginInitial,
  });
  const remainQty = figures.remainQty;
  const remainShare = remainQty === 0n ? 0n : (input.margin * remainQty + input.size - 1n) / input.size;
  const slice = input.margin - remainShare;
  const pnl = figures.realizedPnl;

  let profit = 0n;
  let fromMargin = 0n;
  let fromInsurance = 0n;
  let unbooked = 0n;
  let release = slice;
  let remainMargin = remainShare;
  if (pnl > 0n) {
    profit = pnl;
  } else if (pnl < 0n) {
    const loss = -pnl;
    if (loss <= slice) {
      fromMargin = loss;
      release = slice - loss;
    } else {
      fromMargin = loss < input.margin ? loss : input.margin;
      const excess = loss - fromMargin;
      const allowance = input.roundingAllowance ?? 0n;
      if (excess <= allowance) unbooked = excess;
      else fromInsurance = excess;
      release = 0n;
      remainMargin = input.margin - fromMargin;
    }
  }
  return {
    realizedPnl: pnl,
    profit,
    fromMargin,
    fromInsurance,
    unbooked,
    release,
    potOut: fromMargin + release,
    initialOut: input.marginInitial - figures.remainInitial,
    remainQty,
    remainMargin,
    remainInitial: figures.remainInitial,
    closes: remainQty === 0n,
  };
}

/** The root every ledger key of one reduce fill hangs off: the fill intent's own key. */
export function reduceFillRoot(fillKey: string): string {
  return `fill:${fillKey}`;
}

/**
 * The loss and release legs of a reduce fill, as recipes. The profit leg goes through the payout bound
 * (`payOrOweProfit`) under `reduceFillProfitId`, so it is not built here.
 *
 * `futuresMarginRelease` keys a release by (position, sequence); a fill's release is that fill's own fact, so
 * the fill key replaces the sequence, exactly as a liquidation rung's release does (`maintenance-ladder.ts`).
 */
export function reduceFillRecipes(input: {
  fillKey: string;
  positionId: string;
  userId: string;
  assetId: string;
  plan: Pick<ReduceFillPlan, 'fromMargin' | 'fromInsurance' | 'release'>;
}): { loss: PostRequest | null; release: PostRequest | null } {
  const root = reduceFillRoot(input.fillKey);
  const loss =
    input.plan.fromMargin > 0n || input.plan.fromInsurance > 0n
      ? recipes.futuresRealizeLoss({
          positionId: input.positionId,
          userId: input.userId,
          assetId: input.assetId,
          fromMargin: input.plan.fromMargin,
          fromInsurance: input.plan.fromInsurance,
          lossId: `${root}:loss`,
        })
      : null;
  let release: PostRequest | null = null;
  if (input.plan.release > 0n) {
    const base = recipes.futuresMarginRelease({
      positionId: input.positionId,
      userId: input.userId,
      assetId: input.assetId,
      amount: input.plan.release,
    });
    release = { ...base, idempotencyKey: `futures.margin.release:${input.positionId}:${root}:release` };
  }
  return { loss, release };
}

/** The payout row's id for a reduce fill's profit: the ledger key is `futures.profit:<this>`. */
export function reduceFillProfitId(fillKey: string): string {
  return `${reduceFillRoot(fillKey)}:profit`;
}
