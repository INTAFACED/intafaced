/**
 * May this person be the other side of a new order? Asked of svc-identity, the only owner of account state
 * (`identity.users.status`), the way svc-bank asks before it credits a recipient (`svc-bank/src/recipient-state.ts`).
 *
 * WHY P2P ASKS (#4689). The edge refuses a frozen or closed person's own calls, so a frozen taker never reaches a
 * take. The ad's maker is not the caller: their ad stays on the board, and a take against it would lock the seller's
 * coin in escrow for a buyer who must not receive it, or ask a buyer to pay fiat to a seller who must not be paid.
 * So a take asks about the maker before it reserves anything.
 *
 * WHAT IS ASKED. Identity `GET /internal/account/:userId`, service-authenticated. Only the status is read.
 *   - `active`                     → may trade
 *   - `frozen`, `closed`, 404      → may not; one code for all three, so a taker learns nothing about the maker's account
 *   - no answer, non-2xx, a body that fails the schema or names another user, or no IDENTITY_URL → unknown: the take
 *     refuses and nothing is reserved.
 */

import { accountStateSchema, serviceCallSigner, type ServiceAuthMode, type ServiceSigner } from '@intafaced/contracts';

export type CounterpartyStatus = 'active' | 'frozen' | 'closed' | 'not_found';

/** Identity could not answer, or no IDENTITY_URL is set. */
export class CounterpartyStateUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CounterpartyStateUnavailableError';
  }
}

export interface CounterpartyStatePort {
  /** The account status, or throws `CounterpartyStateUnavailableError`. */
  statusOf(userId: string): Promise<CounterpartyStatus>;
}

/** No IDENTITY_URL: nobody can say the other side may trade, so every take refuses. */
export function unconfiguredCounterpartyState(): CounterpartyStatePort {
  return {
    async statusOf() {
      throw new CounterpartyStateUnavailableError('IDENTITY_URL is unset, so svc-p2p cannot check the other side of an order');
    },
  };
}

const FETCH_MS = 3_000;

/** Server log only: the caller is told "could not check"; this line is where an operator learns why. */
function logCheckFailure(detail: { userId: string; reason: string; httpStatus?: number }): void {
  console.error(JSON.stringify({ level: 'error', service: 'svc-p2p', event: 'p2p.counterparty_check_failed', ...detail }));
}

export function createIdentityCounterpartyState(
  baseUrl: string,
  internalSecret: string,
  s2s?: { signer: ServiceSigner; mode: ServiceAuthMode },
  fetchFn: typeof globalThis.fetch = globalThis.fetch,
): CounterpartyStatePort {
  const base = baseUrl.replace(/\/+$/, '');
  const sign = serviceCallSigner({ service: 'svc-p2p', audience: 'svc-identity', legacySecret: internalSecret, s2s });
  return {
    async statusOf(userId) {
      const id = userId.trim();
      if (!id) return 'not_found';
      const target = `${base}/internal/account/${encodeURIComponent(id)}`;
      let response: Response;
      try {
        response = await fetchFn(target, {
          method: 'GET',
          redirect: 'error',
          headers: sign('', { method: 'GET', url: new URL(target), contentType: '' }),
          signal: AbortSignal.timeout(FETCH_MS),
        });
      } catch (err) {
        logCheckFailure({ userId: id, reason: `identity request failed: ${err instanceof Error ? err.name : 'unknown'}` });
        throw new CounterpartyStateUnavailableError('identity did not answer the account status check');
      }
      if (response.status === 404) return 'not_found';
      if (!response.ok) {
        logCheckFailure({ userId: id, reason: 'identity answered non-2xx', httpStatus: response.status });
        throw new CounterpartyStateUnavailableError(`identity refused the account status check (${response.status})`);
      }
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        logCheckFailure({ userId: id, reason: 'identity body was not JSON', httpStatus: response.status });
        throw new CounterpartyStateUnavailableError('identity returned an unreadable account status');
      }
      const parsed = accountStateSchema.safeParse(body);
      if (!parsed.success || parsed.data.userId !== id) {
        logCheckFailure({
          userId: id,
          reason: parsed.success ? 'identity answered about a different user' : 'identity body failed the account state schema',
          httpStatus: response.status,
        });
        throw new CounterpartyStateUnavailableError('identity returned an unreadable account status');
      }
      return parsed.data.status;
    },
  };
}

/** For tests: anyone not listed is `active`; `failWith` makes every ask throw, as identity down does. */
export function memoryCounterpartyState(statuses: Readonly<Record<string, CounterpartyStatus>> = {}): CounterpartyStatePort & {
  set(userId: string, status: CounterpartyStatus): void;
  failWith(error: CounterpartyStateUnavailableError | null): void;
  readonly asked: string[];
} {
  const table = new Map<string, CounterpartyStatus>(Object.entries(statuses));
  let failure: CounterpartyStateUnavailableError | null = null;
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
      return table.get(userId) ?? 'active';
    },
  };
}
