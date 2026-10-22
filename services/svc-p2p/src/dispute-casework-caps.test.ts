import { describe, expect, it } from 'vitest';
import { CaseworkError, decideClaim, openInfoRequest } from './dispute-casework.js';
import { MAX_DISPUTE_SECONDS } from './dispute-stage.js';

const T0 = new Date('2026-10-22T10:00:00Z');
const codeOf = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (e) {
    if (e instanceof CaseworkError) return e.code;
    throw e;
  }
  return undefined;
};
const free = { agentId: null, leaseUntil: null };

describe('lease and expiry upper cap (engineering input guard, MAX_DISPUTE_SECONDS)', () => {
  it('a lease of exactly the cap is accepted; one over and 1e12 refuse config_unset', () => {
    expect(decideClaim(free, 'a1', MAX_DISPUTE_SECONDS, T0).leaseUntil?.getTime()).toBe(T0.getTime() + MAX_DISPUTE_SECONDS * 1000);
    expect(codeOf(() => decideClaim(free, 'a1', MAX_DISPUTE_SECONDS + 1, T0))).toBe('p2p.config_unset');
    expect(codeOf(() => decideClaim(free, 'a1', 1e12, T0))).toBe('p2p.config_unset');
  });
  it('an info-request expiry over the cap refuses config_unset', () => {
    const input = {
      id: 'r1',
      disputeId: 'd1',
      addresseeId: 'u1',
      parties: { buyerId: 'u1', sellerId: 'u2' },
      stage: 'under_review' as const,
      now: T0,
    };
    expect(codeOf(() => openInfoRequest({ ...input, expirySeconds: MAX_DISPUTE_SECONDS + 1 }))).toBe('p2p.config_unset');
    expect(codeOf(() => openInfoRequest({ ...input, expirySeconds: 1e12 }))).toBe('p2p.config_unset');
  });
});
