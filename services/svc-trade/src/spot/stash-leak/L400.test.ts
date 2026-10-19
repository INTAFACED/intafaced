import { expect, it } from 'vitest';
import { attachPostOnlyStash, bindPostOnly } from '../post-only-place.js';
import { leak } from './stash-leak.js';
it('L400 flag from a failed (unauthenticated) request does not leak onto the next order with the same clientOrderId', async () => {
  expect(
    await leak(attachPostOnlyStash, {
      clientOrderId: 'c1',
      postOnly: true,
      symbol: 'BTC/USDT',
      side: 'buy',
      type: 'limit',
      amount: '1',
      price: '1',
    }),
  ).toBe(401);
  const bound = bindPostOnly({ clientOrderId: 'c1', side: 'buy', type: 'limit', price: 1n, qty: 1n } as never) as any;
  expect(bound.tif).not.toBe('PO');
});
