import { describe, expect, it } from 'vitest';
import { withdrawalCopy } from './withdrawal-copy';
import { failureWords } from './withdrawal-failure';

/** J-wallet-05 #8: a withdrawal's failure reads as a sentence, never as its code. */
describe('failureWords', () => {
  it('names a known failed code in its own words, and every sentence leaves the code out', () => {
    expect(failureWords({ status: 'failed', failureCode: 'rail.refused' })).toBe('failRefused');
    expect(failureWords({ status: 'failed', failureCode: 'rail.rpc_unset' })).toBe('failRoute');
    expect(failureWords({ status: 'failed', failureCode: 'custody.dropped_by_chain' })).toBe('failNotSent');
    for (const key of ['failRefused', 'failRoute', 'failNotSent', 'failOther', 'failCanceled', 'failHeld'] as const)
      expect(withdrawalCopy.t(key)).not.toMatch(/[a-z]+\.[a-z_]+/);
  });

  it('reads an unknown code as the general sentence, never a guessed reason', () => {
    expect(failureWords({ status: 'failed', failureCode: 'rail.rejected' })).toBe('failOther');
  });

  it('says the amount went back only for a failed row that is not a cancel', () => {
    expect(failureWords({ status: 'failed', failureCode: 'withdrawal.canceled' })).toBe('failCanceled');
    expect(failureWords({ status: 'held', failureCode: 'rail.refused' })).toBe('failHeld');
    expect(withdrawalCopy.t('failHeld')).not.toContain('went back to your available balance.');
  });
});
