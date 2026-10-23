import { describe, expect, it } from 'vitest';
import { parseAmount } from '@intafaced/ledger-client';
import {
  FUTURES_PRICE_BAND_UNSET,
  SCALE,
  adverseDistance,
  adverseNumerator,
  bankruptcyPrice,
  correctToBand,
  feeSplit,
  fillFee,
  fillMargin,
  fillWithinLimit,
  limitWithinBand,
  marginNeed,
  marketOpenLimit,
  marketReduceLimit,
  orderFeeReserve,
  perpetualFeeRates,
  orderHoldAmount,
  parsePriceBand,
  planReduceFill,
  priceBandAround,
  protectiveLimit,
  reduceFillProfitId,
  reduceFillRecipes,
  reducingSide,
  SPLIT_MAX_CHILDREN,
  splitPlan,
  weightedEntry,
  withinBankruptcy,
} from './matched-order-plan.js';
import { unrealizedPnl } from './liquidation-planner.js';
import { parseFeeScheduleJson, UNPUBLISHED_FEE_SCHEDULE } from '../spot/fee-schedule.js';

const A = (s: string) => parseAmount(s);

/** Deterministic pseudo-random bigints in [min, max], so a failure reproduces. */
function rng(seed: number) {
  let x = seed >>> 0;
  return (max: bigint): bigint => {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    return BigInt(x) % (max + 1n);
  };
}

describe('matched order plan: the owner band', () => {
  it('blank is unset, never a default', () => {
    expect(parsePriceBand('')).toBeNull();
    expect(parsePriceBand('   ')).toBeNull();
    expect(parsePriceBand(undefined)).toBeNull();
    expect(FUTURES_PRICE_BAND_UNSET).toBe('trade.futures_price_band_unset');
  });

  it('a fraction strictly between 0 and 1 parses; anything else is an error at boot', () => {
    expect(parsePriceBand('0.05')).toBe(A('0.05'));
    expect(() => parsePriceBand('0')).toThrow(/TRADE_FUTURES_PRICE_BAND/);
    expect(() => parsePriceBand('1')).toThrow(/TRADE_FUTURES_PRICE_BAND/);
    expect(() => parsePriceBand('1.5')).toThrow(/TRADE_FUTURES_PRICE_BAND/);
    expect(() => parsePriceBand('-0.1')).toThrow();
    expect(() => parsePriceBand('five')).toThrow();
  });

  it('the band is the mark plus or minus the fraction, and a limit is inside it', () => {
    const band = priceBandAround(A('100'), A('0.05'));
    expect(band.low).toBe(A('95'));
    expect(band.high).toBe(A('105'));
    expect(limitWithinBand(A('105'), band)).toBe(true);
    expect(limitWithinBand(A('95'), band)).toBe(true);
    expect(limitWithinBand(A('105.000000000000000001'), band)).toBe(false);
    expect(limitWithinBand(A('94.999999999999999999'), band)).toBe(false);
  });

  it('a market order takes the band edge on its own side', () => {
    const band = priceBandAround(A('100'), A('0.05'));
    expect(protectiveLimit('buy', band)).toBe(A('105'));
    expect(protectiveLimit('sell', band)).toBe(A('95'));
  });
});

describe('matched order plan: slippage cap, price correction and split (D-orders-06)', () => {
  const band = priceBandAround(A('100'), A('0.05'));

  it('a market open stops at the slippage cap when it is tighter than the band, else at the band edge', () => {
    expect(marketOpenLimit('buy', A('100'), band, 50)).toBe(A('100.5'));
    expect(marketOpenLimit('sell', A('100'), band, 50)).toBe(A('99.5'));
    // A cap wider than the band never lets the limit past the band.
    expect(marketOpenLimit('buy', A('100'), band, 900)).toBe(A('105'));
    expect(marketOpenLimit('sell', A('100'), band, 900)).toBe(A('95'));
    // The cap's distance rounds down: the limit never sits past the cap.
    expect(marketOpenLimit('buy', A('0.000000000000000333'), priceBandAround(A('0.000000000000000333'), A('0.5')), 1)).toBe(
      A('0.000000000000000333'),
    );
  });

  it('adjust moves a limit outside the band to the nearer edge and leaves one inside alone', () => {
    expect(correctToBand(A('120'), band)).toBe(A('105'));
    expect(correctToBand(A('80'), band)).toBe(A('95'));
    expect(correctToBand(A('101'), band)).toBe(A('101'));
    expect(correctToBand(A('105'), band)).toBe(A('105'));
  });

  it('an order above the cap splits into full children of the largest lot multiple within the cap, then the rest', () => {
    // 1000 at a mark of 100 is 10 a child; 10 lots of 0.001 fit exactly.
    const plan = splitPlan({ qty: A('25'), sizedAt: A('100'), maxOrderNotional: A('1000'), lotSize: A('0.001') });
    expect(plan).toEqual({ ok: true, parts: [A('10'), A('10'), A('5')] });
    // A mark that does not divide the cap: each child rounds down to a lot, so its notional stays within the cap.
    const odd = splitPlan({ qty: A('1'), sizedAt: A('300'), maxOrderNotional: A('100'), lotSize: A('0.01') });
    expect(odd.ok).toBe(true);
    if (!odd.ok) return;
    expect(odd.parts.slice(0, -1).every((p) => p === A('0.33'))).toBe(true);
    for (const part of odd.parts) expect((part * A('300')) / SCALE <= A('100')).toBe(true);
    expect(odd.parts.reduce((a, b) => a + b, 0n)).toBe(A('1'));
  });

  it('within the cap is one part; one lot over the cap and too many children are not splittable', () => {
    expect(splitPlan({ qty: A('5'), sizedAt: A('100'), maxOrderNotional: A('1000'), lotSize: A('0.001') })).toEqual({
      ok: true,
      parts: [A('5')],
    });
    expect(splitPlan({ qty: A('5'), sizedAt: A('100'), maxOrderNotional: A('10'), lotSize: A('1') })).toEqual({
      ok: false,
      reason: 'lot_over_cap',
    });
    const many = splitPlan({ qty: A('1000'), sizedAt: A('100'), maxOrderNotional: A('100'), lotSize: A('1') });
    expect(many).toEqual({ ok: false, reason: 'too_many_children', children: 1000n });
    expect(splitPlan({ qty: A(String(SPLIT_MAX_CHILDREN)), sizedAt: A('100'), maxOrderNotional: A('100'), lotSize: A('1') }).ok).toBe(true);
  });

  it('a retry keeps the child size its first attempt used, whatever the mark is now', () => {
    const retry = splitPlan({ qty: A('25'), sizedAt: A('125'), maxOrderNotional: A('1000'), lotSize: A('0.001'), childSize: A('10') });
    expect(retry).toEqual({ ok: true, parts: [A('10'), A('10'), A('5')] });
  });

  it('the children always add up to the order, across random sizes, marks and lots', () => {
    const next = rng(6);
    for (let i = 0; i < 500; i++) {
      const lot = (next(999n) + 1n) * 10n ** 12n;
      const qty = (next(10_000n) + 1n) * lot;
      const mark = (next(100_000n) + 1n) * SCALE;
      const cap = (next(1_000_000n) + 1n) * SCALE;
      const plan = splitPlan({ qty, sizedAt: mark, maxOrderNotional: cap, lotSize: lot });
      if (!plan.ok) continue;
      expect(plan.parts.reduce((a, b) => a + b, 0n)).toBe(qty);
      if (plan.parts.length > 1) for (const part of plan.parts) expect((part * mark) / SCALE <= cap).toBe(true);
    }
  });
});

describe('matched order plan: adverse distance and fills', () => {
  it('a price at or better than the mark carries no adverse distance', () => {
    expect(adverseDistance('buy', A('100'), A('100'))).toBe(0n);
    expect(adverseDistance('buy', A('99'), A('100'))).toBe(0n);
    expect(adverseDistance('sell', A('101'), A('100'))).toBe(0n);
    expect(adverseDistance('buy', A('103'), A('100'))).toBe(A('3'));
    expect(adverseDistance('sell', A('97'), A('100'))).toBe(A('3'));
  });

  it('a fill inside its own limit, on its own side only', () => {
    expect(fillWithinLimit('buy', A('100'), A('100'))).toBe(true);
    expect(fillWithinLimit('buy', A('100.000000000000000001'), A('100'))).toBe(false);
    expect(fillWithinLimit('sell', A('100'), A('100'))).toBe(true);
    expect(fillWithinLimit('sell', A('99.999999999999999999'), A('100'))).toBe(false);
  });

  it('the hold is the fill-at-limit need, and a fill at the mark owes only initial margin', () => {
    // 1 unit at mark 100, leverage 10: initial margin 10, no adverse distance.
    const hold = orderHoldAmount({ side: 'buy', qty: A('1'), limit: A('100'), mark: A('100'), leverage: A('10') });
    expect(hold).toBe(A('10'));
    // The same order with a limit of 105 holds the adverse distance as well.
    const held = orderHoldAmount({ side: 'buy', qty: A('1'), limit: A('105'), mark: A('100'), leverage: A('10') });
    expect(held).toBe(A('15'));
    const first = fillMargin(
      { filled: 0n, adverseNum: 0n },
      { side: 'buy', qty: A('1'), price: A('100'), mark: A('100'), leverage: A('10') },
    );
    expect(first.amount).toBe(A('10'));
  });

  it('a fill at a better price than its limit posts less than the hold; the rest is not used by it', () => {
    const hold = orderHoldAmount({ side: 'buy', qty: A('1'), limit: A('105'), mark: A('100'), leverage: A('10') });
    const step = fillMargin(
      { filled: 0n, adverseNum: 0n },
      { side: 'buy', qty: A('1'), price: A('102'), mark: A('100'), leverage: A('10') },
    );
    expect(step.amount).toBe(A('12'));
    expect(step.amount <= hold).toBe(true);
  });

  it('need never falls and the fills telescope exactly to the need of the total', () => {
    const r = rng(7);
    for (let trial = 0; trial < 200; trial++) {
      const side = trial % 2 === 0 ? 'buy' : 'sell';
      const mark = A('100') + r(A('50'));
      const leverage = A('1') + r(A('9'));
      const limit = side === 'buy' ? mark + r(A('8')) : mark - r(A('8'));
      const qty = A('1') + r(A('20'));
      const hold = orderHoldAmount({ side, qty, limit, mark, leverage });
      let before = { filled: 0n, adverseNum: 0n };
      let spent = 0n;
      let remaining = qty;
      while (remaining > 0n) {
        const want = A('1') + r(A('3'));
        const q = want > remaining ? remaining : want;
        // A fill prices within its own limit, anywhere between the mark and the limit.
        const towardLimit = side === 'buy' ? (limit > mark ? limit - mark : 0n) : mark > limit ? mark - limit : 0n;
        const price =
          side === 'buy' ? mark + (towardLimit === 0n ? 0n : r(towardLimit)) : mark - (towardLimit === 0n ? 0n : r(towardLimit));
        const step = fillMargin(before, { side, qty: q, price, mark, leverage });
        expect(step.amount >= 0n).toBe(true);
        expect(step.need >= before.filled).toBe(true);
        spent += step.amount;
        before = { filled: step.filled, adverseNum: step.adverseNum };
        remaining -= q;
      }
      // Telescoping: the sum of what every fill posted is the need of the whole order at its fill prices.
      expect(spent).toBe(marginNeed({ ...before, mark, leverage }));
      // And it never exceeds the hold, which was computed at the limit.
      expect(spent <= hold).toBe(true);
      expect(adverseNumerator(side, qty, limit, mark) >= before.adverseNum).toBe(true);
    }
  });

  it('a weighted entry is the size-weighted average, floored', () => {
    expect(weightedEntry({ size: 0n, entryPrice: 0n }, { qty: A('2'), price: A('100') })).toBe(A('100'));
    expect(weightedEntry({ size: A('2'), entryPrice: A('100') }, { qty: A('2'), price: A('110') })).toBe(A('105'));
    expect(SCALE).toBe(10n ** 18n);
  });
});

describe('matched order plan: reduce-only, the bankruptcy bound and the reduce fill (slice 6b)', () => {
  it('a reduce is on the side opposite its position', () => {
    expect(reducingSide('long')).toBe('sell');
    expect(reducingSide('short')).toBe('buy');
  });

  it('the bankruptcy price is where the loss equals the margin, rounded toward the entry', () => {
    // Long 2 at 100 with 20 margin: 10 per unit, so 90. Short mirrors at 110.
    expect(bankruptcyPrice({ side: 'long', size: A('2'), entryPrice: A('100'), margin: A('20') })).toBe(A('90'));
    expect(bankruptcyPrice({ side: 'short', size: A('2'), entryPrice: A('100'), margin: A('20') })).toBe(A('110'));
    // 10 margin over 3 units is 3.333…: a long's price rounds UP, a short's DOWN, so the loss at it fits the margin.
    const long = bankruptcyPrice({ side: 'long', size: A('3'), entryPrice: A('100'), margin: A('10') });
    const short = bankruptcyPrice({ side: 'short', size: A('3'), entryPrice: A('100'), margin: A('10') });
    expect(long).toBe(A('96.666666666666666667'));
    expect(short).toBe(A('103.333333333333333333'));
    expect(-unrealizedPnl('long', A('3'), A('100'), long) <= A('10')).toBe(true);
    expect(-unrealizedPnl('short', A('3'), A('100'), short) <= A('10')).toBe(true);
    // A long with margin past its notional has no bankruptcy price above zero.
    expect(bankruptcyPrice({ side: 'long', size: A('1'), entryPrice: A('100'), margin: A('150') })).toBe(0n);
  });

  it('a price is inside the bound at or above a long bankruptcy price, at or below a short one', () => {
    expect(withinBankruptcy('long', A('90'), A('90'))).toBe(true);
    expect(withinBankruptcy('long', A('89.99'), A('90'))).toBe(false);
    expect(withinBankruptcy('short', A('110'), A('110'))).toBe(true);
    expect(withinBankruptcy('short', A('110.01'), A('110'))).toBe(false);
  });

  it('a market reduce takes the band edge, pulled in to the bankruptcy price, or nothing when the bound is past the band', () => {
    const band = { low: A('95'), high: A('105') };
    expect(marketReduceLimit('long', band, A('90'))).toBe(A('95'));
    expect(marketReduceLimit('long', band, A('97'))).toBe(A('97'));
    expect(marketReduceLimit('long', band, A('106'))).toBeNull();
    expect(marketReduceLimit('short', band, A('110'))).toBe(A('105'));
    expect(marketReduceLimit('short', band, A('101'))).toBe(A('101'));
    expect(marketReduceLimit('short', band, A('94'))).toBeNull();
  });

  it('a reduce fill at a profit returns the margin share and books the profit; at a loss the loss comes out of the share', () => {
    const position = { side: 'long' as const, size: A('2'), entryPrice: A('100'), margin: A('20'), marginInitial: A('20') };
    const win = planReduceFill({ ...position, qty: A('1'), price: A('104') });
    expect(win).toMatchObject({ profit: A('4'), fromMargin: 0n, release: A('10'), potOut: A('10'), remainMargin: A('10') });
    expect(win.closes).toBe(false);
    const lose = planReduceFill({ ...position, qty: A('1'), price: A('97') });
    expect(lose).toMatchObject({ profit: 0n, fromMargin: A('3'), release: A('7'), potOut: A('10'), fromInsurance: 0n });
    const all = planReduceFill({ ...position, qty: A('2'), price: A('90') });
    expect(all).toMatchObject({ fromMargin: A('20'), release: 0n, remainMargin: 0n, fromInsurance: 0n, closes: true });
    // Past the bound the excess is left for the insurance bound; the planner never hides it.
    const past = planReduceFill({ ...position, qty: A('2'), price: A('89') });
    expect(past).toMatchObject({ fromMargin: A('20'), fromInsurance: A('2') });
  });

  it('the keys hang off the fill intent: loss, release and profit legs, none of them random', () => {
    const legs = reduceFillRecipes({
      fillKey: 'm:7:p',
      positionId: 'p',
      userId: 'u',
      assetId: 'USDT',
      plan: { fromMargin: A('1'), fromInsurance: 0n, release: A('2') },
    });
    expect(legs.loss?.idempotencyKey).toBe('futures.loss:fill:m:7:p:loss');
    expect(legs.release?.idempotencyKey).toBe('futures.margin.release:p:fill:m:7:p:release');
    expect(reduceFillProfitId('m:7:p')).toBe('fill:m:7:p:profit');
    const none = reduceFillRecipes({
      fillKey: 'm:8:p',
      positionId: 'p',
      userId: 'u',
      assetId: 'USDT',
      plan: { fromMargin: 0n, fromInsurance: 0n, release: 0n },
    });
    expect(none).toEqual({ loss: null, release: null });
  });

  it('rounding past the whole margin within the allowance is left unbooked; beyond it, it is a real loss for the insurance bound', () => {
    const position = { side: 'long' as const, size: A('2'), entryPrice: A('100'), margin: A('20'), marginInitial: A('20') };
    const dust = planReduceFill({ ...position, margin: A('20') - 1n, qty: A('2'), price: A('90'), roundingAllowance: 1n });
    expect(dust).toMatchObject({ fromMargin: A('20') - 1n, unbooked: 1n, fromInsurance: 0n });
    const real = planReduceFill({ ...position, margin: A('20') - 2n, qty: A('2'), price: A('90'), roundingAllowance: 1n });
    expect(real).toMatchObject({ fromMargin: A('20') - 2n, unbooked: 0n, fromInsurance: 2n });
  });

  it('inside the bound it was placed under, reduce fills never reach the insurance fund, and the margin is conserved', () => {
    let x = 6_2026;
    // 128-bit draws, so sizes, prices and margins carry all 18 decimals and the rounding at the bound is exercised.
    const next = (max: bigint): bigint => {
      let v = 0n;
      for (let i = 0; i < 4; i++) {
        x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
        v = (v << 32n) | BigInt(x);
      }
      return v % (max + 1n);
    };
    for (let trial = 0; trial < 4000; trial++) {
      const side = next(1n) === 0n ? ('long' as const) : ('short' as const);
      // Every order of magnitude, from one unit up: the rounding at the bound bites when the margin per unit is small.
      const size = 1n + next(10n ** next(22n));
      const entry = A('0.01') + next(10n ** (16n + next(7n)));
      const notional = (size * entry) / SCALE;
      const cap = notional > 2n ? notional / 2n : 1n;
      const scale = 10n ** next(36n);
      const margin = 1n + next(scale < cap ? scale : cap);
      const bound = bankruptcyPrice({ side, size, entryPrice: entry, margin });
      let row = { size, margin, initial: margin };
      let leftThePot = 0n;
      let fills = 0n;
      while (row.size > 0n && fills < 6n) {
        // Slices of every size, down to one unit: a slice too small to carry a unit of margin share still books its loss.
        const room = row.size - 1n;
        const reach = 10n ** next(22n);
        const qty = next(2n) === 0n || fills === 5n || room === 0n ? row.size : 1n + next(reach < room ? reach : room);
        // Half the fills land exactly on the bound, the rest anywhere between it and the entry.
        const span = side === 'long' ? entry - bound : bound - entry;
        const price = next(1n) === 0n ? bound : side === 'long' ? bound + next(span) : bound - next(span);
        if (price <= 0n) break;
        const plan = planReduceFill({
          side,
          size: row.size,
          entryPrice: entry,
          margin: row.margin,
          marginInitial: row.initial,
          qty,
          price,
          roundingAllowance: fills,
        });
        expect(plan.fromInsurance, `trial ${trial}`).toBe(0n);
        expect(plan.unbooked <= fills).toBe(true);
        expect(plan.potOut + plan.remainMargin).toBe(row.margin);
        expect(plan.release >= 0n && plan.fromMargin >= 0n && plan.remainMargin >= 0n).toBe(true);
        // Inside the bound of the position as it is NOW, nothing is ever left unbooked.
        const current = bankruptcyPrice({ side, size: row.size, entryPrice: entry, margin: row.margin });
        if (withinBankruptcy(side, price, current)) expect(plan.unbooked).toBe(0n);
        leftThePot += plan.potOut;
        fills += 1n;
        row = { size: plan.remainQty, margin: plan.remainMargin, initial: plan.remainInitial };
      }
      if (row.size === 0n) expect(leftThePot).toBe(margin);
    }
  });

  it('a real sequence where the rounding at the bound would charge one unit past the margin: it is left unbooked', () => {
    // Found by the property above's generator. A short at full precision; two small slices inside the bound, the
    // second taking its loss partly from the remainder, then the rest closed exactly at the bound it was placed under.
    const side = 'short' as const;
    const entry = 1000000003059801873n;
    let row = { size: 100003622801402n, margin: 3773041981n, initial: 3773041981n };
    const bound = bankruptcyPrice({ side, size: row.size, entryPrice: entry, margin: row.margin });
    expect(bound).toBe(1000037732112763213n);
    const fills = [
      { qty: 4223563215n, price: 1000037731283211037n },
      { qty: 176484067n, price: 1000037729724429545n },
    ];
    let k = 0n;
    for (const f of fills) {
      const plan = planReduceFill({
        side,
        size: row.size,
        entryPrice: entry,
        margin: row.margin,
        marginInitial: row.initial,
        ...f,
        roundingAllowance: k,
      });
      expect(plan.unbooked).toBe(0n);
      row = { size: plan.remainQty, margin: plan.remainMargin, initial: plan.remainInitial };
      k += 1n;
    }
    const last = { side, size: row.size, entryPrice: entry, margin: row.margin, marginInitial: row.initial, qty: row.size, price: bound };
    // The shared formula charges one unit more than the margin left...
    expect(-planReduceFill(last).realizedPnl).toBe(row.margin + 1n);
    // ...which is rounding within the allowance, never a draw on insurance.
    expect(planReduceFill({ ...last, roundingAllowance: k })).toMatchObject({ fromMargin: row.margin, unbooked: 1n, fromInsurance: 0n });
    // Without the allowance the same unit would have to come from the insurance fund.
    expect(planReduceFill(last)).toMatchObject({ fromInsurance: 1n, unbooked: 0n });
  });
});

describe('trading fees per fill (migration 0099)', () => {
  const rates = { makerBps: 10, takerBps: 20 };

  it('takes the owner’s perpetual block less the rank discount, and refuses a blank one with its own code', () => {
    const schedule = parseFeeScheduleJson(
      JSON.stringify({ published: true, version: 'v1', makerBps: '8', takerBps: '10', perpetual: { makerBps: '10', takerBps: '20' } }),
    );
    expect(perpetualFeeRates(schedule, 0)).toEqual(rates);
    expect(perpetualFeeRates(schedule, 5000)).toEqual({ makerBps: 5, takerBps: 10 });
    expect(() => perpetualFeeRates(UNPUBLISHED_FEE_SCHEDULE, 0)).toThrow(expect.objectContaining({ code: 'trade.fee_schedule_blank' }));
    // The spot rates are not a substitute for an unpublished perpetual block.
    const spotOnly = parseFeeScheduleJson(JSON.stringify({ published: true, version: 'v1', makerBps: '8', takerBps: '10' }));
    expect(() => perpetualFeeRates(spotOnly, 0)).toThrow(expect.objectContaining({ code: 'trade.fee_product_unpublished' }));
  });

  it('charges its own side’s rate at its own price, rounded up to the unit once', () => {
    expect(fillFee({ qty: A('2'), price: A('100'), role: 'maker', rates })).toBe(A('0.2'));
    expect(fillFee({ qty: A('2'), price: A('100'), role: 'taker', rates })).toBe(A('0.4'));
    // 1e-18 × 1 × 0.1% is far below a unit: it is charged as one unit, never as zero.
    expect(fillFee({ qty: 1n, price: A('1'), role: 'maker', rates })).toBe(1n);
    expect(fillFee({ qty: A('2'), price: A('100'), role: 'taker', rates: { makerBps: 0, takerBps: 0 } })).toBe(0n);
    expect(fillFee({ qty: 0n, price: A('100'), role: 'taker', rates })).toBe(0n);
  });

  it('reserves the higher rate on the most the order can cost: a buy at its limit, a sell at the top of its band', () => {
    expect(orderFeeReserve({ side: 'buy', qty: A('2'), limit: A('100'), bandHigh: A('105'), rates })).toBe(A('0.4'));
    expect(orderFeeReserve({ side: 'sell', qty: A('2'), limit: A('100'), bandHigh: A('105'), rates })).toBe(A('0.42'));
    expect(orderFeeReserve({ side: 'sell', qty: A('2'), limit: A('106'), bandHigh: A('105'), rates })).toBe(A('0.424'));
    expect(orderFeeReserve({ side: 'buy', qty: A('2'), limit: A('100'), bandHigh: A('105'), rates: { makerBps: 0, takerBps: 0 } })).toBe(
      0n,
    );
  });

  it('a reserve covers two fills that split the quantity inside its bound, but for one rounding unit the waiver records', () => {
    const draw = rng(99);
    const next = (lo: bigint, hi: bigint) => lo + draw(hi - lo);
    for (let i = 0; i < 300; i += 1) {
      const qty = next(1n, A('50'));
      const limit = next(A('1'), A('200'));
      const bandHigh = limit + next(0n, A('10'));
      const side = i % 2 === 0 ? ('buy' as const) : ('sell' as const);
      const reserve = orderFeeReserve({ side, qty, limit, bandHigh, rates });
      const bound = side === 'buy' ? limit : bandHigh;
      // Two fills that together are the whole quantity, each rounded up on its own.
      const first = next(0n, qty);
      const paid =
        fillFee({ qty: first, price: bound, role: 'taker', rates }) + fillFee({ qty: qty - first, price: bound, role: 'taker', rates });
      // Each fill's own ceiling may add one unit over the reserve's single ceiling; the waiver records that unit.
      expect(paid <= reserve + 1n, `fills ${paid} vs reserve ${reserve}`).toBe(true);
    }
  });

  it('splits a fee between what its source can pay and what is waived, never negative', () => {
    expect(feeSplit(A('0.4'), A('1'))).toEqual({ charged: A('0.4'), waived: 0n });
    expect(feeSplit(A('0.4'), A('0.1'))).toEqual({ charged: A('0.1'), waived: A('0.3') });
    expect(feeSplit(A('0.4'), 0n)).toEqual({ charged: 0n, waived: A('0.4') });
    expect(feeSplit(A('0.4'), -5n)).toEqual({ charged: 0n, waived: A('0.4') });
    expect(feeSplit(0n, A('1'))).toEqual({ charged: 0n, waived: 0n });
  });

  it('a reducing fill whose share is all fee posts a fee-only release; no fee and no share posts none', () => {
    const base = { fillKey: 'm:9:p', positionId: 'p', userId: '11111111-1111-4111-8111-111111111111', assetId: 'USDT' };
    const feeOnly = reduceFillRecipes({ ...base, plan: { fromMargin: A('10'), fromInsurance: 0n, release: 0n }, fee: A('0.05') });
    expect(feeOnly.release?.meta).toMatchObject({ fee: A('0.05').toString() });
    expect(feeOnly.release?.entries).toHaveLength(2);
    const none = reduceFillRecipes({ ...base, plan: { fromMargin: A('10'), fromInsurance: 0n, release: 0n }, fee: 0n });
    expect(none.release).toBeNull();
  });
});
