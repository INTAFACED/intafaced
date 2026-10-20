import { describe, expect, it } from 'vitest';
import { BASE, QUOTE, draft, orderOf, reviewAndPlace } from './desk';
import { claimsOf, identityCall, type Issued } from './identity';
import { fund, ledgerAvailable, newCustomer, until } from './stack';
import { taxCall } from './tax';

type LotBook = {
  method: string;
  indicator: string;
  realizedUsd: string | null;
  residuals: string[];
  sales: Array<{ assetId: string; qty: string; proceedsUsd: string | null; costUsd: string | null; realizedUsd: string | null }>;
  assets: Array<{ assetId: string; openQty: string; openCostUsd: string | null; held: string }>;
};

/**
 * Profit and loss: a customer buys at one price and sells at a higher one, and tax's lot book, read as that customer, says what the
 * trades made. Every figure is TEST money worked by hand: bought 0.1 at 77 (cost 7.7), sold 0.1 at 133 (proceeds 13.3), realised 5.6.
 */
describe('pro trader: profit and loss', () => {
  it('realises the gain on a bought-then-sold coin and names an open position it cannot price from fills alone', async () => {
    const seller = await newCustomer();
    const subject = await newCustomer({ kycTier: 'full' });
    const buyer = await newCustomer();
    await fund(seller.userId, BASE, '1');
    await fund(subject.userId, QUOTE, '1000');
    await fund(buyer.userId, QUOTE, '1000');
    const claims = claimsOf(
      (await identityCall<Issued>('auth.login', { identifier: subject.account.email, password: subject.account.password }, null))
        .accessToken,
    );

    // Buy: the subject crosses a resting sell at 77.
    orderOf((await reviewAndPlace(seller.trade, draft({ side: 'sell', price: '77', amount: '0.1' }))).placed);
    const bought = orderOf((await reviewAndPlace(subject.trade, draft({ side: 'buy', price: '77', amount: '0.1' }))).placed);
    await until('buy filled', async () => {
      const got = await subject.trade.order(bought);
      return got.ok && got.data.status === 'closed' ? true : undefined;
    });
    await until('base credited', async () => ((await ledgerAvailable(subject.userId, BASE)) === '0.1' ? true : undefined));

    const open = await until('open lot listed', async () => {
      const got = await taxCall('lotBook', undefined, claims);
      expect(got.status, got.body).toBe(200);
      const book = got.data as LotBook;
      return book.assets.find((a) => a.assetId === BASE)?.openQty === '0.1' ? book : undefined;
    });
    expect(open.indicator).toBe('indicator_not_tax_advice');
    expect(open.method).toBe('FIFO');
    expect(open.assets.find((a) => a.assetId === BASE)).toMatchObject({ openQty: '0.1', openCostUsd: '7.7', held: '0.1' });
    expect(open.sales).toEqual([]);
    expect(open.realizedUsd).toBeNull();

    // Sell: a resting buy at 133 takes it.
    orderOf((await reviewAndPlace(buyer.trade, draft({ side: 'buy', price: '133', amount: '0.1' }))).placed);
    const sold = orderOf((await reviewAndPlace(subject.trade, draft({ side: 'sell', price: '133', amount: '0.1' }))).placed);
    await until('sell filled', async () => {
      const got = await subject.trade.order(sold);
      return got.ok && got.data.status === 'closed' ? true : undefined;
    });
    await until('proceeds credited', async () => ((await ledgerAvailable(subject.userId, BASE)) === '0' ? true : undefined));

    const closed = await until('sale listed', async () => {
      const book = (await taxCall('lotBook', undefined, claims)).data as LotBook;
      return book.sales.length === 1 ? book : undefined;
    });
    expect(closed.sales[0]).toMatchObject({ assetId: BASE, qty: '0.1', proceedsUsd: '13.3', costUsd: '7.7', realizedUsd: '5.6' });
    expect(closed.realizedUsd).toBe('5.6');
    expect(closed.residuals).toEqual([]);

    // A method is only a switch: LIFO on one lot gives the same answer, and an unknown name is refused, not guessed.
    const lifo = (await taxCall('lotBook', { method: 'LIFO' }, claims)).data as LotBook;
    expect(lifo).toMatchObject({ method: 'LIFO', realizedUsd: '5.6' });
    expect((await taxCall('lotBook', { method: 'NOPE' }, claims)).status).toBeGreaterThanOrEqual(400);
  });
});
