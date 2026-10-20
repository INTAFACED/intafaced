/**
 * Can this user RECEIVE value? Asked of svc-identity, the only owner of account
 * state (`identity.users.status`).
 *
 * WHY BANK ASKS. Frozen and closed are enforced for the SENDER at the edge
 * (`svc-edge/identity-user-status.ts`). A sender with a saved user id could still
 * pay a frozen or closed RECIPIENT, because the only check here was that a
 * primary space row exists. Bank keeps no account state of its own (it would be a
 * second copy that could disagree), so it asks the owner.
 *
 * WHAT IS ASKED. Identity `GET /internal/account/:userId`, service-authenticated
 * with `INTERNAL_SERVICE_SECRET` like the affiliate and approval clients. The
 * answer is a status and a KYC tier, never PII, and only the status is read.
 *
 * SEMANTICS (copied from the edge so the two agree on what frozen means):
 *   - `active`           → may receive
 *   - `frozen`/`closed`  → may not
 *   - 404                → identity does not know the user: may not
 *   - transport error, timeout, non-2xx, unparseable body, or a body about a
 *     different user → UNAVAILABLE. Nothing is posted and the caller may retry.
 *     The edge treats these as "frozen"; bank separates them because a retry of
 *     the same transferId is the correct response to an outage and the wrong one
 *     to a freeze.
 *
 * Frozen and closed are never told apart outside this file: the port returns them
 * separately so tests can pin that both are refused, but `SpaceService` maps both
 * to one code and one message, matching identity's uniform `{ found: false }`.
 */

import { accountStateSchema, serviceCallSigner, type ServiceAuthMode, type ServiceSigner } from '@intafaced/contracts';

export type RecipientStatus = 'active' | 'frozen' | 'closed' | 'not_found';

/** Identity could not answer (outage, timeout, rejected credentials, bad body), or the port is not configured. */
export class RecipientStateUnavailableError extends Error {
  constructor(
    message: string,
    /** `unset` is a deployment gap (no IDENTITY_URL), not an outage: retrying will not fix it. */
    readonly reason: 'unavailable' | 'unset' = 'unavailable',
  ) {
    super(message);
    this.name = 'RecipientStateUnavailableError';
  }
}

export interface RecipientStatePort {
  /** Resolves the account status, or throws `RecipientStateUnavailableError`. */
  statusOf(userId: string): Promise<RecipientStatus>;
}

/**
 * The port a deployment has when nothing was configured. Every ask refuses.
 *
 * Not "everyone may receive": a bank that cannot tell whether a recipient is
 * frozen must not pay them. Same posture as `unwiredApprovalConsumer` and
 * `noCardIssuer` (no invented defaults).
 */
export function unconfiguredRecipientState(
  why = 'IDENTITY_URL is unset, so svc-bank cannot check whether a recipient is frozen or closed',
): RecipientStatePort {
  return {
    async statusOf() {
      throw new RecipientStateUnavailableError(why, 'unset');
    },
  };
}

const FETCH_MS = 3_000;

export type RecipientCheckFailureLog = (detail: { userId: string; reason: string; httpStatus?: number }) => void;

/**
 * SERVER LOG ONLY. The caller is told "could not check" and nothing more; this
 * line is the one place an operator learns WHY (a wrong secret looks like a 401
 * here and like silent 503s everywhere else). One JSON line on stderr, same
 * shape as the router's `bank.undisclosed_error`.
 */
export const logRecipientCheckFailure: RecipientCheckFailureLog = (detail) => {
  console.error(JSON.stringify({ level: 'error', service: 'svc-bank', event: 'bank.recipient_check_failed', ...detail }));
};

export function createIdentityRecipientState(
  baseUrl: string,
  internalSecret: string,
  fetchFn: typeof globalThis.fetch = globalThis.fetch,
  log: RecipientCheckFailureLog = logRecipientCheckFailure,
  s2s?: { signer: ServiceSigner; mode: ServiceAuthMode },
): RecipientStatePort {
  const base = baseUrl.replace(/\/+$/, '');
  const sign = serviceCallSigner({ service: 'svc-bank', audience: 'svc-identity', legacySecret: internalSecret, s2s });
  return {
    async statusOf(userId) {
      const id = userId.trim();
      // An empty id is not a lookup; do not send it to identity as `/account/`.
      if (!id) return 'not_found';
      let response: Response;
      try {
        const target = `${base}/internal/account/${encodeURIComponent(id)}`;
        response = await fetchFn(target, {
          method: 'GET',
          headers: sign('', { method: 'GET', url: new URL(target), contentType: '' }),
          signal: AbortSignal.timeout(FETCH_MS),
        });
      } catch (err) {
        log({ userId: id, reason: `identity request failed: ${err instanceof Error ? err.name : 'unknown'}` });
        throw new RecipientStateUnavailableError('identity did not answer the recipient status check');
      }
      if (response.status === 404) return 'not_found';
      if (!response.ok) {
        log({ userId: id, reason: 'identity answered non-2xx', httpStatus: response.status });
        throw new RecipientStateUnavailableError(`identity refused the recipient status check (${response.status})`);
      }
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        log({ userId: id, reason: 'identity body was not JSON', httpStatus: response.status });
        throw new RecipientStateUnavailableError('identity returned an unreadable recipient status');
      }
      const parsed = accountStateSchema.safeParse(body);
      if (!parsed.success || parsed.data.userId !== id) {
        log({
          userId: id,
          reason: parsed.success ? 'identity answered about a different user' : 'identity body failed the account state schema',
          httpStatus: response.status,
        });
        throw new RecipientStateUnavailableError('identity returned an unreadable recipient status');
      }
      return parsed.data.status;
    },
  };
}

/**
 * An in-memory identity for tests and local stacks, in the spirit of
 * `memoryLedgerHistory`. Anyone not listed is `active` unless `strict` is set
 * (then unlisted users are `not_found`, as identity answers for an unknown id).
 * `failWith` makes every ask throw, to model identity being down.
 */
export function memoryRecipientState(
  statuses: Readonly<Record<string, RecipientStatus>> = {},
  options: { strict?: boolean } = {},
): RecipientStatePort & {
  set(userId: string, status: RecipientStatus): void;
  failWith(error: RecipientStateUnavailableError | null): void;
  readonly asked: string[];
} {
  const table = new Map<string, RecipientStatus>(Object.entries(statuses));
  let failure: RecipientStateUnavailableError | null = null;
  const asked: string[] = [];
  return {
    asked,
    set: (userId, status) => void table.set(userId, status),
    failWith: (error) => {
      failure = error;
    },
    async statusOf(userId) {
      asked.push(userId);
      if (failure) throw failure;
      return table.get(userId) ?? (options.strict ? 'not_found' : 'active');
    },
  };
}
