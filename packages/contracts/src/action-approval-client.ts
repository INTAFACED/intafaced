import {
  actionApprovalConsumeInputSchema,
  actionApprovalSchema,
  type ActionApproval,
  type ActionApprovalConsumeInput,
} from './action-approval.js';
import { serviceAuthHeadersForBody } from './service-auth.js';
import { serviceCallSigner, type ServiceAuthMode } from './service-auth-http.js';
import type { ServiceName, ServiceSigner } from './service-keys.js';

/** tRPC HTTP is `{ result: { data } }`; superjson may wrap `{ json }`. */
export function unwrapTrpcData(body: unknown): unknown {
  if (!body || typeof body !== 'object') return body;
  const envelope = body as { result?: { data?: unknown }; json?: unknown };
  const data = envelope.result?.data ?? body;
  if (data && typeof data === 'object' && 'json' in data) return (data as { json: unknown }).json;
  return data;
}

/** Longest refusal detail kept from identity's reply. */
const REFUSAL_DETAIL_MAX = 300;

/**
 * The part of a refused reply that is safe to pass on: tRPC's `error.message`, which carries the
 * `[action_approval.<code>]` tag callers read. Never the rest of the body: in dev mode it holds identity's stack.
 */
export function refusalDetail(text: string): string {
  let message: unknown;
  try {
    const body = JSON.parse(text) as unknown;
    const first = Array.isArray(body) ? body[0] : body;
    const envelope = first as { error?: { message?: unknown; json?: { message?: unknown } }; message?: unknown } | null;
    message = envelope?.error?.message ?? envelope?.error?.json?.message ?? envelope?.message;
  } catch {
    message = /^\s*[[{]/.test(text) ? undefined : text;
  }
  const detail = typeof message === 'string' ? message.split('\n')[0]!.trim() : '';
  return detail.length > REFUSAL_DETAIL_MAX ? `${detail.slice(0, REFUSAL_DETAIL_MAX)}…` : detail;
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
  /** Present once the service has a signing key and S2S is on; absent keeps the call on the shared secret alone. */
  readonly s2s?: { signer: ServiceSigner; mode: ServiceAuthMode } | undefined;
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
  const authHeadersFor = opts.s2s
    ? serviceCallSigner({
        service: opts.service as ServiceName,
        audience: 'svc-identity',
        legacySecret: opts.internalSecret,
        s2s: opts.s2s,
      })
    : undefined;
  return {
    async consume(input) {
      const parsed = actionApprovalConsumeInputSchema.parse(input);
      const payload = JSON.stringify(parsed);
      const target = `${url}/trpc/actionApproval.consume`;
      const authHeaders = authHeadersFor
        ? authHeadersFor(payload, { method: 'POST', url: new URL(target), contentType: 'application/json' })
        : serviceAuthHeadersForBody(opts.service, opts.internalSecret, payload);
      const res = await fetch(target, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeaders },
        body: payload,
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) {
        const detail = refusalDetail(await res.text().catch(() => ''));
        throw opts.fail(`identity refused consume (${res.status}) ${detail}`.trim(), ACTION_APPROVAL_CONSUME_FAILED);
      }
      let raw: unknown;
      try {
        raw = unwrapTrpcData(await res.json());
      } catch {
        throw opts.fail('identity consume result is not JSON', ACTION_APPROVAL_CONSUME_FAILED);
      }
      const checked = actionApprovalSchema.safeParse(raw);
      if (!checked.success) {
        throw opts.fail('identity consume result is not an action approval', ACTION_APPROVAL_CONSUME_FAILED);
      }
      const approval = checked.data;
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
