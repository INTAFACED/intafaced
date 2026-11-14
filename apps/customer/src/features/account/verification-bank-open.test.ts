import { describe, expect, it } from 'vitest';
import { bankStepsOpen } from './verification-guards';

// J-cex-spot-01 #3 and J-identity-08 #2, #3: the bank's ID and selfie steps stay closed for a person who only trades,
// and open on their own for a person already in them.
describe('bankStepsOpen', () => {
  it('stays closed for a fresh account: no press, no hand-off link, no draft', () => {
    expect(bankStepsOpen(false, '', { draft: null })).toBe(false);
    expect(bankStepsOpen(false, '', null)).toBe(false);
    expect(bankStepsOpen(false, '?tab=cases', { draft: null })).toBe(false);
  });

  it('opens when the person presses "Start verification for the bank"', () => {
    expect(bankStepsOpen(true, '', null)).toBe(true);
  });

  it('opens on a page opened from a hand-off link, a used or cut one included', () => {
    expect(bankStepsOpen(false, '?handoff=abc.def', null)).toBe(true);
    expect(bankStepsOpen(false, '?handoff=', null)).toBe(true);
  });

  it('opens when a guided draft is on the service and not yet sent, so a returning person resumes', () => {
    expect(bankStepsOpen(false, '', { draft: { recordId: null } })).toBe(true);
    expect(bankStepsOpen(false, '', { draft: {} })).toBe(true);
  });

  it('stays closed for a draft already sent as a request', () => {
    expect(bankStepsOpen(false, '', { draft: { recordId: 'rec-1' } })).toBe(false);
  });
});
