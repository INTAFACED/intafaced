/**
 * Privileged identity mutates consume an identity-issued action-bound approval.
 * A typed-in confirmActorId is not two people.
 */
import { createHash } from 'node:crypto';
import { actionApprovalSchema, TRPCError } from '@intafaced/contracts';
import type { AuthService } from './auth-service.js';
import type { FreezeService } from '../affiliates/freeze-service.js';
import { ActionApprovalError, type ActionApprovalService } from './action-approval-service.js';
import type { DualControlCmd } from './four-eyes.js';

const AUTH_FLAG = Symbol.for('intafaced.identity.privileged-dual-control.auth');
const FREEZE_FLAG = Symbol.for('intafaced.identity.privileged-dual-control.freeze');

export const ACTION_APPROVAL_MISSING = 'action_approval.missing' as const;

export class PrivilegedDualControlError extends Error {
  constructor(
    message: string,
    readonly code: typeof ACTION_APPROVAL_MISSING | ActionApprovalError['code'],
  ) {
    super(message);
    this.name = 'PrivilegedDualControlError';
  }
}

export type PrivilegedApprovalCmd = DualControlCmd & {
  readonly approvalId?: string | null;
  readonly operationId?: string | null;
  readonly targetId: string;
  readonly fields?: Record<string, string>;
};

export function identityActionPayloadHash(targetId: string, fields: Record<string, string> = {}): string {
  return `sha256:${createHash('sha256')
    .update(JSON.stringify({ targetId, ...fields }))
    .digest('hex')}`;
}

export function stubActionApprovals(
  approverId = '22222222-2222-4222-8222-222222222222',
  requesterId = 'requester',
): Pick<ActionApprovalService, 'consume'> {
  return {
    async consume(_service: string, input) {
      return actionApprovalSchema.parse({
        approvalId: input.approvalId,
        actionType: input.targetId,
        targetService: input.targetService,
        targetId: input.targetId,
        expectedVersion: input.expectedVersion,
        payloadHash: input.payloadHash,
        requesterId,
        approverId,
        policyVersion: 'v1',
        createdAt: '2026-09-09T12:00:00.000Z',
        expiresAt: '2026-09-09T12:10:00.000Z',
        status: 'CONSUMED',
        operationId: input.operationId,
      });
    },
  };
}

export async function requirePrivilegedDualControl(
  approvals: Pick<ActionApprovalService, 'consume'>,
  cmd: PrivilegedApprovalCmd | undefined,
): Promise<{ requesterId: string; approverId: string }> {
  const approvalId = cmd?.approvalId?.trim() ?? '';
  const operationId = cmd?.operationId?.trim() ?? '';
  if (!approvalId || !operationId || !cmd?.targetId) {
    throw new PrivilegedDualControlError(
      'approvalId and operationId are required; a typed-in second name is not approval',
      ACTION_APPROVAL_MISSING,
    );
  }
  try {
    const row = await approvals.consume('svc-identity', {
      approvalId,
      operationId,
      payloadHash: identityActionPayloadHash(cmd.targetId, cmd.fields ?? {}),
      targetService: 'svc-identity',
      targetId: cmd.targetId,
      expectedVersion: '1',
    });
    return { requesterId: row.requesterId, approverId: row.approverId ?? row.requesterId };
  } catch (err) {
    if (err instanceof ActionApprovalError) {
      throw new PrivilegedDualControlError(err.message, err.code);
    }
    throw err;
  }
}

async function refuseOnWire(approvals: Pick<ActionApprovalService, 'consume'>, cmd: PrivilegedApprovalCmd | undefined): Promise<void> {
  try {
    await requirePrivilegedDualControl(approvals, cmd);
  } catch (err) {
    if (err instanceof PrivilegedDualControlError) {
      throw new TRPCError({ code: 'PRECONDITION_FAILED', message: `${err.message} [${err.code}]`, cause: err });
    }
    throw err;
  }
}

function readApproval(input: object): { approvalId: string | null; operationId: string | null } {
  const approvalId = 'approvalId' in input ? ((input as { approvalId?: string | null }).approvalId ?? null) : null;
  const operationId = 'operationId' in input ? ((input as { operationId?: string | null }).operationId ?? null) : null;
  return { approvalId, operationId };
}

export function installPrivilegedDualControl(auth: AuthService, approvals: Pick<ActionApprovalService, 'consume'>): void {
  const tagged = auth as AuthService & { [AUTH_FLAG]?: true };
  if (tagged[AUTH_FLAG]) return;
  tagged[AUTH_FLAG] = true;

  const freezeIdentity = auth.freezeIdentity.bind(auth);
  auth.freezeIdentity = async (userId: string, cmd?: DualControlCmd) => {
    await refuseOnWire(approvals, {
      ...cmd,
      ...readApproval(cmd ?? {}),
      targetId: 'identity.freeze',
      fields: { userId },
    });
    return freezeIdentity(userId);
  };

  const unfreezeIdentity = auth.unfreezeIdentity.bind(auth);
  auth.unfreezeIdentity = async (userId: string, cmd?: DualControlCmd) => {
    await refuseOnWire(approvals, {
      ...cmd,
      ...readApproval(cmd ?? {}),
      targetId: 'identity.unfreeze',
      fields: { userId },
    });
    return unfreezeIdentity(userId);
  };

  const approveKycRecord = auth.approveKycRecord.bind(auth);
  auth.approveKycRecord = async (input) => approveKycRecord(input);

  const rejectKycRecord = auth.rejectKycRecord.bind(auth);
  auth.rejectKycRecord = async (input) => rejectKycRecord(input);
}

export function installFreezeDualControl(freeze: FreezeService, approvals: Pick<ActionApprovalService, 'consume'>): void {
  const tagged = freeze as FreezeService & { [FREEZE_FLAG]?: true };
  if (tagged[FREEZE_FLAG]) return;
  tagged[FREEZE_FLAG] = true;

  const origFreeze = freeze.freeze.bind(freeze);
  freeze.freeze = async (input) => origFreeze(input);

  const origUnfreeze = freeze.unfreeze.bind(freeze);
  freeze.unfreeze = async (beneficiaryId: string, cmd?: DualControlCmd) => origUnfreeze(beneficiaryId, cmd);
}

export { ACTION_APPROVAL_MISSING as DUAL_CONTROL_MISSING };
export const DUAL_CONTROL_MISSING_MESSAGE = 'approvalId and operationId are required; a typed-in second name is not approval';
