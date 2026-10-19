import { expect, it } from 'vitest';
import { attachFokStash, bindFok } from '../fok-place.js';
import { leak } from './stash-leak.js';
it('L389 flag from a failed (unauthenticated) request does not leak onto the next order with the same clientOrderId', async () => {
  expect(
    await leak(attachFokStash, {
      clientOrderId: 'c1',
      timeInForce: 'FOK',
      symbol: 'BTC/USDT',
      side: 'buy',
      type: 'limit',
      amount: '1',
      price: '1',
    }),
  ).toBe(401);
  const bound = bindFok({ clientOrderId: 'c1', side: 'buy', type: 'limit', price: 1n, qty: 1n } as never) as any;
  expect(bound.tif).not.toBe('FOK');
});
