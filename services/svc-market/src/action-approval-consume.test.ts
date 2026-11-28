import { afterEach, describe, expect, it, vi } from 'vitest';
import { partial } from '@intafaced/service-kit/testing';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import {
  ActionApprovalConsumeError,
  createIdentityApprovalClient,
  marketActionPayloadHash,
  readApprovalIds,
  unwrapTrpcData,
  unwiredApprovalConsumer,
} from './action-approval-consume.js';
import { createMarketRouter } from './router.js';
import type { VendorService } from './vendor-service.js';

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

  it('user apply path is not wired through consume', async () => {
    // The applicant's own door: a signed user with market:write applies, and no approval is consumed for it.
    const consume = vi.fn(async () => {
      throw new Error('apply must not consume an approval');
    });
    const applied = vi.fn(async (input: { userId: string; displayName: string; description: string }) => ({
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      userId: input.userId,
      displayName: input.displayName,
      description: input.description,
      status: 'applied' as const,
      createdAt: '2026-08-08T10:00:00.000Z',
      updatedAt: '2026-08-08T10:00:00.000Z',
    }));
    const vendors = partial<VendorService>({ applyAsVendor: applied });
    const secret = 'a-market-approval-test-edge-secret-long';
    const userId = '11111111-1111-4111-8111-111111111111';
    const raw = encodePrincipal({
      sub: userId,
      userId,
      sid: '22222222-2222-4222-8222-222222222222',
      scopes: ['market:read', 'market:write'],
      tier: 'basic',
      mfa: false,
      expiresAt: new Date(Date.now() + 60_000),
    } as Principal);
    const ctx = createEdgeContext({ secret, serviceName: 'svc-market' })({
      headers: {
        'x-intafaced-principal': raw,
        'x-intafaced-principal-sig': signPrincipalHeader(raw, secret, 'DE'),
        'x-intafaced-region': 'DE',
      },
      id: 'req-apply',
    });
    const vendor = await createMarketRouter(vendors, undefined, undefined, { consume })
      .createCaller(ctx)
      .applyAsVendor({ displayName: 'TEST shop', description: 'TEST' });
    expect(vendor.status).toBe('applied');
    expect(applied).toHaveBeenCalledWith({ userId, displayName: 'TEST shop', description: 'TEST' });
    expect(consume).not.toHaveBeenCalled();
  });
});
