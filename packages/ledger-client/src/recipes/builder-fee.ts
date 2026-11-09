import type { Amount } from '../money.js';
import type { EntryInput, PostRequest } from '../types.js';
import { InvalidEntryError } from '../types.js';
import { houseFees, venueBuilderAccount, venueBuilderFeeReceivable } from '../accounts.js';

/**
 * Our builder fee on a routed venue fill (D-venue-07; OWNER 226 "the ledger posts only our builder fee per venue";
 * OWNER 237). At launch the venue holds the customer's collateral, positions and fills: none of that is posted here. The
 * only money these two recipes move is ours.
 *
 * - `builderFeeEarn`: the fee the venue charged on one fill of one of our users, keyed on the venue's own stable fill id
 *   (`builder-fee:<venueId>:<fillId>`), so a fill read twice posts once. House builder-fee revenue goes up; what the venue
 *   owes us (`venueBuilderFeeReceivable`) goes down by the same amount.
 * - `builderFeeReceive`: the venue pays builder fees out to our builder account there, keyed on the venue's payout id
 *   (`builder-fee-payout:<venueId>:<payoutId>`). The receivable comes back up; our builder account (`venueBuilderAccount`)
 *   records the money now ours at the venue.
 *
 * Neither touches a customer account, so neither is in the custody-layer inventory.
 */
export const BUILDER_FEE_MODULE = 'trade';
/** The house revenue pot for builder fees: `houseFees('builder', <asset>)`, apart from the spot book's own fees. */
export const BUILDER_FEE_POT = 'builder';

const VENUE_ID = /^[a-z0-9][a-z0-9_-]*$/;
const VENUE_REF = /^[^\s:]+$/;

export interface BuilderFeeEarnInput {
  readonly venueId: string;
  /** The venue's own stable trade id for the fill (`UserVenueFill.fillId`). */
  readonly fillId: string;
  /** The venue's fee asset for the fill. */
  readonly assetId: string;
  /** Our builder fee on the fill, as the venue charged it. Must be above zero: a fill with none posts nothing. */
  readonly amount: Amount;
  /** Our user whose venue account made the fill. Recorded for the recon; no entry is on their account. */
  readonly userId: string;
}

export interface BuilderFeeReceiveInput {
  readonly venueId: string;
  /** The venue's own id for the payout. */
  readonly payoutId: string;
  readonly assetId: string;
  readonly amount: Amount;
}

type BuilderFeeAccount = ReturnType<typeof houseFees>;
const debit = (account: BuilderFeeAccount, amount: Amount): EntryInput => ({ account, direction: 'debit', amount });
const credit = (account: BuilderFeeAccount, amount: Amount): EntryInput => ({ account, direction: 'credit', amount });

function requireVenue(venueId: string): void {
  if (!VENUE_ID.test(venueId)) throw new InvalidEntryError(`venueId must be a lower-case venue id, got ${JSON.stringify(venueId)}`);
}
function requireRef(label: string, ref: string): void {
  if (!VENUE_REF.test(ref)) throw new InvalidEntryError(`${label} must be the venue's own id, with no spaces or colons, got ${JSON.stringify(ref)}`);
}
function requireAsset(assetId: string): void {
  if (!assetId?.trim() || assetId.trim() !== assetId) throw new InvalidEntryError('assetId is required, with no surrounding spaces');
}
function requireAmount(label: string, amount: Amount): void {
  if (typeof amount !== 'bigint' || amount <= 0n) throw new InvalidEntryError(`${label} must be above zero; a fill with no builder fee posts nothing`);
}

export function earnedBuilderFeeKey(venueId: string, fillId: string): string {
  return `builder-fee:${venueId}:${fillId}`;
}

export function builderFeePayoutKey(venueId: string, payoutId: string): string {
  return `builder-fee-payout:${venueId}:${payoutId}`;
}

export function builderFeeEarn(input: BuilderFeeEarnInput): PostRequest {
  requireVenue(input.venueId);
  requireRef('fillId', input.fillId);
  requireAsset(input.assetId);
  requireAmount('builder fee', input.amount);
  if (!input.userId?.trim()) throw new InvalidEntryError('userId is required');
  return {
    idempotencyKey: earnedBuilderFeeKey(input.venueId, input.fillId),
    module: BUILDER_FEE_MODULE,
    reason: 'trade.builder_fee.earned',
    meta: { venueId: input.venueId, fillId: input.fillId, userId: input.userId },
    entries: [
      debit(houseFees(BUILDER_FEE_POT, input.assetId), input.amount),
      credit(venueBuilderFeeReceivable(input.venueId, input.assetId), input.amount),
    ],
  };
}

export function builderFeeReceive(input: BuilderFeeReceiveInput): PostRequest {
  requireVenue(input.venueId);
  requireRef('payoutId', input.payoutId);
  requireAsset(input.assetId);
  requireAmount('builder fee payout', input.amount);
  return {
    idempotencyKey: builderFeePayoutKey(input.venueId, input.payoutId),
    module: BUILDER_FEE_MODULE,
    reason: 'trade.builder_fee.received',
    meta: { venueId: input.venueId, payoutId: input.payoutId },
    entries: [
      debit(venueBuilderFeeReceivable(input.venueId, input.assetId), input.amount),
      credit(venueBuilderAccount(input.venueId, input.assetId), input.amount),
    ],
  };
}
