import { createHash } from 'node:crypto';
import type { Sql, TransactionSql } from 'postgres';
import { CATALOG_COPY_MAX_PRODUCTS, CATALOG_COPY_MAX_READ, type CatalogCopy } from '@intafaced/contracts';
import { MerchantOpsError } from '../merchant-ops/errors.js';
import type { MerchantCaller } from '../merchant-ops/roles.js';
import { keyId } from './import.js';
import { assertWriter, isUnique, lockCatalog, requestHash, type ProductRow } from './products.js';

/**
 * Copying the catalogue between test and live (J-merchant-03 step 6, M-adv-payments-core-21).
 *
 * In one transaction, under the target catalogue's lock (`lockCatalog`, shared with imports): every product of the
 * source catalogue is either copied with its active prices, or skipped with its reason. A product that already has a
 * copy in the target is skipped as `copied_before`, so a second copy makes nothing new; one whose product id a product
 * of the target's own already uses is skipped as `id_taken`; an archived one is skipped as `archived`. A copy names its
 * source (`copied_from`, one copy per source and catalogue), and a product that is itself a copy of one in the target is
 * skipped as `copied_before` too. A copy keeps the source's id, name, type, unit, descriptor, event
 * and image, and its prices keep their default mark. Prices added to the source later are not carried over: a copy is
 * made once. The source products are read under a share lock, so none is archived or deleted while it is copied. A copy
 * deleted later can be made again: its create key counts the earlier copies deleted, so each deletion's record stands.
 * Nothing here moves money; a price is a record.
 */

type Mode = 'live' | 'test';

interface SourceRow extends Pick<
  ProductRow,
  | 'id'
  | 'product_key'
  | 'name'
  | 'type'
  | 'unit_label'
  | 'statement_descriptor'
  | 'event_starts_at'
  | 'event_location'
  | 'image_id'
  | 'copied_from'
  | 'status'
> {}

interface SourcePrice {
  id: string;
  product_id: string;
  billing: string;
  kind: string;
  asset_id: string;
  amount: string | null;
  min_amount: string | null;
  max_amount: string | null;
  is_default: boolean;
}

export class CatalogCopier {
  constructor(private readonly sql: Sql) {}

  async copy(caller: MerchantCaller, input: { from: Mode; to: Mode }): Promise<CatalogCopy> {
    assertWriter(caller);
    if (input.from === input.to) throw new MerchantOpsError('pay.catalog_copy_same_mode', 'bad_request');
    const { from, to } = input;
    try {
      return await this.sql.begin(async (tx) => {
        await lockCatalog(tx, caller.merchantId, to);
        const sources = await tx<SourceRow[]>`
          SELECT id, product_key, name, type, unit_label, statement_descriptor, event_starts_at, event_location, image_id,
                 copied_from, status
            FROM pay.catalog_products
           WHERE merchant_id = ${caller.merchantId} AND mode = ${from}
           ORDER BY created_at, id
           LIMIT ${CATALOG_COPY_MAX_READ + 1}
           FOR SHARE`;
        if (sources.length > CATALOG_COPY_MAX_READ) throw new MerchantOpsError('pay.catalog_copy_too_large', 'bad_request');
        const report: CatalogCopy = { from, to, created: [], skipped: [] };
        if (!sources.length) return report;

        const targets = await tx<Array<{ id: string; product_key: string; copied_from: string | null }>>`
          SELECT id, product_key, copied_from FROM pay.catalog_products
           WHERE merchant_id = ${caller.merchantId} AND mode = ${to}
             AND (copied_from = ANY(${tx.array(sources.map((s) => s.id))}::uuid[])
                  OR id = ANY(${tx.array(sources.flatMap((s) => (s.copied_from ? [s.copied_from] : [])))}::uuid[])
                  OR product_key = ANY(${tx.array(sources.map((s) => s.product_key))}::text[]))`;
        const copyOf = new Map(targets.filter((t) => t.copied_from).map((t) => [t.copied_from!, t.id]));
        const keyHolder = new Map(targets.map((t) => [t.product_key, t.id]));
        const inTarget = new Set(targets.map((t) => t.id));

        const fresh: SourceRow[] = [];
        for (const source of sources) {
          const skip = (reason: CatalogCopy['skipped'][number]['reason'], productId: string | null) =>
            report.skipped.push({ sourceId: source.id, productKey: source.product_key, name: source.name, reason, productId });
          if (copyOf.has(source.id)) skip('copied_before', copyOf.get(source.id)!);
          // A product that is itself the copy of one in the target catalogue goes back to where it came from: not again.
          else if (source.copied_from && inTarget.has(source.copied_from)) skip('copied_before', source.copied_from);
          else if (source.status !== 'active') skip('archived', null);
          else if (keyHolder.has(source.product_key)) skip('id_taken', keyHolder.get(source.product_key)!);
          else fresh.push(source);
        }
        if (!fresh.length) return report;
        if (fresh.length > CATALOG_COPY_MAX_PRODUCTS) throw new MerchantOpsError('pay.catalog_copy_too_large', 'bad_request');

        const keys = await this.createKeys(tx, caller.merchantId, to, fresh);
        const values = fresh.map((source) => {
          const requestId = keys.get(source.id)!;
          const event =
            source.event_starts_at && source.event_location
              ? { startsAt: source.event_starts_at.toISOString(), location: source.event_location }
              : undefined;
          return {
            merchant_id: caller.merchantId,
            mode: to,
            product_key: source.product_key,
            request_id: requestId,
            request_hash: requestHash({
              requestId,
              mode: to,
              productKey: source.product_key,
              name: source.name,
              type: source.type,
              ...(source.unit_label ? { unitLabel: source.unit_label } : {}),
              ...(source.statement_descriptor ? { statementDescriptor: source.statement_descriptor } : {}),
              ...(event ? { event } : {}),
              ...(source.image_id ? { imageId: source.image_id } : {}),
            }),
            name: source.name,
            type: source.type,
            unit_label: source.unit_label,
            statement_descriptor: source.statement_descriptor,
            event_starts_at: source.event_starts_at,
            event_location: source.event_location,
            image_id: source.image_id,
            copied_from: source.id,
            created_by: caller.userId,
          };
        });
        const made = await tx<Array<{ id: string; copied_from: string }>>`
          INSERT INTO pay.catalog_products ${tx(values)} RETURNING id, copied_from`;
        const copyId = new Map(made.map((row) => [row.copied_from, row.id]));

        const prices = await tx<SourcePrice[]>`
          SELECT id, product_id, billing, kind, asset_id, amount::text, min_amount::text, max_amount::text, is_default
            FROM pay.catalog_prices
           WHERE merchant_id = ${caller.merchantId} AND status = 'active'
             AND product_id = ANY(${tx.array(fresh.map((s) => s.id))}::uuid[])
           ORDER BY created_at, id`;
        if (prices.length) {
          const rows = prices.map((price) => {
            const productId = copyId.get(price.product_id)!;
            return {
              merchant_id: caller.merchantId,
              product_id: productId,
              request_id: keyId(`catalog-copy-price:${caller.merchantId}:${price.id}:${productId}`),
              request_hash: createHash('sha256')
                .update(JSON.stringify({ copiedFrom: price.id, productId }))
                .digest('hex'),
              billing: price.billing,
              kind: price.kind,
              asset_id: price.asset_id,
              amount: price.amount,
              min_amount: price.min_amount,
              max_amount: price.max_amount,
              is_default: price.is_default,
              created_by: caller.userId,
            };
          });
          await tx`INSERT INTO pay.catalog_prices ${tx(rows)}`;
        }
        const priceCount = new Map<string, number>();
        for (const price of prices) priceCount.set(price.product_id, (priceCount.get(price.product_id) ?? 0) + 1);
        for (const source of fresh)
          report.created.push({
            sourceId: source.id,
            productId: copyId.get(source.id)!,
            productKey: source.product_key,
            name: source.name,
            prices: priceCount.get(source.id) ?? 0,
          });
        return report;
      });
    } catch (err) {
      // A product made with a plain create took one of these ids after the check: nothing was written, so the copy can
      // simply be run again and will skip it.
      if (isUnique(err, 'catalog_products_key_once')) throw new MerchantOpsError('pay.catalog_copy_conflict', 'conflict');
      throw err;
    }
  }

  /**
   * Each copy's create key: the source, the target catalogue and how many earlier copies of it there were deleted. A
   * key a deletion already recorded moves on to the next count, so a copy made again never reuses a deleted one's key.
   */
  private async createKeys(tx: TransactionSql, merchantId: string, to: Mode, fresh: SourceRow[]) {
    const generation = new Map(fresh.map((source) => [source.id, 0]));
    const key = (sourceId: string) => keyId(`catalog-copy:${merchantId}:${sourceId}:${to}:${generation.get(sourceId)}`);
    let open = fresh.map((source) => source.id);
    while (open.length) {
      const gone = await tx<Array<{ request_id: string }>>`
        SELECT request_id::text FROM pay.catalog_product_tombstones
         WHERE merchant_id = ${merchantId} AND request_id = ANY(${tx.array(open.map(key))}::uuid[])`;
      const deleted = new Set(gone.map((row) => row.request_id));
      open = open.filter((sourceId) => deleted.has(key(sourceId)));
      for (const sourceId of open) generation.set(sourceId, generation.get(sourceId)! + 1);
    }
    return new Map(fresh.map((source) => [source.id, key(source.id)]));
  }
}
