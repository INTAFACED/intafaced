import { expect, it } from 'vitest';
import { attachTrailingStopStash, bindTrailingStop } from '../trailing-stop-place.js';
import { leak } from './stash-leak.js';
it('L407 flag from a failed (unauthenticated) request does not leak onto the next order with the same clientOrderId', async () => {
  expect(
    await leak(attachTrailingStopStash, {
      clientOrderId: 'c1',
      trail: '1',
      mark: '10',
      symbol: 'BTC/USDT',
      side: 'buy',
      type: 'limit',
      amount: '1',
      price: '1',
    }),
  ).toBe(401);
  const bound = bindTrailingStop({ clientOrderId: 'c1', side: 'buy', type: 'limit', price: 1n, qty: 1n } as never) as any;
  expect(bound.trail ?? null).toBeNull();
});
