import type { Amount } from '../money.js';
import type { AccountRef, EntryInput, PostRequest } from '../types.js';
import { InvalidEntryError } from '../types.js';
import { isOwnFundsPlace, ownFundsCostAccount, partnerReserve, treasuryWallet, venueBuilderAccount } from '../accounts.js';

/**
 * OUR OWN FUNDS MOVING BETWEEN OUTSIDE PLACES (launch money model, rule 1; project-state OWNER.md item 288).
 *
 * `ownFundsMove` records INTAFACED's own money leaving one named place and arriving at another: collected builder fees
 * swept from our builder account at a venue to our treasury wallet, or our treasury wallet funding our reserve at a
 * partner. It is keyed on the outside world's own record of the move: the chain transaction, or the partner's statement
 * line (`own-funds-move:<from place>:<asset>:<reference>`), so the same transfer read twice posts once, and one transaction
 * that moves two assets posts two moves.
 *
 * - Both sides must be own-funds places (`isOwnFundsPlace`), so no customer account is ever touched and the recipe is not
 *   in the custody-layer inventory.
 * - A move of more than the book shows at the source is refused by the ledger itself (`balanceAllowed`): a place can never
 *   show less than nothing of ours.
 * - Revenue does not change: the money was already ours. Only where it is changes.
 * - What a move cost, as the outside record states it (`costs`: the venue's withdrawal fee, the network fee taken from what
 *   arrived), leaves the source in the same entry, to an `ownFundsCostAccount` per cost and payee. `amount` is what arrived
 *   at the destination, so the source comes down by `amount` plus every cost and the book keeps matching the outside
 *   record at both places (rule 6: nothing is left for a person to make agree).
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
  /** What the move cost, from the same outside record. Absent or empty: it cost nothing in this asset. */
  readonly costs?: readonly OwnFundsMoveCost[];
}

/** One cost of a move, as its outside record states it, in the moved asset. */
export interface OwnFundsMoveCost {
  readonly kind: 'venue-withdrawal-fee' | 'network-fee';
  /** Who was paid: the venue id, or the chain network's name. Lower case, no spaces. */
  readonly paidTo: string;
  readonly amount: Amount;
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
  return `own-funds-move:${ownFundsPlaceAccount(from, assetId).ownerId}:${assetId}:${reference}`;
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
  const costs = input.costs ?? [];
  const seen = new Set<string>();
  let costTotal = 0n;
  const costEntries: EntryInput[] = costs.map((cost) => {
    if (cost.kind !== 'venue-withdrawal-fee' && cost.kind !== 'network-fee') {
      throw new InvalidEntryError('a cost is a venue-withdrawal-fee or a network-fee');
    }
    if (!PLACE_ID.test(cost.paidTo ?? '')) throw new InvalidEntryError('a cost names who was paid, in lower case with no spaces');
    if (typeof cost.amount !== 'bigint' || cost.amount <= 0n)
      throw new InvalidEntryError('a cost must be above zero; leave out one that is zero');
    const name = `${cost.kind}:${cost.paidTo}`;
    if (seen.has(name)) throw new InvalidEntryError(`a move names each cost once (${name} twice)`);
    seen.add(name);
    costTotal += cost.amount;
    return { account: ownFundsCostAccount(cost.kind, cost.paidTo, input.assetId), direction: 'credit', amount: cost.amount };
  });
  const entries: EntryInput[] = [
    // The source's balance comes back toward zero (less of ours there) by what arrived and what it cost; the destination's
    // goes further below (more there) by what arrived; each cost's account goes further below by what it took.
    { account: from, direction: 'debit', amount: input.amount + costTotal },
    { account: to, direction: 'credit', amount: input.amount },
    ...costEntries,
  ];
  return {
    idempotencyKey: ownFundsMoveKey(input.from, input.assetId, input.reference),
    module: OWN_FUNDS_MODULE,
    reason: 'treasury.own_funds.moved',
    meta: {
      from: from.ownerId,
      to: to.ownerId,
      reference: input.reference,
      ...(costs.length > 0 ? { costs: costs.map((c) => ({ kind: c.kind, paidTo: c.paidTo, amount: c.amount.toString() })) } : {}),
    },
    entries,
  };
}
