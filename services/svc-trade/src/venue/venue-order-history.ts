import type { Amount } from '@intafaced/ledger-client/money';
import type { UserVenueAccount } from '@intafaced/venue-contracts';
import type { StoredVenueAction } from './prepared-action-store.js';

/** One amendment the venue accepted: the amount and price it left the order with, and when the venue recorded it. */
export interface VenueAmendment {
  readonly actionKey: string;
  readonly amount: Amount;
  readonly price: Amount;
  readonly recordedAt: Date;
}

/** The amend actions stored under this prefix (`amend:`, the customer app's key for one lowering of an order). */
export const AMEND_KEY_PREFIX = 'amend:';

/**
 * The amend trail of one order on one account, oldest first: each amend our door sent for it that the venue accepted,
 * at the venue's own time for the answer. One still waiting for the venue's answer, or refused, is not an amendment.
 */
export function amendTrail(rows: readonly StoredVenueAction[], account: UserVenueAccount, venueClientOrderId: string): VenueAmendment[] {
  const cloid = venueClientOrderId.toLowerCase();
  const out: VenueAmendment[] = [];
  for (const row of rows) {
    const { intent, account: on } = row.prepared;
    if (intent.kind !== 'amend_order' || intent.venueClientOrderId.toLowerCase() !== cloid) continue;
    if (on.venueId !== account.venueId || on.owner.toLowerCase() !== account.owner || (on.subAccount ?? null) !== account.subAccount)
      continue;
    const outcome = row.lastOutcome;
    if (!row.signature || !outcome || !outcome.definite || !outcome.accepted) continue;
    out.push({ actionKey: row.businessKey, amount: intent.amount, price: intent.price, recordedAt: outcome.asOf });
  }
  return out.sort((a, b) => a.recordedAt.getTime() - b.recordedAt.getTime());
}
