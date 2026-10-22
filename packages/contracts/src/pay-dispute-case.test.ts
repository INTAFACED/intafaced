import { describe, expect, it } from 'vitest';
import {
  PAY_DISPUTE_CASE_STATES,
  PAY_DISPUTE_TRANSITIONS,
  canTransitionDispute,
  payDisputeOpenInputSchema,
  payDisputeOpenResultSchema,
} from './pay-dispute-case.js';

describe('PP-disputes-safety-01 contracts', () => {
  it('PD-3: submitted never jumps to a resolution, terminal states go nowhere', () => {
    expect(canTransitionDispute('submitted', 'resolved_buyer')).toBe(false);
    expect(canTransitionDispute('submitted', 'resolved_seller')).toBe(false);
    expect(canTransitionDispute('submitted', 'under_review')).toBe(true);
    expect(canTransitionDispute('under_review', 'resolved_buyer')).toBe(true);
    for (const t of ['accepted_offer', 'resolved_buyer', 'cancelled', 'auto_closed'] as const)
      expect(PAY_DISPUTE_TRANSITIONS[t]).toEqual([]);
    for (const [from, tos] of Object.entries(PAY_DISPUTE_TRANSITIONS)) {
      expect(PAY_DISPUTE_CASE_STATES).toContain(from);
      for (const to of tos) expect(PAY_DISPUTE_CASE_STATES).toContain(to);
    }
  });

  it('open input carries no client case id', () => {
    const base = { activityId: 'tx-1:0', reasonCode: 'not_received', statement: 'Never arrived' };
    expect(payDisputeOpenInputSchema.parse(base).linkedActivityIds).toEqual([]);
    expect(payDisputeOpenInputSchema.safeParse({ ...base, disputeId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }).success).toBe(false);
    expect(payDisputeOpenInputSchema.safeParse({ ...base, reasonCode: 'Not Received' }).success).toBe(false);
  });

  it('a card line routes to the issuer with no case', () => {
    expect(payDisputeOpenResultSchema.safeParse({ routedTo: 'card_issuer', activityId: 'tx-1:0' }).success).toBe(true);
    expect(payDisputeOpenResultSchema.safeParse({ routedTo: 'card_issuer', activityId: 'tx-1:0', caseId: 'x' }).success).toBe(false);
  });
});
