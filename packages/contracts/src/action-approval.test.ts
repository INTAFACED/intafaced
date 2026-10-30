import { describe, expect, it } from 'vitest';
import {
  ACTION_APPROVAL_NOT_AUTHORITY,
  SAME_PERSON_ACTION_TYPES,
  isSamePersonActionType,
  samePersonTargetService,
  actionApprovalApproveInputSchema,
  actionApprovalConsumeInputSchema,
  actionApprovalIdInputSchema,
  actionApprovalProposeInputSchema,
  actionApprovalSchema,
  approvalCannotExecute,
  founderAttestationVerdict,
  isConsumableApproval,
  isProtectiveOperatorApproval,
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

  it('approve input names the approval and the payload hash the approver reviewed — identity of approver comes from the session', () => {
    const input = { approvalId: 'appr-1', expectedPayloadHash: 'sha256:abc' };
    expect(actionApprovalApproveInputSchema.parse(input)).toEqual(input);
    expect(() => actionApprovalApproveInputSchema.parse({ ...input, confirmOperatorId: 'someone' })).toThrow();
  });

  it('approve input refuses an id with no payload hash (an id alone never approves)', () => {
    expect(() => actionApprovalApproveInputSchema.parse({ approvalId: 'appr-1' })).toThrow();
    expect(() => actionApprovalApproveInputSchema.parse({ approvalId: 'appr-1', expectedPayloadHash: '' })).toThrow();
  });

  it('reject and revoke input is the approval id only', () => {
    expect(actionApprovalIdInputSchema.parse({ approvalId: 'appr-1' })).toEqual({ approvalId: 'appr-1' });
    expect(() => actionApprovalIdInputSchema.parse({ approvalId: 'appr-1', expectedPayloadHash: 'sha256:abc' })).toThrow();
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
    expect(isSamePersonActionType('identity.step_up.email_change')).toBe(true);
    expect(isSamePersonActionType('matching.open')).toBe(false);
    expect(samePersonTargetService('identity.step_up.email_change')).toBe('svc-identity');
    expect(samePersonTargetService('identity.step_up.phone_remove')).toBe('svc-identity');
    expect(samePersonTargetService('identity.step_up.close_account')).toBe('svc-identity');
    for (const action of [
      'passkey_add',
      'passkey_remove',
      'passkey_rename',
      'passkey_purposes',
      'passkey_second_step',
      'totp_replace',
      'totp_disable',
      'recovery_codes_regenerate',
      'password_change_with_second_factor',
      'fund_password_set',
      'limits_loosen',
      'self_freeze_lift',
      'trusted_device_remove',
      'trusted_device_approve',
      'link_method',
      'unlink_method',
      'sub_account_delete',
      'sub_account_edit',
      'anti_phishing_set',
      'security_lock_unlock',
    ]) {
      expect(isSamePersonActionType(`identity.step_up.${action}`)).toBe(true);
      expect(samePersonTargetService(`identity.step_up.${action}`)).toBe('svc-identity');
    }
    expect(samePersonTargetService('pay.step_up.payoutDestination.set')).toBe('svc-pay');
    expect(samePersonTargetService('p2p.step_up.trades.take')).toBe('svc-p2p');
    expect(samePersonTargetService('p2p.step_up.trades.confirmReceived')).toBe('svc-p2p');
    expect(samePersonTargetService('p2p.step_up.instruments.change')).toBe('svc-p2p');
    expect(samePersonTargetService('trade.step_up.bots.grid.withdrawProfit')).toBe('svc-trade');
    expect(samePersonTargetService('trade.step_up.copy.flatten')).toBe('svc-trade');
    expect(samePersonTargetService('token.step_up.governance.setRole')).toBe('svc-token');
    expect(samePersonTargetService('bank.step_up.transfers.toUser')).toBe('svc-bank');
    expect(
      SAME_PERSON_ACTION_TYPES.every(
        (t) =>
          t.startsWith('bank.step_up.') ||
          t.startsWith('pay.step_up.') ||
          t.startsWith('identity.step_up.') ||
          t.startsWith('p2p.step_up.') ||
          t.startsWith('trade.step_up.') ||
          t.startsWith('token.step_up.'),
      ),
    ).toBe(true);
  });
});

const consumed: ActionApproval = { ...approved, status: 'CONSUMED' };

describe('founder attestation at the consumer', () => {
  const founders = { approverIsFounder: true, requesterIsFounder: true } as const;

  it('treats a brake as operator only when type, service, and verb all agree', () => {
    expect(isProtectiveOperatorApproval({ actionType: 'matching.halt', targetService: 'svc-matching', targetId: 'halt:BTC-USDT' })).toBe(
      true,
    );
    expect(isProtectiveOperatorApproval({ actionType: ' Matching.Halt ', targetService: ' SVC-MATCHING ', targetId: 'HALT:btc' })).toBe(
      true,
    );
    expect(isProtectiveOperatorApproval({ actionType: 'matching.halt_all', targetService: 'svc-matching', targetId: 'halt_all' })).toBe(
      true,
    );
    expect(
      isProtectiveOperatorApproval({ actionType: 'matching.reduce_only', targetService: 'svc-matching', targetId: 'reduce_only:BTC-USDT' }),
    ).toBe(true);
    expect(
      isProtectiveOperatorApproval({ actionType: 'matching.post_only', targetService: 'svc-matching', targetId: 'post_only:BTC-USDT' }),
    ).toBe(true);
    expect(isProtectiveOperatorApproval({ actionType: 'ledger.freeze', targetService: 'svc-ledger', targetId: 'posting_freeze' })).toBe(
      true,
    );
    expect(isProtectiveOperatorApproval({ actionType: 'matching.halt', targetService: 'svc-matching', targetId: 'open:BTC-USDT' })).toBe(
      false,
    );
    expect(isProtectiveOperatorApproval({ actionType: 'matching.halt', targetService: 'svc-pay', targetId: 'halt:BTC-USDT' })).toBe(false);
    expect(isProtectiveOperatorApproval({ actionType: 'ledger.freeze', targetService: 'svc-ledger', targetId: 'posting_unfreeze' })).toBe(
      false,
    );
    expect(isProtectiveOperatorApproval({ actionType: 'matching.open', targetService: 'svc-matching', targetId: 'open:BTC-USDT' })).toBe(
      false,
    );
  });

  it('accepts a protective verb with no founder attestation', () => {
    const halt = { ...consumed, actionType: 'matching.halt', targetService: 'svc-matching', targetId: 'halt:BTC-USDT' };
    expect(
      founderAttestationVerdict(halt, { actionType: 'matching.halt', targetService: 'svc-matching', targetId: 'halt:BTC-USDT' }),
    ).toEqual({
      ok: true,
    });
    const freeze = {
      ...consumed,
      actionType: 'ledger.freeze',
      targetService: 'svc-ledger',
      targetId: 'posting_freeze',
      approverIsFounder: false,
    };
    expect(
      founderAttestationVerdict(freeze, { actionType: 'ledger.freeze', targetService: 'svc-ledger', targetId: 'posting_freeze' }),
    ).toEqual({
      ok: true,
    });
  });

  it('calls a founder row with no flags missing, and a false or swapped row forged', () => {
    const open = {
      ...consumed,
      actionType: 'matching.open',
      targetService: 'svc-matching',
      targetId: 'open:BTC-USDT',
    };
    const subject = { actionType: 'matching.open', targetService: 'svc-matching', targetId: 'open:BTC-USDT' };
    expect(founderAttestationVerdict(open, subject)).toEqual({ ok: false, reason: 'missing' });
    expect(founderAttestationVerdict({ ...open, ...founders, approverIsFounder: false }, subject)).toEqual({ ok: false, reason: 'forged' });
    expect(founderAttestationVerdict({ ...open, ...founders, approverId: ' User-A ', requesterId: 'user-a' }, subject)).toEqual({
      ok: false,
      reason: 'forged',
    });
    expect(founderAttestationVerdict({ ...open, ...founders, targetId: 'halt:BTC-USDT' }, subject)).toEqual({
      ok: false,
      reason: 'forged',
    });
    expect(founderAttestationVerdict({ ...open, ...founders, actionType: 'matching.halt' }, subject)).toEqual({
      ok: false,
      reason: 'forged',
    });
    expect(founderAttestationVerdict({ ...open, ...founders }, subject)).toEqual({ ok: true });
    expect(founderAttestationVerdict({ ...open, ...founders, actionType: 'open:BTC-USDT' }, subject)).toEqual({
      ok: false,
      reason: 'forged',
    });
  });
});
