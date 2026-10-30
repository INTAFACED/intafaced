import { describe, expect, it } from 'vitest';
import { skipWords } from './FollowCopies';
import { allowedActions, copyingSwitch, isCloseOnly, stateWord, type Follow } from './FollowDetail';

const follow = (relationshipState: string) =>
  ({ relationshipState, sessionKeyGranted: true, sessionKeyRevoked: false, permittedMarkets: ['BTC/USDT'] }) as unknown as Follow;

describe('a close-only follow (CB-copy-09)', () => {
  it('reads Stopping, cannot be paused, resumed or stopped again, and can still be left or closed out', () => {
    const closeOnly = follow('CLOSE_ONLY');
    expect(stateWord('CLOSE_ONLY')).toBe('Stopping');
    expect(isCloseOnly(closeOnly)).toBe(true);
    expect(isCloseOnly(follow('ACTIVE'))).toBe(false);
    expect(allowedActions(closeOnly)).toEqual({
      pause: 'Only an active follow can be paused',
      resume: 'Only a paused follow can be resumed',
      stop: 'This follow has already stopped',
      detach: null,
      flatten: null,
    });
    // The permission stays so the leader's closes can still be copied.
    expect(copyingSwitch(closeOnly)).toEqual({ on: true, blocked: null });
  });
});

describe('skipWords (CB-copy-11)', () => {
  it('says every reason the service writes in words, and never shows an id', () => {
    const reasons = [
      'paused',
      'stopped',
      'lead_stopped',
      'risk_control',
      'insufficient_funds',
      'max_copy_total',
      'copy_slippage_exceeded',
      'position_closed',
      'refused',
    ];
    const words = reasons.map(skipWords);
    expect(new Set(words).size).toBe(reasons.length);
    for (const w of words) expect(w).not.toMatch(/_|trade\./);
    expect(skipWords('paused')).toBe('You had paused this follow');
    expect(skipWords('trade.something_new')).toBe('The copy was refused');
  });
});
