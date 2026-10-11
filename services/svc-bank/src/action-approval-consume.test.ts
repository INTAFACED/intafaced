import { describe, expect, it } from 'vitest';
import {
  ActionApprovalConsumeError,
  bankActionPayloadHash,
  createIdentityApprovalClient,
  readApprovalIds,
  stubApprovalConsumer,
  unwiredApprovalConsumer,
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
