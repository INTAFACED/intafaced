import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ActionApprovalConsumeError,
  createIdentityApprovalClient,
  marketActionPayloadHash,
  readApprovalIds,
  unwrapTrpcData,
  unwiredApprovalConsumer,
} from './action-approval-consume.js';

const HERE = dirname(fileURLToPath(import.meta.url));

const row = {
  approvalId: 'appr-1',
  actionType: 'market.vendor.vet',
  targetService: 'svc-market',
  targetId: 'market.vendor.vet',
  expectedVersion: '1',
  payloadHash: 'sha256:abc',
  requesterId: 'requester',
  approverId: 'approver',
  policyVersion: 'v1',
  createdAt: '2026-09-09T12:00:00.000Z',
  expiresAt: '2026-09-09T12:10:00.000Z',
  status: 'CONSUMED' as const,
  operationId: 'op-1',
};

describe('market action-approval consume', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('payload hash is stable for the same vendor decision', () => {
    expect(marketActionPayloadHash('market.vendor.vet', { vendorId: 'v', decision: 'approved', reason: 'ok' })).toMatch(
      /^sha256:[0-9a-f]{64}$/,
    );
    expect(marketActionPayloadHash('market.vendor.vet', { vendorId: 'v', decision: 'approved', reason: 'a' })).not.toBe(
      marketActionPayloadHash('market.vendor.vet', { vendorId: 'v', decision: 'approved', reason: 'b' }),
    );
  });

  it('blank IDENTITY_URL consumer refuses instead of inventing a second person', async () => {
    await expect(
      unwiredApprovalConsumer().consume({
        approvalId: 'appr-1',
        operationId: 'op-1',
        payloadHash: 'sha256:abc',
        targetService: 'svc-market',
        targetId: 'market.vendor.vet',
        expectedVersion: '1',
      }),
    ).rejects.toMatchObject({ code: 'action_approval.identity_unwired' });
  });

  it('typed-in names without approval ids refuse', () => {
    expect(() => readApprovalIds({ approvalId: null, operationId: null })).toThrow(ActionApprovalConsumeError);
  });

  it('unwraps tRPC result.data so live consume is not a Zod miss on the envelope', () => {
    expect(unwrapTrpcData({ result: { data: row } })).toEqual(row);
    expect(unwrapTrpcData({ result: { data: { json: row } } })).toEqual(row);
    expect(unwrapTrpcData(row)).toEqual(row);
  });

  it('identity client unwraps tRPC JSON envelope', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ result: { data: { json: row } } }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      ),
    );
    const consumed = await createIdentityApprovalClient('http://identity.test', 'secret-secret-secret-secret-32ch').consume({
      approvalId: 'appr-1',
      operationId: 'op-1',
      payloadHash: 'sha256:abc',
      targetService: 'svc-market',
      targetId: 'market.vendor.vet',
      expectedVersion: '1',
    });
    expect(consumed.approverId).toBe('approver');
  });

  it('refuses a reply that is not the approval asked for', async () => {
    const row = {
      approvalId: 'appr-OTHER',
      actionType: 'market.vendor.vet',
      targetService: 'svc-market',
      targetId: 'market.vendor.vet',
      expectedVersion: '1',
      payloadHash: 'sha256:abc',
      requesterId: 'requester',
      approverId: 'approver',
      policyVersion: 'v1',
      createdAt: '2026-09-09T12:00:00.000Z',
      expiresAt: '2026-09-09T12:10:00.000Z',
      status: 'CONSUMED',
      operationId: 'op-1',
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ result: { data: row } }), { status: 200 })),
    );
    await expect(
      createIdentityApprovalClient('http://identity.test', 'secret-secret-secret-secret-32ch').consume({
        approvalId: 'appr-1',
        operationId: 'op-1',
        payloadHash: 'sha256:abc',
        targetService: 'svc-market',
        targetId: 'market.vendor.vet',
        expectedVersion: '1',
      }),
    ).rejects.toMatchObject({ code: 'action_approval.consume_failed' });
  });

  it('user apply path is not wired through consume', () => {
    const router = readFileSync(join(HERE, 'router.ts'), 'utf8');
    expect(router).toMatch(/applyAsVendor/);
    const applyBlock = router.slice(router.indexOf('applyAsVendor:'), router.indexOf('mine:'));
    expect(applyBlock).not.toMatch(/actionApproval|approvals\.consume/);
  });
});
