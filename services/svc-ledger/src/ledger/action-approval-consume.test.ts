import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { actionApprovalSchema } from '@intafaced/contracts';
import {
  ActionApprovalConsumeError,
  consumeLedgerApproval,
  createIdentityApprovalClient,
  ledgerActionPayloadHash,
  readApprovalIds,
  unwrapTrpcData,
  unwiredApprovalConsumer,
  type ActionApprovalConsumer,
} from './action-approval-consume.js';

const HERE = dirname(fileURLToPath(import.meta.url));

const CONSUME_REQUEST = {
  approvalId: 'appr-1',
  operationId: 'op-1',
  payloadHash: 'sha256:abc',
  targetService: 'svc-ledger',
  targetId: 'posting_freeze',
  expectedVersion: '1',
};

function consumedApproval(overrides: Record<string, string> = {}) {
  return {
    approvalId: 'appr-1',
    actionType: 'ledger.freeze',
    targetService: 'svc-ledger',
    targetId: 'posting_freeze',
    expectedVersion: '1',
    payloadHash: 'sha256:abc',
    requesterId: 'requester',
    approverId: 'approver',
    policyVersion: 'v1',
    createdAt: '2026-09-09T12:00:00.000Z',
    expiresAt: '2026-09-09T12:10:00.000Z',
    status: 'CONSUMED',
    operationId: 'op-1',
    ...overrides,
  };
}

function stubHttpOk(body: unknown) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: true,
      json: async () => body,
    })),
  );
}

describe('ledger action-approval consume', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('payload hash is stable for the same freeze reason', () => {
    expect(ledgerActionPayloadHash('ledger.freeze', { reason: 'suspected drift in USDT' })).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(ledgerActionPayloadHash('ledger.freeze', { reason: 'a' })).not.toBe(ledgerActionPayloadHash('ledger.freeze', { reason: 'b' }));
  });

  it('blank IDENTITY_URL consumer refuses instead of inventing a second person', async () => {
    await expect(
      unwiredApprovalConsumer().consume({
        approvalId: 'appr-1',
        operationId: 'op-1',
        payloadHash: 'sha256:abc',
        targetService: 'svc-ledger',
        targetId: 'posting_freeze',
        expectedVersion: '1',
      }),
    ).rejects.toMatchObject({ code: 'action_approval.identity_unwired' });
  });

  it('typed-in names without approval ids refuse', () => {
    expect(() => readApprovalIds({ approvalId: null, operationId: null })).toThrow(ActionApprovalConsumeError);
  });

  it('unwraps tRPC result.data so live consume is not a Zod miss on the envelope', () => {
    const row = { approvalId: 'a', status: 'CONSUMED' };
    expect(unwrapTrpcData({ result: { data: row } })).toEqual(row);
    expect(unwrapTrpcData({ result: { data: { json: row } } })).toEqual(row);
    expect(unwrapTrpcData(row)).toEqual(row);
  });

  it('accepts an HTTP-ok body only when it is CONSUMED for this approval, operation, target, and payload hash', async () => {
    stubHttpOk({ result: { data: { json: consumedApproval() } } });
    const client = createIdentityApprovalClient('http://identity.test', 'x'.repeat(32));
    await expect(client.consume(CONSUME_REQUEST)).resolves.toMatchObject({
      approvalId: 'appr-1',
      operationId: 'op-1',
      targetService: 'svc-ledger',
      targetId: 'posting_freeze',
      expectedVersion: '1',
      payloadHash: 'sha256:abc',
      status: 'CONSUMED',
    });
  });

  it.each([
    ['status is not CONSUMED', { status: 'APPROVED' }],
    ['approvalId differs', { approvalId: 'appr-other' }],
    ['operationId differs', { operationId: 'op-other' }],
    ['target service differs', { targetService: 'svc-pay' }],
    ['target id differs', { targetId: 'posting_unfreeze' }],
    ['target version differs', { expectedVersion: '9' }],
    ['payload hash differs', { payloadHash: 'sha256:other' }],
  ])('refuses an HTTP-ok body when %s', async (_label, overrides) => {
    stubHttpOk({ result: { data: consumedApproval(overrides) } });
    const client = createIdentityApprovalClient('http://identity.test', 'x'.repeat(32));
    await expect(client.consume(CONSUME_REQUEST)).rejects.toMatchObject({
      name: 'ActionApprovalConsumeError',
      code: 'action_approval.consume_failed',
    });
  });

  it('refuses an HTTP-ok body that is not an action approval', async () => {
    stubHttpOk({ result: { data: { ok: true } } });
    const client = createIdentityApprovalClient('http://identity.test', 'x'.repeat(32));
    await expect(client.consume(CONSUME_REQUEST)).rejects.toBeInstanceOf(ActionApprovalConsumeError);
  });

  it('bounds the call to identity with a timeout signal so a hung identity cannot hang a freeze door', async () => {
    const fetchSpy = vi.fn(async (_url: string, _init: RequestInit) => ({
      ok: true,
      json: async () => ({ result: { data: consumedApproval() } }),
    }));
    vi.stubGlobal('fetch', fetchSpy);
    const client = createIdentityApprovalClient('http://identity.test', 'x'.repeat(32));
    await client.consume(CONSUME_REQUEST);
    expect(fetchSpy.mock.calls[0]![1].signal).toBeInstanceOf(AbortSignal);
  });

  it('boot freeze path is not wired through consume', () => {
    const service = readFileSync(join(HERE, '../service.ts'), 'utf8');
    expect(service).toMatch(/applyStartupPolicy/);
    expect(service).not.toMatch(/actionApproval/);
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

describe('founder attestation at ledger consume', () => {
  it('refuses a thaw when identity sends no attestation', async () => {
    await expect(
      consumeLedgerApproval(
        echoingApproval('ledger.unfreeze', (row) => {
          delete row.approverIsFounder;
          delete row.requesterIsFounder;
        }),
        approvalCmd,
        'ledger.unfreeze',
        'posting_unfreeze',
        '1',
        {},
      ),
    ).rejects.toMatchObject({ code: 'action_approval.not_founders' });
  });

  it('refuses a forged or mismatched founder attestation', async () => {
    const refuse = (mutate: (row: Record<string, unknown>) => void) =>
      expect(
        consumeLedgerApproval(echoingApproval('ledger.reconcile', mutate), approvalCmd, 'ledger.reconcile', 'posting_reconcile', '1', {}),
      ).rejects.toMatchObject({ code: 'action_approval.not_founders' });
    await refuse((row) => {
      row.requesterIsFounder = false;
    });
    await refuse((row) => {
      row.approverId = 'founder-a';
    });
    await refuse((row) => {
      row.targetId = 'posting_freeze';
    });
    await refuse((row) => {
      row.actionType = 'ledger.freeze';
    });
    await expect(
      consumeLedgerApproval(
        echoingApproval('ledger.freeze', (row) => {
          delete row.approverIsFounder;
          delete row.requesterIsFounder;
        }),
        approvalCmd,
        'ledger.freeze',
        'posting_unfreeze',
        '1',
        {},
      ),
    ).rejects.toMatchObject({ code: 'action_approval.not_founders' });
  });

  it('accepts a distinct founder pair for thaw and reconcile', async () => {
    await expect(
      consumeLedgerApproval(echoingApproval('ledger.unfreeze'), approvalCmd, 'ledger.unfreeze', 'posting_unfreeze', '1', {}),
    ).resolves.toMatchObject({
      approverId: 'founder-b',
    });
    await expect(
      consumeLedgerApproval(echoingApproval('ledger.reconcile'), approvalCmd, 'ledger.reconcile', 'posting_reconcile', '1', {}),
    ).resolves.toMatchObject({
      approverId: 'founder-b',
    });
  });

  it('sends the caller request id and the consuming operator, and accepts an attested replay', async () => {
    let seen: string | undefined;
    let consumer: string | undefined;
    const consumed = await consumeLedgerApproval(
      echoingApproval('ledger.reconciliation_control.run', (row) => {
        seen = typeof row.requestId === 'string' ? row.requestId : undefined;
        consumer = typeof row.consumerPrincipalId === 'string' ? row.consumerPrincipalId : undefined;
        row.consumption = 'already_consumed_by_this_request';
      }),
      approvalCmd,
      'ledger.reconciliation_control.run',
      'posting_reconciliation_control.run',
      '1',
      { controlId: 'control-1' },
      'op-1',
      'operator-a',
    );
    expect(seen).toBe('op-1');
    expect(consumer).toBe('operator-a');
    expect(consumed.consumption).toBe('already_consumed_by_this_request');
  });

  it('refuses a replay that carries no founder attestation (fail closed)', async () => {
    await expect(
      consumeLedgerApproval(
        echoingApproval('ledger.reconciliation_control.run', (row) => {
          delete row.approverIsFounder;
          delete row.requesterIsFounder;
          row.consumption = 'already_consumed_by_this_request';
        }),
        approvalCmd,
        'ledger.reconciliation_control.run',
        'posting_reconciliation_control.run',
        '1',
        { controlId: 'control-1' },
        'op-1',
        'operator-a',
      ),
    ).rejects.toMatchObject({ code: 'action_approval.not_founders' });
  });

  it('does not turn a refused non-founder pair into an accepted consume on retry', async () => {
    let calls = 0;
    const identity: ActionApprovalConsumer = {
      async consume(input) {
        calls += 1;
        const row: Record<string, unknown> = {
          ...input,
          actionType: 'ledger.reconciliation_control.run',
          requesterId: 'founder-a',
          approverId: 'operator-x',
          policyVersion: 'v1',
          createdAt: '2026-09-09T12:00:00.000Z',
          expiresAt: '2026-09-09T12:10:00.000Z',
          status: 'CONSUMED',
          requesterIsFounder: true,
          approverIsFounder: false,
        };
        // Identity burns the approval on the first call; the same request id then replays without the flags.
        if (calls > 1) {
          delete row.approverIsFounder;
          delete row.requesterIsFounder;
          row.consumption = 'already_consumed_by_this_request';
        }
        return actionApprovalSchema.parse(row);
      },
    };
    const run = () =>
      consumeLedgerApproval(
        identity,
        approvalCmd,
        'ledger.reconciliation_control.run',
        'posting_reconciliation_control.run',
        '1',
        { controlId: 'control-1' },
        'op-1',
        'operator-a',
      );
    await expect(run()).rejects.toMatchObject({ code: 'action_approval.not_founders' });
    await expect(run()).rejects.toMatchObject({ code: 'action_approval.not_founders' });
    expect(calls).toBe(2);
  });

  it('refuses a replay key without the consuming operator, so identity can bind the replay', async () => {
    await expect(
      consumeLedgerApproval(
        echoingApproval('ledger.reconciliation_control.run'),
        approvalCmd,
        'ledger.reconciliation_control.run',
        'posting_reconciliation_control.run',
        '1',
        { controlId: 'control-1' },
        'op-1',
      ),
    ).rejects.toMatchObject({ code: 'action_approval.missing' });
  });

  it('leaves ledger.freeze working without an attestation', async () => {
    const frozen = await consumeLedgerApproval(
      echoingApproval('ledger.freeze', (row) => {
        delete row.approverIsFounder;
        delete row.requesterIsFounder;
        row.approverId = 'ops-b';
      }),
      approvalCmd,
      'ledger.freeze',
      'posting_freeze',
      '1',
      { reason: 'suspected drift' },
    );
    expect(frozen.approverId).toBe('ops-b');
    expect(frozen.approverIsFounder).toBeUndefined();
  });
});
