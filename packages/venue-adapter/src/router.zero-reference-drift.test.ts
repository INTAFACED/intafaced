import { expect, it } from 'vitest';
import { priceDriftBps } from './router.js';
import { parseAmount } from './router-test-sources.js';
it('L121: a zero reference price does not report zero drift', () => {
  expect(priceDriftBps(0n, parseAmount('100'), 'buy')).toBeGreaterThan(50);
});
