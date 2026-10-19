import { describe, expect, it } from 'vitest';
import type { Draft } from '../../src/features/trade/trade-api';
import { draftOf } from '../../src/screens/trade/desk/draft-of';
import { checkOrder, type OrderType, type Side } from '../../src/screens/trade/desk/order-math';
import type { Tif } from '../../src/screens/trade/desk/tif';
import { BASE, QUOTE, SYMBOL, balance, orderOf, reviewAndPlace } from './desk';
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

  it('the buy side of the tab is off in the form, and the service refuses it too', async () => {
    const trader = await newCustomer();
    await fund(trader.userId, QUOTE, '1000');
    // The ticket never builds a buy OCO (its draft schema refuses it); the service's own refusal is the second line.
    const d = formDraft({ side: 'buy', type: 'oco', tif: 'GTC', price: '131', stopPrice: '91', amount: '0.1' });
    const preview = await trader.trade.preview(d);
    expect(preview.ok).toBe(false);
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
});
