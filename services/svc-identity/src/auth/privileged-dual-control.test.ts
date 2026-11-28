import { describe, expect, it } from 'vitest';
import { issueAccessToken, verifyAccessToken } from '@intafaced/auth';
import { TRPCError } from '@intafaced/contracts';
import { partial } from '@intafaced/service-kit/testing';
import { createIdentityRouter } from '../router.js';
import type { RankService } from '../rank/rank-service.js';
import type { FreezeService } from '../affiliates/freeze-service.js';
import type { ActionApprovalService } from './action-approval-service.js';
import type { AuthService } from './auth-service.js';
import { installPrivilegedDualControl, requirePrivilegedDualControl, stubActionApprovals } from './privileged-dual-control.js';

const ACTOR = '11111111-1111-4111-8111-111111111111';
const CONFIRM = '22222222-2222-4222-8222-222222222222';
const TARGET = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SESSION = '44444444-4444-4444-8444-444444444444';
const APPROVED = { approvalId: 'appr-1', operationId: 'op-1' };
const edgeAuth = {
  secret: 'privileged-dual-control-test-secret-long-enough',
  issuer: 'intafaced',
  audience: 'intafaced.api',
  accessTtlSeconds: 900,
};

describe('privileged dual-control — freeze / KYC / affiliate freeze', () => {
  it('missing approval ids refuse; a typed-in second name is not enough', async () => {
    const approvals = stubActionApprovals(CONFIRM);
    await expect(requirePrivilegedDualControl(approvals, { actorId: ACTOR, targetId: 'kyc.approve' })).rejects.toThrow(
      /typed-in second name/,
    );
    await expect(
      requirePrivilegedDualControl(approvals, {
        actorId: ACTOR,
        confirmActorId: CONFIRM,
        targetId: 'kyc.approve',
      }),
    ).rejects.toThrow(/typed-in second name/);
    await expect(
      requirePrivilegedDualControl(approvals, { actorId: ACTOR, targetId: 'kyc.approve', ...APPROVED, fields: { recordId: 'r' } }),
    ).resolves.toMatchObject({ approverId: CONFIRM });
  });

  it('freezeIdentity / unfreezeIdentity without approval refuse and do not write', async () => {
    let frozen = 0;
    let thawed = 0;
    const auth = {
      async freezeIdentity(userId: string, _cmd?: unknown) {
        frozen += 1;
        return { userId, status: 'frozen' as const, subAccountsRevoked: 0, apiKeysRevoked: 0 };
      },
      async unfreezeIdentity(userId: string, _cmd?: unknown) {
        thawed += 1;
        return { userId, status: 'active' as const };
      },
      async approveKycRecord() {
        return { id: 'r' };
      },
      async rejectKycRecord() {
        return { id: 'r' };
      },
    };
    installPrivilegedDualControl(auth as unknown as AuthService, stubActionApprovals(CONFIRM));

    await expect(auth.freezeIdentity(TARGET)).rejects.toBeInstanceOf(TRPCError);
    await expect(auth.unfreezeIdentity(TARGET)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect(frozen).toBe(0);
    expect(thawed).toBe(0);

    await expect(auth.freezeIdentity(TARGET, APPROVED as never)).resolves.toMatchObject({ status: 'frozen' });
    await expect(auth.unfreezeIdentity(TARGET, APPROVED as never)).resolves.toMatchObject({ status: 'active' });
    expect(frozen).toBe(1);
    expect(thawed).toBe(1);
  });

  it('router privileged doors require approval ids', async () => {
    const consumed: Array<{ targetId: string; approvalId: string; operationId: string }> = [];
    const stub = stubActionApprovals(CONFIRM, ACTOR);
    const actionApprovals: Pick<ActionApprovalService, 'consume'> = {
      consume: async (service, input) => {
        consumed.push({ targetId: input.targetId, approvalId: input.approvalId, operationId: input.operationId });
        return stub.consume(service, input);
      },
    };
    let frozen = 0;
    const freeze = partial<FreezeService>({
      freeze: async (input) => {
        frozen += 1;
        return {
          beneficiaryId: input.beneficiaryId,
          frozenBy: input.frozenBy,
          reason: input.reason,
          frozenAt: new Date('2026-09-09T12:00:00.000Z'),
        } as never;
      },
      frozenIds: async () => new Set([TARGET]),
    });
    const door = createIdentityRouter(partial<AuthService>({}), partial<RankService>({}), {
      registrationOpen: true,
      actionApprovals,
      freeze,
    });
    const { token } = await issueAccessToken(
      { userId: ACTOR, sessionId: SESSION, scopes: ['admin:write'], tier: 'none', mfa: true },
      edgeAuth,
    );
    const operator = door.createCaller({
      principal: await verifyAccessToken(token, edgeAuth),
      service: null,
      region: 'DE',
      requestId: 'req-1',
    });
    const ask = { beneficiaryId: TARGET, reason: 'TEST freeze reason', confirmOperatorId: CONFIRM };
    // No approval ids, blank ones, or a typed-in second name alone: refused before anything is frozen.
    for (const ids of [{}, { approvalId: '', operationId: '' }, { approvalId: null, operationId: null }, { approvalId: 'appr-1' }]) {
      const err = await operator.affiliates.freeze({ ...ask, ...ids }).catch((e: unknown) => e);
      expect((err as { code?: string }).code, JSON.stringify(ids)).toBe('PRECONDITION_FAILED');
    }
    expect(consumed).toEqual([]);
    expect(frozen).toBe(0);
    // With the approval ids the approval is consumed for this door, then the freeze runs. Ids past 128 never parse.
    await expect(operator.affiliates.freeze({ ...ask, ...APPROVED })).resolves.toMatchObject({ beneficiaryId: TARGET, frozenBy: ACTOR });
    expect(consumed).toEqual([{ targetId: 'affiliates.freeze', ...APPROVED }]);
    expect(frozen).toBe(1);
    const long = await operator.affiliates.freeze({ ...ask, approvalId: 'a'.repeat(129), operationId: 'op-1' }).catch((e: unknown) => e);
    expect((long as { code?: string }).code).toBe('BAD_REQUEST');
    expect(consumed).toHaveLength(1);
  });
});
