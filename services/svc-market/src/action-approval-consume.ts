/**
 * Market consumes identity-issued action-bound approval.
 * Two names in one body are not this. User mutates (apply, purchase) do not call here.
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

export function marketActionPayloadHash(actionType: string, fields: Record<string, string>): string {
  const payload = JSON.stringify({ actionType, ...fields });
  return `sha256:${createHash('sha256').update(payload).digest('hex')}`;
}

export { unwrapTrpcData } from '@intafaced/contracts';

export function unwiredApprovalConsumer(): ActionApprovalConsumer {
  return {
    async consume() {
      throw new ActionApprovalConsumeError(
        'IDENTITY_URL is unpublished; vendor vet does not invent a second person',
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
    service: 'svc-market',
    baseUrl,
    internalSecret,
    fail: (message, code) => new ActionApprovalConsumeError(message, code),
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
