import { expect, it } from 'vitest';
import { attachExpireStash, bindExpireAt } from '../gtd-gtt-place.js';
import { leak } from './stash-leak.js';
it('L390 flag from a failed (unauthenticated) request does not leak onto the next order with the same clientOrderId', async () => {
  expect(
    await leak(attachExpireStash, {
      clientOrderId: 'c1',
      expireAt: '2031-01-01T00:00:00Z',
      symbol: 'BTC/USDT',
      side: 'buy',
      type: 'limit',
      amount: '1',
      price: '1',
    }),
  ).toBe(401);
  const bound = bindExpireAt({ clientOrderId: 'c1', side: 'buy', type: 'limit', price: 1n, qty: 1n } as never) as any;
  expect(bound.expireAt).toBeUndefined();
});
