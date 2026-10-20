/**
 * Calendar spread order arithmetic (CB-otc-16): the hold, the anchor window, and the per-leg margin of each fill.
 *
 * The properties that matter are the ones that keep a hold from being short: for ANY order, ANY anchor inside its window
 * and ANY maker price, the leg prices the engine's rule prints stay inside the band the hold includes, and the margin
 * the fills move never adds up to more than the hold.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { SCALE, parseAmount } from '@intafaced/ledger-client';
import { adverseDistance } from './matched-order-plan.js';
import {
  anchorStep,
  anchorWindow,
  crossesSpread,
  engineLegPrices,
  intersectWindows,
  legFillMargin,
  legQtyOf,
  legsSumToSpread,
  orderLegSides,
  pickAnchor,
  readWireListing,
  spreadHoldAmount,
  type ListedLeg,
  type OrderSide,
  type SpreadListing,
  type SpreadOrderTerms,
} from './spread-order-plan.js';

const A = (s: string) => parseAmount(s);

function listing(legs: readonly [ListedLeg, ListedLeg], tick = A('0.01'), lot = A('1')): SpreadListing {
  return { spreadId: 'S', kind: 'calendar', legs, tick, lot };
}

/** far buy 1, near sell 1: the spread is far minus near. */
const CALENDAR = listing([
  { marketId: 'far', side: 'buy', ratio: A('1') },
  { marketId: 'near', side: 'sell', ratio: A('1') },
]);

function terms(
  l: SpreadListing,
  side: OrderSide,
  limit: bigint,
  marks: readonly [bigint, bigint],
  band = A('0.05'),
  qty = A('2'),
  leverage = A('10'),
): SpreadOrderTerms {
  const delta = (mark: bigint) => (mark * band) / SCALE;
  return {
    side,
    qty,
    limit,
    leverage,
    listing: l,
    legs: [
      { ratio: l.legs[0].ratio, mark: marks[0], delta: delta(marks[0]) },
      { ratio: l.legs[1].ratio, mark: marks[1], delta: delta(marks[1]) },
    ],
  };
}

describe('readWireListing', () => {
  const wire = {
    spreadId: 'SPR',
    kind: 'calendar',
    legs: [
      { symbol: 'far', side: 'buy', ratio: '1' },
      { symbol: 'near', side: 'sell', ratio: '1' },
    ],
    tick: '0.01',
    lot: '1',
  };

  it('reads a listing exactly as the engine serves it', () => {
    const read = readWireListing(wire);
    expect(read.ok).toBe(true);
    if (read.ok) expect(read.listing.legs[1]).toEqual({ marketId: 'near', side: 'sell', ratio: A('1') });
  });

  it.each([
    ['a missing tick', { ...wire, tick: '' }],
    ['a zero lot', { ...wire, lot: '0' }],
    ['one leg', { ...wire, legs: [wire.legs[0]] }],
    ['two buys', { ...wire, legs: [wire.legs[0], { ...wire.legs[1], side: 'buy' }] }],
    ['the same leg twice', { ...wire, legs: [wire.legs[0], { ...wire.legs[0], side: 'sell' }] }],
    ['a blank ratio', { ...wire, legs: [{ ...wire.legs[0], ratio: ' ' }, wire.legs[1]] }],
    ['an unknown kind', { ...wire, kind: 'butterfly' }],
  ])('refuses %s and fills nothing in', (_name, bad) => {
    expect(readWireListing(bad).ok).toBe(false);
  });
});

describe('engineLegPrices (the engine rule)', () => {
  it('prints leg 0 at the anchor and leg 1 at the exact residual, for a calendar', () => {
    // far - near = 5 with far = 105: near = 100.
    expect(engineLegPrices(CALENDAR, A('105'), A('5'))).toEqual([A('105'), A('100')]);
  });

  it('refuses a spread price that leaves the residual leg at or below zero', () => {
    expect(engineLegPrices(CALENDAR, A('105'), A('105'))).toBeNull();
    expect(engineLegPrices(CALENDAR, A('105'), A('200'))).toBeNull();
  });

  it('a negative spread price is a near leg dearer than the far leg', () => {
    expect(engineLegPrices(CALENDAR, A('100'), A('-3'))).toEqual([A('100'), A('103')]);
    expect(legsSumToSpread(CALENDAR, A('-3'), [A('100'), A('103')])).toBe(true);
  });
});

describe('the hold', () => {
  it('is, for each leg, the initial margin at the mark plus the full band half-width on the leg quantity', () => {
    // Two lots at 10x. Far leg: 2 x 105 / 10 = 21 plus 2 x 5.25 = 10.5. Near leg: 2 x 100 / 10 = 20 plus 2 x 5 = 10.
    const t = terms(CALENDAR, 'buy', A('5'), [A('105'), A('100')]);
    expect(spreadHoldAmount(t)).toBe(A('61.5'));
  });

  it('does not depend on the side or the spread price: the cover is the band, not the price', () => {
    const base = spreadHoldAmount(terms(CALENDAR, 'buy', A('5'), [A('105'), A('100')]));
    expect(spreadHoldAmount(terms(CALENDAR, 'sell', A('4.5'), [A('105'), A('100')]))).toBe(base);
  });

  it('counts a ratio: two units of the first leg per spread lot', () => {
    const l = listing([
      { marketId: 'eth', side: 'buy', ratio: A('2') },
      { marketId: 'btc', side: 'sell', ratio: A('1') },
    ]);
    const t = terms(l, 'buy', A('10'), [A('50'), A('100')], A('0.05'), A('1'));
    // eth leg: 2 x 50 / 10 = 10 + 2 x 2.5 = 5 ; btc leg: 1 x 100 / 10 = 10 + 5.
    expect(spreadHoldAmount(t)).toBe(A('30'));
  });
});

describe('the anchor window', () => {
  it('is the set of anchors at which neither leg prints further against the order than its band', () => {
    // A buyer buys far (R <= 105 + 5.25) and sells near (near = R - 5 >= 95, so R >= 100).
    expect(anchorWindow(terms(CALENDAR, 'buy', A('5'), [A('105'), A('100')]))).toEqual({ lo: A('100'), hi: A('110.25') });
    // A seller sells far (R >= 99.75) and buys near (near = R - 5 <= 105, so R <= 110).
    expect(anchorWindow(terms(CALENDAR, 'sell', A('5'), [A('105'), A('100')]))).toEqual({ lo: A('99.75'), hi: A('110') });
  });

  it('is empty when the price puts a leg outside its band whatever the anchor', () => {
    // A buyer at spread 25 would sell near at R - 25 >= 95, so R >= 120, but buying far needs R <= 110.25.
    const w = anchorWindow(terms(CALENDAR, 'buy', A('25'), [A('105'), A('100')]));
    expect(w.lo > w.hi).toBe(true);
    expect(pickAnchor({ mark: A('105'), step: 1n, window: w })).toBeNull();
  });

  it('rounds inward: a bound that is not on the unit grid shrinks the window, never grows it', () => {
    const l = listing([
      { marketId: 'a', side: 'buy', ratio: A('3') },
      { marketId: 'b', side: 'sell', ratio: A('1') },
    ]);
    const t = terms(l, 'buy', A('1'), [A('10'), A('30')], A('0.05'), A('1'));
    const w = anchorWindow(t);
    // hi from leg 0: 10.5 ; lo from leg 1: (P1 = 3R - 1 >= 28.5) so R >= 9.8333.. -> ceiled.
    expect(w.hi).toBe(A('10.5'));
    expect(w.lo * 3n >= A('29.5')).toBe(true);
    expect((w.lo - 1n) * 3n < A('29.5')).toBe(true);
  });

  it('a taker is never sent outside the window of a resting order it can cross', () => {
    const maker = anchorWindow(terms(CALENDAR, 'sell', A('5'), [A('105'), A('100')]));
    const taker = anchorWindow(terms(CALENDAR, 'buy', A('5'), [A('120'), A('115')]));
    // The taker's own window is far above the maker's: no anchor serves both.
    const both = intersectWindows([maker, taker]);
    expect(both.lo > both.hi).toBe(true);
    expect(pickAnchor({ mark: A('120'), step: 1n, window: both })).toBeNull();
  });
});

describe('pickAnchor', () => {
  const window = { lo: A('100'), hi: A('110.25') };

  it('takes the mark itself when it is inside the window and on the grid', () => {
    expect(pickAnchor({ mark: A('105'), step: A('0.01'), window })).toBe(A('105'));
  });

  it('clamps a mark outside the window to its nearest grid point', () => {
    expect(pickAnchor({ mark: A('90'), step: A('0.5'), window })).toBe(A('100'));
    expect(pickAnchor({ mark: A('130'), step: A('0.5'), window })).toBe(A('110'));
  });

  it('is null when the window holds no grid point', () => {
    expect(pickAnchor({ mark: A('105'), step: A('20'), window: { lo: A('101'), hi: A('110') } })).toBeNull();
  });
});

describe('anchorStep', () => {
  it('is one unit for ratio 1:1 and keeps every multiple exact for ratios that need it', () => {
    expect(anchorStep(CALENDAR)).toBe(1n);
    const l = listing([
      { marketId: 'a', side: 'buy', ratio: A('0.5') },
      { marketId: 'b', side: 'sell', ratio: A('3') },
    ]);
    const step = anchorStep(l);
    for (const k of [1n, 2n, 3n, 7n, 1000n]) {
      const r = k * step + A('100') - ((A('100') % step) as bigint);
      expect(engineLegPrices(l, r, A('3'))).not.toBeNull();
    }
  });
});

describe('legFillMargin', () => {
  it('moves each leg its share of the hold, and flags a leg printed past its band', () => {
    const t = terms(CALENDAR, 'buy', A('5'), [A('105'), A('100')]);
    // One lot at the mark of both legs: initial margin only.
    const atMark = legFillMargin({ terms: t, leg: 0, before: { spreadFilled: 0n, adverseNum: 0n }, fillQty: A('1'), legPrice: A('105') });
    expect(atMark.amount).toBe(A('10.5'));
    expect(atMark.outsideCover).toBe(false);
    // The buyer buys far dearer than the band allows.
    const past = legFillMargin({ terms: t, leg: 0, before: { spreadFilled: 0n, adverseNum: 0n }, fillQty: A('1'), legPrice: A('111') });
    expect(past.outsideCover).toBe(true);
    // The buyer sells near cheaper than the band allows.
    const cheap = legFillMargin({ terms: t, leg: 1, before: { spreadFilled: 0n, adverseNum: 0n }, fillQty: A('1'), legPrice: A('94') });
    expect(cheap.outsideCover).toBe(true);
  });

  it('the legs of every fill the window allows sum to no more than the hold, fill by fill, to the last unit', () => {
    fc.assert(
      fc.property(
        fc.record({
          side: fc.constantFrom<OrderSide>('buy', 'sell'),
          legSides: fc.constantFrom<'cf' | 'fc'>('cf', 'fc'),
          r0: fc.constantFrom(A('1'), A('2'), A('0.5'), A('3')),
          r1: fc.constantFrom(A('1'), A('2'), A('0.5')),
          m0: fc.integer({ min: 20, max: 500 }),
          m1: fc.integer({ min: 20, max: 500 }),
          band: fc.constantFrom(A('0.01'), A('0.05'), A('0.2')),
          lots: fc.integer({ min: 1, max: 6 }),
          lev: fc.constantFrom(A('1'), A('3.5'), A('10'), A('25')),
          spreadSteps: fc.integer({ min: -200, max: 200 }),
          fills: fc.array(fc.integer({ min: 1, max: 3 }), { minLength: 1, maxLength: 6 }),
          anchorPick: fc.double({ min: 0, max: 1, noNaN: true }),
        }),
        (c) => {
          const l = listing(
            c.legSides === 'cf'
              ? [
                  { marketId: 'a', side: 'buy', ratio: c.r0 },
                  { marketId: 'b', side: 'sell', ratio: c.r1 },
                ]
              : [
                  { marketId: 'a', side: 'sell', ratio: c.r0 },
                  { marketId: 'b', side: 'buy', ratio: c.r1 },
                ],
          );
          const marks: [bigint, bigint] = [BigInt(c.m0) * SCALE, BigInt(c.m1) * SCALE];
          // A price near the marks' own spread, on the tick.
          const s0 = l.legs[0].side === 'buy' ? 1n : -1n;
          const natural = s0 * ((c.r0 * marks[0]) / SCALE - (c.r1 * marks[1]) / SCALE);
          const limit = natural + BigInt(c.spreadSteps) * l.tick;
          const qty = BigInt(c.lots) * A('6');
          const t = terms(l, c.side, limit, marks, c.band, qty, c.lev);
          const w = anchorWindow(t);
          const step = anchorStep(l);
          fc.pre(w.lo <= w.hi);
          // An anchor anywhere on the grid inside the window.
          const span = (w.hi - w.lo) / step;
          const anchor = (w.lo / step + 1n + BigInt(Math.floor(Number(span > 1000000n ? 1000000n : span) * c.anchorPick))) * step;
          fc.pre(anchor >= w.lo && anchor <= w.hi);
          const prices = engineLegPrices(l, anchor, limit);
          fc.pre(prices !== null);
          const sides = orderLegSides(c.side, l);
          // Every leg price stays inside the band against the order.
          for (const i of [0, 1] as const) {
            expect(adverseDistance(sides[i], prices![i], t.legs[i].mark) <= t.legs[i].delta).toBe(true);
          }
          // Fill the order in pieces at those prices, and add up what each leg moves.
          const hold = spreadHoldAmount(t);
          let filled = 0n;
          const adverse: [bigint, bigint] = [0n, 0n];
          const need: [bigint, bigint] = [0n, 0n];
          let moved = 0n;
          for (const lots of c.fills) {
            const fillQty = BigInt(lots) * A('1');
            if (filled + fillQty > qty) break;
            for (const i of [0, 1] as const) {
              const step2 = legFillMargin({
                terms: t,
                leg: i,
                before: { spreadFilled: filled, adverseNum: adverse[i] },
                fillQty,
                legPrice: prices![i],
              });
              expect(step2.outsideCover).toBe(false);
              adverse[i] = step2.adverseNum;
              need[i] = step2.need;
              moved += step2.amount;
            }
            filled += fillQty;
            expect(moved).toBe(need[0] + need[1]);
            expect(moved <= hold).toBe(true);
          }
          // Filled in full, the legs need no more than the hold; and legQtyOf agrees with the ratio.
          expect(legQtyOf(A('6'), c.r0)).toBe((A('6') * c.r0) / SCALE);
        },
      ),
      { numRuns: 400 },
    );
  });

  it('an anchor just outside the window prints at least one leg past its band (the window is not too small)', () => {
    fc.assert(
      fc.property(
        fc.record({
          side: fc.constantFrom<OrderSide>('buy', 'sell'),
          m0: fc.integer({ min: 50, max: 400 }),
          m1: fc.integer({ min: 50, max: 400 }),
          steps: fc.integer({ min: -50, max: 50 }),
        }),
        (c) => {
          const marks: [bigint, bigint] = [BigInt(c.m0) * SCALE, BigInt(c.m1) * SCALE];
          const limit = marks[0] - marks[1] + BigInt(c.steps) * A('0.01');
          const t = terms(CALENDAR, c.side, limit, marks);
          const w = anchorWindow(t);
          fc.pre(w.lo <= w.hi && w.lo > 1n);
          const sides = orderLegSides(c.side, CALENDAR);
          for (const r of [w.lo - 1n, w.hi + 1n]) {
            const p = engineLegPrices(CALENDAR, r, limit);
            if (p === null) continue;
            const past = [0, 1].some(
              (i) => adverseDistance(sides[i as 0 | 1], p[i as 0 | 1], t.legs[i as 0 | 1].mark) > t.legs[i as 0 | 1].delta,
            );
            expect(past).toBe(true);
          }
        },
      ),
      { numRuns: 300 },
    );
  });
});

describe('crossesSpread', () => {
  it('a buy crosses sells at or below its limit, a sell crosses buys at or above it, and a side never crosses itself', () => {
    expect(crossesSpread({ side: 'buy', limit: A('5') }, { side: 'sell', limit: A('4.99') })).toBe(true);
    expect(crossesSpread({ side: 'buy', limit: A('5') }, { side: 'sell', limit: A('5') })).toBe(true);
    expect(crossesSpread({ side: 'buy', limit: A('5') }, { side: 'sell', limit: A('5.01') })).toBe(false);
    expect(crossesSpread({ side: 'sell', limit: A('-1') }, { side: 'buy', limit: A('-1') })).toBe(true);
    expect(crossesSpread({ side: 'sell', limit: A('-1') }, { side: 'buy', limit: A('-1.5') })).toBe(false);
    expect(crossesSpread({ side: 'buy', limit: A('5') }, { side: 'buy', limit: A('1') })).toBe(false);
  });
});
