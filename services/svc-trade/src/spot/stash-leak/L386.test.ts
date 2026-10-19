import { expect, it } from 'vitest';
import { attachCollarStash, bindCollar, readCollar, readMin, readMax } from '../collar-place.js';
import { leak } from './stash-leak.js';
it('L386 collar band from a failed request does not leak onto another order with same clientOrderId', async () => {
  expect(
    await leak(attachCollarStash, {
      clientOrderId: 'c3',
      collar: true,
      min: '1',
      max: '2',
      symbol: 'BTC/USDT',
      side: 'buy',
      type: 'limit',
      amount: '1',
      price: '1',
    }),
  ).toBe(401);
  const bound = bindCollar({ clientOrderId: 'c3', side: 'buy', type: 'limit', price: 1n, qty: 1n } as never);
  expect(readCollar(bound as never) || readMin(bound as never) !== null || readMax(bound as never) !== null).toBe(false);
});
