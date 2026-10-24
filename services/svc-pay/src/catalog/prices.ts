import { createHash } from 'node:crypto';
import type { Sql, TransactionSql } from 'postgres';
import { formatAmount, parseAmount } from '@intafaced/ledger-client';
import type { MerchantPrice, PriceCreateInput, PricedProduct, PriceQuote, PriceReplaceInput } from '@intafaced/contracts';
import { MerchantOpsError } from '../merchant-ops/errors.js';
import { iso, money } from '../merchant-ops/money.js';
import { decodeCursor, encodeCursor, requireLimit, toPage } from '../merchant-ops/pagination.js';
import { assertPermission, type MerchantCaller } from '../merchant-ops/roles.js';
import { assertWriter, isUnique, productNotFound, UUID } from './products.js';

/**
 * Prices on catalogue products (M-catalogue-02, J-merchant-03 step 3; replacing them, M-adv-payments-core-20, step 4).
 *
 * Scoped like the products: the caller's own business, `products.read` to read and quote, `products.manage` from an
 * interactive session to add a price or move the default. A price is a fixed amount of one asset, charged once or every
 * month, or a customer-chosen amount between the business's own minimum and maximum (one-time only; both bounds are
 * required). The first active price of a product is its default; setting another as default moves the mark in one
 * transaction, under the product's row lock, so a product never has two. A price is never edited: Replace price makes a
 * new one that names the old, and archives the old in the same transaction; whatever used the old price (a
 * subscription) stays on it. Nothing here moves money; a quote only says what a price would charge.
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
  replaces_id: string | null;
  created_by: string;
  created_at: Date;
  cursor_ts: string;
}

const FIELDS = (sql: Sql | TransactionSql) => sql`
  id, product_id, request_hash, billing, kind, asset_id, amount::text, min_amount::text, max_amount::text, is_default,
  status, replaces_id, created_by, created_at, to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_ts`;

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
  replacesId: row.replaces_id,
  createdAt: iso(row.created_at),
  createdBy: row.created_by,
});

const priceNotFound = () => new MerchantOpsError('pay.price_not_found', 'not_found');

interface PricedRow extends PriceRow {
  product_key: string;
  product_name: string;
  product_status: 'active' | 'archived';
}

/** A price's fields (aliased `pr`) with its product's (aliased `p`). */
const PRICED = (sql: Sql | TransactionSql) => sql`
  pr.id, pr.product_id, pr.request_hash, pr.billing, pr.kind, pr.asset_id, pr.amount::text, pr.min_amount::text,
  pr.max_amount::text, pr.is_default, pr.status, pr.replaces_id, pr.created_by, pr.created_at,
  to_char(pr.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_ts,
  p.product_key, p.name AS product_name, p.status AS product_status`;

const pricedView = (row: PricedRow): PricedProduct => ({
  price: view(row),
  product: { id: row.product_id, productKey: row.product_key, name: row.product_name, status: row.product_status },
});

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

/**
 * What a create asked for, in canonical form, so a replay can tell the same request from a reused id. A replacement also
 * names the price it replaces; a plain create's hash is unchanged by that.
 */
function requestHash(
  input: PriceCreateInput,
  amounts: { amount: string | null; min: string | null; max: string | null },
  replacesId?: string,
): string {
  const canonical = {
    productId: input.productId.toLowerCase(),
    billing: input.billing,
    kind: input.kind,
    assetId: input.assetId,
    ...amounts,
    ...(replacesId ? { replacesId: replacesId.toLowerCase() } : {}),
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
        return { price: await this.insert(tx, caller, input, amounts, hash, { isDefault: !current, replacesId: null }), replayed: false };
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
      const product = await this.product(tx, caller, input.productId, true);
      if (product.status !== 'active') throw new MerchantOpsError('pay.product_archived', 'precondition');
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
   * Replace a price: archive it and make a new one with the given details, in one transaction under the product's lock.
   * The new price takes the default mark when the old one had it, and names the old one (`replacesId`). Whatever used
   * the old price keeps it: a subscription's price never changes. A price is replaced once; an archived price is not
   * replaced again. The same request id with the same details answers with the pair it made.
   */
  async replace(
    caller: MerchantCaller,
    input: PriceReplaceInput,
  ): Promise<{ price: MerchantPrice; replaced: MerchantPrice; replayed: boolean }> {
    assertWriter(caller);
    const { priceId, ...details } = input;
    if (!UUID.test(priceId)) throw priceNotFound();
    const amounts = amountsOf(details);
    const hash = requestHash(details, amounts, priceId);
    const replayed = async (db: Sql | TransactionSql) => {
      const made = await this.replay(db, caller, input.requestId, hash);
      if (!made) return null;
      const [old] = await db<PriceRow[]>`
        SELECT ${FIELDS(db)} FROM pay.catalog_prices WHERE id = ${made.replacesId}::uuid AND merchant_id = ${caller.merchantId}`;
      return { price: made, replaced: view(old!), replayed: true };
    };
    const prior = await replayed(this.sql);
    if (prior) return prior;
    try {
      return await this.sql.begin(async (tx) => {
        const product = await this.product(tx, caller, details.productId, true);
        // The same request may have finished while this one waited for the product's lock: answer as its replay, not
        // as a refusal of the price it already archived.
        const raced = await replayed(tx);
        if (raced) return raced;
        if (product.status !== 'active') throw new MerchantOpsError('pay.product_archived', 'precondition');
        const [old] = await tx<PriceRow[]>`
          SELECT ${FIELDS(tx)} FROM pay.catalog_prices
           WHERE id = ${priceId}::uuid AND product_id = ${details.productId}::uuid AND merchant_id = ${caller.merchantId}
           FOR UPDATE`;
        if (!old) throw priceNotFound();
        if (old.status !== 'active') throw new MerchantOpsError('pay.price_archived', 'precondition');
        const archived = await tx<PriceRow[]>`
          UPDATE pay.catalog_prices SET status = 'archived', is_default = false, updated_at = now() WHERE id = ${priceId}::uuid
          RETURNING ${FIELDS(tx)}`;
        const price = await this.insert(tx, caller, details, amounts, hash, { isDefault: old.is_default, replacesId: priceId });
        return { price, replaced: view(archived[0]!), replayed: false };
      });
    } catch (err) {
      if (isUnique(err, 'catalog_prices_request_once')) {
        const raced = await replayed(this.sql);
        if (raced) return raced;
      }
      throw err;
    }
  }

  /** What uses a price: the subscriptions started on it that have not ended. Replace price says this before it acts. */
  async usage(caller: MerchantCaller, priceId: string): Promise<{ priceId: string; openSubscriptions: number }> {
    const { price } = await this.get(caller, priceId);
    const [row] = await this.sql<Array<{ open: number }>>`
      SELECT count(*)::int AS open FROM pay.subscriptions
       WHERE price_id = ${price.id}::uuid AND merchant_id = ${caller.merchantId} AND status IN ('active', 'paused')`;
    return { priceId: price.id, openSubscriptions: row?.open ?? 0 };
  }

  /**
   * One price and its product, archived or not, so a document that names a price (a subscription) still reads it after
   * the price is replaced or the product archived.
   */
  async get(caller: MerchantCaller, priceId: string): Promise<PricedProduct> {
    assertPermission(caller, 'products.read');
    if (!UUID.test(priceId)) throw priceNotFound();
    const sql = this.sql;
    const [row] = await sql<PricedRow[]>`
      SELECT ${PRICED(sql)} FROM pay.catalog_prices pr JOIN pay.catalog_products p ON p.id = pr.product_id
       WHERE pr.id = ${priceId}::uuid AND pr.merchant_id = ${caller.merchantId} AND p.mode = ${MODE}`;
    if (!row) throw priceNotFound();
    return pricedView(row);
  }

  /**
   * What a picker offers: active prices of active live products, newest price first, narrowed by billing, kind, asset and
   * amount.
   * An archived product, an archived price and a replaced price are never offered; they still read through `get`.
   */
  async choices(
    caller: MerchantCaller,
    input: {
      billing?: MerchantPrice['billing'] | undefined;
      kind?: MerchantPrice['kind'] | undefined;
      assetId?: string | undefined;
      amount?: string | undefined;
      limit?: number | undefined;
      cursor?: string | undefined;
    },
  ) {
    assertPermission(caller, 'products.read');
    const limit = requireLimit(input.limit);
    const after = decodeCursor(input.cursor);
    if (after && !UUID.test(after.key)) throw new MerchantOpsError('pay.cursor_invalid', 'bad_request');
    const sql = this.sql;
    const rows = await sql<PricedRow[]>`
      SELECT ${PRICED(sql)} FROM pay.catalog_prices pr JOIN pay.catalog_products p ON p.id = pr.product_id
       WHERE pr.merchant_id = ${caller.merchantId} AND p.mode = ${MODE} AND p.status = 'active' AND pr.status = 'active'
         ${input.billing ? sql`AND pr.billing = ${input.billing}` : sql``}
         ${input.kind ? sql`AND pr.kind = ${input.kind}` : sql``}
         ${input.assetId ? sql`AND pr.asset_id = ${input.assetId}` : sql``}
         ${input.amount !== undefined ? sql`AND pr.amount = ${formatAmount(positive(input.amount))}::numeric` : sql``}
         ${after ? sql`AND (pr.created_at, pr.id) < ((${after.ts}::text)::timestamptz, ${after.key}::uuid)` : sql``}
       ORDER BY pr.created_at DESC, pr.id DESC
       LIMIT ${limit + 1}`;
    return toPage(rows, limit, pricedView, (row) => encodeCursor(row.cursor_ts, row.id));
  }

  /**
   * What an active price of an active live product charges. A fixed price takes no amount. A customer-chosen price takes the amount the customer
   * entered and refuses one below its minimum or above its maximum.
   */
  async quote(caller: MerchantCaller, input: { priceId: string; amount?: string | undefined }): Promise<PriceQuote> {
    assertPermission(caller, 'products.read');
    const sql = this.sql;
    const [row] = await sql<Array<PriceRow & { product_status: 'active' | 'archived' }>>`
      SELECT ${FIELDS(sql)}, (SELECT p.status FROM pay.catalog_products p WHERE p.id = product_id AND p.mode = ${MODE}) AS product_status
        FROM pay.catalog_prices WHERE id = ${input.priceId}::uuid AND merchant_id = ${caller.merchantId}`;
    if (!row || !row.product_status) throw priceNotFound();
    if (row.product_status !== 'active') throw new MerchantOpsError('pay.product_archived', 'precondition');
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

  private async insert(
    tx: TransactionSql,
    caller: MerchantCaller,
    input: PriceCreateInput,
    amounts: { amount: string | null; min: string | null; max: string | null },
    hash: string,
    mark: { isDefault: boolean; replacesId: string | null },
  ): Promise<MerchantPrice> {
    const rows = await tx<PriceRow[]>`
      INSERT INTO pay.catalog_prices
        (merchant_id, product_id, request_id, request_hash, billing, kind, asset_id, amount, min_amount, max_amount,
         is_default, replaces_id, created_by)
      VALUES
        (${caller.merchantId}, ${input.productId}::uuid, ${input.requestId}::uuid, ${hash}, ${input.billing}, ${input.kind},
         ${input.assetId}, ${amounts.amount}::numeric, ${amounts.min}::numeric, ${amounts.max}::numeric, ${mark.isDefault},
         ${mark.replacesId}::uuid, ${caller.userId})
      RETURNING ${FIELDS(tx)}`;
    return view(rows[0]!);
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
