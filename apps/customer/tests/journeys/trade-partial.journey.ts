import { describe, expect, it } from 'vitest';
import { BASE, QUOTE, SYMBOL, balance, draft, orderOf, reviewAndPlace } from './desk';
import { fund, ledgerAvailable, newCustomer, until } from './stack';

/**
 * A partial fill: a resting sell is only partly taken. The maker's order stays open for the rest, both customers' balances
 * agree with the ledger's own books, and cancelling the rest releases exactly what is still held.
 */
describe('pro trader: partial fill', () => {
  it('leaves the resting remainder open, settles the filled part, and releases the rest on cancel', async () => {
    const maker = await newCustomer();
    const taker = await newCustomer();
    await fund(maker.userId, BASE, '1');
    await fund(taker.userId, QUOTE, '1000');

    const resting = orderOf((await reviewAndPlace(maker.trade, draft({ side: 'sell', price: '95', amount: '0.1' }))).placed);
    const crossing = orderOf((await reviewAndPlace(taker.trade, draft({ side: 'buy', price: '95', amount: '0.04' }))).placed);

    await until('taker order filled', async () => {
      const got = await taker.trade.order(crossing);
      return got.ok && got.data.status === 'closed' ? got.data : undefined;
    });
    const partly = await until('maker order partly filled', async () => {
      const got = await maker.trade.order(resting);
      return got.ok && got.data.filled === '0.04' ? got.data : undefined;
    });
    expect(partly).toMatchObject({ status: 'open', remaining: '0.06' });

    // The ledger's books: the taker paid 3.8 for 0.04, the maker is paid it and still has 0.06 held for the rest.
    await until('taker base credited', async () => ((await ledgerAvailable(taker.userId, BASE)) === '0.04' ? true : undefined));
    expect(await ledgerAvailable(taker.userId, QUOTE)).toBe('996.2');
    await until('maker quote credited', async () => ((await ledgerAvailable(maker.userId, QUOTE)) === '3.8' ? true : undefined));
    expect(await ledgerAvailable(maker.userId, BASE)).toBe('0.9');
    expect(await balance(maker.trade, BASE)).toMatchObject({ free: '0.9', used: '0.06' });

    const makerFills = await until('maker fill listed', async () => {
      const got = await maker.trade.fills(SYMBOL);
      return got.ok && got.data.length > 0 ? got.data : undefined;
    });
    expect(makerFills).toHaveLength(1);
    expect(makerFills[0]).toMatchObject({ side: 'sell', amount: '0.04', price: '95' });

    const cancelled = await maker.trade.cancel(resting);
    expect(cancelled.ok).toBe(true);
    await until('rest released', async () => ((await balance(maker.trade, BASE)).used === '0' ? true : undefined));
    expect(await ledgerAvailable(maker.userId, BASE)).toBe('0.96');
  });
});
