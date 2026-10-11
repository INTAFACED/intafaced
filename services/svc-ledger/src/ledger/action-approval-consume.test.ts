import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ActionApprovalConsumeError,
  createIdentityApprovalClient,
  ledgerActionPayloadHash,
  readApprovalIds,
  unwrapTrpcData,
  unwiredApprovalConsumer,
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

  it('boot freeze path is not wired through consume', () => {
    const service = readFileSync(join(HERE, '../service.ts'), 'utf8');
    expect(service).toMatch(/applyStartupPolicy/);
    expect(service).not.toMatch(/actionApproval/);
  });
});
