import { describe, expect, it } from 'vitest';
import { DisputeStageError, MAX_DISPUTE_SECONDS, stageDeadline, sweepTimedTransitions } from './dispute-stage.js';

const now = new Date('2026-10-22T10:00:00Z');
const codeOf = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (e) {
    if (e instanceof DisputeStageError) return e.code;
    throw e;
  }
  return undefined;
};

describe('dispute timer upper cap (engineering input guard)', () => {
  it('accepts exactly one year', () => {
    expect(stageDeadline('counterparty_response', now, { respondentWindowSeconds: MAX_DISPUTE_SECONDS })?.getTime()).toBe(
      now.getTime() + MAX_DISPUTE_SECONDS * 1000,
    );
  });
  it('refuses one second over the cap, and a 1e12 s timer, with exactly config_unset', () => {
    expect(codeOf(() => stageDeadline('providing_proof', now, { proofWindowSeconds: MAX_DISPUTE_SECONDS + 1 }))).toBe('p2p.config_unset');
    expect(codeOf(() => stageDeadline('counterparty_response', now, { respondentWindowSeconds: 1e12 }))).toBe('p2p.config_unset');
  });
});

describe('sweeper batch: one bad row never stalls the rest', () => {
  it('moves the due rows and reports the throwing row', () => {
    const past = new Date(now.getTime() - 1000);
    const out = sweepTimedTransitions(
      [
        { id: 'a', stage: 'counterparty_response', deadlineAt: past },
        { id: 'bad', stage: 'providing_proof', deadlineAt: new Date(Number.NaN) },
        { id: 'c', stage: 'providing_proof', deadlineAt: past },
        { id: 'later', stage: 'providing_proof', deadlineAt: new Date(now.getTime() + 1000) },
      ],
      now,
    );
    expect(out.moves).toEqual([
      { id: 'a', from: 'counterparty_response', to: 'under_review' },
      { id: 'c', from: 'providing_proof', to: 'under_review' },
    ]);
    expect(out.failed).toEqual([{ id: 'bad', code: 'p2p.config_unset' }]);
  });
});
