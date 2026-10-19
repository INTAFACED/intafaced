import { beforeAll, describe, expect, it } from 'vitest';
import { orderSchema } from '../../src/features/trade/trade-api';
import { CONFLICT_CODE, resendOrder } from '../../src/screens/trade/desk/resend';
import { BASE, QUOTE, SYMBOL, balance, draft, orderOf, reviewAndPlace } from './desk';
import { newCustomer, fund, ledgerAvailable, until, type Customer } from './stack';

/**
 * The pro trader's core spot journey, through the customer app's own client code (createApiClient, createTradeApi,
 * resendOrder) against the real trade, matching and ledger services. No service answer is faked: the only thing this
 * file supplies is the signed-in principal the edge would add. Funds are TEST deposits made through the ledger recipe.
 */

describe('pro trader: place, retry, cancel', () => {
  let buyer: Customer;
  beforeAll(async () => {
    buyer = await newCustomer();
    await fund(buyer.userId, QUOTE, '1000');
  });

  it('places a limit buy that rests open, with the quote held', async () => {
    const before = await balance(buyer.trade, QUOTE);
    const d = draft();
    const { review, placed } = await reviewAndPlace(buyer.trade, d);
    const order = orderOf(placed);
    expect(order).toMatchObject({ symbol: SYMBOL, side: 'buy', status: 'open', clientOrderId: d.clientOrderId, filled: '0' });

    const open = await buyer.trade.orders('open', SYMBOL);
    expect(open.ok && open.data.map((o) => o.id)).toContain(order.id);

    const after = await balance(buyer.trade, QUOTE);
    expect(after.used).toBe(review.holdAmount);
    expect(review.holdAsset).toBe(QUOTE);
    expect(BigInt(after.used.replace('.', '')) > BigInt(before.used.replace('.', ''))).toBe(true);

    const cancelled = await buyer.trade.cancel(order);
    expect(cancelled.ok).toBe(true);
  });

  it('a retry with the same client id returns the same order and holds funds once', async () => {
    const d = draft({ price: '81' });
    const { placed } = await reviewAndPlace(buyer.trade, d);
    const first = orderOf(placed);
    const held = (await balance(buyer.trade, QUOTE)).used;

    const again = await resendOrder(buyer.api, d);
    expect(again.ok).toBe(true);
    if (again.ok) expect(again.order.id).toBe(first.id);
    const third = await resendOrder(buyer.api, d);
    expect(third.ok && third.order.id).toBe(first.id);

    const open = await buyer.trade.orders('open', SYMBOL);
    expect(open.ok && open.data.filter((o) => o.clientOrderId === d.clientOrderId)).toHaveLength(1);
    expect((await balance(buyer.trade, QUOTE)).used).toBe(held);

    await buyer.trade.cancel(first);
  });

  it('a lost answer is recovered by looking the order up, never by placing a second one', async () => {
    const flaky = buyer.again({ dropResponses: { n: 1 } });
    const d = draft({ price: '82' });
    const review = await flaky.trade.preview(d);
    if (!review.ok) throw new Error(`preview refused: ${review.message}`);
    const lost = await flaky.trade.place(d, review.data);
    expect(lost.ok).toBe(false);
    if (!lost.ok) expect(lost.reason).toBe('uncertain');

    const found = await flaky.trade.reconcile(d.clientOrderId, SYMBOL);
    expect(found.ok).toBe(true);
    if (!found.ok) return;
    expect(found.data.status).toBe('open');

    const resent = await resendOrder(flaky.api, d);
    expect(resent.ok && resent.order.id).toBe(found.data.id);
    const open = await flaky.trade.orders('open', SYMBOL);
    expect(open.ok && open.data.filter((o) => o.clientOrderId === d.clientOrderId)).toHaveLength(1);

    await flaky.trade.cancel(found.data);
  });

  it('the same client id with a different order is refused, and the first order is untouched', async () => {
    const d = draft({ price: '83' });
    const { placed } = await reviewAndPlace(buyer.trade, d);
    const order = orderOf(placed);

    const conflict = await resendOrder(buyer.api, { ...d, price: '84' });
    expect(conflict.ok).toBe(false);
    if (!conflict.ok) expect(conflict.code).toBe(CONFLICT_CODE);

    const looked = await buyer.trade.order(order);
    expect(looked.ok && looked.data.price).toBe('83');
    await buyer.trade.cancel(order);
  });

  it('cancels an open order, releases the hold, and reports the same terminal outcome on a repeat', async () => {
    const d = draft({ price: '85' });
    const { placed } = await reviewAndPlace(buyer.trade, d);
    const order = orderOf(placed);
    const usedWhileOpen = (await balance(buyer.trade, QUOTE)).used;
    expect(usedWhileOpen).not.toBe('0');

    const cancelled = await buyer.trade.cancel(order);
    expect(cancelled.ok).toBe(true);
    if (cancelled.ok) expect(cancelled.data.status).toBe('canceled');

    const open = await buyer.trade.orders('open', SYMBOL);
    expect(open.ok && open.data.map((o) => o.id)).not.toContain(order.id);
    const closed = await buyer.trade.orders('closed', SYMBOL);
    expect(closed.ok && closed.data.find((o) => o.id === order.id)?.status).toBe('canceled');

    // Every order this customer placed is now cancelled, so nothing is left held.
    await until('hold released', async () => ((await balance(buyer.trade, QUOTE)).used === '0' ? true : undefined));
    expect(await ledgerAvailable(buyer.userId, QUOTE)).toBe('1000');

    const repeat = await buyer.trade.cancel(order);
    if (repeat.ok) expect(repeat.data.status).toBe('canceled');
    else expect(['error', 'uncertain']).toContain(repeat.reason);
  });
});

describe('pro trader: fills', () => {
  let taker: Customer;
  let maker: Customer;
  beforeAll(async () => {
    taker = await newCustomer();
    maker = await newCustomer();
    await fund(taker.userId, QUOTE, '1000');
    await fund(maker.userId, BASE, '1');
  });

  it('a resting sell and a crossing buy fill, and the customer sees order, fill and balances', async () => {
    const sell = draft({ side: 'sell', price: '100', amount: '0.1' });
    const resting = await reviewAndPlace(maker.trade, sell);
    const makerOrder = orderOf(resting.placed);

    const buy = draft({ side: 'buy', price: '100', amount: '0.1' });
    const crossing = await reviewAndPlace(taker.trade, buy);
    const takerOrder = orderOf(crossing.placed);

    const filled = await until('taker order filled', async () => {
      const got = await taker.trade.order(takerOrder);
      return got.ok && got.data.status === 'closed' ? got.data : undefined;
    });
    expect(filled).toMatchObject({ filled: '0.1', remaining: '0', side: 'buy' });

    const fills = await until('taker fill listed', async () => {
      const got = await taker.trade.fills(SYMBOL);
      return got.ok && got.data.length > 0 ? got.data : undefined;
    });
    expect(fills).toHaveLength(1);
    expect(fills[0]).toMatchObject({ symbol: SYMBOL, side: 'buy', amount: '0.1', price: '100' });

    const makerFills = await until('maker fill listed', async () => {
      const got = await maker.trade.fills(SYMBOL);
      return got.ok && got.data.length > 0 ? got.data : undefined;
    });
    expect(makerFills[0]).toMatchObject({ side: 'sell', amount: '0.1', price: '100' });

    const restingAfter = await maker.trade.order(makerOrder);
    expect(restingAfter.ok && restingAfter.data.status).toBe('closed');

    // The customer's view agrees with the ledger's own books, read without going through trade.
    await until('taker base credited', async () => ((await ledgerAvailable(taker.userId, BASE)) === '0.1' ? true : undefined));
    expect(await ledgerAvailable(taker.userId, QUOTE)).toBe('990');
    await until('maker quote credited', async () => ((await ledgerAvailable(maker.userId, QUOTE)) === '10' ? true : undefined));
    expect((await balance(taker.trade, BASE)).free).toBe('0.1');
    expect((await balance(taker.trade, QUOTE)).used).toBe('0');
  });
});

describe('unverified customer', () => {
  it('is refused at review with the typed reason, and nothing is held or placed', async () => {
    const newcomer = await newCustomer({ unverified: true });
    await fund(newcomer.userId, QUOTE, '1000');
    const d = draft();
    const review = await newcomer.trade.preview(d);
    expect(review.ok).toBe(true);
    if (!review.ok) return;
    expect(review.data.orderable).toBe(false);
    expect(review.data.refusals.map((r) => r.code)).toContain('denied.kyc_required');

    const sent = await newcomer.api.rest('/orders', orderSchema, { method: 'POST', body: d });
    expect(sent.ok).toBe(false);
    const open = await newcomer.trade.orders('open', SYMBOL);
    expect(open.ok && open.data).toEqual([]);
    expect(await ledgerAvailable(newcomer.userId, QUOTE)).toBe('1000');
  });
});
