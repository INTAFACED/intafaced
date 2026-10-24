import { requireMfa, requireScope, type Principal } from '@intafaced/auth';
import type { OperatorAccessEntry } from './operator-owner-balances.js';

/**
 * The access row every operator object lookup writes BEFORE it reads (OPS-rules-monitoring-12, migration 0026).
 *
 * A business key names a customer's deposit, withdrawal or order, and a transaction id leads to the same. So a lookup
 * is recorded first, exactly as an owner-balances read is, and a lookup whose row cannot be written is refused with
 * nothing read. The record lives inside the read functions, not in a route, so every door that serves them inherits it.
 */

/**
 * Who may look up (owner decision 2026-10-23): `admin:read` with a second factor, so a founder's own sign-in can look
 * and the access row names the person. A lookup is a read, so the halt-the-platform scope is not required for it (a
 * founder sign-in never holds that scope). `admin:treasury` and `admin:compliance` imply `admin:read` (`hasScope`), so
 * their holders still pass. `admin:read` is interactive-only, so `requireScope` refuses it on an API key. Throws
 * `AuthError` (`mfa.required`, `scope.denied` or `scope.interactive_only`); nothing is recorded.
 */
export function requireLookupAuthority(principal: Principal): void {
  requireScope(principal, 'admin:read');
  requireMfa(principal);
}

/** A lookup whose access row could not be written: nothing was read. */
export const LOOKUP_UNRECORDED = 'ledger.lookup_unrecorded' as const;

export class LookupUnrecordedError extends Error {
  readonly code = LOOKUP_UNRECORDED;
  constructor(cause: unknown) {
    super('the lookup could not be recorded, so it was not read', { cause });
    this.name = 'LookupUnrecordedError';
  }
}

/** Who is looking: the operator's verified id and the request it came on. */
export interface LookupActor {
  readonly actorId: string;
  readonly requestId: string | null;
}

export interface LookupRecorder {
  recordOperatorAccess(entry: OperatorAccessEntry): Promise<void>;
}

export async function recordLookup(
  recorder: LookupRecorder,
  actor: LookupActor,
  target:
    | { ownerType: 'transaction' | 'business_key'; ownerId: string; action: 'transaction.read' | 'trace.read' }
    | { ownerType: 'transactions'; ownerId: string; action: 'transactions.list' }
    | { ownerType: 'address_prefix'; ownerId: string; action: 'accounts.search' }
    | { ownerType: 'account'; ownerId: string; action: 'account_metadata.read' },
): Promise<void> {
  try {
    await recorder.recordOperatorAccess({ actorId: actor.actorId, requestId: actor.requestId, ...target });
  } catch (err) {
    throw new LookupUnrecordedError(err);
  }
}
