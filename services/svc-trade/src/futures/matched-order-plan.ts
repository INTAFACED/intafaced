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
import type { OwnerFeeSchedule } from '../spot/fee-schedule.js';
import { ratesForFill } from '../spot/fees.js';
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

/**
 * The protective limit of a market OPEN: the band edge, or nearer the mark when the slippage cap is tighter. The cap's
 * distance rounds down, so the limit never sits past the cap. A market close keeps the band edge (`protectiveLimit`):
 * reducing risk is never held to a tighter price than the band.
 */
export function marketOpenLimit(side: OrderSide, mark: Amount, band: PriceBand, slippageCapBps: number): Amount {
  const delta = (mark * BigInt(slippageCapBps)) / 10_000n;
  if (side === 'buy') {
    const capped = mark + delta;
    return capped < band.high ? capped : band.high;
  }
  const capped = mark - delta;
  return capped > band.low ? capped : band.low;
}

/**
 * The most children one split request places. A request bound, not a money limit: it keeps one call from planning,
 * looking up and placing an unbounded number of orders. Max-position still bounds the total.
 */
export const SPLIT_MAX_CHILDREN = 100;

/**
 * An opening order above the owner's max-order notional (valued at the mark) as children of at most the cap each: as
 * many full children as fit, then the rest. Each child is the largest lot multiple whose notional at the mark is
 * within the cap, so none of them is refused for size. Not splittable when one lot is already over the cap
 * (`lot_over_cap`) or when it would take more than `SPLIT_MAX_CHILDREN` children (`too_many_children`).
 */
export function splitPlan(input: {
  qty: Amount;
  mark: Amount;
  maxOrderNotional: Amount;
  lotSize: Amount | null;
  /** The child size an earlier attempt of the same request already used: a retry keeps it, so its keys still match. */
  childSize?: Amount;
}): { ok: true; parts: Amount[] } | { ok: false; reason: 'lot_over_cap' | 'too_many_children'; children?: bigint } {
  let child = input.childSize ?? (input.maxOrderNotional * SCALE) / input.mark;
  if (input.childSize === undefined && input.lotSize !== null && input.lotSize > 0n) child -= child % input.lotSize;
  if (child <= 0n) return { ok: false, reason: 'lot_over_cap' };
  if (input.qty <= child) return { ok: true, parts: [input.qty] };
  const full = input.qty / child;
  const rest = input.qty - full * child;
  const children = full + (rest > 0n ? 1n : 0n);
  if (children > BigInt(SPLIT_MAX_CHILDREN)) return { ok: false, reason: 'too_many_children', children };
  const parts: Amount[] = Array.from({ length: Number(full) }, () => child);
  if (rest > 0n) parts.push(rest);
  return { ok: true, parts };
}

/** A limit outside the band, moved to the nearer edge (the order's `priceCorrection: 'adjust'`). Inside, unchanged. */
export function correctToBand(limit: Amount, band: PriceBand): Amount {
  if (limit > band.high) return band.high;
  if (limit < band.low) return band.low;
  return limit;
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

// ─────────────────────────────────────────────────────────────────────────────
// TRADING FEES (migration 0099)
// ─────────────────────────────────────────────────────────────────────────────

/** Which side of a fill an order was on. The engine names it: the order that arrived and crossed is the taker. */
export type FeeRole = 'maker' | 'taker';

/** The market's published rates as an order keeps them from the moment it is accepted. Whole basis points. */
export interface FeeRates {
  readonly makerBps: number;
  readonly takerBps: number;
}

/**
 * The perpetual rates an account pays now: the owner's published `perpetual` block of `TRADE_FEE_SCHEDULE` (the one
 * the operator fee read shows for futures), less the account's rank discount, through the spot path's own resolver.
 * Listing-row `maker_bps`/`taker_bps` are not a schedule and are never read here. Unpublished throws `FeeScheduleError`
 * (`trade.fee_schedule_blank` or `trade.fee_product_unpublished`): nothing invents a rate.
 */
export function perpetualFeeRates(schedule: OwnerFeeSchedule, discountBps: number): FeeRates {
  const rates = ratesForFill(schedule, discountBps, discountBps, 'perpetual');
  return { makerBps: rates.makerFeeBps, takerBps: rates.takerFeeBps };
}

/** `qty × price × bps / 10000`, rounded up to the unit once: a fee that rounds down is a fee the house pays. */
function feeAt(qty: Amount, price: Amount, bps: number): Amount {
  if (bps === 0 || qty <= 0n || price <= 0n) return 0n;
  const denominator = SCALE * 10_000n;
  return (qty * price * BigInt(bps) + denominator - 1n) / denominator;
}

/** One fill's fee at its own price and its own side's rate. */
export function fillFee(input: { qty: Amount; price: Amount; role: FeeRole; rates: FeeRates }): Amount {
  return feeAt(input.qty, input.price, input.role === 'taker' ? input.rates.takerBps : input.rates.makerBps);
}

/**
 * What an opening order's hold carries for its fees: the higher of its two rates on the most its whole quantity can
 * cost. A buy never fills above its limit. A sell fills at its limit or better, and a better price for a sell is a
 * higher one, so its bound is the top of the band it was accepted in (its limit is inside that band). A fill priced
 * past even that (a bid resting since the mark fell) pays what the reserve has left; the rest is recorded as waived,
 * never drawn from anything else.
 */
export function orderFeeReserve(input: { side: OrderSide; qty: Amount; limit: Amount; bandHigh: Amount; rates: FeeRates }): Amount {
  const bps = Math.max(input.rates.makerBps, input.rates.takerBps);
  const bound = input.side === 'buy' ? input.limit : input.bandHigh > input.limit ? input.bandHigh : input.limit;
  return feeAt(input.qty, bound, bps);
}

/**
 * How much of a fill's fee is paid and how much is waived, from what its source can give: an opening fill's
 * reserve left in the hold, or a reducing fill's margin share. Never more than either, never negative.
 */
export function feeSplit(fee: Amount, available: Amount): { charged: Amount; waived: Amount } {
  const room = available > 0n ? available : 0n;
  const charged = fee <= room ? fee : room;
  return { charged, waived: fee - charged };
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
  /** The fill's trading fee, already taken out of `plan.release`: it leaves the pot in the release posting. */
  fee?: Amount;
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
  const fee = input.fee ?? 0n;
  if (input.plan.release > 0n || fee > 0n) {
    const base = recipes.futuresMarginRelease({
      positionId: input.positionId,
      userId: input.userId,
      assetId: input.assetId,
      amount: input.plan.release,
      ...(fee > 0n ? { fee } : {}),
    });
    release = { ...base, idempotencyKey: `futures.margin.release:${input.positionId}:${root}:release` };
  }
  return { loss, release };
}

/** The payout row's id for a reduce fill's profit: the ledger key is `futures.profit:<this>`. */
export function reduceFillProfitId(fillKey: string): string {
  return `${reduceFillRoot(fillKey)}:profit`;
}

// ─────────────────────────────────────────────────────────────────────────────
// LIQUIDATION ORDERS (futures ADR slice 7)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The limit of a liquidation's reduce-only IOC (ADR section 5): the position's bankruptcy price, widened by what the
 * insurance fund can pay right now, then pulled in to the price band around the mark exactly as a market reduce is
 * (`marketReduceLimit`). Null when no price inside the band is inside the widened bound: the book cannot take any of
 * it, and the whole tranche goes to ADL.
 *
 * WIDENED ONLY FOR A TRANCHE THAT CLOSES THE POSITION. A partial tranche is a ladder rung on a position that is not
 * bankrupt: the book is asked for it at the bankruptcy price, never past it, and the fund is not offered for it.
 *
 * THE WIDENING NEVER PROMISES MORE THAN THE FUND HOLDS. Filling `size` at `bankruptcy ∓ w` loses at most the margin
 * plus `size × w`, and `w` is chosen so that is at most `insurance − slack`. Each fill's realised loss is charged up by
 * under one unit (10^-18), so `slack` is the most fills the tranche can be split into (`fillsBound`, one per lot).
 * The fund pays only the tranche's NET loss past the margin (`planLiquidationFill`), and its live balance is checked
 * again when it is drawn; a draw it cannot cover waits.
 * Zero, unreadable or unset insurance widens nothing: the limit is the bankruptcy price itself.
 */
export function liquidationLimit(input: {
  side: PositionSide;
  /** The position's size: the tranche when it closes the position. */
  size: Amount;
  closesPosition: boolean;
  bankruptcy: Amount;
  /** The insurance fund's live balance, or 0 when it could not be read. */
  insurance: Amount;
  /** The most fills the tranche can be split into. */
  fillsBound: Amount;
  band: PriceBand;
}): { limit: Amount | null; widened: Amount; widening: Amount } {
  if (input.size <= 0n) throw new Error('a liquidation order needs a positive size');
  const budget = input.closesPosition && input.insurance > input.fillsBound ? input.insurance - input.fillsBound : 0n;
  const widening = (budget * SCALE) / input.size;
  const widened = input.side === 'long' ? (input.bankruptcy > widening ? input.bankruptcy - widening : 0n) : input.bankruptcy + widening;
  return { limit: marketReduceLimit(input.side, input.band, widened), widened, widening };
}

/** The client order id of a liquidation's IOC: a business key, the lifecycle id and the rung id. */
export function liquidationClientOrderId(liquidationId: string, rungId: string): string {
  return `${liquidationId}:rung:${rungId}`;
}

/**
 * What a liquidation order's earlier fills did, read from their applied intents: the fills of one rung's IOC are
 * settled one at a time against the same position, so these totals and the row are all a fill needs.
 */
export interface LiquidationFillsSoFar {
  /** Quantity the earlier fills took off the position. */
  readonly qty: Amount;
  /** Their realised PnL, summed. */
  readonly pnl: Amount;
  /** What they moved from the position's collateral pot into the clearing pot. */
  readonly fromMargin: Amount;
}

function ceilDiv(a: Amount, b: Amount): Amount {
  return (a + b - 1n) / b;
}

/**
 * ONE FILL OF A LIQUIDATION'S IOC (futures ADR section 5, slice 7). The fills of one rung are one liquidation, so they
 * are netted against each other before anything is paid out or drawn from the insurance fund:
 *
 * - THE REMAINDER KEEPS THE RUNG'S MARGIN RATIO. The position keeps `ceil(startMargin × remain / startSize)` in its pot
 *   (start = the row before the order's first fill), so the part the book does not take keeps the bankruptcy price the
 *   rung started from, and ADL prices it there (rule 2). Only the rest of the pot (`free`) is the filled part's.
 * - NOTHING IS PAID OUT MID-TRANCHE. A profit is not paid, and the filled part's free margin is not released: both stay
 *   where they are (the clearing pot and the collateral pot) as the trader's claim on the tranche.
 * - A LOSS IS PAID FROM WHAT THE TRANCHE HAS. The clearing pot is owed `−(Σ pnl + Σ fromMargin)` when that is
 *   positive (the tranche's net loss not yet paid in); this fill pays it from the free margin, as far as that goes.
 *   A profit kept back earlier has already cut that debt, so an above-entry fill then a fill past the bankruptcy price
 *   net to the margin, and the fund pays nothing.
 * - THE INSURANCE FUND PAYS ONLY THE NET SHORTFALL, AND ONLY AT THE END. A debt the free margin cannot cover is not
 *   drawn on this fill: a later, better fill may still cover it. It is drawn once, when the tranche is done: on the
 *   fill that closes the position (here), or by `planLiquidationSettlement` when part of the position goes on to ADL.
 *   On the closing fill the rest of the pot comes back and a net profit is paid.
 */
export function planLiquidationFill(input: {
  side: PositionSide;
  size: Amount;
  entryPrice: Amount;
  margin: Amount;
  marginInitial: Amount;
  qty: Amount;
  price: Amount;
  prior: LiquidationFillsSoFar;
  /** Units of rounding past the margin left unbooked: the number of earlier reduce fills on the position. */
  roundingAllowance?: bigint;
}): ReduceFillPlan {
  if (input.qty <= 0n || input.qty > input.size) throw new Error('a reduce fill must take a slice of its position');
  if (input.price <= 0n) throw new Error('a reduce fill needs a positive price');
  if (input.margin < 0n || input.marginInitial < 0n) throw new Error('a position margin is never negative');
  if (input.prior.qty < 0n || input.prior.fromMargin < 0n) throw new Error('earlier liquidation fills are never negative');
  const figures = proportionalCloseFigures({
    side: input.side,
    size: input.size,
    closeQty: input.qty,
    entryPrice: input.entryPrice,
    exitPrice: input.price,
    margin: input.margin,
    marginInitial: input.marginInitial,
  });
  const pnl = figures.realizedPnl;
  const remainQty = figures.remainQty;
  const startSize = input.size + input.prior.qty;
  const startMargin = input.margin + input.prior.fromMargin;
  const keep = remainQty === 0n ? 0n : ceilDiv(startMargin * remainQty, startSize);
  const free = input.margin > keep ? input.margin - keep : 0n;
  const owed = -(input.prior.pnl + pnl + input.prior.fromMargin);
  const fromMargin = owed > 0n ? (owed < free ? owed : free) : 0n;
  const net = input.prior.pnl + pnl + input.prior.fromMargin + fromMargin;

  let profit = 0n;
  let fromInsurance = 0n;
  let unbooked = 0n;
  let release = 0n;
  if (remainQty === 0n) {
    release = input.margin - fromMargin;
    if (net > 0n) profit = net;
    else if (net < 0n) {
      if (-net <= (input.roundingAllowance ?? 0n)) unbooked = -net;
      else fromInsurance = -net;
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
    remainMargin: remainQty === 0n ? 0n : input.margin - fromMargin,
    remainInitial: figures.remainInitial,
    closes: remainQty === 0n,
  };
}

/**
 * THE END OF A LIQUIDATION'S BOOK when part of the position is left (it goes on to ADL, or the rung was a partial
 * tranche). Every fill has settled (`planLiquidationFill`); what they kept back is settled now, once: the filled part's
 * free margin comes back to the trader, a net profit is paid, and a net loss past the filled part's margin is drawn from
 * the insurance fund. The position keeps exactly its share of the rung's starting margin, so its bankruptcy price is
 * the one the rung started from.
 */
export function planLiquidationSettlement(input: {
  size: Amount;
  margin: Amount;
  prior: LiquidationFillsSoFar;
  roundingAllowance?: bigint;
}): { release: Amount; profit: Amount; fromInsurance: Amount; unbooked: Amount; remainMargin: Amount } {
  if (input.size <= 0n) throw new Error('a settlement needs the position still open');
  const startSize = input.size + input.prior.qty;
  const startMargin = input.margin + input.prior.fromMargin;
  const keep = ceilDiv(startMargin * input.size, startSize);
  const release = input.margin > keep ? input.margin - keep : 0n;
  const net = input.prior.pnl + input.prior.fromMargin;
  let profit = 0n;
  let fromInsurance = 0n;
  let unbooked = 0n;
  if (net > 0n) profit = net;
  else if (net < 0n) {
    if (-net <= (input.roundingAllowance ?? 0n)) unbooked = -net;
    else fromInsurance = -net;
  }
  return { release, profit, fromInsurance, unbooked, remainMargin: input.margin - release };
}

/** The root of a liquidation order's end-of-book settlement keys: one settlement per order, so per rung. */
export function liquidationSettlementRoot(orderId: string): string {
  return `liquidation:${orderId}:settle`;
}
