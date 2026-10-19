import { expect, it } from 'vitest';
import { planRoute } from './router.js';
import { NOW, src, parseAmount } from './router-test-sources.js';
it('L120: a sell quote whose price after the taker fee is <= 0 is refused, never routed', async () => {
  const req = { symbol: 'BTC/USDT', side: 'sell' as const, amount: parseAmount('1') };
  const plan = await planRoute(req, [src('a', '100', 10_000)], { now: NOW });
  expect(plan.legs).toHaveLength(0);
});
