import type { OperatorAccessEntry } from './operator-owner-balances.js';

/**
 * The access row every operator object lookup writes BEFORE it reads (OPS-rules-monitoring-12, migration 0025).
 *
 * A business key names a customer's deposit, withdrawal or order, and a transaction id leads to the same. So a lookup
 * is recorded first, exactly as an owner-balances read is, and a lookup whose row cannot be written is refused with
 * nothing read. The record lives inside the read functions, not in a route, so every door that serves them inherits it.
 */

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
  target: { ownerType: 'transaction' | 'business_key'; ownerId: string; action: 'transaction.read' | 'trace.read' },
): Promise<void> {
  try {
    await recorder.recordOperatorAccess({ actorId: actor.actorId, requestId: actor.requestId, ...target });
  } catch (err) {
    throw new LookupUnrecordedError(err);
  }
}
