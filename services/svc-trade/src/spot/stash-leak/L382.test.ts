import { expect, it } from 'vitest';
import { attachAuctionStash, bindAuction, readAuction, readBenchmark } from '../auction-place.js';
import { leak } from './stash-leak.js';
it('L382 auction/benchmark flag from a failed request does not leak onto the next order', async () => {
  expect(
    await leak(attachAuctionStash, {
      clientOrderId: 'c2',
      auction: true,
      benchmark: true,
      symbol: 'BTC/USDT',
      side: 'buy',
      type: 'limit',
      amount: '1',
      price: '1',
    }),
  ).toBe(401);
  const bound = bindAuction({ clientOrderId: 'c2', side: 'buy', type: 'limit', price: 1n, qty: 1n } as never);
  expect(readAuction(bound as never) || readBenchmark(bound as never)).toBe(false);
});
