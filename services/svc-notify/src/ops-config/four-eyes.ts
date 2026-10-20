/**
 * Two-person approval for an owner-side configuration change.
 *
 * The approval is spent first and the approver checked after, the same order the
 * public notice board uses. A missing consumer (no identity URL or secret) refuses
 * by name; it never lets the change through on one person's word.
 */

import { createHash } from 'node:crypto';
import type { ActionApproval } from '@intafaced/contracts';
import type { NoticeApprovalConsumer } from '../notices/board.js';

export type FourEyesCode = 'notify.approval_unavailable' | 'notify.approval_spent' | 'notify.approval_same_operator';

export class OpsConfigError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'OpsConfigError';
  }
}

export function payloadHashOf(payload: unknown): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(payload)).digest('hex')}`;
}

export type FourEyesInput = {
  readonly actorId: string;
  readonly approvalId: string;
  readonly operationId: string;
  readonly payloadHash: string;
  readonly targetId: string;
  readonly expectedVersion: string;
};

/** Spend the approval for exactly this change. Throws a typed code unless a different person approved it. */
export async function spendFourEyes(approvals: NoticeApprovalConsumer | null, input: FourEyesInput): Promise<ActionApproval> {
  if (!approvals) throw new OpsConfigError('notify.approval_unavailable');
  let approval: ActionApproval;
  try {
    approval = await approvals.consume({
      approvalId: input.approvalId,
      operationId: input.operationId,
      payloadHash: input.payloadHash,
      targetService: 'svc-notify',
      targetId: input.targetId,
      expectedVersion: input.expectedVersion,
    });
  } catch {
    throw new OpsConfigError('notify.approval_spent');
  }
  const sameOperator =
    approval.approverId == null ||
    approval.approverId === input.actorId ||
    approval.approverId === approval.requesterId ||
    approval.kind === 'same_person' ||
    (approval.status !== 'CONSUMED' && approval.status !== 'APPROVED');
  if (sameOperator) throw new OpsConfigError('notify.approval_same_operator');
  return approval;
}
