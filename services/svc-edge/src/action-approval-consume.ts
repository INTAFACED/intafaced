/**
 * Edge consumes identity-issued approval for kill-switch mutate.
 * Freeze is forwarded to ledger (ledger consumes). Edge has no INTERNAL_SERVICE_SECRET.
 */
import { createHash } from 'node:crypto';
import {
  actionApprovalConsumeInputSchema,
  actionApprovalSchema,
  ACTION_APPROVAL_CONSUME_FAILED,
  IDENTITY_CONSUME_TIMEOUT_MS,
  unwrapTrpcData,
  type ActionApproval,
  type ActionApprovalConsumeInput,
} from '@intafaced/contracts';
import type { Principal } from '@intafaced/auth';
import { forwardedPrincipalHeaders, type EdgeEd25519Signing } from './forward-principal-signature.js';

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
  consume(input: ActionApprovalConsumeInput, operator?: Principal): Promise<ActionApproval>;
}

export function edgeActionPayloadHash(actionType: string, fields: Record<string, string>): string {
  return `sha256:${createHash('sha256')
    .update(JSON.stringify({ actionType, ...fields }))
    .digest('hex')}`;
}

export function unwiredApprovalConsumer(): ActionApprovalConsumer {
  return {
    async consume() {
      throw new ActionApprovalConsumeError(
        'identity consume-for-edge is unpublished; kill-switch does not invent a second person',
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

export function createHttpEdgeApprovalConsumer(opts: {
  readonly identityUrl: string;
  readonly edgeSecret: string;
  readonly region: string;
  /** The edge's signing key when it has one; else the shared secret signs. */
  readonly ed25519?: EdgeEd25519Signing | undefined;
  readonly timeoutMs?: number;
}): ActionApprovalConsumer {
  const url = opts.identityUrl.replace(/\/$/, '');
  const timeoutMs = opts.timeoutMs ?? IDENTITY_CONSUME_TIMEOUT_MS;
  return {
    async consume(input, operator) {
      if (!operator) {
        throw new ActionApprovalConsumeError('operator principal required to consume edge approval', ACTION_APPROVAL_MISSING);
      }
      const parsed = actionApprovalConsumeInputSchema.parse(input);
      const payload = JSON.stringify(parsed);
      const res = await fetch(`${url}/trpc/actionApproval.consumeForEdge`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...forwardedPrincipalHeaders(operator, { edgeSecret: opts.edgeSecret, ed25519: opts.ed25519, region: opts.region }),
        },
        body: payload,
        // A hung identity must not hang the kill switch: a timeout rejects, so nothing is approved.
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new ActionApprovalConsumeError(
          `identity refused consumeForEdge (${res.status}) ${detail}`.trim(),
          ACTION_APPROVAL_CONSUME_FAILED,
        );
      }
      let raw: unknown;
      try {
        raw = unwrapTrpcData(await res.json());
      } catch {
        throw new ActionApprovalConsumeError('identity consumeForEdge result is not JSON', ACTION_APPROVAL_CONSUME_FAILED);
      }
      const checked = actionApprovalSchema.safeParse(raw);
      if (!checked.success) {
        throw new ActionApprovalConsumeError('identity consumeForEdge result is not an action approval', ACTION_APPROVAL_CONSUME_FAILED);
      }
      return checked.data;
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
