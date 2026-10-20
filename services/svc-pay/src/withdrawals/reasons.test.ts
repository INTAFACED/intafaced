import { describe, expect, it } from 'vitest';
import { failureReason } from './reasons.js';

describe('failure reason copy', () => {
  it('gives plain words for the customer and guidance for support', () => {
    const reason = failureReason('rail.refused');
    expect(reason).toMatchObject({ code: 'rail.refused', known: true });
    expect(reason!.customer).not.toBe(reason!.support);
    expect(reason!.customer).not.toMatch(/rail\./);
  });

  it('explains every code a rail failure can carry', () => {
    for (const code of [
      'rail.failed',
      'rail.refused',
      'rail.unhealthy',
      'rail.marked_down',
      'rail.health_stale',
      'rail.probe_failed',
      'rail.rpc_unset',
      'rail.sandbox_only',
      'rail.not_sent',
      'rail.unknown_reference',
    ]) {
      expect(failureReason(code)?.known, code).toBe(true);
    }
  });

  it('shows an unknown code as itself and invents no reason', () => {
    expect(failureReason('rail.something_new')).toEqual({
      code: 'rail.something_new',
      known: false,
      customer: 'rail.something_new',
      support: 'rail.something_new',
    });
  });

  it('has nothing to say when nothing failed', () => {
    expect(failureReason(null)).toBeNull();
  });
});
