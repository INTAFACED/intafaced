import { expect, it } from 'vitest';
import { attachPegStash, bindPeg } from '../peg-place.js';
import { leak } from './stash-leak.js';
it('L399 flag from a failed (unauthenticated) request does not leak onto the next order with the same clientOrderId', async () => {
  expect(
    await leak(attachPegStash, { clientOrderId: 'c1', peg: true, symbol: 'BTC/USDT', side: 'buy', type: 'limit', amount: '1', price: '1' }),
  ).toBe(401);
  const bound = bindPeg({ clientOrderId: 'c1', side: 'buy', type: 'limit', price: 1n, qty: 1n } as never) as any;
  expect(bound.peg ?? null).not.toBe(true);
});
