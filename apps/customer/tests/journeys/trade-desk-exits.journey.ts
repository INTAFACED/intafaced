import { describe, expect, it } from 'vitest';
import type { Draft } from '../../src/features/trade/trade-api';
import { draftOf } from '../../src/screens/trade/desk/draft-of';
import { checkOrder, type OrderType, type Side } from '../../src/screens/trade/desk/order-math';
import type { Tif } from '../../src/screens/trade/desk/tif';
import { BASE, QUOTE, SYMBOL, balance, orderOf, reviewAndPlace } from './desk';
import { failureOf } from '../../src/screens/trade/desk/preview';
import { orderSchema, placeBody } from '../../src/features/trade/trade-api';
import { fund, ledgerAvailable, newCustomer, until, type Customer } from './stack';

/**
 * The OCO and Bracket tabs of the trading desk, from the form's own side: the same client check and the same draft the
 * ticket builds (`checkOrder`, then `draftOf`), then the desk's review-then-place against the real stack. The market rules
 * here are loose on purpose; the service stays the authority on tick, lot and minimums.
 */
const rules = { tickSize: '0.01', lotSize: '0.001', minAmount: null, minCost: null };

function formDraft(args: {
  side: Side;
  type: OrderType;
  tif: Tif;
  price?: string;
  stopPrice?: string;
  stopLimit?: string;
  takeProfit?: string;
  amount: string;
}): Draft {
  const checked = checkOrder(
    {
      side: args.side,
      type: args.type,
      price: args.price ?? '',
      amount: args.amount,
      stopPrice: args.stopPrice,
      stopLimit: args.stopLimit,
      takeProfit: args.takeProfit,
    },
    rules,
    null,
  );
  if (!checked.ok) throw new Error(`the form refused it: ${checked.problem.kind}`);
  return draftOf({
    market: { symbol: SYMBOL },
    side: args.side,
    type: args.type,
    tif: args.tif,
    checked,
    clientOrderId: `journey:${crypto.randomUUID()}`,
  });
}

const restingBid = async (c: Customer, price: string) => {
  const book = await c.trade.book(SYMBOL);
  expect(book.ok, 'the order book read').toBe(true);
  return book.ok ? book.data.bids.filter(([p]) => p === price).map(([, amount]) => amount) : [];
};

const restingAt = async (c: Customer, price: string) => {
  const book = await c.trade.book(SYMBOL);
  expect(book.ok, 'the order book read').toBe(true);
  return book.ok ? book.data.asks.filter(([p]) => p === price).map(([, amount]) => amount) : [];
};

describe('pro trader: OCO tab', () => {
  it('rests the take-profit leg on one base hold, and a cancel releases it', async () => {
    const seller = await newCustomer();
    await fund(seller.userId, BASE, '1');

    const d = formDraft({ side: 'sell', type: 'oco', tif: 'GTC', price: '131', stopPrice: '91', amount: '0.1' });
    expect(d).toMatchObject({ side: 'sell', type: 'limit', price: '131', exit: { kind: 'oco', takeProfit: '131', stopLoss: '91' } });
    const order = orderOf((await reviewAndPlace(seller.trade, d)).placed);
    expect(order).toMatchObject({ side: 'sell', status: 'open', amount: '0.1', price: '131' });
    expect(await balance(seller.trade, BASE)).toMatchObject({ free: '0.9', used: '0.1' });
    expect(await restingAt(seller, '131')).toEqual(['0.1']);
    expect(await restingAt(seller, '91')).toEqual([]);

    expect((await seller.trade.cancel(order)).ok).toBe(true);
    await until('hold released', async () => ((await balance(seller.trade, BASE)).used === '0' ? true : undefined));
    expect(await ledgerAvailable(seller.userId, BASE)).toBe('1');
  });

  it('buy side: holds quote once at the stop-loss limit, rests the take-profit buy, and a cancel releases it', async () => {
    const trader = await newCustomer();
    await fund(trader.userId, QUOTE, '1000');

    const d = formDraft({ side: 'buy', type: 'oco', tif: 'GTC', price: '90', stopPrice: '120', stopLimit: '121', amount: '0.1' });
    // The hold is sized at the worse leg, the stop-loss limit, so the draft is a limit buy at that price.
    expect(d).toMatchObject({
      side: 'buy',
      type: 'limit',
      price: '121',
      exit: { kind: 'oco', takeProfit: '90', stopLoss: '120', stopLossLimit: '121' },
    });
    const order = orderOf((await reviewAndPlace(trader.trade, d)).placed);
    expect(order).toMatchObject({ side: 'buy', status: 'open', amount: '0.1' });
    expect(await balance(trader.trade, QUOTE)).toMatchObject({ free: '987.9', used: '12.1' });
    expect(await restingBid(trader, '90')).toEqual(['0.1']);

    expect((await trader.trade.cancel(order)).ok).toBe(true);
    await until('hold released', async () => ((await balance(trader.trade, QUOTE)).used === '0' ? true : undefined));
    expect(await ledgerAvailable(trader.userId, QUOTE)).toBe('1000');
  });

  it('buy side: the form refuses prices out of the engine order before anything is sent', () => {
    const base = { side: 'buy', type: 'oco', tif: 'GTC', amount: '0.1' } as const;
    // take-profit must sit below the stop trigger, and the stop-loss limit at or above it
    expect(() => formDraft({ ...base, price: '120', stopPrice: '120', stopLimit: '121' })).toThrow('exitOrderBuy');
    expect(() => formDraft({ ...base, price: '90', stopPrice: '120', stopLimit: '119' })).toThrow('stopLimitBelowTrigger');
    expect(() => formDraft({ ...base, price: '90', stopPrice: '120' })).toThrow('stopLimitEmpty');
    // a stop limit equal to its trigger is allowed
    expect(formDraft({ ...base, price: '90', stopPrice: '120', stopLimit: '120' })).toMatchObject({ price: '120' });
  });

  it('buy side: the service refuses legs out of order or without a limit, and each refusal reads as words', async () => {
    const trader = await newCustomer();
    await fund(trader.userId, QUOTE, '1000');
    const d = formDraft({ side: 'buy', type: 'oco', tif: 'GTC', price: '90', stopPrice: '120', stopLimit: '121', amount: '0.1' });

    const noLimit = placeBody({ ...d, exit: { ...d.exit!, stopLossLimit: undefined } });
    const outOfOrder = placeBody({ ...d, exit: { ...d.exit!, stopLoss: '85', stopLossLimit: '86' } });
    for (const [body, code, title] of [
      [noLimit, 'trade.oco_stop_limit_required', 'Add a stop-loss limit price'],
      [outOfOrder, 'trade.oco_price_order', 'Check the exit prices'],
    ] as const) {
      const result = await trader.api.rest('/orders', orderSchema, {
        method: 'POST',
        body: { ...body, clientOrderId: `journey:${crypto.randomUUID()}` },
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe(code);
        const failure = failureOf(result, {});
        expect(failure.kind === 'refusal' ? failure.copy.title : null).toBe(title);
      }
    }
    expect((await balance(trader.trade, QUOTE)).used).toBe('0');
  });
});

describe('pro trader: Bracket tab', () => {
  it('buys at the entry price, then holds the received coins behind one OCO exit pair', async () => {
    const seller = await newCustomer();
    const buyer = await newCustomer();
    await fund(seller.userId, BASE, '1');
    await fund(buyer.userId, QUOTE, '1000');
    const ask = orderOf(
      (await reviewAndPlace(seller.trade, { ...formDraft({ side: 'sell', type: 'limit', tif: 'GTC', price: '107', amount: '0.1' }) }))
        .placed,
    );

    const d = formDraft({ side: 'buy', type: 'bracket', tif: 'IOC', price: '107', takeProfit: '140', stopPrice: '95', amount: '0.1' });
    expect(d).toMatchObject({
      side: 'buy',
      type: 'limit',
      price: '107',
      timeInForce: 'IOC',
      exit: { kind: 'bracket', takeProfit: '140', stopLoss: '95' },
    });
    const entry = orderOf((await reviewAndPlace(buyer.trade, d)).placed);
    expect(entry).toMatchObject({ side: 'buy', status: 'closed', filled: '0.1' });

    const exit = await until('exit order resting', async () => {
      const open = await buyer.trade.orders('open', SYMBOL);
      return open.ok ? open.data.find((o) => o.side === 'sell' && o.price === '140') : undefined;
    });
    expect(exit.clientOrderId).toMatch(/^bracket:.+:exit$/);
    // One base hold behind the exit pair: exactly what the buyer received, never more than was filled.
    const held = (await balance(buyer.trade, BASE)).used;
    expect(held).toBe(exit.amount);
    expect(Number(exit.amount)).toBeGreaterThan(0);
    expect(Number(exit.amount)).toBeLessThanOrEqual(0.1);
    expect(await restingAt(buyer, '140')).toEqual([exit.amount]);

    expect((await buyer.trade.cancel(exit)).ok).toBe(true);
    await until('exit hold released', async () => ((await balance(buyer.trade, BASE)).used === '0' ? true : undefined));
    await seller.trade.cancel(ask).catch(() => undefined);
  });

  it('an entry that fills nothing places no exit and holds nothing', async () => {
    const buyer = await newCustomer();
    await fund(buyer.userId, QUOTE, '1000');

    const d = formDraft({ side: 'buy', type: 'bracket', tif: 'IOC', price: '1', takeProfit: '2', stopPrice: '0.5', amount: '0.1' });
    const result = await reviewAndPlace(buyer.trade, d).then(
      (r) => r.placed,
      (e: Error) => e,
    );
    const filled = !(result instanceof Error) && result.ok && 'data' in result ? result.data.filled : '0';
    expect(Number(filled)).toBe(0);
    const open = await buyer.trade.orders('open', SYMBOL);
    expect(open.ok && open.data).toEqual([]);
    expect((await balance(buyer.trade, QUOTE)).used).toBe('0');
    expect((await balance(buyer.trade, BASE)).used).toBe('0');
  });

  it('a resting entry waits on the book at its price, holds quote, and a cancel places no exit', async () => {
    const buyer = await newCustomer();
    await fund(buyer.userId, QUOTE, '1000');

    const d = formDraft({ side: 'buy', type: 'bracket', tif: 'GTC', price: '95', takeProfit: '140', stopPrice: '90', amount: '0.1' });
    expect(d).toMatchObject({
      side: 'buy',
      type: 'limit',
      price: '95',
      timeInForce: 'GTC',
      exit: { kind: 'bracket', takeProfit: '140', stopLoss: '90' },
    });
    const entry = orderOf((await reviewAndPlace(buyer.trade, d)).placed);
    expect(entry).toMatchObject({ side: 'buy', status: 'open', filled: '0' });
    expect(await balance(buyer.trade, QUOTE)).toMatchObject({ used: '9.5' });
    expect(await restingBid(buyer, '95')).toEqual(['0.1']);

    expect((await buyer.trade.cancel(entry)).ok).toBe(true);
    await until('hold released', async () => ((await balance(buyer.trade, QUOTE)).used === '0' ? true : undefined));
    const open = await buyer.trade.orders('open', SYMBOL);
    expect(open.ok && open.data).toEqual([]);
    expect((await balance(buyer.trade, BASE)).used).toBe('0');
  });
});
