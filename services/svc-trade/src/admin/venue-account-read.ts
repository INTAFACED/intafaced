/**
 * A founder's read of one person's venue accounts (J-derivatives-26 #8, /trade-ops/accounts): each venue account the
 * person signed for through our door, its margin now as the venue reports it, and its ratio history, every figure the
 * venue's own with its as-of time. Read-only: nothing is signed, sent or changed.
 *
 * The person's accounts are the ones their own signed actions named (`PreparedActionStore.ownerSignedAccounts`): a
 * founder never types an address. The history is the venue's readings kept by our door (venue-margin-samples.ts), since
 * the venue keeps none. Every read writes one append-only audit row (`venue_accounts.get`) naming the founder and the
 * person before the venue is asked, so a lookup is logged even when the venue is down; the person reads it in their own
 * access list (`staffAccess.mine`). With the user-venue door off the read refuses `trade.user_venue_off`.
 */
import type { Principal } from '@intafaced/auth';
import { VenueRefusalError, encodeVenueWire, type UserVenue, type UserVenueAccount } from '@intafaced/venue-contracts';
import type { PreparedActionStore } from '../venue/prepared-action-store.js';
import { sampleOf, type MarginSampleStore, type VenueMarginSample } from '../venue/venue-margin-samples.js';
import { TradeOpsError, requireOperator, type AuditWrite } from './common.js';

export const VENUE_ACCOUNTS_READ_KIND = 'venue_accounts.get';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface VenueAccountReadDeps {
  readonly audit: (row: AuditWrite, at: Date) => Promise<string>;
  /** The user-venue door's venue; null when the door is off. */
  readonly venue: (() => Promise<UserVenue>) | null;
  readonly store: PreparedActionStore;
  readonly samples: MarginSampleStore;
  readonly now: () => Date;
}

export interface VenueAccountView {
  readonly owner: string;
  readonly subAccount: string | null;
  /** The account's margin now, as the venue reports it; null where the venue reads no margin summary. */
  readonly now: VenueMarginSample | null;
  /** The venue's readings our door kept, newest first. */
  readonly history: readonly VenueMarginSample[];
}

export interface VenueAccountsRead {
  readonly userId: string;
  readonly venueId: string;
  /** The venue's name: the source of every figure here. */
  readonly source: string;
  readonly accounts: readonly VenueAccountView[];
  readonly auditId: string;
}

export async function readVenueAccounts(
  deps: VenueAccountReadDeps,
  principal: Principal,
  input: { userId: string },
): Promise<VenueAccountsRead> {
  requireOperator(principal);
  const userId = input.userId.trim();
  if (!UUID.test(userId)) throw new TradeOpsError('venue_accounts_user_invalid', 'name the person by their user id');
  if (!deps.venue) throw new TradeOpsError('trade.user_venue_off', 'the user-venue door is off: venue accounts cannot be read');
  const auditId = await deps.audit(
    {
      kind: VENUE_ACCOUNTS_READ_KIND,
      operatorId: principal.userId,
      accountId: userId,
      objectId: userId,
      approverId: null,
      reason: null,
    },
    deps.now(),
  );
  try {
    const venue = await deps.venue();
    const venueId = venue.venue.id;
    const signed = await deps.store.ownerSignedAccounts(userId, venueId);
    const accounts: VenueAccountView[] = [];
    for (const s of signed) {
      const account: UserVenueAccount = { venueId, owner: s.owner, subAccount: s.subAccount };
      let now: VenueMarginSample | null = null;
      if (venue.accountSummary) {
        const read = await venue.accountSummary(account);
        await deps.samples.record(account, read);
        now = sampleOf(read);
      }
      accounts.push({ owner: s.owner, subAccount: s.subAccount, now, history: await deps.samples.history(account) });
    }
    return { userId, venueId, source: venue.venue.displayName, accounts, auditId };
  } catch (err) {
    if (err instanceof VenueRefusalError) throw new TradeOpsError(`trade.venue.${err.refusal.code}`, err.refusal.detail);
    throw err;
  }
}

/** The read on the wire: every amount a decimal string, every time an ISO string. */
export const venueAccountsReadWire = (read: VenueAccountsRead): unknown => encodeVenueWire(read);
