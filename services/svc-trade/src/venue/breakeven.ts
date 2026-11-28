import { onVenuePriceRule } from '@intafaced/contracts/venue-price';
import { formatAmount, parseAmount, SCALE, ZERO, type Amount } from '@intafaced/ledger-client/money';

/**
 * A FEE-ADJUSTED BREAKEVEN STOP: the price at which closing the whole open perp position nets zero after every
 * fee it pays, the venue's and our builder fee, on the way in and on the way out. Pure: decimal strings and scaled
 * bigints, never a `number`.
 *
 * With the position's entry price E and size Q, the fees its opening fills already paid F (the venue's own fill records),
 * and the rate r its close pays on its notional (the venue's taker rate for the account plus our builder fee on the stop,
 * in bps), closing at P nets:
 *
 *   long:  Q·(P − E) − F − r·P·Q = 0   →   P = (E·Q + F) / (Q·(1 − r))
 *   short: Q·(E − P) − F − r·P·Q = 0   →   P = (E·Q − F) / (Q·(1 + r))
 *
 * The price then goes on the venue's price rule (5 significant figures and the market's tick) on the side that never
 * nets below zero: a long's stop rounds up, a short's down.
 */

const BPS = 10_000n;

export interface BreakevenInput {
  readonly side: 'long' | 'short';
  readonly size: Amount;
  readonly entryPrice: Amount;
  /** Fees the opening fills paid, venue and builder (`openingFeesOf`). */
  readonly openingFees: Amount;
  /** What the close pays on its notional, in bps (scaled): the venue's taker rate plus our builder fee. */
  readonly closeFeeBps: Amount;
  /** The market's tick, for the venue's price rule. */
  readonly tick: Amount;
}

export interface Breakeven {
  /** The exact price, before the venue's rule, rounded only at its 18th place (up for a long, down for a short). */
  readonly exact: Amount;
  /** The price the stop rests at: on the venue's rule, never netting below zero. */
  readonly price: Amount;
}

/** The fee-adjusted breakeven price of closing the whole position (see the file's head). */
export function feeAdjustedBreakeven(input: BreakevenInput): Breakeven {
  const { side, size, entryPrice, openingFees, closeFeeBps, tick } = input;
  if (size <= ZERO) throw new RangeError('a position to break even has a size above zero');
  if (closeFeeBps < ZERO || closeFeeBps >= BPS * SCALE) throw new RangeError('the close fee rate is between 0 and 10000 bps');
  // Everything at SCALE²: numerator (E·Q ± F)·SCALE, denominator Q·(1 ∓ r), with r = bps / 10000.
  const cost = entryPrice * size + (side === 'long' ? openingFees : -openingFees) * SCALE; // SCALE²
  const keep = side === 'long' ? BPS * SCALE - closeFeeBps : BPS * SCALE + closeFeeBps; // (1 ∓ r) at BPS·SCALE
  const num = cost * BPS * SCALE; // SCALE² · BPS·SCALE
  const den = size * keep; // SCALE · BPS·SCALE
  if (num <= 0n) throw new RangeError('the opening fees are larger than the position is worth: no price breaks even');
  // num / den is at SCALE; round toward the side that never nets below zero.
  const floor = num / den;
  const exact = side === 'long' && floor * den !== num ? floor + 1n : floor;
  const price = parseAmount(onVenuePriceRule(formatAmount(exact), formatAmount(tick), side === 'long' ? 'up' : 'down'));
  return { exact, price };
}
