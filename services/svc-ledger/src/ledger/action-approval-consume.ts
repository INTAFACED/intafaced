/**
 * Ledger consumes identity-issued action-bound approval.
 * Two names in one body are not this. Boot/cron freeze does not call here.
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

export function ledgerActionPayloadHash(actionType: string, fields: Record<string, string>): string {
  const payload = JSON.stringify({ actionType, ...fields });
  return `sha256:${createHash('sha256').update(payload).digest('hex')}`;
}

export function unwiredApprovalConsumer(): ActionApprovalConsumer {
  return {
    async consume() {
      throw new ActionApprovalConsumeError(
        'IDENTITY_URL is unpublished; operator freeze does not invent a second person',
        ACTION_APPROVAL_UNWIRED,
      );
    },
  };
}

/** `posting_freeze` is the target of `ledger.freeze`. Identity stores the action type, not the target id. */
function ledgerActionTypeForTarget(targetId: string): string {
  return targetId.startsWith('posting_') ? `ledger.${targetId.slice('posting_'.length)}` : targetId;
}

export function stubApprovalConsumer(approverId: string): ActionApprovalConsumer {
  return {
    async consume(input) {
      const parsed = actionApprovalConsumeInputSchema.parse(input);
      return actionApprovalSchema.parse({
        ...parsed,
        actionType: ledgerActionTypeForTarget(parsed.targetId),
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
  const url = baseUrl.replace(/\/$/, '');
  return {
    async consume(input) {
      const parsed = actionApprovalConsumeInputSchema.parse(input);
      const payload = JSON.stringify(parsed);
      const res = await fetch(`${url}/trpc/actionApproval.consume`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...serviceAuthHeadersForBody('svc-ledger', internalSecret, payload),
        },
        body: payload,
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new ActionApprovalConsumeError(`identity refused consume (${res.status}) ${detail}`.trim(), 'action_approval.consume_failed');
      }
      let raw: unknown;
      try {
        raw = unwrapTrpcData(await res.json());
      } catch {
        throw new ActionApprovalConsumeError(
          'identity consume body is not a consumed approval for this request',
          'action_approval.consume_failed',
        );
      }
      const parsedBody = actionApprovalSchema.safeParse(raw);
      if (!parsedBody.success || !consumedApprovalMatchesRequest(parsedBody.data, parsed)) {
        throw new ActionApprovalConsumeError(
          'identity consume body is not a consumed approval for this request',
          'action_approval.consume_failed',
        );
      }
      return parsedBody.data;
    },
  };
}

/** HTTP 200 is not consume. Status must be CONSUMED, and the approval, operation, target, and payload hash must be the ones asked for. */
function consumedApprovalMatchesRequest(row: ActionApproval, request: ActionApprovalConsumeInput): boolean {
  return (
    row.status === 'CONSUMED' &&
    row.approvalId === request.approvalId &&
    row.operationId === request.operationId &&
    row.targetService === request.targetService &&
    row.targetId === request.targetId &&
    row.expectedVersion === request.expectedVersion &&
    row.payloadHash === request.payloadHash
  );
}

/** tRPC HTTP is `{ result: { data } }`; superjson may wrap `{ json }`. */
export function unwrapTrpcData(body: unknown): unknown {
  if (!body || typeof body !== 'object') return body;
  const envelope = body as { result?: { data?: unknown }; json?: unknown };
  const data = envelope.result?.data ?? body;
  if (data && typeof data === 'object' && 'json' in data) return (data as { json: unknown }).json;
  return data;
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
 * Founder-audience consumes require identity's attestation. `ledger.freeze` does not.
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

/** Consume a ledger operator approval. Freeze is a protective verb; thaw and reconcile are founder-audience. */
export async function consumeLedgerApproval(
  approvals: ActionApprovalConsumer,
  cmd: { readonly approvalId?: string | null; readonly operationId?: string | null },
  actionType: string,
  targetId: string,
  expectedVersion: string,
  fields: Record<string, string>,
): Promise<ActionApproval> {
  const ids = readApprovalIds(cmd);
  const consumed = await approvals.consume({
    approvalId: ids.approvalId,
    operationId: ids.operationId,
    payloadHash: ledgerActionPayloadHash(actionType, fields),
    targetService: 'svc-ledger',
    targetId,
    expectedVersion,
  });
  assertFounderAudienceAttestation(consumed, { actionType, targetService: 'svc-ledger', targetId });
  return consumed;
}
