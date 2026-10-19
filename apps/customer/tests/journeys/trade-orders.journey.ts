import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { placeInstruction } from '../../src/screens/trade/desk/ticket/scale-flow';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { orderSchema } from '../../src/features/trade/trade-api';
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

  it('lowers the quantity in place: same order, smaller hold, same price', async () => {
    const order = await placed(trader, { price: '70', amount: '0.2' });
    const heldBefore = (await balance(trader.trade, QUOTE)).used;

    const amended = await trader.trade.amend(order, '0.1');
    expect(amended.ok, amended.ok ? '' : amended.message).toBe(true);
    if (!amended.ok) return;
    expect(amended.data).toMatchObject({ accepted: true, orderId: order.id });
    expect(amended.data.order).toMatchObject({ id: order.id, amount: '0.1', price: '70', status: 'open' });

    await until('hold shrinks', async () => ((await balance(trader.trade, QUOTE)).used !== heldBefore ? true : undefined));
    expect((await balance(trader.trade, QUOTE)).used).toBe('7');
    await trader.trade.cancel(order);
  });

  it('refuses to raise the quantity of an open order, with a typed reason, and leaves the order and hold untouched', async () => {
    const order = await placed(trader, { price: '69', amount: '0.1' });
    const held = (await balance(trader.trade, QUOTE)).used;
    const raised = await trader.api.rest(`/orders/${order.id}`, z.any(), { method: 'PATCH', body: { qty: '0.2' } });
    expect(raised.ok).toBe(true);
    if (raised.ok) expect(raised.data).toMatchObject({ accepted: false, reconciliationRequired: false });
    const after = await trader.trade.order(order);
    expect(after.ok && after.data).toMatchObject({ amount: '0.1', status: 'open', recoveryRequired: false });
    expect((await balance(trader.trade, QUOTE)).used).toBe(held);
    await trader.trade.cancel(order);
  });

  it('replaces an order at a new price: the original is cancelled, the replacement rests under its own client id', async () => {
    const original = await placed(trader, { price: '71' });
    const next = draft({ price: '72' });
    const review = await trader.trade.preview(next);
    if (!review.ok) throw new Error(review.message);
    const replaced = await trader.trade.replace(original, next, review.data);
    expect(replaced.ok, replaced.ok ? '' : replaced.message).toBe(true);
    if (!replaced.ok) return;
    if (!('data' in replaced)) throw new Error('replace came back as a changed review');
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
  afterEach(async () => {
    await taker.trade.cancelAll(SYMBOL);
    await maker.trade.cancelAll(SYMBOL);
  });
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
    // Fills settle through the bus after the order is accepted: give a would-be fill time to show before checking none did.
    await new Promise((done) => setTimeout(done, 1500));
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
  it('closed orders respect the page size, a large page returns them all, and a customer with no trades has no fills', async () => {
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

describe('pro trader: stop-limit', () => {
  let trader: Customer;
  beforeAll(async () => {
    trader = await newCustomer();
    await fund(trader.userId, QUOTE, '1000');
  });

  // The desk does not offer stop-limit yet (UNSUPPORTED_TYPES in screens/trade/desk/tif.ts), so this goes through the app's
  // ApiClient directly with the body the service documents.
  const stopBody = (extra: Record<string, unknown> = {}) => ({
    symbol: SYMBOL,
    side: 'buy',
    type: 'stop_limit',
    amount: '0.1',
    price: '150',
    stopPrice: '149',
    timeInForce: 'GTC',
    clientOrderId: `journey:${randomUUID()}`,
    ...extra,
  });

  it('stores the trigger, holds the funds, does not rest on the book, and cancels cleanly', async () => {
    const body = stopBody();
    const result = await trader.api.rest('/orders', orderSchema, { method: 'POST', body });
    expect(result.ok, result.ok ? '' : `${result.code} ${result.message}`).toBe(true);
    if (!result.ok) return;
    expect(result.data).toMatchObject({
      type: 'stop_limit',
      stopPrice: '149',
      price: '150',
      status: 'open',
      clientOrderId: body.clientOrderId,
    });
    expect((await balance(trader.trade, QUOTE)).used).toBe('15');

    const book = await trader.trade.book(SYMBOL);
    expect(book.ok && book.data.bids.some(([price]) => price === '150')).toBe(false);

    const again = await trader.api.rest('/orders', orderSchema, { method: 'POST', body });
    expect(again.ok && again.data.id).toBe(result.data.id);

    const cancelled = await trader.trade.cancel(result.data);
    expect(cancelled.ok && cancelled.data.status).toBe('canceled');
    await until('hold released', async () => ((await balance(trader.trade, QUOTE)).used === '0' ? true : undefined));
  });

  it('refuses a stop-limit with no trigger price, with a typed reason, and holds nothing', async () => {
    const result = await trader.api.rest('/orders', orderSchema, { method: 'POST', body: stopBody({ stopPrice: undefined }) });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('trade.validation_failed');
    expect((await balance(trader.trade, QUOTE)).used).toBe('0');
  });
});
