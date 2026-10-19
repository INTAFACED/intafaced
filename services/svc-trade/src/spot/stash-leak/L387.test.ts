import { expect, it } from 'vitest';
import { attachComboStash, bindCombo } from '../combo-place.js';
import { leak } from './stash-leak.js';
it('L387 flag from a failed (unauthenticated) request does not leak onto the next order with the same clientOrderId', async () => {
  expect(
    await leak(attachComboStash, {
      clientOrderId: 'c1',
      combo: true,
      legs: [{ name: 'a', ratio: '1', strike: '1', expiry: '2030-01-01' }],
      symbol: 'BTC/USDT',
      side: 'buy',
      type: 'limit',
      amount: '1',
      price: '1',
    }),
  ).toBe(401);
  const bound = bindCombo({ clientOrderId: 'c1', side: 'buy', type: 'limit', price: 1n, qty: 1n } as never) as any;
  expect(bound.combo ?? null).not.toBe(true);
  expect(bound.legs ?? null).toBeNull();
});
