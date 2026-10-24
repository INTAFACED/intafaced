import type { Sql } from 'postgres';
import { parseAmount } from '@intafaced/ledger-client';
import { PayError } from '../payment-service.js';

/**
 * The catalogue price a new subscription starts on (M-adv-payments-core-20, J-merchant-03 step 4).
 *
 * The price must be the mandate's business's own, active, on an active live product, a fixed monthly price, and its
 * asset and amount must be the mandate's with a monthly mandate: what the subscription charges is the mandate's amount,
 * so a price that said anything else would be a label that lies. The mandate's terms are read inside the caller's
 * transaction, which holds the mandate's row lock. The price and product rows are held with FOR SHARE until that
 * transaction ends, so Replace price (which archives the price under FOR UPDATE) and archiving the product (an UPDATE of
 * its row) wait for the subscription, and a subscription never starts on a price or product archived under it.
 */
export async function subscriptionPrice(tx: Sql, merchantId: string, priceId: string, mandate: { id: string }): Promise<void> {
  const [terms] = await tx<Array<{ asset_id: string; amount: string; cadence: string }>>`
    SELECT asset_id, amount::text, cadence FROM pay.subscription_mandates WHERE id = ${mandate.id}`;
  // Product first, then price: the order Replace price takes them in (product FOR UPDATE, then the price), so the two
  // never wait on each other in a circle.
  const [product] = await tx<Array<{ status: string }>>`
    SELECT p.status FROM pay.catalog_products p
     WHERE p.id = (SELECT pr.product_id FROM pay.catalog_prices pr WHERE pr.id = ${priceId}::uuid AND pr.merchant_id = ${merchantId})
       AND p.mode = 'live'
     FOR SHARE`;
  const [price] = product
    ? await tx<Array<{ billing: string; kind: string; asset_id: string; amount: string | null; status: string }>>`
        SELECT billing, kind, asset_id, amount::text, status FROM pay.catalog_prices
         WHERE id = ${priceId}::uuid AND merchant_id = ${merchantId}
         FOR SHARE`
    : [];
  if (!terms || !product || !price) throw new PayError(`Price ${priceId} not found`, 'pay.price_not_found');
  if (product.status !== 'active') throw new PayError(`The product of price ${priceId} is archived`, 'pay.product_archived');
  if (price.status !== 'active') throw new PayError(`Price ${priceId} is archived`, 'pay.price_archived');
  const same =
    price.billing === 'monthly' &&
    price.kind === 'fixed' &&
    price.amount !== null &&
    terms.cadence === 'monthly' &&
    price.asset_id === terms.asset_id &&
    parseAmount(price.amount) === parseAmount(terms.amount);
  if (!same)
    throw new PayError(
      'A subscription starts on a monthly fixed price whose asset and amount are the monthly mandate’s. Nothing was written.',
      'pay.subscription_price_terms_differ',
    );
}
