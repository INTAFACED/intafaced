import { expect, it } from 'vitest';
import { attachTrailingStopStash, bindTrailingStop } from '../trailing-stop-place.js';
import { leak } from './stash-leak.js';
it('L408 a JSON number trail is not accepted as a decimal distance', async () => {
  const mark = '10';
  expect(
    await leak(attachTrailingStopStash, {
      clientOrderId: 'c8',
      trail: 0.1,
      mark,
      symbol: 'BTC/USDT',
      side: 'buy',
      amount: '1',
      price: '1',
    }),
  ).toBe(401);
  let trail: unknown = null;
  try {
    trail = (bindTrailingStop({ clientOrderId: 'c8', side: 'buy', type: 'stop', price: 1n, qty: 1n } as never) as any).trail ?? null;
  } catch {
    return;
  }
  expect(trail).toBeNull();
});
