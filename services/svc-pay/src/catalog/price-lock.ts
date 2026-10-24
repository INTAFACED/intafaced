import type { Sql } from 'postgres';
import { PayError } from '../payment-service/internal.js';

export interface LockedPrice {
  billing: string;
  kind: string;
  asset_id: string;
  amount: string | null;
}

/**
 * An active price of an active live product of this business, for something new made on it (a subscription, a payment
 * link). Read inside the caller's transaction: the product and price rows are held with FOR SHARE until it ends, product
 * first and then the price, the order Replace price takes them in (product FOR UPDATE, then the price), so the two never
 * wait on each other in a circle. Replace price and archiving the product wait for the caller, and nothing new is made on
 * a price or product archived under it.
 */
export async function lockActiveLivePrice(tx: Sql, merchantId: string, priceId: string): Promise<LockedPrice> {
  const [product] = await tx<Array<{ status: string }>>`
    SELECT p.status FROM pay.catalog_products p
     WHERE p.id = (SELECT pr.product_id FROM pay.catalog_prices pr WHERE pr.id = ${priceId}::uuid AND pr.merchant_id = ${merchantId})
       AND p.mode = 'live'
     FOR SHARE`;
  const [price] = product
    ? await tx<Array<LockedPrice & { status: string }>>`
        SELECT billing, kind, asset_id, amount::text, status FROM pay.catalog_prices
         WHERE id = ${priceId}::uuid AND merchant_id = ${merchantId}
         FOR SHARE`
    : [];
  if (!product || !price) throw new PayError(`Price ${priceId} not found`, 'pay.price_not_found');
  if (product.status !== 'active') throw new PayError(`The product of price ${priceId} is archived`, 'pay.product_archived');
  if (price.status !== 'active') throw new PayError(`Price ${priceId} is archived`, 'pay.price_archived');
  return { billing: price.billing, kind: price.kind, asset_id: price.asset_id, amount: price.amount };
}
