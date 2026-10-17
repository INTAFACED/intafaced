/**
 * Unit card — same-person money-out step-up approvals (ADR 2026-10-14-money-out-step-up)
 *
 * 1. Promise: a user who proved a fresh factor can create ONE approval for their own
 *    intent; only that user, in that session, can consume it, once, within five minutes,
 *    for exactly the hash they approved.
 * 2. Break: reusing the four-eyes row would either refuse (same_person) or, if relaxed
 *    globally, let anyone approve their own four-eyes action.
 * 3. Done bar: same-person rows are born APPROVED and consume once; wrong user, wrong
 *    session, no principal, hash mismatch, expiry and reuse all refuse; four-eyes types
 *    still refuse `same_person` on approve; the two kinds cannot pass as each other.
 * 4. Class M
 * 5. Paths: services/svc-identity/src/auth/action-approval-service.ts, action-approval-store.ts
 * 6. RED before: no createSamePerson and no kind on the row
 */
import { describe, expect, it } from 'vitest';
import { SAME_PERSON_ACTION_TYPES } from '@intafaced/contracts';
import { staticFounderDirectory } from './action-approval-audience.js';
import { ActionApprovalService } from './action-approval-service.js';
import { MemoryActionApprovalStore } from './action-approval-store.js';

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const S1 = '11111111-1111-4111-8111-111111111111';
const S2 = '22222222-2222-4222-8222-222222222222';
const HASH = `sha256:${'a'.repeat(64)}`;
const TYPE = 'bank.step_up.transfers.toUser';

function svc(now = new Date('2026-10-14T12:00:00.000Z')) {
  let clock = now;
  const service = new ActionApprovalService(
    new MemoryActionApprovalStore(),
    { ttlSeconds: 60, founders: staticFounderDirectory([A, B]) },
    () => clock,
  );
  return {
    service,
    advance(ms: number) {
      clock = new Date(clock.getTime() + ms);
    },
  };
}

function consumeInput(
  a: { approvalId: string; operationId: string; payloadHash: string; targetId: string; expectedVersion: string },
  extra = {},
) {
  return {
    approvalId: a.approvalId,
    operationId: a.operationId,
    payloadHash: a.payloadHash,
    targetService: 'svc-bank',
    targetId: a.targetId,
    expectedVersion: a.expectedVersion,
    principalUserId: A,
    principalSessionId: S1,
    ...extra,
  };
}

describe('same-person step-up approval', () => {
  it('is born APPROVED for svc-bank, bound to the user, lives five minutes, and is its own approver', async () => {
    const { service } = svc();
    const a = await service.createSamePerson({ userId: A, sessionId: S1 }, { actionType: TYPE, payloadHash: HASH });
    expect(a).toMatchObject({
      kind: 'same_person',
      status: 'APPROVED',
      requesterId: A,
      approverId: A,
      targetService: 'svc-bank',
      actionType: TYPE,
      targetId: TYPE,
      payloadHash: HASH,
      operationId: a.approvalId,
    });
    expect(new Date(a.expiresAt).getTime() - new Date(a.createdAt).getTime()).toBe(300_000);
  });

  it('is consumed once by the same user and session, then refuses reuse', async () => {
    const { service } = svc();
    const a = await service.createSamePerson({ userId: A, sessionId: S1 }, { actionType: TYPE, payloadHash: HASH });
    const consumed = await service.consume('svc-bank', consumeInput(a));
    expect(consumed.status).toBe('CONSUMED');
    await expect(service.consume('svc-bank', consumeInput(a))).rejects.toMatchObject({ code: 'action_approval.consumed' });
  });

  it('refuses another user, another session and a missing principal, without burning the approval', async () => {
    const { service } = svc();
    const a = await service.createSamePerson({ userId: A, sessionId: S1 }, { actionType: TYPE, payloadHash: HASH });
    await expect(service.consume('svc-bank', consumeInput(a, { principalUserId: B }))).rejects.toMatchObject({
      code: 'action_approval.not_requester',
    });
    await expect(service.consume('svc-bank', consumeInput(a, { principalSessionId: S2 }))).rejects.toMatchObject({
      code: 'action_approval.not_requester',
    });
    const { principalUserId: _u, principalSessionId: _s, ...noPrincipal } = consumeInput(a);
    void _u;
    void _s;
    await expect(service.consume('svc-bank', noPrincipal)).rejects.toMatchObject({ code: 'action_approval.target_mismatch' });
    // Still spendable by the owner afterwards.
    await expect(service.consume('svc-bank', consumeInput(a))).resolves.toMatchObject({ status: 'CONSUMED' });
  });

  it('refuses a different payload hash, a different service and an expired approval', async () => {
    const { service, advance } = svc();
    const a = await service.createSamePerson({ userId: A, sessionId: S1 }, { actionType: TYPE, payloadHash: HASH });
    await expect(service.consume('svc-bank', consumeInput(a, { payloadHash: `sha256:${'b'.repeat(64)}` }))).rejects.toMatchObject({
      code: 'action_approval.payload_mismatch',
    });
    await expect(service.consume('svc-pay', consumeInput(a, { targetService: 'svc-pay' }))).rejects.toMatchObject({
      code: 'action_approval.service_mismatch',
    });
    advance(301_000);
    await expect(service.consume('svc-bank', consumeInput(a))).rejects.toMatchObject({ code: 'action_approval.expired' });
  });

  it('only issues the listed same-person types, and four-eyes propose refuses them', async () => {
    const { service } = svc();
    await expect(
      service.createSamePerson({ userId: A, sessionId: S1 }, { actionType: 'ledger.freeze', payloadHash: HASH }),
    ).rejects.toMatchObject({ code: 'action_approval.type_not_same_person' });
    for (const actionType of SAME_PERSON_ACTION_TYPES) {
      await expect(
        service.propose(A, {
          actionType,
          targetService: 'svc-bank',
          targetId: actionType,
          expectedVersion: '1',
          payloadHash: HASH,
          policyVersion: 'v1',
        }),
      ).rejects.toMatchObject({ code: 'action_approval.type_not_four_eyes' });
    }
  });

  it('keeps four-eyes untouched: the requester still cannot approve, and a four-eyes row cannot be consumed with a principal', async () => {
    const { service } = svc();
    const propose = {
      actionType: 'ledger.freeze',
      targetService: 'svc-ledger',
      targetId: 'posting_freeze',
      expectedVersion: '1',
      payloadHash: 'sha256:abc',
      policyVersion: 'v1',
    };
    const pending = await service.propose(A, propose);
    expect(pending.kind).toBeUndefined();
    await expect(service.approve(A, pending.approvalId, pending.payloadHash)).rejects.toMatchObject({
      code: 'action_approval.same_person',
    });
    const approved = await service.approve(B, pending.approvalId, pending.payloadHash);
    const base = {
      approvalId: approved.approvalId,
      operationId: approved.operationId,
      payloadHash: approved.payloadHash,
      targetService: 'svc-ledger',
      targetId: approved.targetId,
      expectedVersion: approved.expectedVersion,
    };
    await expect(service.consume('svc-ledger', { ...base, principalUserId: B, principalSessionId: S1 })).rejects.toMatchObject({
      code: 'action_approval.target_mismatch',
    });
    await expect(service.consume('svc-ledger', base)).resolves.toMatchObject({ status: 'CONSUMED' });
  });

  it('a same-person approval cannot be approved or rejected by anyone (it is never PENDING)', async () => {
    const { service } = svc();
    const a = await service.createSamePerson({ userId: A, sessionId: S1 }, { actionType: TYPE, payloadHash: HASH });
    await expect(service.approve(B, a.approvalId, a.payloadHash)).rejects.toMatchObject({ code: 'action_approval.not_pending' });
    await expect(service.reject(B, a.approvalId)).rejects.toMatchObject({ code: 'action_approval.not_pending' });
  });
});
