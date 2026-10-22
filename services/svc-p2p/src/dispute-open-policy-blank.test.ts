import { describe, expect, it } from 'vitest';
import { assertMayOpenDispute, DisputeOpenError, parseDisputePolicy, WINDOW_KEYS } from './dispute-open-policy.js';

// Spec C3 (p2p-disputes-security.md:9): blank windows fail closed; blank dispute
// caps may read as "rule off" (slice test :26, "no cap set").
const OFF = Object.fromEntries(WINDOW_KEYS.map((k) => [k, 'off']));

function code(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    if (e instanceof DisputeOpenError) return e.code;
    throw e;
  }
  return undefined;
}

describe('P-disputes-security-01 blank owner values (DR3 finding 3)', () => {
  it('an empty policy refuses p2p.config_unset (windows are not set)', () => {
    expect(code(() => parseDisputePolicy({}))).toBe('p2p.config_unset');
  });

  it('each blank window refuses p2p.config_unset and names the key', () => {
    for (const key of WINDOW_KEYS) {
      for (const blank of [undefined, null, '', '  ']) {
        let msg = '';
        try {
          parseDisputePolicy({ ...OFF, [key]: blank });
        } catch (e) {
          expect(e).toBeInstanceOf(DisputeOpenError);
          expect((e as DisputeOpenError).code).toBe('p2p.config_unset');
          msg = (e as Error).message;
        }
        expect(msg).toContain(key);
      }
    }
  });

  it('an explicit off disables a window; a number sets it', () => {
    const p = parseDisputePolicy({ ...OFF, latestAfterCreatedSeconds: '3600', earliestAfterFiatSentSeconds: 'OFF' });
    expect(p.latestAfterCreatedSeconds).toBe(3600);
    expect(p.earliestAfterFiatSentSeconds).toBeNull();
  });

  it('blank caps with windows published: open works with no cap (spec :26)', () => {
    const policy = parseDisputePolicy({ ...OFF, perDayCap: '', perOrderCap: undefined, resubmissionWaitSeconds: null });
    const t0 = new Date('2026-10-22T00:00:00Z');
    const prior = [t0, t0, t0, t0, t0];
    expect(
      assertMayOpenDispute({
        policy,
        trade: { status: 'escrowed', buyerId: 'b', sellerId: 's', createdAt: t0 },
        userId: 'b',
        reasonCode: 'other',
        history: { openedByUserLastDay: prior, openedOnThisOrder: prior },
        now: new Date(t0.getTime() + 60_000),
      }).role,
    ).toBe('buyer');
  });

  it('a garbled off-like value still refuses', () => {
    expect(code(() => parseDisputePolicy({ ...OFF, perDayCap: 'none' }))).toBe('p2p.config_unset');
    expect(code(() => parseDisputePolicy({ ...OFF, latestAfterCreatedSeconds: 'unlimited' }))).toBe('p2p.config_unset');
  });
});
