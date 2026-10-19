import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { orderSchema } from '../../src/features/trade/trade-api';
import { BASE, QUOTE, SYMBOL, balance, draft, orderOf, reviewAndPlace } from './desk';
import { fund, ledgerAvailable, newCustomer, until, type Customer } from './stack';

/**
 * A sell OCO (take-profit plus stop-loss) from the pro trader's side. The desk does not offer OCO yet (UNSUPPORTED_TYPES in
 * screens/trade/desk/tif.ts), so the order goes through the app's ApiClient with the body the service documents. One order,
 * one base hold; the take-profit leg rests on the book, the stop-loss leg does not until its trigger. Buy-side OCO and bracket
 * refuse with a typed reason by design.
 */
const ocoBody = (extra: Record<string, unknown> = {}) => ({
  symbol: SYMBOL,
  side: 'sell',
  type: 'limit',
  amount: '0.1',
  price: '110',
  timeInForce: 'GTC',
  oco: true,
  takeProfit: { stopPrice: '110' },
  stopLoss: { stopPrice: '90' },
  clientOrderId: `journey:${randomUUID()}`,
  ...extra,
});

async function placeOco(seller: Customer, body = ocoBody()) {
  const result = await seller.api.rest('/orders', orderSchema, { method: 'POST', body });
  expect(result.ok, result.ok ? '' : `${result.code} ${result.message}`).toBe(true);
  if (!result.ok) throw new Error('unreachable');
  return { body, order: result.data };
}

const restingAt = async (c: Customer, price: string) => {
  const book = await c.trade.book(SYMBOL);
  expect(book.ok, 'the order book read').toBe(true);
  return book.ok ? book.data.asks.filter(([p]) => p === price).map(([, amount]) => amount) : [];
};

describe('pro trader: sell OCO', () => {
  it('rests one take-profit leg on one hold, replays by client id, and a cancel releases everything', async () => {
    const seller = await newCustomer();
    await fund(seller.userId, BASE, '1');

    const { body, order } = await placeOco(seller);
    expect(order).toMatchObject({ side: 'sell', status: 'open', amount: '0.1', price: '110', clientOrderId: body.clientOrderId });
    expect(await balance(seller.trade, BASE)).toMatchObject({ free: '0.9', used: '0.1' });
    expect(await ledgerAvailable(seller.userId, BASE)).toBe('0.9');
    expect(await restingAt(seller, '110')).toEqual(['0.1']);
    expect(await restingAt(seller, '90')).toEqual([]);

    const again = await seller.api.rest('/orders', orderSchema, { method: 'POST', body });
    expect(again.ok && again.data.id).toBe(order.id);
    expect((await balance(seller.trade, BASE)).used).toBe('0.1');

    const cancelled = await seller.trade.cancel(order);
    expect(cancelled.ok && cancelled.data.status).toBe('canceled');
    await until('hold released', async () => ((await balance(seller.trade, BASE)).used === '0' ? true : undefined));
    expect(await ledgerAvailable(seller.userId, BASE)).toBe('1');
    expect(await restingAt(seller, '110')).toEqual([]);
  });

  it('a buyer who takes the take-profit leg settles against the ledger, and nothing stays held', async () => {
    const seller = await newCustomer();
    const buyer = await newCustomer();
    await fund(seller.userId, BASE, '1');
    await fund(buyer.userId, QUOTE, '1000');

    const { order } = await placeOco(seller);
    const bought = orderOf((await reviewAndPlace(buyer.trade, draft({ side: 'buy', price: '110', amount: '0.1' }))).placed);
    await until('buyer order filled', async () => {
      const got = await buyer.trade.order(bought);
      return got.ok && got.data.status === 'closed' ? got.data : undefined;
    });

    await until('seller paid', async () => ((await ledgerAvailable(seller.userId, QUOTE)) === '11' ? true : undefined));
    expect(await ledgerAvailable(seller.userId, BASE)).toBe('0.9');
    expect(await ledgerAvailable(buyer.userId, BASE)).toBe('0.1');
    expect(await ledgerAvailable(buyer.userId, QUOTE)).toBe('989');
    await until('seller hold released', async () => ((await balance(seller.trade, BASE)).used === '0' ? true : undefined));
    const closed = await seller.trade.order(order);
    expect(closed.ok && closed.data).toMatchObject({ status: 'closed', filled: '0.1', remaining: '0' });
    expect(await restingAt(seller, '110')).toEqual([]);
  });

  it('a partial fill keeps the remaining hold for the remaining leg, and a cancel releases exactly that', async () => {
    const seller = await newCustomer();
    const buyer = await newCustomer();
    await fund(seller.userId, BASE, '1');
    await fund(buyer.userId, QUOTE, '1000');

    const { order } = await placeOco(seller);
    const bought = orderOf((await reviewAndPlace(buyer.trade, draft({ side: 'buy', price: '110', amount: '0.04' }))).placed);
    await until('buyer order filled', async () => {
      const got = await buyer.trade.order(bought);
      return got.ok && got.data.status === 'closed' ? got.data : undefined;
    });
    await until('seller paid for the filled part', async () =>
      (await ledgerAvailable(seller.userId, QUOTE)) === '4.4' ? true : undefined,
    );

    // The engine cancels the stop-loss sibling on any first fill; the take-profit remainder still rests and still needs its funds.
    expect(await balance(seller.trade, BASE)).toMatchObject({ free: '0.9', used: '0.06' });
    expect(await restingAt(seller, '110')).toEqual(['0.06']);

    const cancelled = await seller.trade.cancel(order);
    expect(cancelled.ok).toBe(true);
    await until('rest released', async () => ((await balance(seller.trade, BASE)).used === '0' ? true : undefined));
    expect(await ledgerAvailable(seller.userId, BASE)).toBe('0.96');
  });

  it('refuses a buy-side OCO with no stop-loss limit and a bracket with a typed reason and holds nothing', async () => {
    const trader = await newCustomer();
    await fund(trader.userId, QUOTE, '1000');
    await fund(trader.userId, BASE, '1');

    const buyOco = await trader.api.rest('/orders', orderSchema, {
      method: 'POST',
      body: ocoBody({ side: 'buy', price: '80', takeProfit: { stopPrice: '90' }, stopLoss: { stopPrice: '70' } }),
    });
    expect(buyOco.ok).toBe(false);
    // A buy OCO places only with a stop-loss limit (stopLoss.price); without it the single hold has no worst price.
    if (!buyOco.ok) expect(buyOco.code).toBe('trade.oco_stop_limit_required');

    const bracket = await trader.api.rest('/orders', orderSchema, {
      method: 'POST',
      body: ocoBody({ oco: undefined, bracket: true }),
    });
    expect(bracket.ok).toBe(false);
    if (!bracket.ok) expect(bracket.code).toBe('trade.order_type_unsupported');

    expect((await balance(trader.trade, QUOTE)).used).toBe('0');
    expect((await balance(trader.trade, BASE)).used).toBe('0');
    const open = await trader.trade.orders('open', SYMBOL);
    expect(open.ok && open.data).toEqual([]);
  });
});
