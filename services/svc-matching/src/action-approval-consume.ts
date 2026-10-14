/**
 * Matching consumes identity-issued action-bound approval for halt/resume/mode.
 * Two names in one body are attribution at most. Blank IDENTITY_URL refuses.
 */
import { createHash } from 'node:crypto';
import {
  actionApprovalConsumeInputSchema,
  actionApprovalSchema,
  serviceAuthHeadersForBody,
  type ActionApproval,
  type ActionApprovalConsumeInput,
} from '@intafaced/contracts';

export const ACTION_APPROVAL_UNWIRED = 'action_approval.identity_unwired' as const;
export const ACTION_APPROVAL_MISSING = 'action_approval.missing' as const;
/** The typed operatorId is not the person identity recorded as the requester. */
export const ACTION_APPROVAL_OPERATOR_MISMATCH = 'action_approval.operator_not_requester' as const;
/** The approval identity returned is for another action, service or target than this door. */
export const ACTION_APPROVAL_WRONG_ACTION = 'action_approval.wrong_action' as const;
/** Proposer or approver does not hold an operator seat on this venue. */
export const ACTION_APPROVAL_NOT_OPERATOR = 'action_approval.not_operator' as const;
/** The venue has published no operator list, so no one may open. */
export const ACTION_APPROVAL_OPERATORS_UNSET = 'action_approval.operators_unset' as const;

export class ActionApprovalConsumeError extends Error {
  constructor(
    message: string,
    readonly code:
      | typeof ACTION_APPROVAL_UNWIRED
      | typeof ACTION_APPROVAL_MISSING
      | typeof ACTION_APPROVAL_OPERATOR_MISMATCH
      | typeof ACTION_APPROVAL_NOT_OPERATOR
      | typeof ACTION_APPROVAL_WRONG_ACTION
      | typeof ACTION_APPROVAL_OPERATORS_UNSET
      | 'action_approval.consume_failed',
  ) {
    super(message);
    this.name = 'ActionApprovalConsumeError';
  }
}

export interface ActionApprovalConsumer {
  consume(input: ActionApprovalConsumeInput): Promise<ActionApproval>;
}

export function matchingActionPayloadHash(actionType: string, fields: Record<string, string>): string {
  const payload = JSON.stringify({ actionType, ...fields });
  return `sha256:${createHash('sha256').update(payload).digest('hex')}`;
}

export function unwrapTrpcJson(body: unknown): unknown {
  const root = body && typeof body === 'object' ? (body as { result?: { data?: unknown }; json?: unknown }) : null;
  if (!root) return body;
  const data = root.result?.data ?? root.json ?? body;
  if (data && typeof data === 'object' && 'json' in data) return (data as { json: unknown }).json;
  return data;
}

export function unwiredApprovalConsumer(): ActionApprovalConsumer {
  return {
    async consume() {
      throw new ActionApprovalConsumeError(
        'IDENTITY_URL is unpublished; matching halt does not invent a second person',
        ACTION_APPROVAL_UNWIRED,
      );
    },
  };
}

/**
 * Owner-published operator list (`MATCHING_OPERATOR_IDS`, comma separated user
 * ids). Identity records who proposed and approved, not what role they hold, so
 * matching keeps its own list of who may open. Blank → empty → nobody may open.
 */
export function parseOperatorIds(raw: string | undefined | null): ReadonlySet<string> {
  return new Set(
    (raw ?? '')
      .split(',')
      .map((id) => id.trim().toLowerCase())
      .filter((id) => id.length > 0),
  );
}

export function sameUser(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

export function stubApprovalConsumer(approverId: string, requesterId = 'ops-1'): ActionApprovalConsumer {
  return {
    async consume(input) {
      const parsed = actionApprovalConsumeInputSchema.parse(input);
      return actionApprovalSchema.parse({
        ...parsed,
        // `halt:BTC-USDT` → `matching.halt`, `halt_all` → `matching.halt_all`, like the real doors.
        actionType: `matching.${parsed.targetId.split(':')[0]}`,
        requesterId,
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
  const url = baseUrl.replace(/\/$/, '');
  return {
    async consume(input) {
      const parsed = actionApprovalConsumeInputSchema.parse(input);
      const payload = JSON.stringify(parsed);
      const res = await fetch(`${url}/trpc/actionApproval.consume`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...serviceAuthHeadersForBody('svc-matching', internalSecret, payload),
        },
        body: payload,
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new ActionApprovalConsumeError(`identity refused consume (${res.status}) ${detail}`.trim(), 'action_approval.consume_failed');
      }
      return actionApprovalSchema.parse(unwrapTrpcJson(await res.json()));
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
