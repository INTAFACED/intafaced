import { describe, expect, it } from 'vitest';
import { paymentListSummary, paymentListSummaryFromText } from './list-summary.js';

describe('payment list summary', () => {
  it('counts every match and rounds the finished rate half up', () => {
    expect(paymentListSummary(3n, 2n, 1n)).toEqual({
      matchedCount: '3',
      succeededCount: '2',
      failedCount: '1',
      finishedCount: '3',
      successRate: '67',
    });
    expect(paymentListSummary(8n, 7n, 1n).successRate).toBe('88');
    expect(paymentListSummary(2n, 1n, 1n).successRate).toBe('50');
  });

  it('does not invent a rate when nothing has finished', () => {
    expect(paymentListSummary(4n, 0n, 0n)).toEqual({
      matchedCount: '4',
      succeededCount: '0',
      failedCount: '0',
      finishedCount: '0',
      successRate: null,
    });
  });

  it('refuses a count that is not an integer', () => {
    expect(() => paymentListSummaryFromText('1.5', '0', '0')).toThrow(/not an integer/);
    expect(() => paymentListSummary(1n, 2n, 0n)).toThrow(/inconsistent/);
  });
});
