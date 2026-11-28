import { describe, expect, it } from 'vitest';
import { issueAccessToken, verifyAccessToken } from '@intafaced/auth';
import { namesAreNotActionApproval, type Context } from '@intafaced/contracts';
import { createActionApprovalRouter } from '../action-approval-router.js';
import { staticFounderDirectory } from './action-approval-audience.js';
import { ActionApprovalError, ActionApprovalService } from './action-approval-service.js';
import { MemoryActionApprovalStore } from './action-approval-store.js';

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const routerAuth = {
  secret: 'action-approval-service-test-secret-long-enough',
  issuer: 'intafaced',
  audience: 'intafaced.api',
  accessTtlSeconds: 900,
};

/** One of the founder pair, signed in, with or without a second factor. */
async function founder(userId: string, mfa: boolean): Promise<Context> {
  const { token } = await issueAccessToken(
    { userId, sessionId: '44444444-4444-4444-8444-444444444444', scopes: ['identity:write', 'admin:write'], tier: 'none', mfa },
    routerAuth,
  );
  return { principal: await verifyAccessToken(token, routerAuth), service: null, region: 'DE', requestId: 'req-aa' };
}

const propose = {
  actionType: 'ledger.freeze',
  targetService: 'svc-ledger',
  targetId: 'posting_freeze',
  expectedVersion: '1',
  payloadHash: 'sha256:abc',
  policyVersion: 'v1',
};

function svc(ttlSeconds: number | 'unset' = 60, now = new Date('2026-09-09T12:00:00.000Z')) {
  let clock = now;
  const service = new ActionApprovalService(
    new MemoryActionApprovalStore(),
    { ttlSeconds: ttlSeconds === 'unset' ? undefined : ttlSeconds, founders: staticFounderDirectory([A, B]) },
    () => clock,
  );
  return {
    service,
    advance(ms: number) {
      clock = new Date(clock.getTime() + ms);
    },
  };
}

describe('ActionApprovalService', () => {
  it('refuses propose when TTL is unpublished', async () => {
    const { service } = svc('unset');
    await expect(service.propose(A, propose)).rejects.toMatchObject({ code: 'action_approval.ttl_unset' });
  });

  it('refuses the requester approving their own action — including a second session of the same person', async () => {
    const { service } = svc();
    const pending = await service.propose(A, propose);
    expect(pending.approverId).toBeNull();
    await expect(service.approve(A, pending.approvalId, propose.payloadHash)).rejects.toMatchObject({
      code: 'action_approval.same_person',
    });
  });

  it('names the two people on an approval without consuming it, and null for none', async () => {
    const { service } = svc();
    const pending = await service.propose(A, propose);
    expect(await service.partiesOf(pending.approvalId)).toEqual({ requesterId: A, approverId: null });
    await service.approve(B, pending.approvalId, propose.payloadHash);
    expect(await service.partiesOf(pending.approvalId)).toEqual({ requesterId: A, approverId: B });
    expect((await service.getForCaller(A, pending.approvalId, { operator: false, founder: false })).status).toBe('APPROVED');
    expect(await service.partiesOf('missing')).toBeNull();
  });

  it('lets a distinct person approve, then consume once, then refuse replay', async () => {
    const { service } = svc();
    const pending = await service.propose(A, propose);
    const approved = await service.approve(B, pending.approvalId, propose.payloadHash);
    expect(approved.status).toBe('APPROVED');
    expect(approved.approverId).toBe(B);

    const consumed = await service.consume('svc-ledger', {
      approvalId: approved.approvalId,
      operationId: approved.operationId,
      payloadHash: approved.payloadHash,
      targetService: 'svc-ledger',
      targetId: approved.targetId,
      expectedVersion: approved.expectedVersion,
    });
    expect(consumed.status).toBe('CONSUMED');
    await expect(
      service.consume('svc-ledger', {
        approvalId: approved.approvalId,
        operationId: approved.operationId,
        payloadHash: approved.payloadHash,
        targetService: 'svc-ledger',
        targetId: approved.targetId,
        expectedVersion: approved.expectedVersion,
      }),
    ).rejects.toMatchObject({ code: 'action_approval.consumed' });
  });

  it('refuses a changed payload or a different target service', async () => {
    const { service } = svc();
    const pending = await service.propose(A, propose);
    const approved = await service.approve(B, pending.approvalId, propose.payloadHash);
    await expect(
      service.consume('svc-ledger', {
        approvalId: approved.approvalId,
        operationId: approved.operationId,
        payloadHash: 'sha256:other',
        targetService: 'svc-ledger',
        targetId: approved.targetId,
        expectedVersion: approved.expectedVersion,
      }),
    ).rejects.toMatchObject({ code: 'action_approval.payload_mismatch' });
    await expect(
      service.consume('svc-identity', {
        approvalId: approved.approvalId,
        operationId: approved.operationId,
        payloadHash: approved.payloadHash,
        targetService: 'svc-identity',
        targetId: approved.targetId,
        expectedVersion: approved.expectedVersion,
      }),
    ).rejects.toMatchObject({ code: 'action_approval.service_mismatch' });
  });

  it('expires a pending row after the published lifetime', async () => {
    const { service, advance } = svc(1);
    const pending = await service.propose(A, propose);
    advance(2_000);
    await expect(service.approve(B, pending.approvalId, propose.payloadHash)).rejects.toMatchObject({ code: 'action_approval.expired' });
  });

  it('does not treat two names in one body as approval', () => {
    const { service } = svc();
    expect(service.namesAreNotAuthority({ actorId: A, confirmActorId: B })).toBe(true);
    expect(namesAreNotActionApproval({ actorId: A, confirmOperatorId: B })).toBe(true);
  });

  it('lets the requester revoke before consume, and refuses later consume', async () => {
    const { service } = svc();
    const pending = await service.propose(A, propose);
    const approved = await service.approve(B, pending.approvalId, propose.payloadHash);
    const revoked = await service.revoke(A, approved.approvalId);
    expect(revoked.status).toBe('REVOKED');
    await expect(
      service.consume('svc-ledger', {
        approvalId: approved.approvalId,
        operationId: approved.operationId,
        payloadHash: approved.payloadHash,
        targetService: 'svc-ledger',
        targetId: approved.targetId,
        expectedVersion: approved.expectedVersion,
      }),
    ).rejects.toBeInstanceOf(ActionApprovalError);
  });
});

describe('S10 matching.open is two people (TRD-0003)', () => {
  const openBook = {
    actionType: 'matching.open',
    targetService: 'svc-matching',
    targetId: 'open:BTC-USDT',
    expectedVersion: '1',
    payloadHash: 'sha256:matching-open',
    policyVersion: 'v1',
  };

  it('refuses when the proposer then approves their own matching.open', async () => {
    const { service } = svc();
    const pending = await service.propose(A, openBook);
    await expect(service.approve(A, pending.approvalId, openBook.payloadHash)).rejects.toMatchObject({
      code: 'action_approval.same_person',
    });
    expect(pending.status).toBe('PENDING');
  });

  it('lets a different founder approve, and refuses a second approval of that proposal', async () => {
    const { service } = svc();
    const pending = await service.propose(A, openBook);
    const approved = await service.approve(B, pending.approvalId, openBook.payloadHash);
    expect(approved.status).toBe('APPROVED');
    expect(approved.approverId).toBe(B);
    await expect(service.approve(B, pending.approvalId, openBook.payloadHash)).rejects.toMatchObject({
      code: 'action_approval.not_pending',
    });
  });
});

describe('action-approval source pins', () => {
  it('router does not accept confirmActorId on approve and is mounted', async () => {
    const r = createActionApprovalRouter(
      new ActionApprovalService(new MemoryActionApprovalStore(), { ttlSeconds: 60, founders: staticFounderDirectory([A, B]) }),
    );
    const maker = r.createCaller(await founder(A, true));
    const pending = await maker.actionApproval.propose(propose);
    const decision = { approvalId: pending.approvalId, expectedPayloadHash: pending.payloadHash };
    // A second factor is required to approve or reject.
    const noFactor = r.createCaller(await founder(B, false));
    for (const call of [
      () => noFactor.actionApproval.approve(decision),
      () => noFactor.actionApproval.reject({ approvalId: pending.approvalId }),
    ]) {
      const err = await call().catch((e: unknown) => e);
      expect((err as { code?: string }).code).toBe('UNAUTHORIZED');
      expect(((err as { cause?: { code?: string } }).cause ?? {}).code).toBe('mfa.required');
    }
    // The approver is always the caller: a named confirmer (confirmActorId / confirmOperatorId) is refused, never taken.
    const checker = r.createCaller(await founder(B, true));
    for (const extra of [{ confirmActorId: A }, { confirmOperatorId: A }]) {
      const err = await checker.actionApproval.approve({ ...decision, ...extra } as never).catch((e: unknown) => e);
      expect((err as { code?: string }).code, JSON.stringify(extra)).toBe('BAD_REQUEST');
    }
    await expect(checker.actionApproval.approve(decision)).resolves.toMatchObject({ status: 'APPROVED', approverId: B });
    // Consuming an approval is a service call: a person's session cannot reach it.
    const consume = {
      approvalId: pending.approvalId,
      actionType: propose.actionType,
      targetService: propose.targetService,
      targetId: propose.targetId,
      expectedVersion: propose.expectedVersion,
      payloadHash: propose.payloadHash,
      policyVersion: propose.policyVersion,
    };
    const bySession = await maker.actionApproval.consume(consume as never).catch((e: unknown) => e);
    expect(['UNAUTHORIZED', 'FORBIDDEN']).toContain((bySession as { code?: string }).code);
  });
});
