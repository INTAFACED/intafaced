import { describe, expect, it } from 'vitest';
import { withdrawalCopy } from './withdrawal-copy';
import { failureWords, type FailureWord } from './withdrawal-failure';

/** J-wallet-05 #8: a withdrawal's failure reads as a sentence, never as its code, and claims only what its state proves. */
describe('failureWords', () => {
  it('names a failed code in its own words, then says nothing was sent and anything held went back', () => {
    expect(failureWords('failed', 'rail.refused')).toEqual(['failRefused', 'failBack']);
    expect(failureWords('failed', 'rail.rpc_unset')).toEqual(['failRoute', 'failBack']);
    expect(failureWords('failed', 'rail.down')).toEqual(['failRoute', 'failBack']);
    expect(failureWords('failed', 'custody.dropped_by_chain')).toEqual(['failDropped', 'failBack']);
  });

  it('reads an unknown code as the general sentence, never a guessed reason', () => {
    expect(failureWords('failed', 'rail.rejected')).toEqual(['failOther', 'failBack']);
  });

  it('never says a send was refused or money came back on a row that is not failed, nor on a cancel', () => {
    for (const status of ['pending', 'held'] as const) expect(failureWords(status, 'rail.refused')).toEqual(['failChecking']);
    expect(failureWords('failed', 'withdrawal.canceled')).toEqual(['failCanceled']);
    expect(withdrawalCopy.t('failChecking')).not.toMatch(/refused|went back/);
  });

  it('every sentence leaves the code out', () => {
    const keys: FailureWord[] = ['failRefused', 'failRoute', 'failDropped', 'failOther', 'failBack', 'failCanceled', 'failChecking'];
    for (const key of keys) expect(withdrawalCopy.t(key)).not.toMatch(/[a-z]+\.[a-z_]+/);
  });
});
