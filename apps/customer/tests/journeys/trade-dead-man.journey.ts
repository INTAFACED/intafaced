import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { QUOTE, SYMBOL, balance, draft, orderOf, reviewAndPlace } from './desk';
import { newCustomer, fund, until, type Customer } from './stack';

/**
 * The pro trader's dead-man switch (cancel-all-after), through the customer app's own api client against the real stack.
 * Arm it, stop talking, and the resting orders are cancelled and their holds released; keep re-arming and nothing is
 * touched; disarm and nothing is touched. A second customer's order is never affected.
 */
const armed = z.object({ armed: z.boolean(), timeout: z.number(), triggerTime: z.string().nullable() });

describe('pro trader: dead-man switch', () => {
  let trader: Customer;
  let other: Customer;
  beforeAll(async () => {
    trader = await newCustomer();
    other = await newCustomer();
    await fund(trader.userId, QUOTE, '1000');
    await fund(other.userId, QUOTE, '1000');
  });
  afterAll(async () => {
    await trader.trade.cancelAll(SYMBOL);
    await other.trade.cancelAll(SYMBOL);
  });

  const arm = (c: Customer, timeout: number) => c.api.rest('/orders/cancel-all-after', armed, { method: 'POST', body: { timeout } });
  const openIds = async (c: Customer) => {
    const open = await c.trade.orders('open', SYMBOL);
    return open.ok ? open.data.map((o) => o.id) : [];
  };

  it('refuses a timeout the owner has not published', async () => {
    const res = await arm(trader, 7);
    expect(res.ok).toBe(false);
  });

  it('cancels every resting order after the deadline, releases the holds, and leaves another customer alone', async () => {
    const a = orderOf((await reviewAndPlace(trader.trade, draft({ price: '60', amount: '0.1' }))).placed);
    const b = orderOf((await reviewAndPlace(trader.trade, draft({ price: '61', amount: '0.1' }))).placed);
    const o = orderOf((await reviewAndPlace(other.trade, draft({ price: '62', amount: '0.1' }))).placed);
    expect((await balance(trader.trade, QUOTE)).used).not.toBe('0');

    const res = await arm(trader, 10);
    expect(res.ok, res.ok ? '' : res.message).toBe(true);
    if (!res.ok) return;
    expect(res.data).toMatchObject({ armed: true, timeout: 10 });
    expect(await openIds(trader)).toEqual(expect.arrayContaining([a.id, b.id]));

    await until('the switch fires', async () => ((await openIds(trader)).length === 0 ? true : undefined), 30_000);
    await until('holds released', async () => ((await balance(trader.trade, QUOTE)).used === '0' ? true : undefined));
    expect(await openIds(other)).toContain(o.id);
  });

  it('timeout 0 disarms: the orders stay open past the old deadline', async () => {
    const a = orderOf((await reviewAndPlace(trader.trade, draft({ price: '59', amount: '0.1' }))).placed);
    expect((await arm(trader, 10)).ok).toBe(true);
    const off = await arm(trader, 0);
    expect(off.ok && off.data).toMatchObject({ armed: false, timeout: 0, triggerTime: null });
    await new Promise((done) => setTimeout(done, 13_000));
    expect(await openIds(trader)).toContain(a.id);
    await trader.trade.cancel(a);
  });
});
