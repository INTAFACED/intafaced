import type { Sql } from 'postgres';
import { formatAmount, parseAmount, type Amount } from '@intafaced/ledger-client';
import { lockActiveLivePrice } from './catalog/price-lock.js';
import { PayError } from './payment-service/internal.js';

/**
 * The catalogue price a new payment link sells (M-catalogue-03, J-merchant-04 step 2).
 *
 * The price must be the business's own, active, on an active live product, and a one-time fixed price: a link takes one
 * payment of one amount, so a monthly price or one the customer chooses would be a label that lies. What the link charges
 * is the price's amount and asset. An amount or asset the caller sent too must be the price's.
 *
 * Read inside the caller's transaction, which `lockActiveLivePrice` holds the product and price in until it ends, so a link
 * is never made on a price or product archived under it.
 */
export async function linkPrice(
  tx: Sql,
  merchantId: string,
  priceId: string,
  sent: { amount?: Amount | undefined; currency?: string | undefined },
): Promise<{ amount: Amount; currency: string }> {
  const price = await lockActiveLivePrice(tx, merchantId, priceId);
  if (price.billing !== 'one_time' || price.kind !== 'fixed' || price.amount === null)
    throw new PayError('A payment link sells a one-time fixed price. Nothing was written.', 'pay.link_price_not_one_time');
  const amount = parseAmount(price.amount);
  if ((sent.amount !== undefined && sent.amount !== amount) || (sent.currency !== undefined && sent.currency !== price.asset_id))
    throw new PayError(
      `The link's amount and asset must be its price's (${formatAmount(amount)} ${price.asset_id}). Nothing was written.`,
      'pay.link_price_terms_differ',
    );
  return { amount, currency: price.asset_id };
}
