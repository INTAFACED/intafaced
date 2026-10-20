/**
 * The Protocol ops desk consumes an identity-issued four-eyes approval before it hides or restores anything.
 * A typed-in second name is attribution, not a second person (`action_approval.names_are_not_authority`).
 *
 * `svc-protocol` has no service-to-service role today (`SERVICE_NAMES` in `packages/contracts/src/service-keys.ts`), so it
 * cannot call `svc-identity`'s consume. Until that role exists, the default consumer refuses with
 * `action_approval.identity_unwired` and nothing is hidden. The desk takes the consumer as a seam so the day the role lands
 * is a wiring change, not a rewrite.
 */
import { createHash } from 'node:crypto';
import { founderAttestationVerdict, type ActionApproval, type ActionApprovalConsumeInput } from '@intafaced/contracts';

export const ACTION_APPROVAL_UNWIRED = 'action_approval.identity_unwired' as const;
export const ACTION_APPROVAL_MISSING = 'action_approval.missing' as const;
export const ACTION_APPROVAL_NOT_FOUNDERS = 'action_approval.not_founders' as const;

export class ActionApprovalConsumeError extends Error {
  constructor(
    message: string,
    readonly code: typeof ACTION_APPROVAL_UNWIRED | typeof ACTION_APPROVAL_MISSING | typeof ACTION_APPROVAL_NOT_FOUNDERS | string,
  ) {
    super(message);
    this.name = 'ActionApprovalConsumeError';
  }
}

export interface ActionApprovalConsumer {
  consume(input: ActionApprovalConsumeInput): Promise<ActionApproval>;
}

export const unwiredApprovalConsumer: ActionApprovalConsumer = {
  async consume() {
    throw new ActionApprovalConsumeError(
      'svc-protocol has no service-to-service role to reach svc-identity yet; the desk does not invent a second person',
      ACTION_APPROVAL_UNWIRED,
    );
  },
};

/** The hash both founders sign: the action and every field that changes what it does. */
export function opsPayloadHash(actionType: string, fields: Record<string, string>): string {
  return `sha256:${createHash('sha256')
    .update(JSON.stringify({ actionType, ...fields }))
    .digest('hex')}`;
}

/** Consume the approval, then require identity's attestation that proposer and approver are distinct founders. */
export async function consumeOpsApproval(
  approvals: ActionApprovalConsumer,
  ids: { approvalId: string; operationId: string },
  subject: { actionType: string; targetId: string },
  fields: Record<string, string>,
  expectedVersion: string,
): Promise<ActionApproval> {
  const approvalId = ids.approvalId.trim();
  if (!approvalId) {
    throw new ActionApprovalConsumeError('an approval id is required; a typed-in second name is not approval', ACTION_APPROVAL_MISSING);
  }
  const consumed = await approvals.consume({
    approvalId,
    operationId: ids.operationId,
    payloadHash: opsPayloadHash(subject.actionType, fields),
    targetService: 'svc-protocol',
    targetId: subject.targetId,
    expectedVersion,
  });
  const verdict = founderAttestationVerdict(consumed, { ...subject, targetService: 'svc-protocol' });
  if (!verdict.ok) {
    throw new ActionApprovalConsumeError(
      verdict.reason === 'missing'
        ? 'identity did not attest that the proposer and the approver are both founders'
        : 'the founder attestation does not match a distinct founder pair for this action',
      ACTION_APPROVAL_NOT_FOUNDERS,
    );
  }
  return consumed;
}
