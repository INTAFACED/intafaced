/**
 * Pay consumes identity-issued action-bound approval (HMAC).
 * Two names in one body are not this.
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
/** The approval was not approved by a distinct founder who proposed-and-approved as a founder pair. */
export const ACTION_APPROVAL_NOT_FOUNDERS = 'action_approval.not_founders' as const;
/** Identity refused because the consume hash is not the hash the second founder approved. */
export const ACTION_APPROVAL_PAYLOAD_MISMATCH = 'action_approval.payload_mismatch' as const;

export class ActionApprovalConsumeError extends Error {
  constructor(
    message: string,
    readonly code:
      | typeof ACTION_APPROVAL_UNWIRED
      | typeof ACTION_APPROVAL_MISSING
      | typeof ACTION_APPROVAL_NOT_FOUNDERS
      | typeof ACTION_APPROVAL_PAYLOAD_MISMATCH
      | 'action_approval.consume_failed',
  ) {
    super(message);
    this.name = 'ActionApprovalConsumeError';
  }
}

export interface ActionApprovalConsumer {
  consume(input: ActionApprovalConsumeInput): Promise<ActionApproval>;
}

export function payActionPayloadHash(actionType: string, fields: Record<string, string>): string {
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
        approverIsFounder: true,
        requesterIsFounder: true,
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
    service: 'svc-pay',
    baseUrl,
    internalSecret,
    timeoutMs: 2_000,
    // Identity names a payload mismatch in the refusal text; keep it typed for the caller.
    fail: (message, code) =>
      new ActionApprovalConsumeError(message, message.includes(ACTION_APPROVAL_PAYLOAD_MISMATCH) ? ACTION_APPROVAL_PAYLOAD_MISMATCH : code),
  });
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

/**
 * Consume before mutate. Returns the authentic approver id for wire echo.
 *
 * Every pay action is a founder-only approval: the proposer and the approver must be two different people who are both
 * founders. Identity decides who is a founder (the live founder entitlement) and re-checks it when it consumes, so an
 * approval made before that rule existed is refused there. Pay does not trust the approver id alone: it requires
 * identity's attestation on the consumed row, refuses a requester who approved their own action, and refuses when the
 * attestation is missing or false (an identity that does not send it fails closed). Nothing is grandfathered.
 */
export async function consumePayApproval(
  approvals: ActionApprovalConsumer,
  cmd: { readonly approvalId?: string | null; readonly operationId?: string | null },
  actionType: string,
  fields: Record<string, string>,
): Promise<string> {
  const ids = readApprovalIds(cmd);
  const consumed = await approvals.consume({
    approvalId: ids.approvalId,
    operationId: ids.operationId,
    payloadHash: payActionPayloadHash(actionType, fields),
    targetService: 'svc-pay',
    targetId: actionType,
    expectedVersion: '1',
  });
  const approver = consumed.approverId?.trim() ?? '';
  if (consumed.status !== 'CONSUMED' || !approver) {
    throw new ActionApprovalConsumeError('Identity did not return a consumed approval with an approver', 'action_approval.consume_failed');
  }
  if (approver.toLowerCase() === consumed.requesterId.trim().toLowerCase()) {
    throw new ActionApprovalConsumeError('the proposer cannot be the approver of a pay action', ACTION_APPROVAL_NOT_FOUNDERS);
  }
  if (consumed.approverIsFounder !== true || consumed.requesterIsFounder !== true) {
    throw new ActionApprovalConsumeError(
      'a pay action needs a proposer and an approver who are both founders; identity did not attest that',
      ACTION_APPROVAL_NOT_FOUNDERS,
    );
  }
  return approver;
}
