import { describe, expect, it } from 'vitest';
import { QUANT_PAPER_FEE_UNSET } from '../errors.js';
import { createPaperBook } from './book.js';
import { runIsolate } from './isolate.js';

// J-algo-dev-05 #1 #2 #4 #5 #6: the paper book's orders obey their types, sizing and pre-trade checks.
// Every figure is a TEST simulation input; the fee is a labelled TEST 10 bps.
const limits = { maxOps: 5_000, maxSource: 8_000 };
const run = (source: string, cash = '1000', feeBps: string | null = '10') =>
  runIsolate('javascript', source, createPaperBook({ startingCash: cash, venueVaultSet: false, feeBps }), limits, true);
const kinds = (ran: ReturnType<typeof run>, order: string) => ran.events.filter((e) => e.order === order).map((e) => e.kind);

describe('paper orders (AL-orders-01)', () => {
  it('a limit buy below the market is new, accepted, then filled once the TEST path reaches it; quantity zero is rejected', () => {
    const ran = run(`const a = oms.limitBuy("BTC-USD", "0.01", "49990", "gtc");
const z = oms.limitBuy("BTC-USD", "0", "49990", "gtc");
console.log(a.status);
console.log(z.status);
console.log(z.reason);`);
    expect(kinds(ran, 'o1')).toEqual(['new', 'accepted', 'filled']);
    const placed = ran.events.find((e) => e.order === 'o1' && e.kind === 'new');
    expect(placed).toMatchObject({ type: 'limit', side: 'buy', limit: '49990', market: '50000' });
    const filled = ran.events.find((e) => e.order === 'o1' && e.kind === 'filled');
    expect(Number(filled?.price)).toBeLessThanOrEqual(49990);
    expect(Number(filled?.market)).toBeLessThanOrEqual(49990);
    expect(kinds(ran, 'o2')).toEqual(['rejected']);
    expect(ran.events.find((e) => e.order === 'o2')).toMatchObject({ qty: '0', reason: 'quantity invalid' });
    // The strategy saw the resting order as accepted and the zero order as rejected, with its reason.
    expect(ran.logs).toEqual(['accepted', 'rejected', 'quantity invalid']);
    // The fill moved cash by notional plus fee: 0.01 x 49985 = 499.85, fee 10 bps = 0.49985.
    expect(ran.cash).toBe('499.65015');
    expect(ran.positions).toEqual([{ symbol: 'BTC-USD', qty: '0.01' }]);
  });

  it('cancelling before a fill is cancel pending then cancelled, with no fill; a second cancel is refused', () => {
    const ran = run(`const a = oms.limitBuy("BTC-USD", "0.01", "40000", "gtc");
oms.cancel(a.id);
const again = oms.cancel(a.id);
console.log(again.reason);`);
    expect(kinds(ran, 'o1')).toEqual(['new', 'accepted', 'cancel_pending', 'cancelled']);
    expect(ran.fills).toHaveLength(0);
    expect(ran.cash).toBe('1000');
    expect(ran.logs).toEqual(['not open']);
  });

  it('a limit that never reached stays accepted at the end and holds no fill', () => {
    const ran = run(`oms.limitBuy("BTC-USD", "0.01", "40000", "gtc");`);
    expect(kinds(ran, 'o1')).toEqual(['new', 'accepted']);
    expect(ran.fills).toHaveLength(0);
  });

  it('rejects a bad limit price and an unknown time in force by name', () => {
    const ran = run(`const p = oms.limitBuy("BTC-USD", "0.01", "0", "gtc");
const t = oms.limitBuy("BTC-USD", "0.01", "49990", "day");
console.log(p.reason);
console.log(t.reason);`);
    expect(ran.logs).toEqual(['price invalid', 'time in force invalid']);
    expect(ran.events.every((e) => e.kind === 'rejected')).toBe(true);
  });

  it('a blank paper fee refuses the order by name: the fee is never invented as zero', () => {
    expect(() => run(`oms.buy("BTC-USD", "0.01");`, '1000', null)).toThrow(QUANT_PAPER_FEE_UNSET);
  });
});

describe('pyramiding and reversal (AL-orders-02)', () => {
  it('with pyramiding two, a third entry is rejected with "limit hit" and adds nothing', () => {
    const ran = run(
      `oms.setPyramiding(2);
oms.buy("BTC-USD", "0.01");
oms.buy("BTC-USD", "0.01");
const third = oms.buy("BTC-USD", "0.01");
console.log(third.status);
console.log(third.reason);`,
      '10000',
    );
    expect(ran.events.filter((e) => e.kind === 'filled' && e.side === 'buy')).toHaveLength(2);
    expect(ran.events.filter((e) => e.kind === 'rejected')).toEqual([expect.objectContaining({ reason: 'limit hit' })]);
    expect(ran.logs).toEqual(['rejected', 'limit hit']);
    expect(ran.positions).toEqual([{ symbol: 'BTC-USD', qty: '0.02' }]);
  });

  it('a flat position starts the entry count again', () => {
    const ran = run(
      `oms.setPyramiding(1);
oms.buy("BTC-USD", "0.01");
oms.sell("BTC-USD", "0.01");
const again = oms.buy("BTC-USD", "0.01");
console.log(again.status);`,
      '10000',
    );
    expect(ran.logs).toEqual(['filled']);
  });

  it('refuses a pyramiding that is not a whole number of 1 or more', () => {
    expect(() => run(`oms.setPyramiding("0");`)).toThrow('quant.param_out_of_range');
    expect(() => run(`oms.setPyramiding("1.5");`)).toThrow('quant.param_out_of_range');
  });

  it('reversing long three to short two is two checked legs: the close fills, the open is refused with no short rule', () => {
    const ran = run(
      `oms.buy("BTC-USD", "3");
const r = oms.reverse("BTC-USD", "-2");
console.log(r.legs.length);`,
      '1000000',
    );
    expect(ran.legs).toEqual([
      expect.objectContaining({ leg: 'close', side: 'sell', qty: '3', checked: true, outcome: 'filled', reason: null }),
      expect.objectContaining({ leg: 'open', side: 'sell', qty: '2', checked: true, outcome: 'refused', reason: 'no short rule' }),
    ]);
    expect(ran.logs).toEqual(['2']);
    expect(ran.positions).toEqual([]);
  });
});

describe('pre-trade checks (AL-orders-03)', () => {
  it('a buy whose notional plus fee is more than the cash is rejected with the numbers, and the cash is unchanged', () => {
    const ran = run(`const b = oms.buy("BTC-USD", "0.01");`, '100');
    expect(ran.events).toEqual([
      expect.objectContaining({ kind: 'rejected', reason: 'insufficient cash', notional: '500', fee: '0.5', cash: '100' }),
    ]);
    expect(ran.fills).toHaveLength(0);
    expect(ran.cash).toBe('100');
  });

  it('a buy of exactly the cash less its fee passes; one unit of fee more is rejected', () => {
    // 0.01998 x 50000 = 999 and its fee 0.999: 999.999 against 1000 passes.
    expect(run(`oms.buy("BTC-USD", "0.01998");`).fills).toHaveLength(1);
    expect(run(`oms.buy("BTC-USD", "0.02");`).events[0]).toMatchObject({ kind: 'rejected', reason: 'insufficient cash' });
  });

  it('resting buys hold their cash: a second resting buy past what is left is rejected', () => {
    const ran = run(`const a = oms.limitBuy("BTC-USD", "0.01", "40000", "gtc");
const b = oms.limitBuy("BTC-USD", "0.02", "40000", "gtc");
console.log(b.reason);`);
    expect(ran.logs).toEqual(['insufficient cash']);
  });

  it('two resting sells that together exceed the position reject the second; the first rests', () => {
    const ran = run(`oms.buy("BTC-USD", "0.01");
const s1 = oms.limitSell("BTC-USD", "0.006", "60000", "gtc");
const s2 = oms.limitSell("BTC-USD", "0.006", "60000", "gtc");
console.log(s1.status);
console.log(s2.status);`);
    expect(kinds(ran, 'o2')).toEqual(['new', 'accepted']);
    expect(kinds(ran, 'o3')).toEqual(['rejected']);
    expect(ran.events.find((e) => e.order === 'o3')).toMatchObject({ reason: 'exceeds position', position: '0.01', reserved: '0.006' });
    expect(ran.logs).toEqual(['accepted', 'rejected']);
  });

  it('a sell with nothing held is refused: spot paper has no short rule', () => {
    const ran = run(`const s = oms.sell("BTC-USD", "0.01");
console.log(s.reason);`);
    expect(ran.logs).toEqual(['no short rule']);
    expect(ran.cash).toBe('1000');
  });
});
