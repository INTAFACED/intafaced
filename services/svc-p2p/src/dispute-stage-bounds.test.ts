import { describe, expect, it } from 'vitest';
import { DisputeStageError, stageDeadline, timedTransition } from './dispute-stage.js';

function code(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    if (e instanceof DisputeStageError) return e.code;
    throw e;
  }
  return undefined;
}

const now = new Date('2026-10-22T10:00:00Z');

describe('dispute timer bounds (fail-closed)', () => {
  it('refuses a huge safe-integer timer that would overflow Date', () => {
    expect(code(() => stageDeadline('counterparty_response', now, { respondentWindowSeconds: Number.MAX_SAFE_INTEGER }))).toBe(
      'p2p.config_unset',
    );
    expect(code(() => stageDeadline('providing_proof', now, { proofWindowSeconds: 9e12 }))).toBe('p2p.config_unset');
  });
  it('refuses non-finite timers', () => {
    for (const v of [Infinity, -Infinity, NaN]) {
      expect(code(() => stageDeadline('counterparty_response', now, { respondentWindowSeconds: v }))).toBe('p2p.config_unset');
    }
  });
  it('still accepts a large but valid timer', () => {
    const d = stageDeadline('counterparty_response', now, { respondentWindowSeconds: 365 * 86400 });
    expect(d?.getTime()).toBe(now.getTime() + 365 * 86400 * 1000);
  });
  it('never fires a transition on an invalid deadline or clock', () => {
    expect(code(() => timedTransition('counterparty_response', new Date(NaN), now))).toBe('p2p.config_unset');
    expect(code(() => timedTransition('providing_proof', now, new Date(NaN)))).toBe('p2p.config_unset');
  });
  it('a valid future deadline is not due', () => {
    expect(timedTransition('counterparty_response', new Date(now.getTime() + 1000), now)).toBeNull();
  });
});
