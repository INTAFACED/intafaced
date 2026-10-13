import { describe, expect, it } from 'vitest';
import { actionApprovalSchema, type ActionApprovalConsumeInput, type ActionApprovalStatus } from '@intafaced/contracts';
import {
  ActionApprovalConsumeError,
  consumePayApproval,
  createIdentityApprovalClient,
  payActionPayloadHash,
  readApprovalIds,
  stubApprovalConsumer,
  unwiredApprovalConsumer,
  type ActionApprovalConsumer,
} from './action-approval-consume.js';

function consumeResult(input: ActionApprovalConsumeInput, status: ActionApprovalStatus, approverId: string | null) {
  return actionApprovalSchema.parse({
    ...input,
    actionType: input.targetId,
    requesterId: 'requester',
    approverId,
    policyVersion: 'v1',
    createdAt: '2026-09-09T12:00:00.000Z',
    expiresAt: '2026-09-09T12:10:00.000Z',
    status,
    operationId: input.operationId,
  });
}

function consumerReturning(status: ActionApprovalStatus, approverId: string | null): ActionApprovalConsumer {
  return {
    async consume(input) {
      return consumeResult(input, status, approverId);
    },
  };
}

describe('pay action-approval consume', () => {
  it('payload hash is stable for the same KYB decision', () => {
    expect(payActionPayloadHash('pay.merchant_decide_kyb', { merchantId: 'm', decision: 'approved' })).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(payActionPayloadHash('pay.merchant_decide_kyb', { merchantId: 'm', decision: 'approved' })).not.toBe(
      payActionPayloadHash('pay.merchant_decide_kyb', { merchantId: 'm', decision: 'rejected' }),
    );
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

  it('status CONSUMED and approverId null throws action_approval.consume_failed and does not resolve to the requester', async () => {
    const settled = await consumePayApproval(
      consumerReturning('CONSUMED', null),
      { approvalId: 'appr-1', operationId: 'op-1' },
      'pay.kyb_decide',
      { decision: 'approved' },
    ).then(
      (approverId) => ({ kind: 'resolved' as const, approverId }),
      (error: unknown) => ({ kind: 'rejected' as const, error }),
    );
    expect(settled.kind === 'resolved' ? settled.approverId : undefined).not.toBe('requester');
    expect(settled.kind).toBe('rejected');
    if (settled.kind === 'rejected') {
      expect(settled.error).toBeInstanceOf(ActionApprovalConsumeError);
      expect(settled.error).toMatchObject({ code: 'action_approval.consume_failed' });
    }
  });

  it('status PENDING with an approverId throws action_approval.consume_failed', async () => {
    await expect(
      consumePayApproval(consumerReturning('PENDING', 'approver-1'), { approvalId: 'appr-1', operationId: 'op-1' }, 'pay.kyb_decide', {
        decision: 'approved',
      }),
    ).rejects.toMatchObject({ code: 'action_approval.consume_failed' });
  });

  it('status CONSUMED with approverId approver-1 returns approver-1', async () => {
    await expect(
      consumePayApproval(consumerReturning('CONSUMED', 'approver-1'), { approvalId: 'appr-1', operationId: 'op-1' }, 'pay.kyb_decide', {
        decision: 'approved',
      }),
    ).resolves.toBe('approver-1');
  });
});
