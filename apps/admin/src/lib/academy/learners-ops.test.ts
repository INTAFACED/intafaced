import { describe, expect, it } from 'vitest';
import { isLearnerOp, learnerChange } from './learners-ops';

// The exact bodies apps/admin/src/components/academy-learner-desk.tsx sends: each form's body, with the page's `userId`
// added by `send` (postLearnerChange({ userId, ...body })).
const USER = '11111111-1111-4111-8111-111111111111';
const GRANT = '22222222-2222-4222-8222-222222222222';
const ATTEMPT = '33333333-3333-4333-8333-333333333333';
const bodies: Record<string, Record<string, unknown>> = {
  addNote: { op: 'addNote', body: 'TEST note', key: `note:${USER}:1` },
  markComplete: { op: 'markComplete', itemSlug: 'sovereign-rail-map', reason: '', key: `override:${USER}:sovereign-rail-map:1` },
  voidAttempt: { op: 'voidAttempt', attemptId: ATTEMPT, reason: 'TEST' },
  extension: {
    op: 'extension',
    itemSlug: 'sovereign-rail-map',
    until: '2026-11-20T10:00:00.000Z',
    reason: 'TEST',
    key: `extend:x:${USER}:1`,
  },
  grantAccess: { op: 'grantAccess', pathSlug: 'sovereign', reason: 'TEST', expiresAt: null },
  reinstate: { op: 'reinstate', grantId: GRANT, reason: 'TEST', expiresAt: null, n: 3 },
  tag: { op: 'tag', tag: 'test-tag', reason: 'TEST' },
  untag: { op: 'untag', tag: 'test-tag', reason: 'TEST' },
};

describe('learner page changes (J-academy-14)', () => {
  it('every body the page sends parses into the call svc-academy takes', () => {
    for (const [op, body] of Object.entries(bodies)) {
      expect(isLearnerOp(op)).toBe(true);
      const change = learnerChange(op as never, { userId: USER, ...body });
      expect(change, op).not.toHaveProperty('why');
    }
  });

  it('a tag goes to the many-learner call as a list of one, with no stray learner field', () => {
    expect(learnerChange('tag', { userId: USER, ...bodies.tag })).toEqual({
      procedure: 'admin.tagLearners',
      input: { userIds: [USER], tag: 'test-tag', reason: 'TEST' },
      what: 'tag added',
    });
    expect(learnerChange('tag', { userId: USER, op: 'tag', tag: 'Not A Tag', reason: 'TEST' })).toHaveProperty('why');
  });

  it('a blank reason passes through, so svc-academy refuses it by name; an unknown op is not one', () => {
    expect(learnerChange('markComplete', { userId: USER, ...bodies.markComplete })).toMatchObject({ input: { reason: '' } });
    expect(isLearnerOp('unenrol')).toBe(false);
  });
});
