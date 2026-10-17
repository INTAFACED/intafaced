import { describe, expect, it } from 'vitest';
import { categoryLabel } from './analytics-copy';

describe('spending category names', () => {
  it('shows a plain name for every key the Bank reports', () => {
    const expected: Record<string, string> = {
      transfers: 'Transfers',
      trading: 'Trading',
      p2p: 'Person-to-person',
      fees: 'Fees',
      withdrawals: 'Withdrawals',
      earn: 'Earn and staking',
      deposits: 'Deposits',
      rewards: 'Rewards',
      other: 'Everything else',
    };
    for (const [key, label] of Object.entries(expected)) expect(categoryLabel(key)).toBe(label);
  });
  it('makes an unknown key readable instead of printing it raw', () => {
    expect(categoryLabel('card_payments')).toBe('Card payments');
    expect(categoryLabel('bank.fx-fees')).toBe('Bank fx fees');
    expect(categoryLabel('  ')).toBe('Everything else');
  });
});
