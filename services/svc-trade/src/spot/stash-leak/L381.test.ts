import { expect, it } from 'vitest';
import { attachAonStash, bindAon, readAon } from '../aon-place.js';
import { leak } from './stash-leak.js';
it('L381 AON flag from a failed request does not leak onto the next order with same clientOrderId', async () => {
  expect(
    await leak(attachAonStash, { clientOrderId: 'c1', aon: true, symbol: 'BTC/USDT', side: 'buy', type: 'limit', amount: '1', price: '1' }),
  ).toBe(401);
  const bound = bindAon({ clientOrderId: 'c1', side: 'buy', type: 'limit', price: 1n, qty: 1n } as never);
  expect(readAon(bound as never)).toBe(false);
});
