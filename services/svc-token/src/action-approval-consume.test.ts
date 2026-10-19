import { describe, expect, it, vi } from 'vitest';
import { actionApprovalSchema } from '@intafaced/contracts';
import {
  ActionApprovalConsumeError,
  assertFounderAudienceAttestation,
  consumeTokenApproval,
  createIdentityApprovalClient,
  readApprovalIds,
  tokenActionPayloadHash,
  unwiredApprovalConsumer,
  type ActionApprovalConsumer,
} from './action-approval-consume.js';

const consumed = {
  approvalId: 'appr-1',
  actionType: 'token.revenue.distribute',
  targetService: 'svc-token',
  targetId: 'token.revenue.distribute',
  expectedVersion: 'w1',
  payloadHash: 'sha256:abc',
  requesterId: 'requester',
  approverId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  policyVersion: 'v1',
  createdAt: '2026-09-09T12:00:00.000Z',
  expiresAt: '2026-09-09T12:10:00.000Z',
  status: 'CONSUMED' as const,
  operationId: 'op-1',
};

describe('token action-approval consume', () => {
  it('payload hash is stable for the same window + amounts', () => {
    expect(tokenActionPayloadHash('token.revenue.distribute', { windowId: 'w1', sources: 'trade:100' })).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(tokenActionPayloadHash('token.revenue.distribute', { windowId: 'w1', sources: 'trade:100' })).not.toBe(
      tokenActionPayloadHash('token.revenue.distribute', { windowId: 'w1', sources: 'trade:101' }),
    );
  });

  it('blank IDENTITY_URL consumer refuses instead of inventing a second person', async () => {
    await expect(
      unwiredApprovalConsumer().consume({
        approvalId: 'appr-1',
        operationId: 'op-1',
        payloadHash: 'sha256:abc',
        targetService: 'svc-token',
        targetId: 'token.revenue.distribute',
        expectedVersion: 'w1',
      }),
    ).rejects.toMatchObject({ code: 'action_approval.identity_unwired' });
  });

  it('typed-in names without approval ids refuse', () => {
    expect(() => readApprovalIds({ approvalId: null, operationId: null })).toThrow(ActionApprovalConsumeError);
    expect(() => readApprovalIds({ approvalId: 'appr-1', operationId: '  ' })).toThrow(ActionApprovalConsumeError);
  });

  it('parses tRPC result.data (and superjson .json), not the raw envelope', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ result: { data: { json: consumed } } }),
    }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      const client = createIdentityApprovalClient('http://identity.test', 's'.repeat(32));
      const got = await client.consume({
        approvalId: 'appr-1',
        operationId: 'op-1',
        payloadHash: 'sha256:abc',
        targetService: 'svc-token',
        targetId: 'token.revenue.distribute',
        expectedVersion: 'w1',
      });
      expect(actionApprovalSchema.parse(got).approverId).toBe(consumed.approverId);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  const request = {
    approvalId: 'appr-1',
    operationId: 'op-1',
    payloadHash: 'sha256:abc',
    targetService: 'svc-token',
    targetId: 'token.revenue.distribute',
    expectedVersion: 'w1',
  };

  it('refuses a reply for a different approval, payload or status than the request', async () => {
    for (const change of [{ payloadHash: 'sha256:other' }, { approvalId: 'appr-2' }, { expectedVersion: 'w2' }, { status: 'PENDING' }]) {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => ({ ok: true, json: async () => ({ result: { data: { json: { ...consumed, ...change } } } }) })),
      );
      try {
        const client = createIdentityApprovalClient('http://identity.test', 's'.repeat(32));
        await expect(client.consume(request)).rejects.toMatchObject({ code: 'action_approval.consume_failed' });
      } finally {
        vi.unstubAllGlobals();
      }
    }
  });

  it('bounds the identity call with a timeout so a hung identity cannot block a founder-gated mutation', async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => ({
      ok: true,
      json: async () => ({ result: { data: { json: consumed } } }),
    }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      await createIdentityApprovalClient('http://identity.test', 's'.repeat(32)).consume(request);
      expect(fetchMock.mock.calls[0]![1].signal).toBeInstanceOf(AbortSignal);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

const approvalCmd = { approvalId: 'appr-1', operationId: 'op-1' };

function echoingApproval(actionType: string, mutate: (row: Record<string, unknown>) => void = () => {}): ActionApprovalConsumer {
  return {
    async consume(input) {
      const row: Record<string, unknown> = {
        ...input,
        actionType,
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

describe('founder attestation at token consume', () => {
  it('refuses a founder action when identity sends no attestation', async () => {
    await expect(
      consumeTokenApproval(
        echoingApproval('token.revenue.distribute', (row) => {
          delete row.approverIsFounder;
          delete row.requesterIsFounder;
        }),
        approvalCmd,
        'token.revenue.distribute',
        { windowId: 'w1' },
        'w1',
      ),
    ).rejects.toMatchObject({ code: 'action_approval.not_founders' });
  });

  it('refuses a forged or mismatched founder attestation', async () => {
    const refuse = (mutate: (row: Record<string, unknown>) => void) =>
      expect(
        consumeTokenApproval(echoingApproval('token.buyback.record', mutate), approvalCmd, 'token.buyback.record', { runId: 'r1' }, 'r1'),
      ).rejects.toMatchObject({ code: 'action_approval.not_founders' });
    await refuse((row) => {
      row.approverIsFounder = false;
    });
    await refuse((row) => {
      row.requesterId = 'founder-b';
    });
    await refuse((row) => {
      row.targetService = 'svc-pay';
    });
    await refuse((row) => {
      row.actionType = 'token.other';
    });
  });

  it('accepts a distinct founder pair', async () => {
    await expect(
      consumeTokenApproval(echoingApproval('token.revenue.distribute'), approvalCmd, 'token.revenue.distribute', { windowId: 'w1' }, 'w1'),
    ).resolves.toMatchObject({ approverId: 'founder-b', approverIsFounder: true, requesterIsFounder: true });
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
        approverId: 'ops-a',
        policyVersion: 'v1',
        createdAt: '2026-09-09T12:00:00.000Z',
        expiresAt: '2026-09-09T12:10:00.000Z',
        status: 'CONSUMED',
      });
      expect(() => assertFounderAudienceAttestation(row, subject)).not.toThrow();
    }
  });
});
