import { describe, expect, it } from 'vitest';
import { BASE, QUOTE, SYMBOL, balance, draft, orderOf, reviewAndPlace } from './desk';
import { fund, ledgerAvailable, newCustomer, until } from './stack';

/**
 * What the desk shows around an order. The market list, the public tape, the ticker and the candles must reflect a real trade,
 * a spot customer has no positions, and one customer can neither see nor touch another's order.
 */
describe('pro trader: market data after a trade', () => {
  it('lists the market, and the tape, ticker and candles reflect a fill', async () => {
    const maker = await newCustomer();
    const taker = await newCustomer();
    await fund(maker.userId, BASE, '1');
    await fund(taker.userId, QUOTE, '1000');

    const markets = await taker.trade.markets();
    expect(markets.ok, markets.ok ? '' : markets.message).toBe(true);
    if (markets.ok) expect(markets.data.map((m) => m.symbol)).toContain(SYMBOL);

    orderOf((await reviewAndPlace(maker.trade, draft({ side: 'sell', price: '97', amount: '0.1' }))).placed);
    const bought = orderOf((await reviewAndPlace(taker.trade, draft({ side: 'buy', price: '97', amount: '0.1' }))).placed);
    await until('fill', async () => {
      const got = await taker.trade.order(bought);
      return got.ok && got.data.status === 'closed' ? got.data : undefined;
    });

    const tape = await until('tape row', async () => {
      const got = await taker.trade.tape(SYMBOL);
      return got.ok && got.data.some((t) => t.price === '97' && t.amount === '0.1') ? got.data : undefined;
    });
    expect(tape.every((t) => t.symbol === SYMBOL)).toBe(true);

    const ticker = await until('ticker last price', async () => {
      const got = await taker.trade.ticker(SYMBOL);
      return got.ok && got.data.last === '97' ? got.data : undefined;
    });
    expect(ticker.symbol).toBe(SYMBOL);

    const candles = await until('candle', async () => {
      const got = await taker.trade.history(SYMBOL, '1m');
      return got.ok && got.data.length > 0 ? got.data : undefined;
    });
    expect(candles.length).toBeGreaterThan(0);
  });

  it('a spot customer has no positions', async () => {
    const person = await newCustomer();
    const positions = await person.trade.positions(SYMBOL);
    expect(positions.ok && positions.data).toEqual([]);
  });
});

describe('pro trader: one customer cannot see or touch another customer', () => {
  it("cannot read, cancel or list another customer's order, and the owner's order and hold stay put", async () => {
    const owner = await newCustomer();
    const other = await newCustomer();
    await fund(owner.userId, QUOTE, '1000');
    await fund(other.userId, QUOTE, '1000');

    const order = orderOf((await reviewAndPlace(owner.trade, draft({ price: '70', amount: '0.1' }))).placed);

    const read = await other.trade.order(order);
    expect(read.ok).toBe(false);
    const cancel = await other.trade.cancel(order);
    expect(cancel.ok).toBe(false);
    const theirs = await other.trade.orders('open', SYMBOL);
    expect(theirs.ok && theirs.data).toEqual([]);
    expect((await balance(other.trade, QUOTE)).used).toBe('0');

    const still = await owner.trade.order(order);
    expect(still.ok && still.data.status).toBe('open');
    expect((await balance(owner.trade, QUOTE)).used).toBe('7');
    expect(await ledgerAvailable(owner.userId, QUOTE)).toBe('993');

    const cancelled = await owner.trade.cancel(order);
    expect(cancelled.ok && cancelled.data.status).toBe('canceled');
  });
});
