import { expect, it } from 'vitest';
import { attachReduceOnlyStash, bindReduceOnly } from '../reduce-only-place.js';
import { leak } from './stash-leak.js';
it('L403 flag from a failed (unauthenticated) request does not leak onto the next order with the same clientOrderId', async () => {
  expect(
    await leak(attachReduceOnlyStash, {
      clientOrderId: 'c1',
      reduceOnly: true,
      symbol: 'BTC/USDT',
      side: 'buy',
      type: 'limit',
      amount: '1',
      price: '1',
    }),
  ).toBe(401);
  const bound = bindReduceOnly({ clientOrderId: 'c1', side: 'buy', type: 'limit', price: 1n, qty: 1n } as never) as any;
  expect(bound.reduceOnly).not.toBe(true);
});
