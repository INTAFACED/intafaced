import { describe, expect, it } from 'vitest';
import { issueAccessToken, verifyAccessToken } from '@intafaced/auth';
import type { Context } from '@intafaced/contracts';
import { createActionApprovalRouter } from './action-approval-router.js';
import { staticFounderDirectory } from './auth/action-approval-audience.js';
import { ActionApprovalService } from './auth/action-approval-service.js';
import { MemoryActionApprovalStore } from './auth/action-approval-store.js';

const authConfig = {
  secret: 'an-identity-action-approval-read-test-secret-long-enough',
  issuer: 'intafaced',
  audience: 'intafaced.api',
  accessTtlSeconds: 900,
};

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const OP = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const SESSION = '44444444-4444-4444-8444-444444444444';

async function ctx(userId: string, scopes: string[], mfa: boolean): Promise<Context> {
  const { token } = await issueAccessToken({ userId, sessionId: SESSION, scopes, tier: 'none', mfa }, authConfig);
  return { principal: await verifyAccessToken(token, authConfig), service: null, region: 'DE', requestId: 'req-read' };
}

function router() {
  return createActionApprovalRouter(
    new ActionApprovalService(new MemoryActionApprovalStore(), { ttlSeconds: 60, founders: staticFounderDirectory([A, B]) }),
  );
}

describe('actionApproval.list and actionApproval.get', () => {
  it('shows the requester their row and a founder the pending founder action', async () => {
    const r = router();
    const maker = r.createCaller(await ctx(A, ['identity:write', 'admin:write'], true));
    const pending = await maker.actionApproval.propose({
      actionType: 'ledger.freeze',
      targetService: 'svc-ledger',
      targetId: 'posting_freeze',
      expectedVersion: 'v1',
      payloadHash: 'sha256:abc',
      policyVersion: 'v1',
    });

    const mine = await maker.actionApproval.list({ view: 'mine', limit: 20 });
    expect(mine.approvals.map((row) => row.approvalId)).toEqual([pending.approvalId]);
    expect(mine.pageFull).toBe(false);

    const founder = r.createCaller(await ctx(B, ['identity:write', 'admin:write'], true));
    const pendingForFounder = await founder.actionApproval.list({ view: 'pending', limit: 20 });
    expect(pendingForFounder.approvals.map((row) => row.approvalId)).toEqual([pending.approvalId]);

    const got = await founder.actionApproval.get({ approvalId: pending.approvalId });
    expect(got).toMatchObject({ approvalId: pending.approvalId, requesterId: A, status: 'PENDING' });
  });

  it('refuses a session that is neither operator nor founder', async () => {
    const r = router();
    const maker = r.createCaller(await ctx(A, ['identity:write', 'admin:write'], true));
    const pending = await maker.actionApproval.propose({
      actionType: 'ledger.freeze',
      targetService: 'svc-ledger',
      targetId: 'posting_freeze',
      expectedVersion: 'v1',
      payloadHash: 'sha256:abc',
      policyVersion: 'v1',
    });
    const plain = r.createCaller(await ctx(C, ['identity:write'], true));
    await expect(plain.actionApproval.list({ view: 'pending', limit: 20 })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(plain.actionApproval.get({ approvalId: pending.approvalId })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(plain.actionApproval.list({ view: 'mine', limit: 20 })).resolves.toEqual({ approvals: [], pageFull: false });
  });

  it('hides a founder-only pending row from an operator who is not a founder', async () => {
    const r = router();
    const maker = r.createCaller(await ctx(A, ['identity:write', 'admin:write'], true));
    // Freeze is a protective operator brake. Unfreeze is founder-only, so an operator session must not see it.
    await maker.actionApproval.propose({
      actionType: 'ledger.unfreeze',
      targetService: 'svc-ledger',
      targetId: 'posting_freeze',
      expectedVersion: 'v1',
      payloadHash: 'sha256:abc',
      policyVersion: 'v1',
    });
    const operator = r.createCaller(await ctx(OP, ['admin:write'], true));
    const kill = await operator.actionApproval.propose({
      actionType: 'edge.kill',
      targetService: 'svc-edge',
      targetId: 'kill:trade',
      expectedVersion: '1',
      payloadHash: 'sha256:def',
      policyVersion: 'v1',
    });
    const other = r.createCaller(await ctx(B, ['admin:write'], false));
    // B is a founder in the directory but this session has no MFA, so founder reads stay closed.
    // B is still an operator via admin:write, so the operator kill is visible and the ledger freeze is not.
    const pending = await other.actionApproval.list({ view: 'pending', limit: 20 });
    expect(pending.approvals.map((row) => row.approvalId)).toEqual([kill.approvalId]);
  });
});
