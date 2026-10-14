import { describe, expect, it } from 'vitest';
import {
  ACTION_APPROVAL_NOT_AUTHORITY,
  SAME_PERSON_ACTION_TYPES,
  isSamePersonActionType,
  actionApprovalApproveInputSchema,
  actionApprovalConsumeInputSchema,
  actionApprovalProposeInputSchema,
  actionApprovalSchema,
  approvalCannotExecute,
  isConsumableApproval,
  namesAreNotActionApproval,
  type ActionApproval,
} from './action-approval.js';

const NOW = '2026-09-09T12:00:00.000Z';
const LATER = '2026-09-09T12:15:00.000Z';

const approved: ActionApproval = {
  approvalId: 'appr-1',
  actionType: 'ledger.freeze',
  targetService: 'svc-ledger',
  targetId: 'posting_freeze',
  expectedVersion: '1',
  payloadHash: 'sha256:abc',
  requesterId: 'user-a',
  approverId: 'user-b',
  policyVersion: 'v1',
  createdAt: NOW,
  expiresAt: LATER,
  status: 'APPROVED',
  operationId: 'op-1',
};

describe('action-bound approval contract', () => {
  it('parses a complete APPROVED row', () => {
    expect(actionApprovalSchema.parse(approved).status).toBe('APPROVED');
  });

  it('refuses a missing payloadHash — the action cannot change after approve', () => {
    const { payloadHash: _, ...rest } = approved;
    expect(() => actionApprovalSchema.parse(rest)).toThrow();
  });

  it('treats two names in one body as not authority', () => {
    expect(
      namesAreNotActionApproval({
        actorId: 'authenticated-first-person',
        confirmOperatorId: 'unverified-second-person',
      }),
    ).toBe(true);
    expect(ACTION_APPROVAL_NOT_AUTHORITY).toBe('action_approval.names_are_not_authority');
  });

  it('only APPROVED with a distinct approver is consumable', () => {
    expect(isConsumableApproval(approved)).toBe(true);
    expect(approvalCannotExecute({ ...approved, status: 'PENDING', approverId: null })).toBe(true);
    expect(approvalCannotExecute({ ...approved, status: 'CONSUMED' })).toBe(true);
    expect(isConsumableApproval({ ...approved, status: 'REJECTED' })).toBe(false);
    expect(isConsumableApproval({ ...approved, approverId: approved.requesterId })).toBe(false);
    expect(isConsumableApproval({ ...approved, approverId: null })).toBe(false);
  });

  it('PENDING may carry a null approverId — the second person has not authenticated yet', () => {
    expect(actionApprovalSchema.parse({ ...approved, status: 'PENDING', approverId: null }).approverId).toBeNull();
  });

  it('propose input has no approverId — second person authenticates later', () => {
    const parsed = actionApprovalProposeInputSchema.parse({
      actionType: 'ledger.freeze',
      targetService: 'svc-ledger',
      targetId: 'posting_freeze',
      expectedVersion: '1',
      payloadHash: 'sha256:abc',
      policyVersion: 'v1',
    });
    expect(parsed).not.toHaveProperty('approverId');
    expect(parsed).not.toHaveProperty('confirmOperatorId');
  });

  it('approve input is the approval id only — identity of approver comes from the session', () => {
    expect(actionApprovalApproveInputSchema.parse({ approvalId: 'appr-1' })).toEqual({ approvalId: 'appr-1' });
    expect(() => actionApprovalApproveInputSchema.parse({ approvalId: 'appr-1', confirmOperatorId: 'someone' })).toThrow();
  });

  it('consume requires the same payload hash the approver saw', () => {
    const parsed = actionApprovalConsumeInputSchema.parse({
      approvalId: 'appr-1',
      operationId: 'op-1',
      payloadHash: 'sha256:abc',
      targetService: 'svc-ledger',
      targetId: 'posting_freeze',
      expectedVersion: '1',
    });
    expect(parsed.payloadHash).toBe('sha256:abc');
  });
});

describe('same-person approvals', () => {
  it('a same_person row is consumable by its own requester; a four-eyes row never is', () => {
    const self: ActionApproval = { ...approved, kind: 'same_person', requesterId: 'user-a', approverId: 'user-a' };
    expect(isConsumableApproval(self)).toBe(true);
    expect(isConsumableApproval({ ...self, approverId: 'user-b' })).toBe(false);
    expect(isConsumableApproval({ ...self, status: 'PENDING' })).toBe(false);
    expect(isConsumableApproval({ ...approved, approverId: approved.requesterId })).toBe(false);
  });

  it('consume input carries the optional principal and the list is closed', () => {
    const parsed = actionApprovalConsumeInputSchema.parse({
      approvalId: 'a',
      operationId: 'a',
      payloadHash: 'sha256:abc',
      targetService: 'svc-bank',
      targetId: 'bank.step_up.transfers.toUser',
      expectedVersion: '1',
      principalUserId: 'u',
      principalSessionId: 's',
    });
    expect(parsed.principalUserId).toBe('u');
    expect(isSamePersonActionType('bank.step_up.transfers.toUser')).toBe(true);
    expect(isSamePersonActionType('matching.open')).toBe(false);
    expect(SAME_PERSON_ACTION_TYPES.every((t) => t.startsWith('bank.step_up.'))).toBe(true);
  });
});
