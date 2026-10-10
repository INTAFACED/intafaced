import { describe, expect, it } from 'vitest';
import {
  ActionApprovalConsumeError,
  payActionPayloadHash,
  readApprovalIds,
  stubApprovalConsumer,
  unwiredApprovalConsumer,
} from './action-approval-consume.js';

describe('pay action-approval consume', () => {
  it('payload hash is stable for the same KYB decision', () => {
    expect(payActionPayloadHash('pay.merchant_decide_kyb', { merchantId: 'm', decision: 'approved' })).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(payActionPayloadHash('pay.merchant_decide_kyb', { merchantId: 'm', decision: 'approved' })).not.toBe(
      payActionPayloadHash('pay.merchant_decide_kyb', { merchantId: 'm', decision: 'rejected' }),
    );
  });

  it('payload hash keeps the action type and ignores field key order', () => {
    expect(payActionPayloadHash('grant', { actionType: 'revoke', amount: '1' })).not.toBe(
      payActionPayloadHash('revoke', { amount: '1' }),
    );
    expect(payActionPayloadHash('grant', { b: '2', a: '1' })).toBe(payActionPayloadHash('grant', { a: '1', b: '2' }));
  });

  it('blank IDENTITY_URL consumer refuses instead of inventing a second person', async () => {
    await expect(
      unwiredApprovalConsumer().consume({
        approvalId: 'appr-1',
        operationId: 'op-1',
        payloadHash: 'sha256:abc',
        targetService: 'svc-pay',
        targetId: 'pay.deposit_credit',
        expectedVersion: '1',
      }),
    ).rejects.toMatchObject({ code: 'action_approval.identity_unwired' });
  });

  it('typed-in names without approval ids refuse', () => {
    expect(() => readApprovalIds({ approvalId: null, operationId: null })).toThrow(ActionApprovalConsumeError);
    expect(() => readApprovalIds({ approvalId: 'appr-1', operationId: '  ' })).toThrow(ActionApprovalConsumeError);
  });

  it('stub consumes and names the authentic approver', async () => {
    const row = await stubApprovalConsumer('approver-1').consume({
      approvalId: 'appr-1',
      operationId: 'op-1',
      payloadHash: 'sha256:abc',
      targetService: 'svc-pay',
      targetId: 'pay.kyb_decide',
      expectedVersion: '1',
    });
    expect(row).toMatchObject({ status: 'CONSUMED', approverId: 'approver-1', targetService: 'svc-pay' });
  });
});
