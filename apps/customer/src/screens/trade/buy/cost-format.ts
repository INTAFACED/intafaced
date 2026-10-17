import { fmtAmount, fmtUsd } from './deps';
import type { CostRows } from './cost';

/**
 * The "You get about" text, shared by the card (CostBlock) and the review dialog (BuyReview) so the two cannot drift:
 * money -> dollars; coins after a fee in those coins -> "{amount} {coin} after the fee"; coins with the fee paid
 * elsewhere -> the full amount. Null when it is not known yet (the caller shows "—").
 */
export function formatGet(
  get: CostRows['get'],
  baseAsset: string,
  places: number,
  t: (key: '{amount} {coin} after the fee', params: { amount: string; coin: string }) => string,
): string | null {
  if (get === null) return null;
  if (get.kind === 'money') return fmtUsd(get.amount);
  if (get.afterFee) return t('{amount} {coin} after the fee', { amount: fmtAmount(get.amount, { places: 8 }), coin: baseAsset });
  return `${fmtAmount(get.amount, { places })} ${baseAsset}`;
}
