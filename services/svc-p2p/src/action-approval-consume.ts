/**
 * P2P consumes identity-issued action-bound approval for operator mutates
 * (method schema + merchant decide). A typed-in second name is not this.
 */
import { createHash } from 'node:crypto';
import {
  actionApprovalConsumeInputSchema,
  actionApprovalSchema,
  createIdentityApprovalClient as createSharedIdentityApprovalClient,
  type ActionApproval,
  type ActionApprovalConsumeInput,
} from '@intafaced/contracts';

export const ACTION_APPROVAL_UNWIRED = 'action_approval.identity_unwired' as const;
export const ACTION_APPROVAL_MISSING = 'action_approval.missing' as const;

export class ActionApprovalConsumeError extends Error {
  constructor(
    message: string,
    readonly code: typeof ACTION_APPROVAL_UNWIRED | typeof ACTION_APPROVAL_MISSING | 'action_approval.consume_failed',
  ) {
    super(message);
    this.name = 'ActionApprovalConsumeError';
  }
}

export interface ActionApprovalConsumer {
  consume(input: ActionApprovalConsumeInput): Promise<ActionApproval>;
}

export function p2pActionPayloadHash(actionType: string, fields: Record<string, string>): string {
  const payload = JSON.stringify({ actionType, ...fields });
  return `sha256:${createHash('sha256').update(payload).digest('hex')}`;
}

export function unwiredApprovalConsumer(): ActionApprovalConsumer {
  return {
    async consume() {
      throw new ActionApprovalConsumeError(
        'IDENTITY_URL is unpublished; operator mutate does not invent a second person',
        ACTION_APPROVAL_UNWIRED,
      );
    },
  };
}

export function stubApprovalConsumer(approverId: string): ActionApprovalConsumer {
  return {
    async consume(input) {
      const parsed = actionApprovalConsumeInputSchema.parse(input);
      return actionApprovalSchema.parse({
        ...parsed,
        actionType: parsed.targetId,
        requesterId: 'requester',
        approverId,
        policyVersion: 'v1',
        createdAt: '2026-09-09T12:00:00.000Z',
        expiresAt: '2026-09-09T12:10:00.000Z',
        status: 'CONSUMED',
      });
    },
  };
}

export function createIdentityApprovalClient(baseUrl: string, internalSecret: string): ActionApprovalConsumer {
  return createSharedIdentityApprovalClient({
    service: 'svc-p2p',
    baseUrl,
    internalSecret,
    fail: (message, code) => new ActionApprovalConsumeError(message, code),
  });
}

/** Identity action type for a dispute ruling. Operator audience: svc-p2p is already an operator target. */
export const DISPUTE_RESOLVE_ACTION = 'p2p.dispute_resolve';

/**
 * Hash of the ruling the second person approved.
 * `winner` is `buyer` on release and `seller` on refund. `note` is the ruling note, or `''` when none was sent.
 * Key order is fixed: actionType, disputeId, winner, note.
 */
export function disputeResolvePayloadHash(input: { disputeId: string; winner: 'buyer' | 'seller'; note: string }): string {
  return p2pActionPayloadHash(DISPUTE_RESOLVE_ACTION, {
    disputeId: input.disputeId,
    winner: input.winner,
    note: input.note,
  });
}

export interface DisputeResolveApproval {
  readonly approvalId: string;
  readonly operationId: string;
  readonly disputeId: string;
  readonly winner: 'buyer' | 'seller';
  readonly note: string;
}

/**
 * Consume `p2p.dispute_resolve` bound to this dispute and this ruling.
 * The caller runs this inside the ruling transaction, before commit and before the ledger post.
 */
export async function consumeDisputeResolveApproval(
  approvals: ActionApprovalConsumer,
  input: DisputeResolveApproval,
): Promise<{ approverId: string; requesterId: string }> {
  const consumed = await approvals.consume({
    approvalId: input.approvalId,
    operationId: input.operationId,
    payloadHash: disputeResolvePayloadHash(input),
    targetService: 'svc-p2p',
    targetId: input.disputeId,
    expectedVersion: '1',
  });
  if (consumed.actionType !== DISPUTE_RESOLVE_ACTION) {
    throw new ActionApprovalConsumeError('approval is not p2p.dispute_resolve for this dispute', 'action_approval.consume_failed');
  }
  if (consumed.targetId !== input.disputeId || consumed.payloadHash !== disputeResolvePayloadHash(input)) {
    throw new ActionApprovalConsumeError('payload hash does not match the approved action', 'action_approval.consume_failed');
  }
  const approverId = consumed.approverId?.trim() ?? '';
  const requesterId = consumed.requesterId.trim();
  if (!approverId || approverId.toLowerCase() === requesterId.toLowerCase()) {
    throw new ActionApprovalConsumeError(
      'consumed approval has no distinct approver; the requester does not confirm the ruling',
      'action_approval.consume_failed',
    );
  }
  return { approverId, requesterId };
}

export function readApprovalIds(cmd: { readonly approvalId?: string | null; readonly operationId?: string | null }): {
  readonly approvalId: string;
  readonly operationId: string;
} {
  const approvalId = cmd.approvalId?.trim() ?? '';
  const operationId = cmd.operationId?.trim() ?? '';
  if (!approvalId || !operationId) {
    throw new ActionApprovalConsumeError(
      'approvalId and operationId are required; a typed-in second name is not approval',
      ACTION_APPROVAL_MISSING,
    );
  }
  return { approvalId, operationId };
}
