import { add, compare, sub, SCALE, ZERO, type Amount } from '@intafaced/ledger-client/money';
import type { UserVenueFill } from './user-venue.js';

/**
 * A PERP POSITION'S RESULT AFTER FEES, from the venue's own figures: what its opening fills paid, and what closing the
 * whole position at a price nets after those and the close's own fees. Shared by svc-trade's breakeven stop and the
 * desk's chart lines and risk strip (J-derivatives-32), so the two never disagree. Pure: scaled bigints, never a number.
 */

const BPS = 10_000n;

/**
 * What the opening fills of the position open now paid in fees, the venue's and our builder fee, read from the
 * account's own fills on `symbol` oldest first: a fill that grows the position adds its fees, one that shrinks it keeps the
 * share of the fees still open, and one that turns it over keeps only the share that opened the new side. `null` when the
 * fills read do not add up to the position the venue holds (its opening fell before the history read): never a guess.
 */
export function openingFeesOf(
  position: { readonly side: 'long' | 'short'; readonly size: Amount },
  fills: readonly Pick<UserVenueFill, 'side' | 'amount' | 'venueFee' | 'builderFee' | 'filledAt'>[],
): Amount | null {
  const sorted = [...fills].sort((x, y) => x.filledAt.getTime() - y.filledAt.getTime());
  let held = ZERO; // signed: above zero long, below zero short
  let fees = ZERO;
  for (const f of sorted) {
    const move = f.side === 'buy' ? f.amount : -f.amount;
    const paid = add(f.venueFee, f.builderFee);
    if (held === ZERO || held > ZERO === move > ZERO) {
      held = add(held, move);
      fees = add(fees, paid);
      continue;
    }
    const size = held > ZERO ? held : -held;
    const amount = move > ZERO ? move : -move;
    if (compare(amount, size) <= 0) {
      const left = sub(size, amount);
      fees = left === ZERO ? ZERO : (fees * left) / size;
      held = add(held, move);
      continue;
    }
    // Turned over: the part past zero opened the other side and paid its share of this fill's fees.
    const over = sub(amount, size);
    fees = (paid * over) / amount;
    held = move > ZERO ? over : -over;
  }
  const want = position.side === 'long' ? position.size : -position.size;
  return held === want ? fees : null;
}

/**
 * What closing the whole position at `price` nets after every fee: (P − E)·Q for a long, (E − P)·Q for a short, less
 * the fees its opening fills paid and the close's own fees on its notional (`closeFeeBps`: the venue's taker rate plus
 * our builder fee, in bps, scaled). Rounded toward the person's loss at the 18th place, so it never reads better.
 */
export function netIfClosedAt(input: {
  readonly side: 'long' | 'short';
  readonly size: Amount;
  readonly entryPrice: Amount;
  readonly openingFees: Amount;
  readonly closeFeeBps: Amount;
  readonly price: Amount;
}): Amount {
  const { side, size, entryPrice, openingFees, closeFeeBps, price } = input;
  const move = side === 'long' ? price - entryPrice : entryPrice - price;
  const gross = move * size; // SCALE²
  const closeFee = price * size * closeFeeBps; // SCALE³ · bps
  const den = SCALE * SCALE * BPS;
  const num = gross * SCALE * BPS - closeFee - openingFees * SCALE * SCALE * BPS;
  // Floor toward minus infinity: a fraction of the last place counts against the person.
  const q = num / den;
  return q * den > num ? q - 1n : q;
}
