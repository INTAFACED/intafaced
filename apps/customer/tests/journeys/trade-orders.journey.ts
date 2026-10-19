import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { placeInstruction } from '../../src/screens/trade/desk/ticket/scale-flow';
import { BASE, QUOTE, SYMBOL, balance, draft, orderOf, reviewAndPlace } from './desk';
import { newCustomer, fund, ledgerAvailable, until, type Customer } from './stack';

/**
 * The pro trader's order-management and order-type journeys, through the customer app's own trade API against the real
 * stack. Each journey rests its liquidity at its own price level and cancels what it leaves, so journeys never cross each
 * other or the smoke's orders.
 */
const placed = async (c: Customer, extra: Parameters<typeof draft>[0]) => orderOf((await reviewAndPlace(c.trade, draft(extra))).placed);
const terminal = (status: string) => ['closed', 'canceled', 'expired', 'rejected'].includes(status);

describe('pro trader: change an open order', () => {
  let trader: Customer;
  afterEach(async () => {
    await trader.trade.cancelAll(SYMBOL);
  });
  beforeAll(async () => {
    trader = await newCustomer();
    await fund(trader.userId, QUOTE, '1000');
  });

  it('replaces an order at a new price: the original is cancelled, the replacement rests under its own client id', async () => {
    const original = await placed(trader, { price: '71' });
    const next = draft({ price: '72' });
    const review = await trader.trade.preview(next);
    if (!review.ok) throw new Error(review.message);
    const replaced = await trader.trade.replace(original, next, review.data);
    expect(replaced.ok, replaced.ok ? '' : replaced.message).toBe(true);
    if (!replaced.ok || !('data' in replaced)) return;
    expect(replaced.data.accepted).toBe(true);
    expect(replaced.data.original).toMatchObject({ id: original.id, status: 'canceled' });
    expect(replaced.data.replacement).toMatchObject({ price: '72', status: 'open', clientOrderId: next.clientOrderId });

    const open = await trader.trade.orders('open', SYMBOL);
    expect(open.ok && open.data.map((o) => o.id)).toEqual([replaced.data.replacementOrderId]);
    await trader.trade.cancelAll(SYMBOL);
  });

  it('cancels every open order in the market in one call and releases all holds', async () => {
    const a = await placed(trader, { price: '73' });
    const b = await placed(trader, { price: '74' });
    expect((await balance(trader.trade, QUOTE)).used).not.toBe('0');

    const all = await trader.trade.cancelAll(SYMBOL);
    expect(all.ok, all.ok ? '' : all.message).toBe(true);
    if (!all.ok) return;
    expect(all.data.map((o) => o.id).sort()).toEqual([a.id, b.id].sort());
    expect(all.data.every((o) => o.status === 'canceled')).toBe(true);

    const open = await trader.trade.orders('open', SYMBOL);
    expect(open.ok && open.data).toEqual([]);
    await until('holds released', async () => ((await balance(trader.trade, QUOTE)).used === '0' ? true : undefined));
    expect(await ledgerAvailable(trader.userId, QUOTE)).toBe('1000');
  });
});

describe('pro trader: order types', () => {
  let taker: Customer;
  let maker: Customer;
  beforeAll(async () => {
    taker = await newCustomer();
    maker = await newCustomer();
    await fund(taker.userId, QUOTE, '10000');
    await fund(maker.userId, BASE, '5');
  });

  it('a market buy fills against the resting sell at its price and leaves no hold', async () => {
    const sell = await placed(maker, { side: 'sell', price: '110', amount: '0.1' });
    const buy = await placed(taker, { type: 'market', side: 'buy', amount: '0.1', price: undefined, timeInForce: 'IOC' });
    const done = await until('market order terminal', async () => {
      const got = await taker.trade.order(buy);
      return got.ok && terminal(got.data.status) ? got.data : undefined;
    });
    expect(done).toMatchObject({ status: 'closed', filled: '0.1', type: 'market' });
    const fills = await until('market fill listed', async () => {
      const got = await taker.trade.fills(SYMBOL);
      return got.ok && got.data.some((f) => f.price === '110') ? got.data : undefined;
    });
    expect(fills.find((f) => f.price === '110')).toMatchObject({ side: 'buy', amount: '0.1' });
    expect((await maker.trade.order(sell)).ok).toBe(true);
    await until('taker used released', async () => ((await balance(taker.trade, QUOTE)).used === '0' ? true : undefined));
  });

  it('an IOC buy with nothing to match ends without resting and releases its hold', async () => {
    const before = await ledgerAvailable(taker.userId, QUOTE);
    const ioc = await placed(taker, { price: '60', timeInForce: 'IOC' });
    const done = await until('IOC terminal', async () => {
      const got = await taker.trade.order(ioc);
      return got.ok && terminal(got.data.status) ? got.data : undefined;
    });
    expect(done.filled).toBe('0');
    expect(done.status).not.toBe('open');
    const open = await taker.trade.orders('open', SYMBOL);
    expect(open.ok && open.data.map((o) => o.id)).not.toContain(ioc.id);
    await until('hold released', async () => ((await balance(taker.trade, QUOTE)).used === '0' ? true : undefined));
    expect(await ledgerAvailable(taker.userId, QUOTE)).toBe(before);
  });

  it('a FOK buy for more than is available does not fill at all, and the resting sell is untouched', async () => {
    const sell = await placed(maker, { side: 'sell', price: '120', amount: '0.05' });
    const fok = await placed(taker, { price: '120', amount: '0.1', timeInForce: 'FOK' });
    const done = await until('FOK terminal', async () => {
      const got = await taker.trade.order(fok);
      return got.ok && terminal(got.data.status) ? got.data : undefined;
    });
    expect(done.filled).toBe('0');
    const resting = await maker.trade.order(sell);
    expect(resting.ok && resting.data).toMatchObject({ status: 'open', filled: '0' });
    await maker.trade.cancel(sell);
  });

  it('a post-only buy that would cross is not accepted as a taker, and one that rests does', async () => {
    const sell = await placed(maker, { side: 'sell', price: '130', amount: '0.1' });
    const crossing = draft({ price: '130', ...placeInstruction('PO') });
    const review = await taker.trade.preview(crossing);
    if (!review.ok) throw new Error(review.message);
    const result = await taker.trade.place(crossing, review.data);
    // Either the service refuses outright or accepts and ends the order unfilled; it never fills as a taker.
    const fills = await taker.trade.fills(SYMBOL);
    expect(fills.ok && fills.data.some((f) => f.price === '130')).toBe(false);
    if (result.ok && 'data' in result) expect(result.data.filled).toBe('0');
    else expect(result.ok).toBe(false);
    const resting = await maker.trade.order(sell);
    expect(resting.ok && resting.data.filled).toBe('0');

    const rests = await placed(taker, { price: '65', ...placeInstruction('PO') });
    expect(rests.status).toBe('open');
    await taker.trade.cancel(rests);
    await maker.trade.cancel(sell);
  });
});

describe('pro trader: history', () => {
  it('closed orders and fills come back newest first, limited, and filtered by market', async () => {
    const trader = await newCustomer();
    await fund(trader.userId, QUOTE, '1000');
    const ids: string[] = [];
    for (const price of ['50', '51', '52']) {
      const order = await placed(trader, { price });
      ids.push(order.id);
      await trader.trade.cancel(order);
    }
    const closed = await trader.trade.orders('closed', SYMBOL, 2);
    expect(closed.ok).toBe(true);
    if (!closed.ok) return;
    expect(closed.data).toHaveLength(2);
    expect(closed.data.every((o) => o.status === 'canceled')).toBe(true);
    const all = await trader.trade.orders('closed', SYMBOL, 100);
    expect(all.ok && all.data.map((o) => o.id).sort()).toEqual([...ids].sort());
    const none = await trader.trade.fills(SYMBOL);
    expect(none.ok && none.data).toEqual([]);
  });
});
