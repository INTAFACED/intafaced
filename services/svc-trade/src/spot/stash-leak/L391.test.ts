import { expect, it } from 'vitest';
import { attachIocStash, bindIoc } from '../ioc-place.js';
import { leak } from './stash-leak.js';
it('L391 flag from a failed (unauthenticated) request does not leak onto the next order with the same clientOrderId', async () => {
  expect(
    await leak(attachIocStash, {
      clientOrderId: 'c1',
      timeInForce: 'IOC',
      symbol: 'BTC/USDT',
      side: 'buy',
      type: 'limit',
      amount: '1',
      price: '1',
    }),
  ).toBe(401);
  const bound = bindIoc({ clientOrderId: 'c1', side: 'buy', type: 'limit', price: 1n, qty: 1n } as never) as any;
  expect(bound.tif).not.toBe('IOC');
});
