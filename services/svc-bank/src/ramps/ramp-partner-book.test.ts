import { describe, expect, it } from 'vitest';
import { rampPartnerBook } from './ramp-partner-book.js';
import { rampMetricsView } from '../ops/ramp-metrics.js';
import { payinSim } from './payin-sim.js';

const at = (s: number) => new Date(Date.UTC(2026, 10, 17, 0, 0, s));

describe("the ramp partner's own report (J-bank-28 #3)", () => {
  it('counts each order in the state the partner last gave it, with every state present', () => {
    let now = at(0);
    const book = rampPartnerBook('TEST ramp', () => now);
    book.opened('paid', at(600));
    book.approved('paid');
    book.paid('paid');
    book.opened('back', at(600));
    book.paid('back');
    book.returned('back');
    book.opened('approved', at(10));
    book.approved('approved');
    book.opened('open', at(600));
    book.opened('ran-out', at(10));
    now = at(30);
    const r = book.report();
    expect(r.orders).toEqual({ opened: 1, approved: 1, paid: 1, returned: 1, expired: 1 });
    expect(r.quoteExpiries).toEqual({ count: 1, latest: [{ orderId: 'ran-out', expiredAt: at(10) }] });
    expect(r).toMatchObject({ health: 'operational', lastOpenedAt: at(0), lastPaidAt: at(0), asOf: at(30) });
  });

  it('an order still inside its quote is opened, not expired; a return without a payment changes nothing', () => {
    const book = rampPartnerBook('TEST ramp', () => at(5));
    book.opened('o', at(10));
    book.returned('o');
    book.opened('o', at(1));
    expect(book.report().orders).toMatchObject({ opened: 1, expired: 0, returned: 0 });
  });

  it("the TEST age door moves one order's clock back, and its quote runs out at the partner", () => {
    const book = rampPartnerBook('TEST ramp', () => at(0));
    book.opened('o', at(600));
    expect(book.age('o', 601_000)).toBe(true);
    expect(book.age('missing', 1000)).toBe(false);
    expect(book.age('o', 0)).toBe(false);
    expect(book.report().orders).toMatchObject({ opened: 0, expired: 1 });
  });

  it('with no partner the desk reads no data, never zero', () => {
    expect(rampMetricsView(null)).toEqual({ partner: null });
  });

  it('the pay-in stand-in keeps the order it opens in its own book, with its quote expiry', async () => {
    const sim = payinSim(
      { label: 'TEST sim', methods: ['pay_by_bank'] },
      new URL('http://127.0.0.1:1'),
      new URL('http://127.0.0.1:2/back'),
    );
    await sim.payments.open({
      onrampId: 'o-1',
      quoteId: 'q',
      method: 'pay_by_bank',
      userId: 'u',
      assetId: 'USDT',
      amount: '1',
      quoteExpiresAt: new Date(Date.now() - 1000),
    });
    // A way to pay it does not list opens nothing, and is not on its book.
    await sim.payments.open({ onrampId: 'o-2', quoteId: 'q', method: 'card', userId: 'u', assetId: 'USDT', amount: '1' });
    const view = rampMetricsView(sim.book!.report()).partner!;
    expect(view.orders.find((o) => o.state === 'expired')?.count).toBe(1);
    expect(view.orders.reduce((n, o) => n + o.count, 0)).toBe(1);
    expect(view.quoteExpiries.latest.map((e) => e.orderId)).toEqual(['o-1']);
  });
});
