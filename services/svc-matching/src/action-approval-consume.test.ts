import { afterEach, describe, expect, it, vi } from 'vitest';
import { actionApprovalSchema } from '@intafaced/contracts';
import {
  ActionApprovalConsumeError,
  consumeMatchingApproval,
  createIdentityApprovalClient,
  matchingActionPayloadHash,
  readApprovalIds,
  unwiredApprovalConsumer,
  unwrapTrpcJson,
  type ActionApprovalConsumer,
} from './action-approval-consume.js';

describe('matching action-approval consume', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('payload hash is stable for the same halt market', () => {
    expect(matchingActionPayloadHash('matching.halt', { marketId: 'BTC-USDT' })).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(matchingActionPayloadHash('matching.halt', { marketId: 'BTC-USDT' })).not.toBe(
      matchingActionPayloadHash('matching.halt', { marketId: 'ETH-USDT' }),
    );
    expect(matchingActionPayloadHash('matching.halt_all', {})).not.toBe(matchingActionPayloadHash('matching.resume_all', {}));
  });

  it('blank IDENTITY_URL consumer refuses instead of inventing a second person', async () => {
    await expect(
      unwiredApprovalConsumer().consume({
        approvalId: 'appr-1',
        operationId: 'op-1',
        payloadHash: 'sha256:abc',
        targetService: 'svc-matching',
        targetId: 'halt:BTC-USDT',
        expectedVersion: '1',
      }),
    ).rejects.toMatchObject({ code: 'action_approval.identity_unwired' });
  });

  it('typed-in names without approval ids refuse', () => {
    expect(() => readApprovalIds({ approvalId: null, operationId: null })).toThrow(ActionApprovalConsumeError);
    expect(() => readApprovalIds({ approvalId: 'appr-1', operationId: '' })).toThrow(/typed-in second name/);
  });

  it('unwraps tRPC result.data.json', () => {
    const inner = { approvalId: 'appr-1', status: 'CONSUMED' };
    expect(unwrapTrpcJson({ result: { data: { json: inner } } })).toEqual(inner);
    expect(unwrapTrpcJson(inner)).toEqual(inner);
  });

  it('HMAC consume posts to identity actionApproval.consume as svc-matching', async () => {
    const row = {
      approvalId: 'appr-1',
      actionType: 'halt:BTC-USDT',
      targetService: 'svc-matching',
      targetId: 'halt:BTC-USDT',
      expectedVersion: '1',
      payloadHash: matchingActionPayloadHash('matching.halt', { marketId: 'BTC-USDT' }),
      requesterId: 'requester',
      approverId: 'ops-confirm',
      policyVersion: 'v1',
      createdAt: '2026-09-09T12:00:00.000Z',
      expiresAt: '2026-09-09T12:10:00.000Z',
      status: 'CONSUMED' as const,
      operationId: 'op-1',
    };
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ result: { data: { json: row } } }),
    }));
    vi.stubGlobal('fetch', fetchMock);
    const client = createIdentityApprovalClient('http://identity.test', 's'.repeat(32));
    const consumed = await client.consume({
      approvalId: 'appr-1',
      operationId: 'op-1',
      payloadHash: row.payloadHash,
      targetService: 'svc-matching',
      targetId: 'halt:BTC-USDT',
      expectedVersion: '1',
    });
    expect(consumed.approverId).toBe('ops-confirm');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, { headers: Record<string, string>; body: string }];
    expect(url).toBe('http://identity.test/trpc/actionApproval.consume');
    expect(init.headers['x-intafaced-service']).toBe('svc-matching');
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

describe('founder attestation at matching consume', () => {
  it('refuses opening a market when identity sends no attestation', async () => {
    await expect(
      consumeMatchingApproval(
        echoingApproval((row) => {
          delete row.approverIsFounder;
          delete row.requesterIsFounder;
        }),
        approvalCmd,
        'matching.open',
        { marketId: 'BTC-USDT' },
        'open:BTC-USDT',
      ),
    ).rejects.toMatchObject({ code: 'action_approval.not_founders' });
  });

  it('refuses a forged or mismatched founder attestation', async () => {
    const refuse = (mutate: (row: Record<string, unknown>) => void) =>
      expect(
        consumeMatchingApproval(echoingApproval(mutate), approvalCmd, 'matching.resume', { marketId: 'BTC-USDT' }, 'resume:BTC-USDT'),
      ).rejects.toMatchObject({ code: 'action_approval.not_founders' });
    await refuse((row) => {
      row.approverIsFounder = false;
      row.requesterIsFounder = true;
    });
    await refuse((row) => {
      row.approverId = ' REQUESTER ';
      row.requesterId = 'requester';
    });
    await refuse((row) => {
      row.targetId = 'halt:BTC-USDT';
    });
    await refuse((row) => {
      row.actionType = 'matching.halt';
    });
    await expect(
      consumeMatchingApproval(
        echoingApproval((row) => {
          delete row.approverIsFounder;
          delete row.requesterIsFounder;
        }),
        approvalCmd,
        'matching.halt',
        { marketId: 'BTC-USDT' },
        'open:BTC-USDT',
      ),
    ).rejects.toMatchObject({ code: 'action_approval.not_founders' });
  });

  it('accepts a distinct founder pair for opening a market', async () => {
    await expect(
      consumeMatchingApproval(echoingApproval(), approvalCmd, 'matching.open', { marketId: 'BTC-USDT' }, 'open:BTC-USDT'),
    ).resolves.toMatchObject({ approverId: 'founder-b' });
  });

  it('leaves halt, halt_all, reduce_only, and post_only working without an attestation', async () => {
    const brakes = [
      ['matching.halt', 'halt:BTC-USDT'],
      ['matching.halt_all', 'halt_all'],
      ['matching.reduce_only', 'reduce_only:BTC-USDT'],
      ['matching.post_only', 'post_only:BTC-USDT'],
    ] as const;
    for (const [actionType, targetId] of brakes) {
      const consumed = await consumeMatchingApproval(
        echoingApproval((row) => {
          delete row.approverIsFounder;
          delete row.requesterIsFounder;
        }),
        approvalCmd,
        actionType,
        {},
        targetId,
      );
      expect(consumed.approverId).toBe('founder-b');
      expect(consumed.approverIsFounder).toBeUndefined();
    }
  });
});
