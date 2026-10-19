import { expect, it } from 'vitest';
import { planRoute } from './router.js';
import { NOW, src, parseAmount } from './router-test-sources.js';
it('L119: NaN maxSlippageBps / maxVenues keeps the default caps', async () => {
  const req = { symbol: 'BTC/USDT', side: 'buy' as const, amount: parseAmount('2') };
  const plan = await planRoute(req, [src('a', '100', 0), src('b', '120', 0)], { now: NOW, maxSlippageBps: NaN });
  expect(plan.legs.map((l) => l.venueId)).toEqual(['a']);
  const plan2 = await planRoute(req, [src('a', '100', 0), src('b', '101', 0)], { now: NOW, maxVenues: NaN });
  expect(plan2.legs.length).toBeGreaterThan(0);
});
