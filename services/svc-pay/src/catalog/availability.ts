import type { Sql } from 'postgres';
import type { ProductAvailability, SaleChannel } from '@intafaced/contracts';
import { MerchantOpsError } from '../merchant-ops/errors.js';
import { assertPermission, type MerchantCaller } from '../merchant-ops/roles.js';
import { storeNotFound } from '../stores/stores.js';
import { assertWriter, productNotFound, UUID } from './products.js';

/**
 * Where each product is sold (M-adv-payments-core-21 channel availability, J-merchant-03 step 6). A product is sold in
 * every store of its business and every channel until the business turns one off, which is one row in
 * `pay.catalog_product_unavailable`; turning it back on deletes that row. A store's availability changes only while
 * the store is open. A price check for a store and channel the product is not sold in refuses there
 * (`ProductPrices.quote`); a sale that names no store (a subscription, a link) is not limited by it. A copy between the
 * test and live catalogues carries where its source is not sold. Nothing here moves money.
 */
export class ProductAvailabilities {
  constructor(private readonly sql: Sql) {}

  /** Every store of the business, archived ones too, in the order they were added, with each channel on or off. */
  async get(caller: MerchantCaller, productId: string): Promise<ProductAvailability> {
    assertPermission(caller, 'products.read');
    if (!UUID.test(productId)) throw productNotFound();
    const sql = this.sql;
    const [product] = await sql`
      SELECT 1 FROM pay.catalog_products WHERE id = ${productId}::uuid AND merchant_id = ${caller.merchantId}`;
    if (!product) throw productNotFound();
    const rows = await sql<Array<{ id: string; name: string; status: 'active' | 'archived'; off: SaleChannel[] }>>`
      SELECT s.id, s.name, s.status,
             coalesce(array_agg(u.channel) FILTER (WHERE u.channel IS NOT NULL), '{}')::text[] AS off
        FROM pay.stores s
        LEFT JOIN pay.catalog_product_unavailable u ON u.store_id = s.id AND u.product_id = ${productId}::uuid
       WHERE s.merchant_id = ${caller.merchantId}
       GROUP BY s.id
       ORDER BY s.created_at, s.id`;
    return {
      productId,
      stores: rows.map((row) => ({
        storeId: row.id,
        name: row.name,
        status: row.status,
        channels: {
          online: !row.off.includes('online'),
          in_person: !row.off.includes('in_person'),
          invoice: !row.off.includes('invoice'),
        },
      })),
    };
  }

  /** Sell the product in one store and channel, or stop. Setting what is already set changes nothing. */
  async set(
    caller: MerchantCaller,
    input: { productId: string; storeId: string; channel: SaleChannel; sold: boolean },
  ): Promise<ProductAvailability> {
    assertWriter(caller);
    if (!UUID.test(input.productId)) throw productNotFound();
    // The store and the product are held for the change (FOR SHARE), so an archive of the store or a delete of the
    // product waits for it instead of landing in between.
    await this.sql.begin(async (tx) => {
      const [store] = await tx<Array<{ status: 'active' | 'archived' }>>`
        SELECT status FROM pay.stores WHERE id = ${input.storeId}::uuid AND merchant_id = ${caller.merchantId} FOR SHARE`;
      if (!store) throw storeNotFound();
      if (store.status !== 'active') throw new MerchantOpsError('pay.store_archived', 'precondition');
      const [product] = await tx`
        SELECT 1 FROM pay.catalog_products WHERE id = ${input.productId}::uuid AND merchant_id = ${caller.merchantId} FOR SHARE`;
      if (!product) throw productNotFound();
      if (input.sold)
        await tx`
          DELETE FROM pay.catalog_product_unavailable
           WHERE product_id = ${input.productId}::uuid AND store_id = ${input.storeId}::uuid AND channel = ${input.channel}`;
      else
        await tx`
          INSERT INTO pay.catalog_product_unavailable (product_id, store_id, channel, set_by)
          VALUES (${input.productId}::uuid, ${input.storeId}::uuid, ${input.channel}, ${caller.userId})
          ON CONFLICT (product_id, store_id, channel) DO NOTHING`;
    });
    return this.get(caller, input.productId);
  }
}
