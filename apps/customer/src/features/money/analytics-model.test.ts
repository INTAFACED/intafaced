import { describe, expect, it } from 'vitest';
import { splitAnalytics } from './analytics-model';

const by = (over: Record<string, string>) => ({
  transfers: '300',
  trading: '203',
  p2p: '0',
  fees: '0',
  withdrawals: '200',
  earn: '0',
  deposits: '1000',
  rewards: '0',
  other: '0',
  ...over,
});

describe('analytics: deposits are money in, not outflow', () => {
  it('moves the deposits bucket out of the outflow list so the categories sum to the outflow total', () => {
    const split = splitAnalytics({ outflowByCategory: by({}), totalOutflow: '703' });
    expect(split.outflow.map((row) => row.category)).not.toContain('deposits');
    const sum = split.outflow.reduce((total, row) => total + Number(row.amount), 0);
    expect(sum).toBe(703);
    expect(split.moneyInDeposits).toBe('1000');
    expect(split.exact).toBe(true);
  });
  it('keeps value that left under a deposit reason in the outflow list and only the rest as money in', () => {
    const split = splitAnalytics({ outflowByCategory: by({}), totalOutflow: '713' });
    expect(split.outflow.find((row) => row.category === 'deposits')?.amount).toBe('10');
    expect(split.moneyInDeposits).toBe('990');
  });
  it('shows the bucket as reported, and says it is not exact, when the figures do not reconcile', () => {
    const split = splitAnalytics({ outflowByCategory: by({}), totalOutflow: '600' });
    expect(split.exact).toBe(false);
    expect(split.moneyInDeposits).toBe('1000');
    expect(split.outflow.map((row) => row.category)).not.toContain('deposits');
  });
  it('has no money-in row when the bank returned no deposits figure', () => {
    const { deposits: _unused, ...rest } = by({});
    expect(splitAnalytics({ outflowByCategory: rest, totalOutflow: '703' }).moneyInDeposits).toBeNull();
  });
});
