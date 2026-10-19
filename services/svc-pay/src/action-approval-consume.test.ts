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

type Attestation = { approverIsFounder?: boolean; requesterIsFounder?: boolean };
/** What identity attests on a consume of a founder-only row: both parties are live founders. */
const FOUNDERS: Attestation = { approverIsFounder: true, requesterIsFounder: true };

function consumeResult(
  input: ActionApprovalConsumeInput,
  status: ActionApprovalStatus,
  approverId: string | null,
  attestation: Attestation = FOUNDERS,
  requesterId = 'requester',
) {
  return actionApprovalSchema.parse({
    ...input,
    actionType: input.targetId,
    requesterId,
    approverId,
    ...attestation,
    policyVersion: 'v1',
    createdAt: '2026-09-09T12:00:00.000Z',
    expiresAt: '2026-09-09T12:10:00.000Z',
    status,
    operationId: input.operationId,
  });
}

function consumerReturning(
  status: ActionApprovalStatus,
  approverId: string | null,
  attestation: Attestation = FOUNDERS,
  requesterId = 'requester',
): ActionApprovalConsumer {
  return {
    async consume(input) {
      return consumeResult(input, status, approverId, attestation, requesterId);
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

  describe('founder re-check at consume (no grandfathering)', () => {
    const cmd = { approvalId: 'appr-1', operationId: 'op-1' };
    const consume = (consumer: ActionApprovalConsumer) => consumePayApproval(consumer, cmd, 'pay.deposit_credit', { amount: '1' });

    it('refuses an approver identity does not attest as a founder', async () => {
      await expect(
        consume(consumerReturning('CONSUMED', 'approver-1', { approverIsFounder: false, requesterIsFounder: true })),
      ).rejects.toMatchObject({
        code: 'action_approval.not_founders',
      });
    });

    it('refuses a proposer identity does not attest as a founder', async () => {
      await expect(
        consume(consumerReturning('CONSUMED', 'approver-1', { approverIsFounder: true, requesterIsFounder: false })),
      ).rejects.toMatchObject({
        code: 'action_approval.not_founders',
      });
    });

    it('refuses when identity sends no attestation at all (an identity from before this check fails closed)', async () => {
      await expect(consume(consumerReturning('CONSUMED', 'approver-1', {}))).rejects.toMatchObject({
        code: 'action_approval.not_founders',
      });
    });

    it('refuses the proposer as their own approver, whatever the attestation says', async () => {
      await expect(consume(consumerReturning('CONSUMED', 'Requester', FOUNDERS, 'requester '))).rejects.toMatchObject({
        code: 'action_approval.not_founders',
      });
    });

    it('accepts a distinct founder pair', async () => {
      await expect(consume(consumerReturning('CONSUMED', 'founder-b', FOUNDERS, 'founder-a'))).resolves.toBe('founder-b');
    });

    it('through the identity client: a payload mismatch is typed action_approval.payload_mismatch', async () => {
      const realFetch = globalThis.fetch;
      globalThis.fetch = (async () =>
        new Response(
          JSON.stringify({
            error: {
              message: 'payload hash does not match the approved action [action_approval.payload_mismatch]',
              data: { code: 'PRECONDITION_FAILED', httpStatus: 412 },
            },
          }),
          { status: 412 },
        )) as typeof fetch;
      try {
        const client = createIdentityApprovalClient('http://identity.test', 'test-internal-service-secret-32ch!!');
        await expect(consume(client)).rejects.toMatchObject({ code: 'action_approval.payload_mismatch' });
      } finally {
        globalThis.fetch = realFetch;
      }
    });

    it('through the identity client: a pre-existing APPROVED row approved by a non-founder is refused by identity and surfaces as a failed consume', async () => {
      const realFetch = globalThis.fetch;
      globalThis.fetch = (async () =>
        new Response(
          JSON.stringify({
            error: { message: 'founders only [action_approval.founder_only]', data: { code: 'FORBIDDEN', httpStatus: 403 } },
          }),
          { status: 403 },
        )) as typeof fetch;
      try {
        const client = createIdentityApprovalClient('http://identity.test', 'test-internal-service-secret-32ch!!');
        await expect(consume(client)).rejects.toMatchObject({ code: 'action_approval.consume_failed' });
      } finally {
        globalThis.fetch = realFetch;
      }
    });

    it('through the identity client: a consumed row with no founder attestation is refused even though identity said 200', async () => {
      const realFetch = globalThis.fetch;
      globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
        const input = JSON.parse(String(init?.body)) as ActionApprovalConsumeInput;
        return new Response(JSON.stringify({ result: { data: consumeResult(input, 'CONSUMED', 'admin-1', {}) } }), { status: 200 });
      }) as typeof fetch;
      try {
        const client = createIdentityApprovalClient('http://identity.test', 'test-internal-service-secret-32ch!!');
        await expect(consume(client)).rejects.toMatchObject({ code: 'action_approval.not_founders' });
      } finally {
        globalThis.fetch = realFetch;
      }
    });

    it('through the identity client: a 200 reply for a different payload than the request is refused', async () => {
      const realFetch = globalThis.fetch;
      globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
        const input = JSON.parse(String(init?.body)) as ActionApprovalConsumeInput;
        const other = { ...input, payloadHash: 'sha256:someone-elses-action' };
        return new Response(JSON.stringify({ result: { data: consumeResult(other, 'CONSUMED', 'founder-b', FOUNDERS, 'founder-a') } }), {
          status: 200,
        });
      }) as typeof fetch;
      try {
        const client = createIdentityApprovalClient('http://identity.test', 'test-internal-service-secret-32ch!!');
        await expect(consume(client)).rejects.toMatchObject({ code: 'action_approval.consume_failed' });
      } finally {
        globalThis.fetch = realFetch;
      }
    });
  });
});
