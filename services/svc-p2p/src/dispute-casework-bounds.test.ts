import { describe, expect, it } from 'vitest';
import {
  answerInfoRequest,
  CaseworkError,
  CLAIM_UPSERT_SQL_SHAPE,
  currentAgent,
  decideClaim,
  expireInfoRequest,
  openInfoRequest,
  type InfoRequest,
} from './dispute-casework.js';

function code(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    if (e instanceof CaseworkError) return e.code;
    throw e;
  }
  return undefined;
}

const T0 = new Date('2026-10-22T10:00:00Z');
const HUGE = Number.MAX_SAFE_INTEGER;
const free = { agentId: null, leaseUntil: null };

describe('casework lease/expiry bounds (fail-closed)', () => {
  it('refuses a huge lease instead of writing an Invalid Date', () => {
    expect(code(() => decideClaim(free, 'a1', HUGE, T0))).toBe('p2p.config_unset');
    expect(code(() => decideClaim(free, 'a1', 9e12, T0))).toBe('p2p.config_unset');
    expect(code(() => decideClaim(free, 'a1', Infinity, T0))).toBe('p2p.config_unset');
  });
  it('an invalid stored lease is never read as unheld', () => {
    const held = { agentId: 'a1', leaseUntil: new Date(NaN) };
    expect(currentAgent(held, T0)).toBe('a1');
    expect(currentAgent({ agentId: 'a1', leaseUntil: new Date(T0.getTime() + 1000) }, new Date(NaN))).toBe('a1');
    expect(code(() => decideClaim(held, 'a2', 300, T0))).toBe('p2p.case_claimed');
  });
  it('a valid expired lease is still free', () => {
    expect(currentAgent({ agentId: 'a1', leaseUntil: new Date(T0.getTime() - 1) }, T0)).toBeNull();
  });
  it('refuses a huge info-request expiry', () => {
    expect(
      code(() =>
        openInfoRequest({
          id: 'r1',
          disputeId: 'd1',
          stage: 'under_review',
          addresseeId: 'b',
          parties: { buyerId: 'b', sellerId: 's' },
          expirySeconds: HUGE,
          now: T0,
        }),
      ),
    ).toBe('p2p.config_unset');
  });
  it('an invalid stored expiry cannot be answered and refuses the sweeper', () => {
    const req: InfoRequest = {
      id: 'r1',
      disputeId: 'd1',
      addresseeId: 'b',
      status: 'open',
      expiresAt: new Date(NaN),
      returnStage: 'under_review',
    };
    expect(code(() => answerInfoRequest(req, 'b', T0))).toBe('p2p.request_expired');
    expect(code(() => expireInfoRequest(req, T0))).toBe('p2p.config_unset');
  });
  it('the claim is an upsert guarded by the same WHERE and the DB clock', () => {
    expect(CLAIM_UPSERT_SQL_SHAPE).toMatch(
      /^INSERT .* ON CONFLICT \(dispute_id\) DO UPDATE .* WHERE .*agent_id IS NULL OR .*lease_until <= now\(\).* RETURNING agent_id$/,
    );
  });
});
