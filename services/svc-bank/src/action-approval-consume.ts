/**
 * Bank consumes identity-issued action-bound approval for ops.* mutates.
 * Typed-in confirmOperatorId is attribution, not authority.
 * Bank maker-checker (business.approve/reject/cancel) is not this door.
 */
import { createHash } from 'node:crypto';
import {
  actionApprovalConsumeInputSchema,
  actionApprovalSchema,
  founderAttestationVerdict,
  serviceAuthHeadersForBody,
  type ActionApproval,
  type ActionApprovalConsumeInput,
  type FounderApprovalSubject,
} from '@intafaced/contracts';

/** How long bank waits for identity to answer a consume before refusing closed. */
export const IDENTITY_CONSUME_TIMEOUT_MS = 5000;

export const ACTION_APPROVAL_UNWIRED = 'action_approval.identity_unwired' as const;
export const ACTION_APPROVAL_MISSING = 'action_approval.missing' as const;
/** Identity did not attest a distinct founder pair for a founder-audience action. */
export const ACTION_APPROVAL_NOT_FOUNDERS = 'action_approval.not_founders' as const;

export class ActionApprovalConsumeError extends Error {
  constructor(
    message: string,
    readonly code:
      | typeof ACTION_APPROVAL_UNWIRED
      | typeof ACTION_APPROVAL_MISSING
      | typeof ACTION_APPROVAL_NOT_FOUNDERS
      | 'action_approval.consume_failed',
  ) {
    super(message);
    this.name = 'ActionApprovalConsumeError';
  }
}

export interface ActionApprovalConsumer {
  consume(input: ActionApprovalConsumeInput): Promise<ActionApproval>;
}

export function bankActionPayloadHash(actionType: string, fields: Record<string, string>): string {
  const sortedCopy: Record<string, string> = {};
  for (const key of Object.keys(fields).sort()) {
    const value = fields[key];
    if (value !== undefined) sortedCopy[key] = value;
  }
  const payload = JSON.stringify({ actionType, fields: sortedCopy });
  return `sha256:${createHash('sha256').update(payload).digest('hex')}`;
}

export function unwiredApprovalConsumer(): ActionApprovalConsumer {
  return {
    async consume() {
      throw new ActionApprovalConsumeError('IDENTITY_URL is unpublished; bank ops do not invent a second person', ACTION_APPROVAL_UNWIRED);
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

function unwrapTrpcJson(body: unknown): unknown {
  const envelope = body as { result?: { data?: unknown }; json?: unknown };
  const data = envelope.result?.data ?? body;
  if (data && typeof data === 'object' && 'json' in data) {
    return (data as { json: unknown }).json;
  }
  return data;
}

export function createIdentityApprovalClient(baseUrl: string, internalSecret: string): ActionApprovalConsumer {
  const url = baseUrl.replace(/\/$/, '');
  return {
    async consume(input) {
      const parsed = actionApprovalConsumeInputSchema.parse(input);
      const payload = JSON.stringify(parsed);
      const res = await fetch(`${url}/trpc/actionApproval.consume`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...serviceAuthHeadersForBody('svc-bank', internalSecret, payload),
        },
        body: payload,
        // Fail closed, never hang a money door on identity: a timeout is "unavailable", and nothing posts.
        signal: AbortSignal.timeout(IDENTITY_CONSUME_TIMEOUT_MS),
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new ActionApprovalConsumeError(`identity refused consume (${res.status}) ${detail}`.trim(), 'action_approval.consume_failed');
      }
      const approval = actionApprovalSchema.parse(unwrapTrpcJson(await res.json()));
      if (
        approval.status !== 'CONSUMED' ||
        approval.approvalId !== parsed.approvalId ||
        approval.operationId !== parsed.operationId ||
        approval.payloadHash !== parsed.payloadHash ||
        approval.targetService !== parsed.targetService ||
        approval.targetId !== parsed.targetId ||
        approval.expectedVersion !== parsed.expectedVersion
      ) {
        throw new ActionApprovalConsumeError(
          'identity consume result does not match the request or is not CONSUMED',
          'action_approval.consume_failed',
        );
      }
      return approval;
    },
  };
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
 * Founder-audience consumes require identity's attestation. A protective verb does not.
 * Absent flags and a false, same-person, or swapped row both refuse; nothing is grandfathered.
 */
export function assertFounderAudienceAttestation(consumed: ActionApproval, subject: FounderApprovalSubject): void {
  const verdict = founderAttestationVerdict(consumed, subject);
  if (verdict.ok) return;
  throw new ActionApprovalConsumeError(
    verdict.reason === 'missing'
      ? 'a founder-audience action needs identity to attest that the proposer and the approver are both founders'
      : 'the founder attestation does not match a distinct founder pair for this action',
    ACTION_APPROVAL_NOT_FOUNDERS,
  );
}

/** Consume a bank ops approval and require the founder attestation. Bank ops are founder-audience. */
export async function consumeBankOpsApproval(
  approvals: ActionApprovalConsumer,
  cmd: { readonly approvalId?: string | null; readonly operationId?: string | null },
  actionType: string,
  fields: Record<string, string>,
): Promise<string> {
  const ids = readApprovalIds(cmd);
  const consumed = await approvals.consume({
    approvalId: ids.approvalId,
    operationId: ids.operationId,
    payloadHash: bankActionPayloadHash(actionType, fields),
    targetService: 'svc-bank',
    targetId: actionType,
    expectedVersion: '1',
  });
  assertFounderAudienceAttestation(consumed, { actionType, targetService: 'svc-bank', targetId: actionType });
  if (!consumed.approverId) {
    throw new ActionApprovalConsumeError(
      'consumed approval has no approver; a typed-in name is not approval',
      'action_approval.consume_failed',
    );
  }
  return consumed.approverId;
}
