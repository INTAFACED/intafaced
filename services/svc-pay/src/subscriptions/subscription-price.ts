import type { Sql } from 'postgres';
import { parseAmount } from '@intafaced/ledger-client';
import { PayError } from '../payment-service.js';
import { lockActiveLivePrice } from '../catalog/price-lock.js';

/**
 * The catalogue price a new subscription starts on (M-adv-payments-core-20, J-merchant-03 step 4).
 *
 * The price must be the mandate's business's own, active, on an active live product, a fixed monthly price, and its
 * asset and amount must be the mandate's with a monthly mandate: what the subscription charges is the mandate's amount,
 * so a price that said anything else would be a label that lies. The mandate's terms are read inside the caller's
 * transaction, which holds the mandate's row lock; the price and product are held by `lockActiveLivePrice` until it ends.
 */
export async function subscriptionPrice(tx: Sql, merchantId: string, priceId: string, mandate: { id: string }): Promise<void> {
  const [terms] = await tx<Array<{ asset_id: string; amount: string; cadence: string }>>`
    SELECT asset_id, amount::text, cadence FROM pay.subscription_mandates WHERE id = ${mandate.id}`;
  const price = await lockActiveLivePrice(tx, merchantId, priceId);
  if (!terms) throw new PayError(`Price ${priceId} not found`, 'pay.price_not_found');
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
