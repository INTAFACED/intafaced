import { expect, it } from 'vitest';
import { attachStopLimitStash, bindStopLimit } from '../stop-limit-place.js';
import { leak } from './stash-leak.js';
it('L405 flag from a failed (unauthenticated) request does not leak onto the next order with the same clientOrderId', async () => {
  expect(
    await leak(attachStopLimitStash, {
      clientOrderId: 'c1',
      stopPx: '9',
      symbol: 'BTC/USDT',
      side: 'buy',
      type: 'limit',
      amount: '1',
      price: '1',
    }),
  ).toBe(401);
  const bound = bindStopLimit({ clientOrderId: 'c1', side: 'buy', type: 'limit', price: 1n, qty: 1n } as never) as any;
  expect(bound.stopPx ?? null).toBeNull();
});
