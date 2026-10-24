import { createHash } from 'node:crypto';
import type { Sql, TransactionSql } from 'postgres';
import { formatAmount, parseAmount } from '@intafaced/ledger-client';
import type { MerchantPrice, PriceCreateInput, PriceQuote } from '@intafaced/contracts';
import { MerchantOpsError } from '../merchant-ops/errors.js';
import { iso, money } from '../merchant-ops/money.js';
import { decodeCursor, encodeCursor, requireLimit, toPage } from '../merchant-ops/pagination.js';
import { assertPermission, type MerchantCaller } from '../merchant-ops/roles.js';
import { assertWriter, isUnique, productNotFound, UUID } from './products.js';

/**
 * Prices on catalogue products (M-catalogue-02, J-merchant-03 step 3).
 *
 * Scoped like the products: the caller's own business, `products.read` to read and quote, `products.manage` from an
 * interactive session to add a price or move the default. A price is a fixed amount of one asset, charged once or every
 * month, or a customer-chosen amount between the business's own minimum and maximum (one-time only; both bounds are
 * required). The first active price of a product is its default; setting another as default moves the mark in one
 * transaction, under the product's row lock, so a product never has two. A price is never edited: replacing one is a new
 * price (M-adv-payments-core-20). Nothing here moves money; a quote only says what a price would charge.
 */

const MODE = 'live' as const;

interface PriceRow {
  id: string;
  product_id: string;
  request_hash: string;
  billing: MerchantPrice['billing'];
  kind: MerchantPrice['kind'];
  asset_id: string;
  amount: string | null;
  min_amount: string | null;
  max_amount: string | null;
  is_default: boolean;
  status: 'active' | 'archived';
  created_by: string;
  created_at: Date;
  cursor_ts: string;
}

const FIELDS = (sql: Sql | TransactionSql) => sql`
  id, product_id, request_hash, billing, kind, asset_id, amount::text, min_amount::text, max_amount::text, is_default,
  status, created_by, created_at, to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_ts`;

const optionalMoney = (value: string | null) => (value === null ? null : money(value));

const view = (row: PriceRow): MerchantPrice => ({
  id: row.id,
  productId: row.product_id,
  billing: row.billing,
  kind: row.kind,
  assetId: row.asset_id,
  amount: optionalMoney(row.amount),
  minAmount: optionalMoney(row.min_amount),
  maxAmount: optionalMoney(row.max_amount),
  isDefault: row.is_default,
  status: row.status,
  createdAt: iso(row.created_at),
  createdBy: row.created_by,
});

const priceNotFound = () => new MerchantOpsError('pay.price_not_found', 'not_found');

/** A typed decimal amount as the ledger's scaled bigint; zero or less is not an amount. */
function positive(raw: string): bigint {
  let value: bigint;
  try {
    value = parseAmount(raw);
  } catch {
    throw new MerchantOpsError('pay.price_amount_invalid', 'bad_request');
  }
  if (value <= 0n) throw new MerchantOpsError('pay.price_amount_invalid', 'bad_request');
  return value;
}

/** The checked amounts of a create, written back in canonical form. */
function amountsOf(input: PriceCreateInput): { amount: string | null; min: string | null; max: string | null } {
  if (input.kind === 'fixed') {
    if (input.minAmount !== undefined || input.maxAmount !== undefined)
      throw new MerchantOpsError('pay.price_bounds_not_fixed', 'bad_request');
    if (input.amount === undefined) throw new MerchantOpsError('pay.price_amount_required', 'bad_request');
    return { amount: formatAmount(positive(input.amount)), min: null, max: null };
  }
  if (input.billing !== 'one_time') throw new MerchantOpsError('pay.price_customer_chosen_one_time', 'bad_request');
  if (input.amount !== undefined) throw new MerchantOpsError('pay.price_amount_not_chosen', 'bad_request');
  if (input.minAmount === undefined || input.maxAmount === undefined)
    throw new MerchantOpsError('pay.price_bounds_required', 'bad_request');
  const min = positive(input.minAmount);
  const max = positive(input.maxAmount);
  if (max < min) throw new MerchantOpsError('pay.price_bounds_invalid', 'bad_request');
  return { amount: null, min: formatAmount(min), max: formatAmount(max) };
}

/** What a create asked for, in canonical form, so a replay can tell the same request from a reused id. */
function requestHash(input: PriceCreateInput, amounts: { amount: string | null; min: string | null; max: string | null }): string {
  const canonical = {
    productId: input.productId.toLowerCase(),
    billing: input.billing,
    kind: input.kind,
    assetId: input.assetId,
    ...amounts,
  };
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

export class ProductPrices {
  constructor(private readonly sql: Sql) {}

  /** A product's prices, oldest first, archived ones included so old documents still resolve. */
  async list(caller: MerchantCaller, input: { productId: string; limit?: number | undefined; cursor?: string | undefined }) {
    assertPermission(caller, 'products.read');
    const limit = requireLimit(input.limit);
    const after = decodeCursor(input.cursor);
    if (after && !UUID.test(after.key)) throw new MerchantOpsError('pay.cursor_invalid', 'bad_request');
    await this.product(this.sql, caller, input.productId);
    const sql = this.sql;
    const rows = await sql<PriceRow[]>`
      SELECT ${FIELDS(sql)} FROM pay.catalog_prices
       WHERE merchant_id = ${caller.merchantId} AND product_id = ${input.productId}::uuid
         ${after ? sql`AND (created_at, id) > ((${after.ts}::text)::timestamptz, ${after.key}::uuid)` : sql``}
       ORDER BY created_at, id
       LIMIT ${limit + 1}`;
    return toPage(rows, limit, view, (row) => encodeCursor(row.cursor_ts, row.id));
  }

  /**
   * Add a price to an active product. The product's first active price becomes its default. The same request id with
   * the same details answers with the price it made; with other details it is refused.
   */
  async create(caller: MerchantCaller, input: PriceCreateInput): Promise<{ price: MerchantPrice; replayed: boolean }> {
    assertWriter(caller);
    const amounts = amountsOf(input);
    const hash = requestHash(input, amounts);
    const replay = await this.replay(this.sql, caller, input.requestId, hash);
    if (replay) return { price: replay, replayed: true };
    try {
      return await this.sql.begin(async (tx) => {
        const product = await this.product(tx, caller, input.productId, true);
        if (product.status !== 'active') throw new MerchantOpsError('pay.product_archived', 'precondition');
        const [current] = await tx<Array<{ id: string }>>`
          SELECT id FROM pay.catalog_prices WHERE product_id = ${input.productId}::uuid AND is_default`;
        const rows = await tx<PriceRow[]>`
          INSERT INTO pay.catalog_prices
            (merchant_id, product_id, request_id, request_hash, billing, kind, asset_id, amount, min_amount, max_amount,
             is_default, created_by)
          VALUES
            (${caller.merchantId}, ${input.productId}::uuid, ${input.requestId}::uuid, ${hash}, ${input.billing}, ${input.kind},
             ${input.assetId}, ${amounts.amount}::numeric, ${amounts.min}::numeric, ${amounts.max}::numeric, ${!current},
             ${caller.userId})
          RETURNING ${FIELDS(tx)}`;
        return { price: view(rows[0]!), replayed: false };
      });
    } catch (err) {
      if (isUnique(err, 'catalog_prices_request_once')) {
        // The same request won a race with this one: answer as its replay.
        const raced = await this.replay(this.sql, caller, input.requestId, hash);
        if (raced) return { price: raced, replayed: true };
      }
      throw err;
    }
  }

  /** Make one active price the product's default, taking the mark off the one that had it. Setting it twice is a no-op. */
  async setDefault(caller: MerchantCaller, input: { productId: string; priceId: string }): Promise<MerchantPrice> {
    assertWriter(caller);
    return this.sql.begin(async (tx) => {
      await this.product(tx, caller, input.productId, true);
      const [price] = await tx<PriceRow[]>`
        SELECT ${FIELDS(tx)} FROM pay.catalog_prices
         WHERE id = ${input.priceId}::uuid AND product_id = ${input.productId}::uuid AND merchant_id = ${caller.merchantId}`;
      if (!price) throw priceNotFound();
      if (price.status !== 'active') throw new MerchantOpsError('pay.price_archived', 'precondition');
      if (price.is_default) return view(price);
      await tx`
        UPDATE pay.catalog_prices SET is_default = false, updated_at = now()
         WHERE product_id = ${input.productId}::uuid AND is_default`;
      const rows = await tx<PriceRow[]>`
        UPDATE pay.catalog_prices SET is_default = true, updated_at = now() WHERE id = ${input.priceId}::uuid
        RETURNING ${FIELDS(tx)}`;
      return view(rows[0]!);
    });
  }

  /**
   * What an active price charges. A fixed price takes no amount. A customer-chosen price takes the amount the customer
   * entered and refuses one below its minimum or above its maximum.
   */
  async quote(caller: MerchantCaller, input: { priceId: string; amount?: string | undefined }): Promise<PriceQuote> {
    assertPermission(caller, 'products.read');
    const sql = this.sql;
    const [row] = await sql<PriceRow[]>`
      SELECT ${FIELDS(sql)} FROM pay.catalog_prices WHERE id = ${input.priceId}::uuid AND merchant_id = ${caller.merchantId}`;
    if (!row) throw priceNotFound();
    if (row.status !== 'active') throw new MerchantOpsError('pay.price_archived', 'precondition');
    const answer = (amount: string): PriceQuote => ({ priceId: row.id, assetId: row.asset_id, amount, billing: row.billing });
    if (row.kind === 'fixed') {
      if (input.amount !== undefined) throw new MerchantOpsError('pay.price_amount_not_chosen', 'bad_request');
      return answer(money(row.amount));
    }
    if (input.amount === undefined) throw new MerchantOpsError('pay.price_amount_required', 'bad_request');
    const chosen = positive(input.amount);
    if (chosen < parseAmount(row.min_amount!)) throw new MerchantOpsError('pay.price_amount_below_minimum', 'bad_request');
    if (chosen > parseAmount(row.max_amount!)) throw new MerchantOpsError('pay.price_amount_above_maximum', 'bad_request');
    return answer(formatAmount(chosen));
  }

  /** The caller's own live product, locked for the transaction when asked; anything else is not found. */
  private async product(db: Sql | TransactionSql, caller: MerchantCaller, productId: string, lock = false) {
    if (!UUID.test(productId)) throw productNotFound();
    const [row] = await db<Array<{ id: string; status: 'active' | 'archived' }>>`
      SELECT id, status FROM pay.catalog_products
       WHERE id = ${productId}::uuid AND merchant_id = ${caller.merchantId} AND mode = ${MODE}
       ${lock ? db`FOR UPDATE` : db``}`;
    if (!row) throw productNotFound();
    return row;
  }

  private async replay(db: Sql | TransactionSql, caller: MerchantCaller, requestId: string, hash: string) {
    const [row] = await db<PriceRow[]>`
      SELECT ${FIELDS(db)} FROM pay.catalog_prices WHERE merchant_id = ${caller.merchantId} AND request_id = ${requestId}::uuid`;
    if (!row) return null;
    if (row.request_hash !== hash) throw new MerchantOpsError('pay.request_id_reused', 'conflict');
    return view(row);
  }
}
