import { venueBound } from '@intafaced/contracts/venue-price';
import { formatAmount, parseAmount, ZERO, type Amount } from '@intafaced/ledger-client/money';

/**
 * A worst price svc-trade computes from `reference` (a best price, the mark or the mid), on the venue's price rule
 * (`@intafaced/contracts/venue-price`, the one rounding the desk uses too): the tick and 5 significant figures, toward
 * the market unless that would leave no room past the reference. Nothing above zero stays zero, for the caller's own
 * "no price" answer.
 */
export function venueBoundPrice(
  side: 'buy' | 'sell',
  { moved, reference, tick }: { moved: Amount; reference: Amount; tick: Amount },
): Amount {
  if (moved <= ZERO || reference <= ZERO) return ZERO;
  return parseAmount(venueBound(side, { moved: formatAmount(moved), reference: formatAmount(reference), tick: formatAmount(tick) }));
}
