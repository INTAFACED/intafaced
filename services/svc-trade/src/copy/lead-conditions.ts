/**
 * The two outside reads that applying to lead is measured by (CB-copy-12, J-copy-bots-otc-04 #1): whom the person follows
 * now, from svc-trade's own follows and leader directory, and the USDC of the person's own venue account, as the venue
 * reports it. Which venue accounts are the person's: those whose owner wallet signed an action this person prepared
 * through the user-venue door (`PreparedActionStore.ownerSignedAccounts`, as `venue.ownActivity` reads them). Nothing is
 * stored and nothing moves.
 */
import { ZERO } from '@intafaced/ledger-client/money';
import { isTestVenue, type UserVenue } from '@intafaced/venue-contracts';
import type { PreparedActionStore } from '../venue/prepared-action-store.js';
import { followRelationshipState } from './copy-lifecycle.js';
import type { CopyFollowStore } from './follow-store.js';
import type { LeaderDirectory } from './leader-directory.js';
import type { LeadFollowing, LeadVenueRead } from './lead-applications.js';

/** The asset a lead's venue balance is measured in. */
export const LEAD_BALANCE_ASSET = 'USDC';

/** The first leader this person follows and has not left, by its listing; null when they follow no one. */
export async function leadFollowing(
  deps: { follows: Pick<CopyFollowStore, 'listFollowsByFollower'>; directory: Pick<LeaderDirectory, 'listingName'> },
  userId: string,
): Promise<LeadFollowing | null> {
  const follows = (await deps.follows.listFollowsByFollower(userId))
    .filter((f) => followRelationshipState(f) !== 'DETACHED')
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.followId.localeCompare(b.followId));
  const first = follows[0];
  if (!first) return null;
  const listing = await deps.directory.listingName(first.leaderId);
  // A follow outlives a listing that was removed: the leader is still followed, and named as no longer listed.
  return listing ?? { leaderRef: null, displayName: 'a leader no longer listed' };
}

/**
 * The USDC of the person's richest own venue account (main or sub-account), with the venue's as-of time. The door off
 * reads `off`; no account their wallet signed for reads `none`. A venue that does not answer throws.
 */
export async function leadVenueUsdc(
  deps: { venue: (() => Promise<UserVenue>) | null; store: Pick<PreparedActionStore, 'ownerSignedAccounts'> },
  userId: string,
): Promise<LeadVenueRead> {
  if (!deps.venue) return { state: 'off' };
  const venue = await deps.venue();
  const venueId = venue.venue.id;
  const owned = await deps.store.ownerSignedAccounts(userId, venueId);
  if (owned.length === 0) return { state: 'none' };
  let best: { owner: string; usdc: bigint; asOf: Date } | null = null;
  for (const { owner, subAccount } of owned) {
    const read = await venue.balances({ venueId, owner, subAccount });
    const usdc = read.value.find((b) => b.asset === LEAD_BALANCE_ASSET)?.total ?? ZERO;
    if (!best || usdc > best.usdc) best = { owner, usdc, asOf: read.asOf };
  }
  return { state: 'read', owner: best!.owner, test: isTestVenue(venue.venue), usdc: best!.usdc, asOf: best!.asOf };
}
