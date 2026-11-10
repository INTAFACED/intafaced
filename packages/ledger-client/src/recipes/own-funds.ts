import type { Amount } from '../money.js';
import type { AccountRef, EntryInput, PostRequest } from '../types.js';
import { InvalidEntryError } from '../types.js';
import { isOwnFundsPlace, partnerReserve, treasuryWallet, venueBuilderAccount } from '../accounts.js';

/**
 * OUR OWN FUNDS MOVING BETWEEN OUTSIDE PLACES (launch money model, rule 5; project-state OWNER.md item 288).
 *
 * `ownFundsMove` records INTAFACED's own money leaving one named place and arriving at another: collected builder fees
 * swept from our builder account at a venue to our treasury wallet, or our treasury wallet funding our reserve at a
 * partner. It is keyed on the outside world's own record of the move: the chain transaction, or the partner's statement
 * line (`own-funds-move:<from place>:<reference>`), so the same transfer read twice posts once.
 *
 * - Both sides must be own-funds places (`isOwnFundsPlace`), so no customer account is ever touched and the recipe is not
 *   in the custody-layer inventory.
 * - A move of more than the book shows at the source is refused by the ledger itself (`balanceAllowed`): a place can never
 *   show less than nothing of ours.
 * - Revenue does not change: the money was already ours. Only where it is changes.
 */
export const OWN_FUNDS_MODULE = 'treasury';

/** One of our named places, as a move names it. */
export type OwnFundsPlace =
  | { readonly kind: 'venue-builder-account'; readonly venueId: string }
  | { readonly kind: 'partner-reserve'; readonly partnerId: string }
  | { readonly kind: 'treasury-wallet'; readonly walletId: string };

export interface OwnFundsMoveInput {
  readonly from: OwnFundsPlace;
  readonly to: OwnFundsPlace;
  readonly assetId: string;
  readonly amount: Amount;
  /** The outside record of the move: the chain transaction hash, or the partner's statement line id. */
  readonly reference: string;
}

const PLACE_ID = /^[a-z0-9][a-z0-9:_-]*$/;
const REFERENCE = /^[^\s]+$/;

/** The account a place names. */
export function ownFundsPlaceAccount(place: OwnFundsPlace, assetId: string): AccountRef {
  const id = place.kind === 'venue-builder-account' ? place.venueId : place.kind === 'partner-reserve' ? place.partnerId : place.walletId;
  if (!PLACE_ID.test(id)) throw new InvalidEntryError(`${place.kind} needs a lower-case id, got ${JSON.stringify(id)}`);
  const account =
    place.kind === 'venue-builder-account'
      ? venueBuilderAccount(id, assetId)
      : place.kind === 'partner-reserve'
        ? partnerReserve(id, assetId)
        : treasuryWallet(id, assetId);
  if (!isOwnFundsPlace(account)) throw new InvalidEntryError(`${place.kind} is not an own-funds place`);
  return account;
}

export function ownFundsMoveKey(from: OwnFundsPlace, assetId: string, reference: string): string {
  return `own-funds-move:${ownFundsPlaceAccount(from, assetId).ownerId}:${reference}`;
}

export function ownFundsMove(input: OwnFundsMoveInput): PostRequest {
  if (!input.assetId?.trim() || input.assetId.trim() !== input.assetId) {
    throw new InvalidEntryError('assetId is required, with no surrounding spaces');
  }
  if (typeof input.amount !== 'bigint' || input.amount <= 0n) throw new InvalidEntryError('an own-funds move must be above zero');
  if (!REFERENCE.test(input.reference ?? '')) {
    throw new InvalidEntryError('reference must be the chain transaction or the partner statement line, with no spaces');
  }
  const from = ownFundsPlaceAccount(input.from, input.assetId);
  const to = ownFundsPlaceAccount(input.to, input.assetId);
  if (from.ownerId === to.ownerId) throw new InvalidEntryError('an own-funds move needs two different places');
  const entries: EntryInput[] = [
    // The source's balance comes back toward zero (less of ours there); the destination's goes further below (more there).
    { account: from, direction: 'debit', amount: input.amount },
    { account: to, direction: 'credit', amount: input.amount },
  ];
  return {
    idempotencyKey: ownFundsMoveKey(input.from, input.assetId, input.reference),
    module: OWN_FUNDS_MODULE,
    reason: 'treasury.own_funds.moved',
    meta: { from: from.ownerId, to: to.ownerId, reference: input.reference },
    entries,
  };
}
