import { describe, expect, it } from 'vitest';
import {
  ActionApprovalConsumeError,
  createIdentityApprovalClient,
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

  it('a fetch that never resolves is aborted by the signal', async () => {
    // AbortSignal.timeout is not driven by fake timers. This waits the real 2000ms.
    const realFetch = globalThis.fetch;
    globalThis.fetch = ((_input: unknown, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        const signal = init?.signal;
        if (signal == null) return;
        const fail = () => reject(signal.reason);
        if (signal.aborted) {
          fail();
          return;
        }
        signal.addEventListener('abort', fail, { once: true });
      })) as typeof fetch;
    try {
      const consume = createIdentityApprovalClient('http://identity.test', 'test-internal-service-secret-32ch!!').consume({
        approvalId: 'appr-1',
        operationId: 'op-1',
        payloadHash: 'sha256:abc',
        targetService: 'svc-pay',
        targetId: 'pay.kyb_decide',
        expectedVersion: '1',
      });
      let caught: unknown;
      try {
        await consume;
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(Error);
      expect(['TimeoutError', 'AbortError']).toContain((caught as Error).name);
    } finally {
      globalThis.fetch = realFetch;
    }
  }, 10_000);
});
