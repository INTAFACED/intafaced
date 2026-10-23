import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { namesAreNotActionApproval } from '@intafaced/contracts';
import { staticFounderDirectory } from './action-approval-audience.js';
import { ActionApprovalError, ActionApprovalService } from './action-approval-service.js';
import { MemoryActionApprovalStore } from './action-approval-store.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

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
  it('router does not accept confirmActorId on approve and is mounted', () => {
    const routerSrc = readFileSync(join(HERE, '../action-approval-router.ts'), 'utf8');
    const indexSrc = readFileSync(join(HERE, '../index.ts'), 'utf8');
    expect(routerSrc).toMatch(/requireMfa\(ctx\.principal\)/);
    expect(routerSrc).toMatch(/serviceProcedure/);
    expect(routerSrc).not.toMatch(/confirmActorId/);
    expect(routerSrc).not.toMatch(/confirmOperatorId/);
    expect(indexSrc).toMatch(/createActionApprovalRouter/);
  });
});
