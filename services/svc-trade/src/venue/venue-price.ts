import { onVenuePriceRule } from '@intafaced/contracts/venue-price';
import { formatAmount, parseAmount, ZERO, type Amount } from '@intafaced/ledger-client/money';

/**
 * A price svc-trade computes, on the venue's price rule (`@intafaced/contracts/venue-price`, the one rounding the desk
 * uses too): the tick and 5 significant figures, moved `toward` the market (a buy's cap down, a sell's floor up).
 * Nothing above zero stays zero, for the caller's own "no price" answer.
 */
export function venuePrice(price: Amount, tick: Amount, toward: 'up' | 'down'): Amount {
  if (price <= ZERO) return ZERO;
  return parseAmount(onVenuePriceRule(formatAmount(price), formatAmount(tick), toward));
}
