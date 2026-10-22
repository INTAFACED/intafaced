import { createHash } from 'node:crypto';
import type { Sql } from 'postgres';
import { formatAmount, parseAmount } from '@intafaced/ledger-client';
import { MerchantOpsError } from '../merchant-ops/errors.js';
import type { MerchantCaller } from '../merchant-ops/roles.js';
import { assertCatalog } from './product-service.js';
import {
  amount,
  CATALOG_PRICE_MODELS,
  normalizeTiers,
  priceQuantity,
  type CatalogPriceModel,
  type NormalTier,
  type PriceTier,
  type QuoteLine,
} from './pricing.js';

/**
 * M-catalogue-02: prices on a catalogue product, the product's default price, and a quote.
 * A price never changes amount, asset, interval or model after create (DB trigger in 0128): a new amount is a new
 * price, so subscriptions and invoices that point at the old one keep what they were sold.
 * Usage-based pricing is refused until a quantity source exists (pay.catalog_usage_source_unset).
 * The quote quantity ceiling is an owner value, PAY_CATALOG_QUOTE_QUANTITY_MAX; unset, quotes refuse.
 */
export const RECURRING_UNITS = ['day', 'week', 'month', 'year'] as const;
export type RecurringUnit = (typeof RECURRING_UNITS)[number];
export const TAX_BEHAVIORS = ['inclusive', 'exclusive', 'unspecified'] as const;
export type TaxBehavior = (typeof TAX_BEHAVIORS)[number];

export interface PriceInput {
  productId: string;
  assetId: string;
  model: CatalogPriceModel | 'usage';
  unitAmount?: string | null;
  tiers?: PriceTier[] | null;
  recurring?: { unit: RecurringUnit; count: number } | null;
  taxBehavior: TaxBehavior;
  description?: string | null;
}

export interface PriceView {
  id: string;
  productId: string;
  assetId: string;
  model: CatalogPriceModel;
  unitAmount: string | null;
  tiers: NormalTier[] | null;
  recurring: { unit: RecurringUnit; count: number } | null;
  taxBehavior: TaxBehavior;
  description: string | null;
  isDefault: boolean;
  archived: boolean;
  archivedAt: string | null;
  createdAt: string;
}

export interface QuoteView {
  priceId: string;
  assetId: string;
  quantity: number;
  lines: QuoteLine[];
  total: string;
  taxBehavior: TaxBehavior;
}

type Row = {
  id: string;
  product_id: string;
  asset_id: string;
  model: CatalogPriceModel;
  unit_amount: string | null;
  tiers: NormalTier[] | null;
  recurring_unit: RecurringUnit | null;
  recurring_count: number | null;
  tax_behavior: TaxBehavior;
  description: string | null;
  archived_at: Date | null;
  created_at: Date;
  is_default: boolean;
};

const SELECT = (sql: Sql) => sql`
  SELECT p.id, p.product_id, p.asset_id, p.model, p.unit_amount::text AS unit_amount, p.tiers, p.recurring_unit,
         p.recurring_count, p.tax_behavior, p.description, p.archived_at, p.created_at,
         (pr.default_price_id IS NOT DISTINCT FROM p.id) AS is_default
    FROM pay.catalog_prices p JOIN pay.catalog_products pr ON pr.id = p.product_id`;

function view(r: Row): PriceView {
  return {
    id: r.id,
    productId: r.product_id,
    assetId: r.asset_id,
    model: r.model,
    unitAmount: r.unit_amount === null ? null : formatAmount(parseAmount(r.unit_amount)),
    tiers: r.tiers,
    recurring: r.recurring_unit ? { unit: r.recurring_unit, count: r.recurring_count! } : null,
    taxBehavior: r.tax_behavior,
    description: r.description,
    isDefault: r.is_default,
    archived: r.archived_at !== null,
    archivedAt: r.archived_at ? r.archived_at.toISOString() : null,
    createdAt: r.created_at.toISOString(),
  };
}

const bad = (code: `pay.${string}`) => new MerchantOpsError(code, 'bad_request');
const fingerprint = (action: string, payload: unknown) =>
  createHash('sha256')
    .update(JSON.stringify([action, payload]))
    .digest('hex');

function normalize(input: PriceInput) {
  if (input.model === 'usage') throw new MerchantOpsError('pay.catalog_usage_source_unset', 'precondition');
  if (!CATALOG_PRICE_MODELS.includes(input.model)) throw bad('pay.catalog_price_model_invalid');
  const assetId = input.assetId?.trim() ?? '';
  if (!/^[A-Za-z0-9._-]{1,16}$/.test(assetId)) throw bad('pay.catalog_price_asset_invalid');
  if (!TAX_BEHAVIORS.includes(input.taxBehavior)) throw bad('pay.catalog_price_tax_behavior_invalid');
  const flatish = input.model === 'flat' || input.model === 'per_seat';
  if (flatish && input.tiers) throw bad('pay.catalog_price_tiers_invalid');
  if (!flatish && input.unitAmount != null) throw bad('pay.catalog_price_amount_invalid');
  const unitAmount = flatish ? formatAmount(amount(input.unitAmount ?? '')) : null;
  const tiers = flatish ? null : normalizeTiers(input.tiers);
  let recurring: PriceView['recurring'] = null;
  if (input.recurring) {
    const { unit, count } = input.recurring;
    if (!RECURRING_UNITS.includes(unit) || !Number.isSafeInteger(count) || count < 1 || count > 365) {
      throw bad('pay.catalog_price_interval_invalid');
    }
    recurring = { unit, count };
  }
  const description = input.description?.trim() || null;
  if (description !== null && description.length > 500) throw bad('pay.catalog_price_description_invalid');
  return {
    productId: input.productId,
    assetId,
    model: input.model,
    unitAmount,
    tiers,
    recurring,
    taxBehavior: input.taxBehavior,
    description,
  };
}

/**
 * Owner value: the decimal places each asset allows, `PAY_CATALOG_ASSET_DECIMALS="USDT:6,BTC:8"`. Unset or garbled
 * refuses `pay.catalog_asset_scale_unset`; an asset not listed refuses `pay.catalog_price_asset_unknown`. No default scale.
 */
export function assetDecimals(env: NodeJS.ProcessEnv = process.env): Map<string, number> | null {
  const raw = env.PAY_CATALOG_ASSET_DECIMALS?.trim();
  if (!raw) return null;
  const out = new Map<string, number>();
  for (const part of raw.split(',')) {
    const m = /^([A-Za-z0-9._-]{1,16}):(\d{1,2})$/.exec(part.trim());
    if (!m || Number(m[2]) > 18) return null;
    out.set(m[1]!, Number(m[2]));
  }
  return out;
}

function decimalPlaces(v: string): number {
  const i = v.indexOf('.');
  return i < 0 ? 0 : v.length - i - 1;
}

/** Every amount on the price must fit the asset's scale. */
function assertAssetScale(f: { assetId: string; unitAmount: string | null; tiers: NormalTier[] | null }, env: NodeJS.ProcessEnv) {
  const scales = assetDecimals(env);
  if (!scales) throw new MerchantOpsError('pay.catalog_asset_scale_unset', 'precondition');
  const scale = scales.get(f.assetId);
  if (scale === undefined) throw bad('pay.catalog_price_asset_unknown');
  const amounts = [f.unitAmount, ...(f.tiers ?? []).flatMap((t) => [t.unitAmount, t.flatAmount])].filter((a): a is string => a !== null);
  if (amounts.some((a) => decimalPlaces(a) > scale)) throw bad('pay.catalog_price_amount_scale');
}

/** The owner-set quote ceiling. Unset or not a positive whole number means quotes refuse rather than guess. */
export function quoteQuantityMax(env: NodeJS.ProcessEnv = process.env): number | null {
  const raw = env.PAY_CATALOG_QUOTE_QUANTITY_MAX?.trim();
  if (!raw || !/^\d{1,9}$/.test(raw)) return null;
  const n = Number(raw);
  return n >= 1 ? n : null;
}

export class CatalogPriceService {
  constructor(
    private readonly sql: Sql,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  async create(caller: MerchantCaller, input: PriceInput & { requestId: string }): Promise<PriceView> {
    assertCatalog(caller, 'catalog.write');
    const f = normalize(input);
    assertAssetScale(f, this.env);
    const fp = fingerprint('create', f);
    const prior = await this.action(caller.merchantId, input.requestId);
    if (prior) return this.replay(caller, prior, 'create', fp);
    const id = await this.raceSafe(caller, input.requestId, 'create', fp, () =>
      this.sql.begin(async (tx) => {
        const product = await tx<Array<{ archived_at: Date | null }>>`
        SELECT archived_at FROM pay.catalog_products WHERE id = ${f.productId}::uuid AND merchant_id = ${caller.merchantId} FOR UPDATE`;
        if (!product[0]) throw new MerchantOpsError('pay.catalog_product_not_found', 'not_found');
        if (product[0].archived_at) throw new MerchantOpsError('pay.catalog_product_archived', 'conflict');
        const [row] = await tx<Array<{ id: string }>>`
        INSERT INTO pay.catalog_prices (merchant_id, product_id, asset_id, model, unit_amount, tiers, recurring_unit,
                                        recurring_count, tax_behavior, description, created_by)
        VALUES (${caller.merchantId}, ${f.productId}::uuid, ${f.assetId}, ${f.model}, ${f.unitAmount},
                ${f.tiers ? tx.json(f.tiers as never) : null}, ${f.recurring?.unit ?? null}, ${f.recurring?.count ?? null},
                ${f.taxBehavior}, ${f.description}, ${caller.userId})
        RETURNING id`;
        if (!row) throw new MerchantOpsError('pay.catalog_price_not_found', 'not_found');
        await this.record(tx as unknown as Sql, caller.merchantId, input.requestId, row.id, 'create', fp);
        return row.id;
      }),
    );
    return this.get(caller, id);
  }

  async get(caller: MerchantCaller, priceId: string): Promise<PriceView> {
    assertCatalog(caller, 'catalog.read');
    if (!/^[0-9a-f-]{36}$/i.test(priceId)) throw new MerchantOpsError('pay.catalog_price_not_found', 'not_found');
    const rows = await this.sql<Row[]>`${SELECT(this.sql)} WHERE p.id = ${priceId}::uuid AND p.merchant_id = ${caller.merchantId}`;
    if (!rows[0]) throw new MerchantOpsError('pay.catalog_price_not_found', 'not_found');
    return view(rows[0]);
  }

  async list(caller: MerchantCaller, input: { productId: string; includeArchived?: boolean }): Promise<PriceView[]> {
    assertCatalog(caller, 'catalog.read');
    const rows = await this.sql<Row[]>`${SELECT(this.sql)}
      WHERE p.merchant_id = ${caller.merchantId} AND p.product_id = ${input.productId}::uuid
        AND (${input.includeArchived ?? false} OR p.archived_at IS NULL)
      ORDER BY p.created_at DESC, p.id DESC LIMIT 200`;
    return rows.map(view);
  }

  /** Make a live price the product's default. Setting the current default again changes nothing. */
  async setDefault(caller: MerchantCaller, input: { requestId: string; priceId: string }): Promise<PriceView> {
    assertCatalog(caller, 'catalog.write');
    const fp = fingerprint('set_default', { priceId: input.priceId });
    const prior = await this.action(caller.merchantId, input.requestId);
    if (prior) return this.replay(caller, prior, 'set_default', fp);
    await this.raceSafe(caller, input.requestId, 'set_default', fp, () =>
      this.sql.begin(async (tx) => {
        const [p] = await tx<Array<{ product_id: string; archived_at: Date | null }>>`
        SELECT product_id, archived_at FROM pay.catalog_prices WHERE id = ${input.priceId}::uuid AND merchant_id = ${caller.merchantId} FOR UPDATE`;
        if (!p) throw new MerchantOpsError('pay.catalog_price_not_found', 'not_found');
        if (p.archived_at) throw new MerchantOpsError('pay.catalog_price_archived', 'conflict');
        await tx`UPDATE pay.catalog_products SET default_price_id = ${input.priceId}::uuid, updated_at = now()
                WHERE id = ${p.product_id} AND default_price_id IS DISTINCT FROM ${input.priceId}::uuid`;
        await this.record(tx as unknown as Sql, caller.merchantId, input.requestId, input.priceId, 'set_default', fp);
        return input.priceId;
      }),
    );
    return this.get(caller, input.priceId);
  }

  /** Archive a price: new sales stop using it, existing references keep it. Archiving the default clears the default. */
  async archive(caller: MerchantCaller, input: { requestId: string; priceId: string }): Promise<PriceView> {
    assertCatalog(caller, 'catalog.write');
    const fp = fingerprint('archive', { priceId: input.priceId });
    const prior = await this.action(caller.merchantId, input.requestId);
    if (prior) return this.replay(caller, prior, 'archive', fp);
    await this.raceSafe(caller, input.requestId, 'archive', fp, () =>
      this.sql.begin(async (tx) => {
        const [p] = await tx<Array<{ product_id: string }>>`
        UPDATE pay.catalog_prices SET archived_at = COALESCE(archived_at, now())
         WHERE id = ${input.priceId}::uuid AND merchant_id = ${caller.merchantId} RETURNING product_id`;
        if (!p) throw new MerchantOpsError('pay.catalog_price_not_found', 'not_found');
        await tx`UPDATE pay.catalog_products SET default_price_id = NULL, updated_at = now()
                WHERE id = ${p.product_id} AND default_price_id = ${input.priceId}::uuid`;
        await this.record(tx as unknown as Sql, caller.merchantId, input.requestId, input.priceId, 'archive', fp);
        return input.priceId;
      }),
    );
    return this.get(caller, input.priceId);
  }

  /** What a quantity costs on a live price. Read-only; nothing is reserved or charged. */
  async quote(caller: MerchantCaller, input: { priceId: string; quantity: number }): Promise<QuoteView> {
    const price = await this.get(caller, input.priceId);
    const max = quoteQuantityMax(this.env);
    if (max === null) throw new MerchantOpsError('pay.catalog_quote_quantity_max_unset', 'precondition');
    if (!Number.isSafeInteger(input.quantity) || input.quantity < 1 || input.quantity > max) {
      throw bad('pay.catalog_quote_quantity_invalid');
    }
    if (price.archived) throw new MerchantOpsError('pay.catalog_price_archived', 'conflict');
    if (price.model === 'flat' && input.quantity !== 1) throw bad('pay.catalog_quote_quantity_invalid');
    const { lines, total } = priceQuantity(price.model, price.unitAmount, price.tiers, input.quantity);
    return { priceId: price.id, assetId: price.assetId, quantity: input.quantity, lines, total, taxBehavior: price.taxBehavior };
  }

  /** One write transaction; a concurrent call with the same requestId (23505 on the log) replays instead of a 500. */
  private async raceSafe(
    caller: MerchantCaller,
    requestId: string,
    action: string,
    fp: string,
    write: () => Promise<string>,
  ): Promise<string> {
    try {
      return await write();
    } catch (e) {
      if ((e as { code?: string } | null)?.code !== '23505') throw e;
      const raced = await this.action(caller.merchantId, requestId);
      if (!raced) throw e;
      if (raced.action !== action || raced.fingerprint !== fp) throw new MerchantOpsError('pay.request_id_reused', 'conflict');
      return raced.price_id;
    }
  }

  private async action(merchantId: string, requestId: string) {
    const rows = await this.sql<Array<{ price_id: string; action: string; fingerprint: string }>>`
      SELECT price_id, action, fingerprint FROM pay.catalog_price_actions WHERE merchant_id = ${merchantId} AND request_id = ${requestId}::uuid`;
    return rows[0] ?? null;
  }

  private async replay(
    caller: MerchantCaller,
    prior: { price_id: string; action: string; fingerprint: string },
    action: string,
    fp: string,
  ) {
    if (prior.action !== action || prior.fingerprint !== fp) throw new MerchantOpsError('pay.request_id_reused', 'conflict');
    return this.get(caller, prior.price_id);
  }

  private async record(db: Sql, merchantId: string, requestId: string, priceId: string, action: string, fp: string) {
    await db`
      INSERT INTO pay.catalog_price_actions (merchant_id, request_id, price_id, action, fingerprint)
      VALUES (${merchantId}, ${requestId}::uuid, ${priceId}::uuid, ${action}, ${fp})`;
  }
}
