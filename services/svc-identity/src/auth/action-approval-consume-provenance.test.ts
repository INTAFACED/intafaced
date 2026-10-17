/**
 * Consume records who used an approval and which request id.
 * The same request id returns the original row. A different request id is action_approval.consumed.
 * get returns consumedAt and consumedByRequestId only to the requester, the approver, and admin:read.
 */
import { describe, expect, it } from 'vitest';
import { issueAccessToken, verifyAccessToken } from '@intafaced/auth';
import type { Context } from '@intafaced/contracts';
import { createActionApprovalRouter } from '../action-approval-router.js';
import { ActionApprovalService } from './action-approval-service.js';
import { MemoryActionApprovalStore } from './action-approval-store.js';

const authConfig = {
  secret: 'an-identity-consume-provenance-test-secret-long-enough',
  issuer: 'intafaced',
  audience: 'intafaced.api',
  accessTtlSeconds: 900,
};
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const SESSION = '44444444-4444-4444-8444-444444444444';
const propose = {
  actionType: 'market.vendor.vet',
  targetService: 'svc-market',
  targetId: 'market.vendor.vet',
  expectedVersion: '1',
  payloadHash: 'sha256:abc',
  policyVersion: 'v1',
};

function service() {
  const store = new MemoryActionApprovalStore();
  return { store, service: new ActionApprovalService(store, { ttlSeconds: 60 }) };
}

async function ctx(userId: string, scopes: string[]): Promise<Context> {
  const { token } = await issueAccessToken({ userId, sessionId: SESSION, scopes, tier: 'none', mfa: true }, authConfig);
  return { principal: await verifyAccessToken(token, authConfig), service: null, region: 'DE', requestId: 'req-prov' };
}

describe('action approval consume provenance', () => {
  it('stores the first consume, replays the same request id, and refuses a different one', async () => {
    const { service: svc, store } = service();
    const pending = await svc.propose(A, propose);
    const approved = await svc.approve(B, pending.approvalId, propose.payloadHash);
    const binding = {
      approvalId: approved.approvalId,
      operationId: approved.operationId,
      payloadHash: approved.payloadHash,
      targetService: 'svc-market',
      targetId: approved.targetId,
      expectedVersion: approved.expectedVersion,
    };
    const first = await svc.consume('svc-market', { ...binding, requestId: 'req-1', consumerPrincipalId: C });
    expect(first.status).toBe('CONSUMED');
    expect(first.consumedByRequestId).toBe('req-1');
    expect(first.consumedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(first.consumption).toBeUndefined();
    const stored = await store.get(approved.approvalId);
    expect(stored).toMatchObject({ consumedByService: 'svc-market', consumedByPrincipal: C, consumedRequestId: 'req-1' });

    const replay = await svc.consume('svc-market', { ...binding, requestId: 'req-1', consumerPrincipalId: C });
    expect(replay).toMatchObject({
      status: 'CONSUMED',
      approvalId: first.approvalId,
      consumedByRequestId: 'req-1',
      consumption: 'already_consumed_by_this_request',
    });
    expect(replay.consumedAt).toBe(first.consumedAt);

    await expect(svc.consume('svc-market', { ...binding, requestId: 'req-2', consumerPrincipalId: C })).rejects.toMatchObject({
      code: 'action_approval.consumed',
    });
    expect((await store.get(approved.approvalId))?.consumedRequestId).toBe('req-1');
  });

  it('get returns provenance to the requester, the approver and admin:read, and withholds it from another operator', async () => {
    const { service: svc, store } = service();
    const r = createActionApprovalRouter(svc);
    const pending = await svc.propose(A, propose);
    const approved = await svc.approve(B, pending.approvalId, propose.payloadHash);
    await svc.consume('svc-market', {
      approvalId: approved.approvalId,
      operationId: approved.operationId,
      payloadHash: approved.payloadHash,
      targetService: 'svc-market',
      targetId: approved.targetId,
      expectedVersion: approved.expectedVersion,
      requestId: 'req-9',
    });

    const requester = await r.createCaller(await ctx(A, ['market:ops'])).actionApproval.get({ approvalId: approved.approvalId });
    expect(requester.consumedByRequestId).toBe('req-9');
    expect(requester.consumedAt).toBeTruthy();

    const approver = await r.createCaller(await ctx(B, ['market:ops'])).actionApproval.get({ approvalId: approved.approvalId });
    expect(approver.consumedByRequestId).toBe('req-9');

    const reader = await r.createCaller(await ctx(C, ['admin:read'])).actionApproval.get({ approvalId: approved.approvalId });
    expect(reader.consumedByRequestId).toBe('req-9');

    const outsider = await r
      .createCaller(await ctx('dddddddd-dddd-4ddd-8ddd-dddddddddddd', ['market:ops']))
      .actionApproval.get({ approvalId: approved.approvalId });
    expect(outsider.status).toBe('CONSUMED');
    expect(outsider.consumedAt).toBeUndefined();
    expect(outsider.consumedByRequestId).toBeUndefined();
    expect((await store.get(approved.approvalId))?.consumedRequestId).toBe('req-9');
  });
});
