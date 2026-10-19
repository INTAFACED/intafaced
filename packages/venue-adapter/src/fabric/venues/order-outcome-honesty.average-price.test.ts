import { expect, it } from 'vitest';
import { assertFillReportMatchesStatus } from './order-outcome-honesty.js';
it('L118: partially_filled with filled>0 and null/zero average price is refused', () => {
  expect(() => assertFillReportMatchesStatus('v', 'partially_filled', 5n, null)).toThrow();
  expect(() => assertFillReportMatchesStatus('v', 'partially_filled', 5n, 0n)).toThrow();
});
