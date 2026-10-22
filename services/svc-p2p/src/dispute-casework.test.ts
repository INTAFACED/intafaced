import { describe, expect, it } from 'vitest';
import {
  answerInfoRequest,
  CaseworkError,
  CLAIM_SQL_SHAPE,
  currentAgent,
  decideClaim,
  expireInfoRequest,
  openInfoRequest,
  slaBadge,
} from './dispute-casework.js';

const T0 = new Date('2026-10-22T00:00:00Z');
const at = (s: number) => new Date(T0.getTime() + s * 1000);
const parties = { buyerId: 'b', sellerId: 's' };

function code(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    if (e instanceof CaseworkError) return e.code;
    throw e;
  }
  return undefined;
}

const open = (over: Partial<Parameters<typeof openInfoRequest>[0]> = {}) =>
  openInfoRequest({ id: 'r', disputeId: 'd', stage: 'under_review', addresseeId: 'b', parties, expirySeconds: 600, now: T0, ...over });

describe('P-disputes-security-05 request for information', () => {
  it('request to the buyer → waiting_on_party; the answer returns the stage', () => {
    const { request, stage } = open();
    expect(stage).toBe('waiting_on_party');
    expect(request.expiresAt).toEqual(at(600));
    expect(answerInfoRequest(request, 'b', at(10))).toEqual({ request: { ...request, status: 'answered' }, stage: 'under_review' });
    expect(open({ stage: 'under_investigation' }).request.returnStage).toBe('under_investigation');
  });

  it('only the addressee may answer; a non-party cannot be addressed', () => {
    const { request } = open();
    expect(code(() => answerInfoRequest(request, 's', at(1)))).toBe('p2p.not_the_addressee');
    expect(code(() => answerInfoRequest(request, '', at(1)))).toBe('p2p.not_the_addressee');
    expect(code(() => open({ addresseeId: 'x' }))).toBe('p2p.not_the_addressee');
  });

  it('blank expiry refuses p2p.config_unset; a terminal dispute refuses', () => {
    for (const v of [null, undefined, 0, -1, 2.5]) expect(code(() => open({ expirySeconds: v }))).toBe('p2p.config_unset');
    expect(code(() => open({ stage: 'resolved' }))).toBe('p2p.dispute_resolved');
    expect(code(() => open({ stage: 'pending_processing' }))).toBe('p2p.invalid_stage');
  });

  it('deadline passes → expired and the case returns to review; a late answer refuses', () => {
    const { request } = open();
    expect(expireInfoRequest(request, at(599))).toBeNull();
    expect(expireInfoRequest(request, at(600))).toEqual({ request: { ...request, status: 'expired' }, stage: 'under_review' });
    expect(code(() => answerInfoRequest(request, 'b', at(600)))).toBe('p2p.request_expired');
    expect(code(() => answerInfoRequest({ ...request, status: 'answered' }, 'b', at(1)))).toBe('p2p.request_expired');
  });
});

describe('P-disputes-security-05 claim with lease', () => {
  const free = { agentId: null, leaseUntil: null };

  it('two agents claim → the first wins, the second refuses p2p.case_claimed', () => {
    const a = decideClaim(free, 'a1', 300, T0);
    expect(a).toEqual({ agentId: 'a1', leaseUntil: at(300) });
    expect(code(() => decideClaim(a, 'a2', 300, at(10)))).toBe('p2p.case_claimed');
    expect(decideClaim(a, 'a1', 300, at(10)).leaseUntil).toEqual(at(310));
  });

  it('lease expires → unassigned and claimable', () => {
    const a = decideClaim(free, 'a1', 300, T0);
    expect(currentAgent(a, at(299))).toBe('a1');
    expect(currentAgent(a, at(300))).toBeNull();
    expect(decideClaim(a, 'a2', 300, at(300)).agentId).toBe('a2');
  });

  it('blank lease refuses; the SQL claim is one conditional UPDATE', () => {
    expect(code(() => decideClaim(free, 'a1', null, T0))).toBe('p2p.config_unset');
    expect(code(() => decideClaim(free, '', 300, T0))).toBe('p2p.case_claimed');
    expect(CLAIM_SQL_SHAPE).toMatch(/^UPDATE .* WHERE .*agent_id IS NULL OR lease_until <= now\(\).* RETURNING/);
  });

  it('blank SLA target → no colouring; set target → on_track, due_soon, overdue', () => {
    expect(slaBadge(T0, null, at(99999))).toBe('no_target');
    expect(slaBadge(T0, undefined, at(1))).toBe('no_target');
    expect(slaBadge(T0, 100, at(10))).toBe('on_track');
    expect(slaBadge(T0, 100, at(85))).toBe('due_soon');
    expect(slaBadge(T0, 100, at(100))).toBe('overdue');
    expect(code(() => slaBadge(T0, 0, at(1)))).toBe('p2p.config_unset');
  });
});
