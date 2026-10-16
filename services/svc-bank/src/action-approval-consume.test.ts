import { describe, expect, it, vi } from 'vitest';
import { actionApprovalSchema } from '@intafaced/contracts';
import {
  ActionApprovalConsumeError,
  assertFounderAudienceAttestation,
  bankActionPayloadHash,
  consumeBankOpsApproval,
  createIdentityApprovalClient,
  IDENTITY_CONSUME_TIMEOUT_MS,
  readApprovalIds,
  stubApprovalConsumer,
  unwiredApprovalConsumer,
  type ActionApprovalConsumer,
} from './action-approval-consume.js';

const CONSUME_REQUEST = {
  approvalId: 'appr-1',
  operationId: 'op-1',
  payloadHash: 'sha256:abc',
  targetService: 'svc-bank',
  targetId: 'bank.fund_pool',
  expectedVersion: '1',
} as const;

function consumeApproval(overrides: Record<string, string> = {}) {
  return {
    approvalId: 'appr-1',
    operationId: 'op-1',
    actionType: 'bank.fund_pool',
    targetService: 'svc-bank',
    targetId: 'bank.fund_pool',
    expectedVersion: '1',
    payloadHash: 'sha256:abc',
    requesterId: 'requester',
    approverId: 'approver',
    policyVersion: 'v1',
    createdAt: '2026-09-09T12:00:00.000Z',
    expiresAt: '2026-09-09T12:10:00.000Z',
    status: 'CONSUMED',
    ...overrides,
  };
}

async function consumeWithBody(body: unknown) {
  const orig = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch;
  try {
    const client = createIdentityApprovalClient('http://identity.test', 'x'.repeat(32));
    return await client.consume(CONSUME_REQUEST);
  } finally {
    globalThis.fetch = orig;
  }
}

describe('bank action-approval consume', () => {
  it('payload hash is stable for the same fund-pool fields', () => {
    expect(bankActionPayloadHash('bank.fund_pool', { poolId: 'p', fundingId: 'f', amount: '10' })).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(bankActionPayloadHash('bank.fund_pool', { poolId: 'p', fundingId: 'f', amount: '10' })).not.toBe(
      bankActionPayloadHash('bank.fund_pool', { poolId: 'p', fundingId: 'f', amount: '11' }),
    );
  });

  it('keeps the action type and ignores field key order', () => {
    const digest = bankActionPayloadHash('ops.limit', { z: '1', a: '2' });
    expect(digest.startsWith('sha256:')).toBe(true);
    expect(digest).toBe(bankActionPayloadHash('ops.limit', { a: '2', z: '1' }));
    expect(bankActionPayloadHash('ops.limit', { actionType: 'other' })).not.toBe(bankActionPayloadHash('other', {}));
  });

  it('blank IDENTITY_URL consumer refuses instead of inventing a second person', async () => {
    await expect(
      unwiredApprovalConsumer().consume({
        approvalId: 'appr-1',
        operationId: 'op-1',
        payloadHash: 'sha256:abc',
        targetService: 'svc-bank',
        targetId: 'bank.fund_pool',
        expectedVersion: '1',
      }),
    ).rejects.toMatchObject({ code: 'action_approval.identity_unwired' });
  });

  it('typed-in names without approval ids refuse', () => {
    expect(() => readApprovalIds({ approvalId: null, operationId: null })).toThrow(ActionApprovalConsumeError);
    expect(() => readApprovalIds({ approvalId: 'appr-1', operationId: '   ' })).toThrow(ActionApprovalConsumeError);
  });

  it('stubApprovalConsumer is one-arg and returns that approverId', async () => {
    const consumed = await stubApprovalConsumer('dddddddd-dddd-4ddd-8ddd-dddddddddddd').consume({
      approvalId: 'appr-1',
      operationId: 'op-1',
      payloadHash: bankActionPayloadHash('bank.fund_pool', { poolId: 'p', fundingId: 'f', amount: '10' }),
      targetService: 'svc-bank',
      targetId: 'bank.fund_pool',
      expectedVersion: '1',
    });
    expect(consumed.approverId).toBe('dddddddd-dddd-4ddd-8ddd-dddddddddddd');
    expect(consumed.status).toBe('CONSUMED');
  });

  it('unwraps tRPC result.data / .json before parse', async () => {
    const approval = {
      approvalId: 'appr-1',
      operationId: 'op-1',
      actionType: 'bank.fund_pool',
      targetService: 'svc-bank',
      targetId: 'bank.fund_pool',
      expectedVersion: '1',
      payloadHash: 'sha256:abc',
      requesterId: 'requester',
      approverId: 'approver',
      policyVersion: 'v1',
      createdAt: '2026-09-09T12:00:00.000Z',
      expiresAt: '2026-09-09T12:10:00.000Z',
      status: 'CONSUMED',
    };
    const orig = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ result: { data: { json: approval } } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch;
    try {
      const client = createIdentityApprovalClient('http://identity.test', 'x'.repeat(32));
      await expect(
        client.consume({
          approvalId: 'appr-1',
          operationId: 'op-1',
          payloadHash: 'sha256:abc',
          targetService: 'svc-bank',
          targetId: 'bank.fund_pool',
          expectedVersion: '1',
        }),
      ).resolves.toMatchObject({ approvalId: 'appr-1', approverId: 'approver' });
    } finally {
      globalThis.fetch = orig;
    }
  });

  it('returns a consume body that matches the request and is CONSUMED', async () => {
    const body = consumeApproval();
    await expect(consumeWithBody(body)).resolves.toEqual(body);
  });

  it('refuses an APPROVED body when the request fields otherwise match', async () => {
    await expect(consumeWithBody(consumeApproval({ status: 'APPROVED' }))).rejects.toMatchObject({
      name: 'ActionApprovalConsumeError',
      code: 'action_approval.consume_failed',
    });
  });

  it('refuses a consume body whose approvalId does not match the request', async () => {
    await expect(consumeWithBody(consumeApproval({ approvalId: 'appr-other' }))).rejects.toMatchObject({
      name: 'ActionApprovalConsumeError',
      code: 'action_approval.consume_failed',
    });
  });

  it.each([
    ['operationId', 'op-other'],
    ['payloadHash', 'sha256:def'],
    ['targetService', 'svc-other'],
    ['targetId', 'bank.other'],
    ['expectedVersion', '2'],
  ] as const)('refuses a consume body whose %s does not match the request', async (field, value) => {
    await expect(consumeWithBody(consumeApproval({ [field]: value }))).rejects.toMatchObject({
      name: 'ActionApprovalConsumeError',
      code: 'action_approval.consume_failed',
    });
  });
});

describe('identity consume client', () => {
  it('gives identity a bounded time to answer, and a timeout rejects instead of hanging', async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(AbortSignal.abort(new DOMException('timed out', 'TimeoutError')));
    let seen: AbortSignal | null | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        seen = init.signal;
        if (init.signal?.aborted) throw init.signal.reason;
        throw new Error('expected an aborted signal');
      }),
    );
    try {
      const client = createIdentityApprovalClient('http://identity.test', 's'.repeat(32));
      await expect(
        client.consume({
          approvalId: 'a',
          operationId: 'a',
          payloadHash: 'sha256:abc',
          targetService: 'svc-bank',
          targetId: 'bank.step_up.transfers.toUser',
          expectedVersion: '1',
        }),
      ).rejects.toMatchObject({ name: 'TimeoutError' });
      expect(timeoutSpy).toHaveBeenCalledWith(IDENTITY_CONSUME_TIMEOUT_MS);
      expect(IDENTITY_CONSUME_TIMEOUT_MS).toBe(5000);
      expect(seen).toBeInstanceOf(AbortSignal);
    } finally {
      vi.unstubAllGlobals();
      timeoutSpy.mockRestore();
    }
  });
});

const approvalCmd = { approvalId: 'appr-1', operationId: 'op-1' };

function echoingApproval(mutate: (row: Record<string, unknown>) => void = () => {}): ActionApprovalConsumer {
  return {
    async consume(input) {
      const row: Record<string, unknown> = {
        ...input,
        actionType: input.targetId,
        requesterId: 'founder-a',
        approverId: 'founder-b',
        policyVersion: 'v1',
        createdAt: '2026-09-09T12:00:00.000Z',
        expiresAt: '2026-09-09T12:10:00.000Z',
        status: 'CONSUMED',
        approverIsFounder: true,
        requesterIsFounder: true,
      };
      mutate(row);
      return actionApprovalSchema.parse(row);
    },
  };
}

describe('founder attestation at bank consume', () => {
  it('refuses a founder action when identity sends no attestation', async () => {
    await expect(
      consumeBankOpsApproval(
        echoingApproval((row) => {
          delete row.approverIsFounder;
          delete row.requesterIsFounder;
        }),
        approvalCmd,
        'bank.fund_pool',
        { poolId: 'p' },
      ),
    ).rejects.toMatchObject({ code: 'action_approval.not_founders' });
  });

  it('refuses a forged or mismatched founder attestation', async () => {
    const refuse = (mutate: (row: Record<string, unknown>) => void) =>
      expect(consumeBankOpsApproval(echoingApproval(mutate), approvalCmd, 'bank.seize_loan', { loanId: 'l' })).rejects.toMatchObject({
        code: 'action_approval.not_founders',
      });
    await refuse((row) => {
      row.approverIsFounder = false;
    });
    await refuse((row) => {
      row.requesterIsFounder = false;
    });
    await refuse((row) => {
      row.approverId = 'Founder-A';
      row.requesterId = 'founder-a';
    });
    await refuse((row) => {
      row.targetId = 'bank.other';
    });
    await refuse((row) => {
      row.actionType = 'matching.halt';
    });
  });

  it('accepts a distinct founder pair', async () => {
    await expect(consumeBankOpsApproval(echoingApproval(), approvalCmd, 'bank.fund_pool', { poolId: 'p' })).resolves.toBe('founder-b');
  });

  it('leaves protective verbs working without an attestation', () => {
    const brakes = [
      { actionType: 'matching.halt', targetService: 'svc-matching', targetId: 'halt:BTC-USDT' },
      { actionType: 'matching.halt_all', targetService: 'svc-matching', targetId: 'halt_all' },
      { actionType: 'matching.reduce_only', targetService: 'svc-matching', targetId: 'reduce_only:BTC-USDT' },
      { actionType: 'matching.post_only', targetService: 'svc-matching', targetId: 'post_only:BTC-USDT' },
      { actionType: 'ledger.freeze', targetService: 'svc-ledger', targetId: 'posting_freeze' },
    ] as const;
    for (const subject of brakes) {
      const row = actionApprovalSchema.parse({
        approvalId: 'appr-1',
        operationId: 'op-1',
        ...subject,
        expectedVersion: '1',
        payloadHash: 'sha256:abc',
        requesterId: 'ops-a',
        approverId: 'ops-b',
        policyVersion: 'v1',
        createdAt: '2026-09-09T12:00:00.000Z',
        expiresAt: '2026-09-09T12:10:00.000Z',
        status: 'CONSUMED',
        approverIsFounder: false,
      });
      expect(() => assertFounderAudienceAttestation(row, subject)).not.toThrow();
    }
  });
});
