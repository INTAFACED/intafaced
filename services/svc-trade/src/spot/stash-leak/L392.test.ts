import { expect, it } from 'vitest';
import { attachMinQtyStash, bindMinQty } from '../min-qty-place.js';
import { leak } from './stash-leak.js';
it('L392 flag from a failed (unauthenticated) request does not leak onto the next order with the same clientOrderId', async () => {
  expect(
    await leak(attachMinQtyStash, {
      clientOrderId: 'c1',
      minQty: '5',
      symbol: 'BTC/USDT',
      side: 'buy',
      type: 'limit',
      amount: '1',
      price: '1',
    }),
  ).toBe(401);
  const bound = bindMinQty({ clientOrderId: 'c1', side: 'buy', type: 'limit', price: 1n, qty: 1n } as never) as any;
  expect(bound.minQty ?? null).toBeNull();
});
