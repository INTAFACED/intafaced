import { expect, it } from 'vitest';
import { attachOptionStash, bindOption } from '../option-place.js';
import { leak } from './stash-leak.js';
it('L395 flag from a failed (unauthenticated) request does not leak onto the next order with the same clientOrderId', async () => {
  expect(
    await leak(attachOptionStash, {
      clientOrderId: 'c1',
      strike: '100',
      expiry: '2030-01-01',
      exercise: true,
      symbol: 'BTC/USDT',
      side: 'buy',
      type: 'limit',
      amount: '1',
      price: '1',
    }),
  ).toBe(401);
  const bound = bindOption({ clientOrderId: 'c1', side: 'buy', type: 'limit', price: 1n, qty: 1n } as never) as any;
  expect(bound.exercise).not.toBe(true);
  expect(bound.strike ?? null).toBeNull();
});
