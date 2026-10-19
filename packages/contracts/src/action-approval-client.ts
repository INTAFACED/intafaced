import {
  actionApprovalConsumeInputSchema,
  actionApprovalSchema,
  type ActionApproval,
  type ActionApprovalConsumeInput,
} from './action-approval.js';
import { serviceAuthHeadersForBody } from './service-auth.js';

/** tRPC HTTP is `{ result: { data } }`; superjson may wrap `{ json }`. */
export function unwrapTrpcData(body: unknown): unknown {
  if (!body || typeof body !== 'object') return body;
  const envelope = body as { result?: { data?: unknown }; json?: unknown };
  const data = envelope.result?.data ?? body;
  if (data && typeof data === 'object' && 'json' in data) return (data as { json: unknown }).json;
  return data;
}

/** Fail closed, never hang a founder-gated door on identity: a timeout is "unavailable", and nothing posts. */
export const IDENTITY_CONSUME_TIMEOUT_MS = 5000;

export const ACTION_APPROVAL_CONSUME_FAILED = 'action_approval.consume_failed' as const;

export interface IdentityApprovalClientOptions {
  readonly service: string;
  readonly baseUrl: string;
  readonly internalSecret: string;
  /** Builds the calling service's own error type. */
  readonly fail: (message: string, code: typeof ACTION_APPROVAL_CONSUME_FAILED) => Error;
  readonly timeoutMs?: number;
}

/**
 * The one client every service uses to consume an identity-issued approval.
 * It sends one signed request, bounds it with a timeout, and accepts the reply
 * only when it is CONSUMED and echoes the request (approval, operation,
 * payload hash, target, version).
 */
export function createIdentityApprovalClient(opts: IdentityApprovalClientOptions): {
  consume(input: ActionApprovalConsumeInput): Promise<ActionApproval>;
} {
  const url = opts.baseUrl.replace(/\/$/, '');
  const timeoutMs = opts.timeoutMs ?? IDENTITY_CONSUME_TIMEOUT_MS;
  return {
    async consume(input) {
      const parsed = actionApprovalConsumeInputSchema.parse(input);
      const payload = JSON.stringify(parsed);
      const res = await fetch(`${url}/trpc/actionApproval.consume`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...serviceAuthHeadersForBody(opts.service, opts.internalSecret, payload),
        },
        body: payload,
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw opts.fail(`identity refused consume (${res.status}) ${detail}`.trim(), ACTION_APPROVAL_CONSUME_FAILED);
      }
      const approval = actionApprovalSchema.parse(unwrapTrpcData(await res.json()));
      if (
        approval.status !== 'CONSUMED' ||
        approval.approvalId !== parsed.approvalId ||
        approval.operationId !== parsed.operationId ||
        approval.payloadHash !== parsed.payloadHash ||
        approval.targetService !== parsed.targetService ||
        approval.targetId !== parsed.targetId ||
        approval.expectedVersion !== parsed.expectedVersion
      ) {
        throw opts.fail('identity consume result does not match the request or is not CONSUMED', ACTION_APPROVAL_CONSUME_FAILED);
      }
      return approval;
    },
  };
}
