/**
 * An agent key cannot move money (J-developer-15 #6: "The payout is refused `auth.scope_denied` and no approval row is
 * made").
 *
 * A request a key makes on one of the routes below is not forwarded until identity says the key is not an agent key.
 * An agent key's request is refused 403 `auth.scope_denied`: nothing reached the service and nothing was written, so
 * the action did not run. Any other key's request goes on as before (the service's own scope rules still decide it).
 *
 * The list is explicit, by method and tRPC procedure. Widen it only together with the action list in contracts
 * (`AGENT_HELD_ACTIONS`).
 */
import { createHash } from 'node:crypto';
import { AGENT_KEY_ACTION_REFUSAL, agentKeyHoldOutputSchema, type AgentHeldAction } from '@intafaced/contracts/api-keys';
import { unwrapTrpcData } from '@intafaced/contracts';
import { identityCallHeaders, type EdgeS2s } from './s2s.js';

const HELD_PROCEDURES: ReadonlyArray<{ readonly prefix: string; readonly procedure: string; readonly action: AgentHeldAction }> = [
  { prefix: '/api/pay/trpc/', procedure: 'settlement.payout', action: 'pay.payout' },
  { prefix: '/api/pay/trpc/', procedure: 'payment.refund', action: 'pay.refund' },
];

/**
 * The held action this request asks for, if any. A tRPC batch (`a,b?batch=1`) is held when any of its procedures is.
 * Only POST runs a tRPC mutation, so other methods are never held.
 */
export function agentHeldAction(method: string, pathname: string): AgentHeldAction | undefined {
  if (method.toUpperCase() !== 'POST') return undefined;
  for (const held of HELD_PROCEDURES) {
    if (!pathname.startsWith(held.prefix)) continue;
    let tail: string;
    try {
      tail = decodeURIComponent(pathname.slice(held.prefix.length));
    } catch {
      // An unreadable path is held: the edge cannot tell it is not the payout.
      return held.action;
    }
    if (tail.split(',').some((procedure) => procedure.trim() === held.procedure)) return held.action;
  }
  return undefined;
}

export function requestBodyHash(body: Buffer | Uint8Array | undefined): string {
  return `sha256:${createHash('sha256')
    .update(body ?? Buffer.alloc(0))
    .digest('hex')}`;
}

export type AgentHoldOutcome =
  /** An agent key: the request is refused `auth.scope_denied`, never forwarded. */
  | { readonly kind: 'agent_refused'; readonly code: typeof AGENT_KEY_ACTION_REFUSAL }
  | { readonly kind: 'not_held' }
  /** Identity refused: the key is not this user's live key. The request is refused, never forwarded. */
  | { readonly kind: 'refused' }
  /** Identity could not be asked. The request is not forwarded; the caller may retry. */
  | { readonly kind: 'unavailable' };

export async function holdAgentKeyAttempt(options: {
  readonly identityUrl: string;
  readonly identityOwnershipSecret: string;
  readonly s2s?: EdgeS2s | undefined;
  readonly fetch?: typeof globalThis.fetch;
  readonly userId: string;
  readonly keyId: string;
  readonly action: AgentHeldAction;
  readonly method: string;
  readonly path: string;
  readonly body: Buffer | Uint8Array | undefined;
}): Promise<AgentHoldOutcome> {
  const target = `${options.identityUrl.replace(/\/+$/, '')}/trpc/developerKeys.holdAgentAction`;
  const body = JSON.stringify({
    userId: options.userId,
    keyId: options.keyId,
    action: options.action,
    method: options.method.toUpperCase(),
    path: options.path.split('?')[0]!.slice(0, 512),
    bodyHash: requestBodyHash(options.body),
  });
  let response: Response;
  try {
    response = await (options.fetch ?? globalThis.fetch)(target, {
      method: 'POST',
      body,
      headers: {
        'content-type': 'application/json',
        ...identityCallHeaders(options.identityOwnershipSecret, options.s2s, {
          method: 'POST',
          target,
          body,
          contentType: 'application/json',
        }),
      },
      signal: AbortSignal.timeout(5_000),
    });
  } catch {
    return { kind: 'unavailable' };
  }
  if (!response.ok) {
    return response.status >= 500 || response.status === 408 || response.status === 429 ? { kind: 'unavailable' } : { kind: 'refused' };
  }
  let envelope: unknown;
  try {
    envelope = await response.json();
  } catch {
    return { kind: 'unavailable' };
  }
  const parsed = agentKeyHoldOutputSchema.safeParse(unwrapTrpcData(envelope));
  if (!parsed.success) return { kind: 'unavailable' };
  return parsed.data.held ? { kind: 'agent_refused', code: parsed.data.refusal } : { kind: 'not_held' };
}
