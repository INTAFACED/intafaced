/**
 * PURE ARITHMETIC FOR FUTURES CALENDAR SPREAD ORDERS (CB-otc-16, svc-trade side).
 *
 * Nothing here posts, reads a row or calls the engine. It turns a spread listing, two marks, a band and a spread
 * price into the hold, the anchor window and the per-leg margin each fill moves.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT THE ENGINE GUARANTEES ABOUT LEG PRICES, AND WHAT IT DOES NOT
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * svc-matching `engine/spread-instrument.ts`: a spread fill prints at the MAKER's spread price S. Leg 0 (the anchor leg)
 * prints at the TAKER's caller-supplied anchor reference R; leg 1 (the residual) prints at the one price that makes the
 * spread identity exact:
 *
 *     S  = s0 * r0 * P0  +  s1 * r1 * P1          (s_i = +1 when the listing buys leg i for the spread buyer)
 *     P0 = R
 *     P1 = (S - s0 * r0 * R) / (s1 * r1)          (exact at 18 decimals, and > 0, or the whole order refuses)
 *
 * The engine bounds nothing else: R only has to be positive and exact, it is not collared, and there is no mark in
 * the engine. So the leg prices a RESTING order prints at are chosen by whoever takes it, and a hold sized from the
 * resting order's own price alone could be short. svc-trade is the only caller of the spread door and chooses every
 * anchor; the bound therefore comes from here:
 *
 *   · each order carries a per-leg band around that leg's mark (the same band matched orders use);
 *   · its HOLD covers, for each leg, the initial margin at the mark plus the FULL band half-width as the adverse
 *     distance on the whole leg quantity;
 *   · its ANCHOR WINDOW is the set of anchors R at which neither leg of that order prints further against it than
 *     the band half-width (an order that buys a leg is only hurt by a price above the mark, so the bound is one-sided
 *     per leg: one leg gives an upper bound on R and the other a lower bound, because the two legs have opposite sides);
 *   · an order is only ever sent with an anchor inside the window of EVERY live order it can cross (checked under a
 *     per-spread lock in `spread-orders.ts`), so every fill of every order prints inside that order's window and its
 *     adverse distance never exceeds what its hold already contains.
 *
 * The same checks run again at settlement: a fill whose leg prices are outside an order's cover is refused whole for
 * an operator before anything posts, never settled against a hold that is too small.
 *
 * Amounts are scaled bigints (18 decimals). Rounding of the window is always INWARD (upper bound floored, lower bound
 * ceiled), so a window can only be too small, never too large.
 */
import { MAX_AMOUNT, SCALE, parseAmount, type Amount } from '@intafaced/ledger-client';
import { adverseDistance, fillMargin, marginNeed, type FillMarginResult, type OrderSide } from './matched-order-plan.js';

export type { OrderSide };

export const SPREAD_LEG_COUNT = 2;

/** One leg of a listing, in the listing's own terms (the spread BUYER's side of the leg). */
export interface ListedLeg {
  /** The leg's market id: the engine names a leg by its market id, which is the trade.markets id. */
  readonly marketId: string;
  readonly side: OrderSide;
  readonly ratio: Amount;
}

export interface SpreadListing {
  readonly spreadId: string;
  readonly kind: 'calendar' | 'inter_coin';
  readonly legs: readonly [ListedLeg, ListedLeg];
  readonly tick: Amount;
  readonly lot: Amount;
}

export type ListingRead =
  { readonly ok: true; readonly listing: SpreadListing } | { readonly ok: false; readonly code: string; readonly message: string };

function bad(message: string): ListingRead {
  return { ok: false, code: 'trade.spread_listing_invalid', message };
}

function positive(raw: unknown): Amount | null {
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  try {
    const value = parseAmount(raw.trim());
    return value > 0n ? value : null;
  } catch {
    return null;
  }
}

/** Read one listing off the engine's `GET /spreads` wire. Anything missing or malformed refuses; nothing is filled in. */
export function readWireListing(wire: unknown): ListingRead {
  const w = wire as {
    spreadId?: unknown;
    kind?: unknown;
    legs?: unknown;
    tick?: unknown;
    lot?: unknown;
  } | null;
  if (!w || typeof w.spreadId !== 'string' || w.spreadId.trim() === '') return bad('the listing has no spread id');
  if (w.kind !== 'calendar' && w.kind !== 'inter_coin') return bad(`the listing's kind ${String(w.kind)} is not one svc-trade knows`);
  if (!Array.isArray(w.legs) || w.legs.length !== SPREAD_LEG_COUNT) return bad('a spread lists exactly two legs');
  const legs: ListedLeg[] = [];
  for (const raw of w.legs as Array<{ symbol?: unknown; side?: unknown; ratio?: unknown }>) {
    const ratio = positive(raw?.ratio);
    if (typeof raw?.symbol !== 'string' || raw.symbol.trim() === '') return bad('a leg has no symbol');
    if (raw.side !== 'buy' && raw.side !== 'sell') return bad(`leg ${raw.symbol} has no side`);
    if (ratio === null) return bad(`leg ${raw.symbol} has no positive ratio`);
    legs.push({ marketId: raw.symbol.trim(), side: raw.side, ratio });
  }
  const [l0, l1] = legs as [ListedLeg, ListedLeg];
  if (l0.marketId === l1.marketId) return bad('a spread names two different legs');
  if (l0.side === l1.side) return bad('a spread buys one leg and sells the other');
  const tick = positive(w.tick);
  const lot = positive(w.lot);
  if (tick === null || lot === null) return bad('the listing has no positive tick and lot');
  return { ok: true, listing: { spreadId: w.spreadId.trim(), kind: w.kind, legs: [l0, l1], tick, lot } };
}

// ── exact arithmetic ─────────────────────────────────────────────────────────

const fits = (value: Amount): boolean => value <= MAX_AMOUNT && value >= -MAX_AMOUNT;

/** a x b at 18 decimals, or null when the product is not exact or does not fit (the engine's rule). */
export function mulExact(a: Amount, b: Amount): Amount | null {
  const product = a * b;
  if (product % SCALE !== 0n) return null;
  const value = product / SCALE;
  return fits(value) ? value : null;
}

/** a / b at 18 decimals, or null when the quotient is not exact, b is zero, or it does not fit (the engine's rule). */
export function divExact(a: Amount, b: Amount): Amount | null {
  if (b === 0n) return null;
  const numerator = a * SCALE;
  if (numerator % b !== 0n) return null;
  const value = numerator / b;
  return fits(value) ? value : null;
}

/** floor(a / b) for b > 0, correct for negative a. */
export function floorDiv(a: bigint, b: bigint): bigint {
  if (b <= 0n) throw new Error('floorDiv needs a positive divisor');
  const q = a / b;
  return a % b !== 0n && a < 0n ? q - 1n : q;
}

/** ceil(a / b) for b > 0, correct for negative a. */
export function ceilDiv(a: bigint, b: bigint): bigint {
  if (b <= 0n) throw new Error('ceilDiv needs a positive divisor');
  const q = a / b;
  return a % b !== 0n && a > 0n ? q + 1n : q;
}

function gcd(a: bigint, b: bigint): bigint {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y !== 0n) [x, y] = [y, x % y];
  return x;
}

export function opposite(side: OrderSide): OrderSide {
  return side === 'buy' ? 'sell' : 'buy';
}

const sign = (side: OrderSide): bigint => (side === 'buy' ? 1n : -1n);

/** The side an order of `side` on the spread takes on each leg. The spread buyer takes the listed sides. */
export function orderLegSides(side: OrderSide, listing: Pick<SpreadListing, 'legs'>): readonly [OrderSide, OrderSide] {
  const [l0, l1] = listing.legs;
  return side === 'buy' ? [l0.side, l1.side] : [opposite(l0.side), opposite(l1.side)];
}

/**
 * The leg prices the ENGINE prints for a fill at spread price S under taker anchor R, or null when the engine would
 * refuse the order (`spread_leg_unfillable`). A port of `spreadLegPrices`: exact at 18 decimals, residual positive,
 * and the two legs sum to S exactly.
 */
export function engineLegPrices(
  listing: Pick<SpreadListing, 'legs'>,
  anchor: Amount,
  spreadPrice: Amount,
): readonly [Amount, Amount] | null {
  const [anchorLeg, residualLeg] = listing.legs;
  if (anchor <= 0n) return null;
  const anchorTerm = mulExact(anchorLeg.ratio, anchor);
  if (anchorTerm === null) return null;
  const residual = divExact(spreadPrice - sign(anchorLeg.side) * anchorTerm, sign(residualLeg.side) * residualLeg.ratio);
  if (residual === null || residual <= 0n) return null;
  const residualTerm = mulExact(residualLeg.ratio, residual);
  if (residualTerm === null) return null;
  if (sign(anchorLeg.side) * anchorTerm + sign(residualLeg.side) * residualTerm !== spreadPrice) return null;
  return [anchor, residual];
}

/**
 * The grid every anchor sits on: the smallest step `g` such that `r0 x R / r1` is exact for every multiple of it
 * (the engine's `spreadReferenceRefuse`). With a spread price on the listed tick, the residual price is then exact too.
 */
export function anchorStep(listing: Pick<SpreadListing, 'legs'>): bigint {
  const [anchorLeg, residualLeg] = listing.legs;
  const r0 = anchorLeg.ratio;
  const r1 = residualLeg.ratio;
  // r0 x R must be a whole number of units: R a multiple of SCALE / gcd(r0, SCALE).
  const g1 = SCALE / gcd(r0, SCALE);
  const t0 = r0 / gcd(r0, SCALE);
  // (r0 x R) x SCALE must divide by r1: k a multiple of r1 / gcd(r1, t0 x SCALE).
  const g2 = r1 / gcd(r1, t0 * SCALE);
  return g1 * g2;
}

// ── terms, hold, window ──────────────────────────────────────────────────────

/** One leg's pricing terms for an order: the mark it was read at and the band half-width around it. */
export interface LegTerms {
  readonly ratio: Amount;
  readonly mark: Amount;
  /** `mark x band`: the most the leg may print away from the mark, against the order. */
  readonly delta: Amount;
}

export interface SpreadOrderTerms {
  readonly side: OrderSide;
  readonly qty: Amount;
  /** The spread limit price. May be zero or negative. */
  readonly limit: Amount;
  readonly leverage: Amount;
  readonly listing: Pick<SpreadListing, 'legs'>;
  readonly legs: readonly [LegTerms, LegTerms];
}

/** The leg's quantity for a spread quantity: `qty x ratio`, which the listing makes exact for any whole number of lots. */
export function legQtyOf(qty: Amount, ratio: Amount): Amount {
  const value = mulExact(qty, ratio);
  if (value === null || value <= 0n) throw new Error('a spread quantity does not give a whole leg quantity at 18 decimals');
  return value;
}

/** The margin one leg needs for `spreadQty` of the spread when it prints `adverseNum` away from the mark, in all. */
function legNeed(terms: SpreadOrderTerms, leg: 0 | 1, spreadQty: Amount, adverseNum: bigint): Amount {
  const t = terms.legs[leg];
  return marginNeed({ filled: legQtyOf(spreadQty, t.ratio), adverseNum, mark: t.mark, leverage: terms.leverage });
}

/**
 * The whole hold: for each leg, the initial margin at the mark on the full leg quantity plus the full band half-width
 * as the adverse distance on that quantity. No fill of this order can need more than this (see the header).
 */
export function spreadHoldAmount(terms: SpreadOrderTerms): Amount {
  let hold = 0n;
  for (const leg of [0, 1] as const) {
    const t = terms.legs[leg];
    hold += legNeed(terms, leg, terms.qty, legQtyOf(terms.qty, t.ratio) * t.delta);
  }
  return hold;
}

export interface AnchorWindow {
  readonly lo: Amount;
  readonly hi: Amount;
}

export function windowIsEmpty(w: AnchorWindow): boolean {
  return w.lo > w.hi;
}

export function intersectWindows(windows: readonly AnchorWindow[]): AnchorWindow {
  let lo = 1n;
  let hi = MAX_AMOUNT;
  for (const w of windows) {
    if (w.lo > lo) lo = w.lo;
    if (w.hi < hi) hi = w.hi;
  }
  return { lo, hi };
}

/**
 * The anchors R at which neither leg of this order prints further against it than its band half-width.
 *
 * The order buys or sells each leg. Buying a leg is hurt by a price above the mark, so the price must be at or below
 * `mark + delta`; selling it, at or above `mark - delta`. Leg 0 prints at R itself. Leg 1 prints at
 * `P1 = (r0 x R - s0 x S) / r1`, increasing in R, so its bound on P1 is a bound on R. The legs have opposite sides,
 * so one gives the upper bound and the other the lower: the window is always a bounded interval (possibly empty).
 */
export function anchorWindow(terms: SpreadOrderTerms): AnchorWindow {
  const [l0, l1] = terms.listing.legs;
  const [x0, x1] = orderLegSides(terms.side, terms.listing);
  const [t0, t1] = terms.legs;
  const s0 = sign(l0.side);
  let lo = 1n;
  let hi = MAX_AMOUNT;
  // Leg 0 prints at R.
  if (x0 === 'buy') hi = min(hi, t0.mark + t0.delta);
  else lo = max(lo, t0.mark - t0.delta);
  // Leg 1: P1 <= B  <=>  R <= (B x r1 + s0 x S x SCALE) / r0 (scale 10^36 over scale 10^18); floor for an upper bound,
  // ceil for a lower one.
  if (x1 === 'buy') {
    const numerator = (t1.mark + t1.delta) * t1.ratio + s0 * terms.limit * SCALE;
    hi = min(hi, floorDiv(numerator, t0.ratio));
  } else {
    const numerator = (t1.mark - t1.delta) * t1.ratio + s0 * terms.limit * SCALE;
    lo = max(lo, ceilDiv(numerator, t0.ratio));
  }
  return { lo, hi };
}

const min = (a: bigint, b: bigint): bigint => (a < b ? a : b);
const max = (a: bigint, b: bigint): bigint => (a > b ? a : b);

/**
 * The anchor to send: the point of `window` on the grid that is nearest to the leg-0 mark, or null when no grid point
 * lies inside it. Nearest keeps leg 0 at the market whenever the windows allow it.
 */
export function pickAnchor(input: { mark: Amount; step: bigint; window: AnchorWindow }): Amount | null {
  const { mark, step, window } = input;
  if (step <= 0n || windowIsEmpty(window)) return null;
  const target = mark < window.lo ? window.lo : mark > window.hi ? window.hi : mark;
  const down = floorDiv(target, step) * step;
  const up = down + step;
  const inside = (value: Amount) => value >= window.lo && value <= window.hi && value > 0n;
  const distance = (value: Amount) => (value > mark ? value - mark : mark - value);
  const candidates = [down, up].filter(inside);
  if (candidates.length === 0) {
    // The window is narrower than a step around the target; the first grid point above `lo` may still lie inside.
    const first = ceilDiv(window.lo, step) * step;
    return inside(first) ? first : null;
  }
  return candidates.reduce((best, c) => (distance(c) < distance(best) ? c : best));
}

/** Whether a resting order at `makerSide`/`makerPrice` is one that a new `takerSide` order at `takerLimit` can cross. */
export function crossesSpread(taker: { side: OrderSide; limit: Amount }, maker: { side: OrderSide; limit: Amount }): boolean {
  if (taker.side === maker.side) return false;
  return taker.side === 'buy' ? maker.limit <= taker.limit : maker.limit >= taker.limit;
}

// ── fills ────────────────────────────────────────────────────────────────────

/** The adverse distance of a leg price for the side the order takes on that leg. */
export function legAdverse(legSide: OrderSide, price: Amount, mark: Amount): Amount {
  return adverseDistance(legSide, price, mark);
}

/**
 * The margin one leg of one fill moves, from the order's cumulative state on that leg. `before.spreadFilled` is the
 * spread quantity filled so far. Throws when the leg printed further from its mark than the band half-width: the hold
 * does not cover it, and the caller refuses the fill whole.
 */
export function legFillMargin(input: {
  readonly terms: SpreadOrderTerms;
  readonly leg: 0 | 1;
  readonly before: { readonly spreadFilled: Amount; readonly adverseNum: bigint };
  readonly fillQty: Amount;
  readonly legPrice: Amount;
}): FillMarginResult & { readonly outsideCover: boolean } {
  const { terms, leg } = input;
  const t = terms.legs[leg];
  const legSide = orderLegSides(terms.side, terms.listing)[leg];
  const outsideCover = adverseDistance(legSide, input.legPrice, t.mark) > t.delta;
  const result = fillMargin(
    {
      filled: input.before.spreadFilled === 0n ? 0n : legQtyOf(input.before.spreadFilled, t.ratio),
      adverseNum: input.before.adverseNum,
    },
    { side: legSide, qty: legQtyOf(input.fillQty, t.ratio), price: input.legPrice, mark: t.mark, leverage: terms.leverage },
  );
  return { ...result, outsideCover };
}

/** `S = s0 r0 P0 + s1 r1 P1` exactly: the legs of a fill sum to its spread price. */
export function legsSumToSpread(listing: Pick<SpreadListing, 'legs'>, spreadPrice: Amount, prices: readonly [Amount, Amount]): boolean {
  const [l0, l1] = listing.legs;
  const t0 = mulExact(l0.ratio, prices[0]);
  const t1 = mulExact(l1.ratio, prices[1]);
  if (t0 === null || t1 === null) return false;
  return sign(l0.side) * t0 + sign(l1.side) * t1 === spreadPrice;
}
