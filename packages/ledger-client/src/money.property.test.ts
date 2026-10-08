import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  MoneyError,
  DECIMALS,
  MAX_AMOUNT,
  SCALE,
  add,
  div,
  formatAmount,
  mul,
  mulBps,
  parseAmount,
  proRata,
  sub,
  sum,
  type Amount,
} from './money.js';

/**
 * THE MONEY PRIMITIVES, ARGUED WITH INSTEAD OF SAMPLED.
 *
 * `money.test.ts` is example-based and stays that way — it pins the cases a
 * human decided were interesting, and it reads as documentation. This file asks
 * a different question: not "does 0.1 + 0.2 work" but "is there ANY pair of
 * amounts for which it does not".
 *
 * Every property here is a claim the rest of the platform already relies on.
 * `proRata` is used for staking rewards and PPLNS payouts, and its doc comment
 * promises the shares "always sum back to exactly `total` — the ledger will not
 * accept anything less". That is a universally quantified statement about an
 * algorithm with a dust-distribution loop and a sort, and no fixed set of
 * examples can establish it. A counterexample here is money that was created or
 * destroyed by a rounding path.
 *
 * Scope: pure arithmetic in `money.ts`. No balance is touched, no recipe is
 * called, nothing moves. This is the layer everything above it assumes is right.
 */

/**
 * Amounts across the range the book actually holds.
 *
 * `numeric(38,18)` gives 20 integer digits. The generator stops at the
 * largest scaled unit that column can store. 10^38 scaled is 10^20 exactly,
 * one integer digit past the column, and parseAmount refuses it.
 */
const anyAmount = (): fc.Arbitrary<Amount> => fc.bigInt({ min: -MAX_AMOUNT, max: MAX_AMOUNT });

/** Non-negative amounts, for the properties that only make sense on a credit. */
const positiveAmount = (): fc.Arbitrary<Amount> => fc.bigInt({ min: 0n, max: MAX_AMOUNT });

/**
 * Weights, INCLUDING zero ones. `proRata` refuses a non-positive *total*
 * weight, so the first entry is forced positive; every other entry may be `0n`.
 *
 * This generator used to start at `min: 1n`. A zero weight was outside the
 * search space, so no property here could ever be evaluated on one — and a zero
 * weight is exactly where `proRata` misallocated on a negative total, handing
 * dust to participants entitled to nothing. The gate was not weak; its input
 * domain was narrower than the function's, and a defect that lives in the gap
 * is invisible however many runs you do.
 *
 * A zero weight is not a contrived input either: an unstaked participant, a
 * miner with no accepted shares in the round, a follower with the position
 * closed — all of them arrive as `0n` and all of them are in the array.
 *
 * Zero is drawn as its OWN branch rather than as one value in a `min: 0n`
 * range. Widening the range to include it is not the same as generating it:
 * over 0…10^24 uniform, `0n` essentially never appears, and a suite that
 * "covers" zero weights without ever producing one is the original defect
 * wearing a fix. Measured — with the range-only version, reverting the
 * `proRata` sort left the zero-weight property GREEN. With this one it fails.
 */
const weights = (): fc.Arbitrary<Amount[]> =>
  fc
    .array(fc.oneof({ arbitrary: fc.constant(0n), weight: 1 }, { arbitrary: fc.bigInt({ min: 1n, max: 10n ** 24n }), weight: 2 }), {
      minLength: 1,
      maxLength: 40,
    })
    .map((w) => (sum(w) > 0n ? w : [1n, ...w.slice(1)]));

describe('parse / format are exact inverses', () => {
  it('format then parse returns the original amount, for every amount', () => {
    fc.assert(
      fc.property(anyAmount(), (value) => {
        expect(parseAmount(formatAmount(value))).toBe(value);
      }),
    );
  });

  it('emits a canonical string — no trailing zeros, no "-0", no exponent', () => {
    fc.assert(
      fc.property(anyAmount(), (value) => {
        const text = formatAmount(value);

        expect(text).toMatch(/^-?\d+(\.\d*[1-9])?$/);
        expect(text).not.toBe('-0');
        // Canonical means a second trip changes nothing.
        expect(formatAmount(parseAmount(text))).toBe(text);
      }),
    );
  });

  it('never silently truncates precision it cannot carry', () => {
    fc.assert(
      fc.property(fc.stringMatching(/^\d{1,4}$/), fc.integer({ min: DECIMALS + 1, max: DECIMALS + 12 }), (whole, places) => {
        // A fraction ending in a non-zero digit past the 18th place cannot be
        // represented. Rejection is the only honest answer; rounding it would
        // be the book quietly disagreeing with its own input.
        const tooPrecise = `${whole}.${'0'.repeat(places - 1)}1`;
        // `MoneyError` specifically, not "something threw". A bare `toThrow()`
        // is satisfied by a TypeError from a broken implementation, which is
        // how an over-precision-truncating mutant survived this assertion
        // before the type was named.
        expect(() => parseAmount(tooPrecise)).toThrow(MoneyError);
      }),
    );
  });
});

describe('additive structure', () => {
  it('subtraction undoes addition', () => {
    fc.assert(
      fc.property(anyAmount(), anyAmount(), (a, b) => {
        expect(sub(add(a, b), b)).toBe(a);
      }),
    );
  });

  it('sum is order-independent — a reordered ledger is the same ledger', () => {
    fc.assert(
      fc.property(fc.array(anyAmount(), { maxLength: 60 }), (amounts) => {
        const reversed = [...amounts].reverse();
        expect(sum(reversed)).toBe(sum(amounts));
      }),
    );
  });

  it('sum is exact regardless of magnitude spread', () => {
    // The float failure mode: adding 10^-18 to 10^20 and losing it. bigint
    // cannot do that, and this is the assertion that says so out loud.
    fc.assert(
      fc.property(fc.array(anyAmount(), { minLength: 1, maxLength: 60 }), (amounts) => {
        let expected = 0n;
        for (const a of amounts) expected += a;
        expect(sum(amounts)).toBe(expected);
      }),
    );
  });
});

describe('rounding is ordered and explicit', () => {
  it('floor <= half-up <= ceil, for multiplication', () => {
    fc.assert(
      fc.property(anyAmount(), anyAmount(), (a, b) => {
        const floor = mul(a, b, 'floor');
        const half = mul(a, b, 'half-up');
        const ceil = mul(a, b, 'ceil');

        expect(floor <= half).toBe(true);
        expect(half <= ceil).toBe(true);
        // The three can differ by at most one scaled unit — anything wider is
        // not rounding, it is a different answer.
        expect(ceil - floor <= 1n).toBe(true);
      }),
    );
  });

  it('floor <= half-up <= ceil, for division', () => {
    fc.assert(
      fc.property(
        anyAmount(),
        anyAmount().filter((b) => b !== 0n),
        (a, b) => {
          const floor = div(a, b, 'floor');
          const ceil = div(a, b, 'ceil');
          const half = div(a, b, 'half-up');

          expect(floor <= half).toBe(true);
          expect(half <= ceil).toBe(true);
          expect(ceil - floor <= 1n).toBe(true);
        },
      ),
    );
  });

  /**
   * The exact-half boundary, constructed rather than hoped for.
   *
   * Ordering properties (`floor <= half-up <= ceil`) hold whether the rule is
   * `r * 2 >= d` or `r * 2 > d`, and a random bigint lands exactly on a half
   * essentially never — so a mutation flipping that comparison survives an
   * ordering-only suite. It was verified to survive before this test existed.
   *
   * `mul(k, 0.5)` for odd `k` is exactly half a scaled unit, every time:
   * `k * (SCALE/2) mod SCALE === SCALE/2`. That gives the boundary on demand.
   */
  it('half-up rounds a true half AWAY FROM ZERO, on both signs', () => {
    const HALF: Amount = SCALE / 2n;

    fc.assert(
      fc.property(fc.bigInt({ min: 1n, max: 10n ** 20n }), (k) => {
        const odd = k % 2n === 0n ? k + 1n : k;

        const posFloor = mul(odd, HALF, 'floor');
        const posCeil = mul(odd, HALF, 'ceil');
        const posHalf = mul(odd, HALF, 'half-up');

        // A genuine boundary: floor and ceil really do differ here.
        expect(posCeil - posFloor).toBe(1n);
        // Away from zero on the positive side is up.
        expect(posHalf).toBe(posCeil);

        const negFloor = mul(-odd, HALF, 'floor');
        const negCeil = mul(-odd, HALF, 'ceil');
        const negHalf = mul(-odd, HALF, 'half-up');

        expect(negCeil - negFloor).toBe(1n);
        // Away from zero on the negative side is down — NOT the same as ceil.
        // A rule that rounded -0.5 to 0 would make a refund cheaper than a
        // charge of the same size.
        expect(negHalf).toBe(negFloor);
      }),
    );
  });

  it('floor and ceil bracket the exact rational value of a product', () => {
    fc.assert(
      fc.property(anyAmount(), anyAmount(), (a, b) => {
        const exactNumerator = a * b;
        const floor = mul(a, b, 'floor');
        const ceil = mul(a, b, 'ceil');

        // floor * SCALE <= a*b <= ceil * SCALE, i.e. the rounded answers really
        // do sit either side of the true value rather than near it.
        expect(floor * SCALE <= exactNumerator).toBe(true);
        expect(exactNumerator <= ceil * SCALE).toBe(true);
      }),
    );
  });
});

describe('mulBps — the fee rule the house cannot lose money to', () => {
  it('a fee at or below 100% never exceeds the amount it is taken from', () => {
    fc.assert(
      fc.property(positiveAmount(), fc.integer({ min: 0, max: 10_000 }), (amount, bps) => {
        const fee = mulBps(amount, bps, 'ceil');
        expect(fee >= 0n).toBe(true);
        // The ceil rounding may add one scaled unit at exactly 100%, which is
        // the documented "the house does not eat the rounding" direction.
        expect(fee <= amount + 1n).toBe(true);
      }),
    );
  });

  it('ceil never credits a user less than floor, and they differ by at most a unit', () => {
    fc.assert(
      fc.property(positiveAmount(), fc.integer({ min: 0, max: 100_000 }), (amount, bps) => {
        const floor = mulBps(amount, bps, 'floor');
        const ceil = mulBps(amount, bps, 'ceil');
        expect(floor <= ceil).toBe(true);
        expect(ceil - floor <= 1n).toBe(true);
      }),
    );
  });

  /**
   * The rounding argument is OBEYED, not merely accepted.
   *
   * The property above is satisfied by an implementation that ignores its
   * `rounding` parameter entirely and always floors — `floor === ceil` passes
   * both `<=` and `<= 1n`. A mutant doing exactly that survived until this
   * test, which matters because the whole point of `mulBps` defaulting to
   * `ceil` is that a fee rounding to zero is a fee the house pays.
   *
   * When the division leaves a remainder the two modes MUST differ, by exactly
   * one unit.
   */
  it('actually rounds the way the caller asked, whenever it is inexact', () => {
    fc.assert(
      fc.property(positiveAmount(), fc.integer({ min: 1, max: 100_000 }), (amount, bps) => {
        const inexact = (amount * BigInt(bps)) % 10_000n !== 0n;
        fc.pre(inexact);

        expect(mulBps(amount, bps, 'ceil') - mulBps(amount, bps, 'floor')).toBe(1n);
      }),
    );
  });

  it('a zero rate is always exactly zero — no dust invented from nothing', () => {
    fc.assert(
      fc.property(positiveAmount(), (amount) => {
        expect(mulBps(amount, 0, 'ceil')).toBe(0n);
        expect(mulBps(amount, 0, 'floor')).toBe(0n);
      }),
    );
  });
});

describe('proRata — the conservation law', () => {
  it('shares sum to exactly the total, for every split', () => {
    // THE property. Staking rewards and PPLNS payouts go through here, and a
    // single unit of drift is value created or destroyed by a sort order.
    fc.assert(
      fc.property(anyAmount(), weights(), (total, w) => {
        const shares = proRata(total, w);
        expect(sum(shares)).toBe(total);
      }),
    );
  });

  it('returns exactly one share per weight', () => {
    fc.assert(
      fc.property(anyAmount(), weights(), (total, w) => {
        expect(proRata(total, w).length).toBe(w.length);
      }),
    );
  });

  /**
   * A ZERO WEIGHT RECEIVES EXACTLY ZERO.
   *
   * The property that was missing, and the one that catches the defect the
   * conservation law cannot see. On a negative total the old dust order paid
   * zero-weight participants first — 42 817 of 58 713 negative-total splits
   * misallocated — while the shares still summed to `total` exactly, so every
   * property in this file passed and the ledger accepted every one of them.
   *
   * `anyAmount()` deliberately, not `positiveAmount()`: on a positive total
   * this property was never violated, so a positive-only generator proves
   * nothing here.
   */
  it('pays a zero weight exactly zero, on a total of either sign', () => {
    fc.assert(
      fc.property(anyAmount(), weights(), (total, w) => {
        const shares = proRata(total, w);
        w.forEach((weight, i) => {
          if (weight === 0n) expect(shares[i]).toBe(0n);
        });
      }),
    );
  });

  it('no share is off its exact entitlement by more than one unit', () => {
    // Dust distribution is allowed to move a unit; it is not allowed to
    // reallocate a stake. This is what separates "fair rounding" from "wrong".
    // On `anyAmount()` — a clawback, a reversal or a negative settlement splits
    // the same way, and this bound has to hold there too.
    fc.assert(
      fc.property(anyAmount(), weights(), (total, w) => {
        const totalWeight = sum(w);
        const shares = proRata(total, w);

        shares.forEach((share, i) => {
          const exact = (total * (w[i] ?? 0n)) / totalWeight;
          const delta = share - exact;
          expect(delta >= -1n && delta <= 1n).toBe(true);
        });
      }),
    );
  });

  /**
   * Dust goes to the LARGEST remainders — the rule the implementation names.
   *
   * Conservation alone does not pin this down: an implementation that hands the
   * leftover units to the SMALLEST remainders still sums to `total`, still
   * keeps every share within one unit of its entitlement, and still passes the
   * monotonicity check. That mutant survived this suite until this test, and it
   * is not cosmetic — it systematically pays the participants who earned least
   * of the final unit, every single round, forever.
   *
   * Stated on the MAGNITUDE of the remainder so it means the same thing on both
   * signs. Comparing raw remainders is the bug, not the test of it: on a
   * negative total every remainder is negative except a zero weight's, whose
   * remainder is `0` and therefore the largest — which is precisely how the
   * dust reached participants owed nothing.
   */
  it('hands the leftover units to the largest remainders, not the smallest', () => {
    fc.assert(
      fc.property(anyAmount(), weights(), (total, w) => {
        const totalWeight = sum(w);
        const shares = proRata(total, w);
        const abs = (v: bigint) => (v < 0n ? -v : v);

        const rows = w.map((weight, i) => ({
          // Magnitude of the truncation loss: how much of a unit this
          // participant gave up, regardless of which way the total points.
          remainder: abs((total * weight) % totalWeight),
          // Division truncates toward zero on both signs, so this is the
          // entitlement before dust and the difference is the dust received —
          // +1 on a positive total, -1 on a negative one, hence the magnitude.
          dust: abs((shares[i] ?? 0n) - (total * weight) / totalWeight),
        }));

        for (const a of rows) {
          for (const b of rows) {
            if (a.remainder > b.remainder) {
              expect(a.dust >= b.dust).toBe(true);
            }
          }
        }
      }),
      // Cross-product over up to 40 weights; fewer runs keeps this honest and quick.
      { numRuns: 60 },
    );
  });

  it('gives a larger weight no less than a smaller one', () => {
    fc.assert(
      fc.property(positiveAmount(), weights(), (total, w) => {
        const shares = proRata(total, w);
        const pairs = w.map((weight, i) => ({ weight, share: shares[i] ?? 0n }));
        pairs.sort((a, b) => (a.weight === b.weight ? 0 : a.weight < b.weight ? -1 : 1));

        for (let i = 1; i < pairs.length; i++) {
          // Monotone up to the single unit of dust each share may carry.
          expect((pairs[i]?.share ?? 0n) >= (pairs[i - 1]?.share ?? 0n) - 1n).toBe(true);
        }
      }),
    );
  });

  it('splits a zero total into nothing at all', () => {
    fc.assert(
      fc.property(weights(), (w) => {
        expect(proRata(0n, w).every((s) => s === 0n)).toBe(true);
      }),
    );
  });

  it('refuses a non-positive total weight rather than dividing by zero', () => {
    fc.assert(
      fc.property(anyAmount(), fc.array(fc.bigInt({ min: -(10n ** 12n), max: 0n }), { minLength: 1, maxLength: 10 }), (total, w) => {
        expect(() => proRata(total, w)).toThrow();
      }),
    );
  });

  it('refuses a negative individual weight even when the total weight stays positive', () => {
    fc.assert(
      fc.property(
        anyAmount(),
        fc.bigInt({ min: 1n, max: 10n ** 18n }),
        fc.bigInt({ min: -(10n ** 18n), max: -1n }),
        fc.array(fc.bigInt({ min: 0n, max: 10n ** 18n }), { minLength: 0, maxLength: 8 }),
        (total, positive, negative, rest) => {
          const cover = positive > -negative ? positive : -negative + 1n;
          const w = [cover, negative, ...rest];
          expect(sum(w) > 0n).toBe(true);
          expect(() => proRata(total, w)).toThrow(MoneyError);
        },
      ),
    );
  });
});
