import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { TRPCError } from '@intafaced/contracts';
import type { AuthService } from './auth-service.js';
import { installPrivilegedDualControl, requirePrivilegedDualControl, stubActionApprovals } from './privileged-dual-control.js';

const ACTOR = '11111111-1111-4111-8111-111111111111';
const CONFIRM = '22222222-2222-4222-8222-222222222222';
const TARGET = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const APPROVED = { approvalId: 'appr-1', operationId: 'op-1' };
const here = dirname(fileURLToPath(import.meta.url));

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

  it('router privileged doors require approval ids', () => {
    const door = readFileSync(join(here, '../router.ts'), 'utf8');
    expect(door).toMatch(/approvalId: z\.string\(\)\.max\(128\)\.nullish\(\)/);
    expect(door).toMatch(/consumePrivileged/);
  });
});
