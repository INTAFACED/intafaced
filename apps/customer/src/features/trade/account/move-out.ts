import { parseAmount } from '../../../shared/money';

/**
 * Why a move out of the trading account can't start, or null when it can (J-derivatives-25 #10): `amount` when the typed
 * amount is not a positive decimal (`asked` is its canonical form, null when it is not one), `unreported` when the venue
 * reports no withdrawable figure, `above` when the amount is more than that figure. The figure is the venue's own: what a
 * withdrawal of exactly it is accepted at, its fee already counted, so nothing is added to it here.
 */
export function moveOutRefusal(asked: string | null, withdrawable: string | null): 'amount' | 'unreported' | 'above' | null {
  if (asked === null) return 'amount';
  const units = parseAmount(asked);
  if (units <= 0n) return 'amount';
  if (withdrawable === null) return 'unreported';
  return units > parseAmount(withdrawable) ? 'above' : null;
}
