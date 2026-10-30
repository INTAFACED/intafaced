import type { PayCustodyOpenItem, PayCustodyOpenItemsReply, PayCustodyOpenItemSum } from '@intafaced/contracts/pay-custody-deposit';

/**
 * Open custody items, as svc-pay's `founderAdmin.depositOpenItems.list` answers them (OPS-reconciliation-02): what custody holds
 * that the ledger has not credited, and what the ledger credited that the chain took back and no balance could cover. These are
 * two of the reasons custody and the ledger can differ (not review rows); the reconciliation reads the same list. Read-only: this desk resolves nothing here.
 * Pure, so the server loader and the page share it.
 */

export type OpenItems = PayCustodyOpenItemsReply;
export type OpenItem = PayCustodyOpenItem;
export type OpenItemSum = PayCustodyOpenItemSum;

/** How many items the page asks for. A reading window, not a product limit: the page says how many of how many it shows. */
export const OPEN_ITEMS_WINDOW = 50;

export const OPEN_ITEM_KIND_LABEL: Readonly<Record<OpenItem['kind'], string>> = {
  held: 'Held, not credited',
  reversal_unfunded: 'Taken back by the chain, not covered',
};

/** Why an item is open, in words. Unknown reasons are shown as their code rather than guessed at. */
const REASON_LABEL: Readonly<Record<string, string>> = {
  below_minimum: 'under the minimum deposit',
  address_expired: 'sent to an expired address',
  address_frozen: 'sent to a frozen address',
  travel_rule_declaration: 'waiting for the travel-rule declaration',
  travel_rule_review: 'travel rule under review',
  travel_rule_counterparty: 'travel rule waiting on the sending platform',
  travel_rule_expired: 'travel rule wait ran out (still held)',
  reversal_unfunded: 'the credited funds were already spent',
};

export function openItemWhy(item: Pick<OpenItem, 'status' | 'reason'>): string {
  if (item.reason) return REASON_LABEL[item.reason] ?? item.reason;
  return item.status === 'held_for_screening' ? 'held for screening' : item.status;
}

/** One line per network and asset: custody minus ledger, and what it is made of. */
export function sumLine(sum: OpenItemSum): string {
  const parts = [`held ${sum.held} (${sum.heldCount})`, `not covered ${sum.reversalUnfunded} (${sum.reversalUnfundedCount})`];
  return `${sum.assetId} on ${sum.networkId}: custody minus ledger ${sum.net} — ${parts.join(', ')}`;
}

/** "Showing 3 of 3" or "Showing 50 of 120": never a silent cut. */
export function shownLine(reply: Pick<OpenItems, 'items' | 'total'>): string {
  return `Showing ${reply.items.length} of ${reply.total}.`;
}
