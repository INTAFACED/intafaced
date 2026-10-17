import { describe, expect, it } from 'vitest';
import { audienceOfApproval } from './action-approval-audience.js';

describe('identity.revoke_sessions audience', () => {
  it('stays operator, and market and academy approvals stay operator', () => {
    expect(
      audienceOfApproval({
        actionType: 'identity.revoke_sessions',
        targetService: 'svc-identity',
        targetId: '11111111-1111-4111-8111-111111111111',
      }),
    ).toBe('operator');
    expect(audienceOfApproval({ actionType: 'market.halt', targetService: 'svc-market', targetId: 'book-1' })).toBe('operator');
    expect(audienceOfApproval({ actionType: 'academy.publish', targetService: 'svc-academy', targetId: 'course-1' })).toBe('operator');
  });
});
