import { createHash } from 'node:crypto';
import type { Sql } from 'postgres';
import { MerchantOpsError } from '../merchant-ops/errors.js';
import type { MerchantCaller, MerchantRole } from '../merchant-ops/roles.js';

/**
 * M-catalogue-01: merchant product records (create, get, list, update, archive, unarchive). No price lives here.
 *
 * Permissions. `catalog.read` is held by every role; `catalog.write` by owner and admin only. They are kept in this
 * module, NOT added to MERCHANT_PERMISSIONS (merchant-ops/roles.ts) yet: that list is pinned key-for-key by the
 * customer app (apps/customer roles.pin.test.ts) and the contracts capability flags, and apps/ is outside this lane.
 * Moving them into MERCHANT_PERMISSIONS is a front-end follow-up (frontend.md).
 *
 * Every write is idempotent on its request id: a retry with the same request id and the same fields returns the first
 * result; the same request id with different fields refuses `pay.request_id_reused`.
 * The merchant product id (`productRef`) is unique per merchant and immutable: reusing it with other fields refuses
 * `pay.catalog_product_id_taken`; the database also refuses any change to it once set.
 * Statement descriptor: at most 22 characters (the card-network limit, an engineering choice recorded as such).
 */

export const CATALOG_PRODUCT_TYPES = ['good', 'service', 'digital'] as const;
export type CatalogProductType = (typeof CATALOG_PRODUCT_TYPES)[number];
export const STATEMENT_DESCRIPTOR_MAX = 22;

const CATALOG_WRITE_ROLES = new Set<MerchantRole>(['owner', 'admin']);
export type CatalogPermission = 'catalog.read' | 'catalog.write';

export function roleHasCatalogPermission(role: MerchantRole, permission: CatalogPermission): boolean {
  return permission === 'catalog.read' ? true : CATALOG_WRITE_ROLES.has(role);
}

export function assertCatalog(caller: MerchantCaller, permission: CatalogPermission): void {
  if (!roleHasCatalogPermission(caller.role, permission)) throw new MerchantOpsError('pay.team_role_forbidden', 'forbidden');
}

export interface ProductFields {
  name: string;
  description?: string | null;
  imageRef?: string | null;
  taxCode?: string | null;
  statementDescriptor?: string | null;
  unitLabel?: string | null;
  type: CatalogProductType;
  typeFields?: Record<string, string>;
  category?: string | null;
  sku?: string | null;
}

export interface ProductView {
  id: string;
  productRef: string | null;
  name: string;
  description: string | null;
  imageRef: string | null;
  taxCode: string | null;
  statementDescriptor: string | null;
  unitLabel: string | null;
  type: CatalogProductType;
  typeFields: Record<string, string>;
  category: string | null;
  sku: string | null;
  archived: boolean;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

type Row = {
  id: string;
  product_ref: string | null;
  name: string;
  description: string | null;
  image_ref: string | null;
  tax_code: string | null;
  statement_descriptor: string | null;
  unit_label: string | null;
  type: CatalogProductType;
  type_fields: Record<string, string>;
  category: string | null;
  sku: string | null;
  archived_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

const COLS =
  'id, product_ref, name, description, image_ref, tax_code, statement_descriptor, unit_label, type, type_fields, category, sku, archived_at, created_at, updated_at';

function view(r: Row): ProductView {
  return {
    id: r.id,
    productRef: r.product_ref,
    name: r.name,
    description: r.description,
    imageRef: r.image_ref,
    taxCode: r.tax_code,
    statementDescriptor: r.statement_descriptor,
    unitLabel: r.unit_label,
    type: r.type,
    typeFields: r.type_fields ?? {},
    category: r.category,
    sku: r.sku,
    archived: r.archived_at !== null,
    archivedAt: r.archived_at ? r.archived_at.toISOString() : null,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
  };
}

function blank(v: string | null | undefined, max: number, code: `pay.${string}`): string | null {
  if (v === undefined || v === null) return null;
  const t = v.trim();
  if (t === '') return null;
  if (t.length > max) throw new MerchantOpsError(code, 'bad_request');
  return t;
}

function normalize(f: ProductFields) {
  const name = f.name?.trim() ?? '';
  if (name.length < 1 || name.length > 120) throw new MerchantOpsError('pay.catalog_product_name_invalid', 'bad_request');
  if (!CATALOG_PRODUCT_TYPES.includes(f.type)) throw new MerchantOpsError('pay.catalog_product_type_invalid', 'bad_request');
  const typeFields = f.typeFields ?? {};
  if (Object.keys(typeFields).length > 20) throw new MerchantOpsError('pay.catalog_product_type_fields_invalid', 'bad_request');
  return {
    name,
    description: blank(f.description, 2000, 'pay.catalog_product_description_invalid'),
    imageRef: blank(f.imageRef, 500, 'pay.catalog_product_image_invalid'),
    taxCode: blank(f.taxCode, 64, 'pay.catalog_product_tax_code_invalid'),
    statementDescriptor: blank(f.statementDescriptor, STATEMENT_DESCRIPTOR_MAX, 'pay.catalog_statement_descriptor_too_long'),
    unitLabel: blank(f.unitLabel, 32, 'pay.catalog_product_unit_label_invalid'),
    type: f.type,
    typeFields: Object.fromEntries(Object.entries(typeFields).sort(([a], [b]) => a.localeCompare(b))),
    category: blank(f.category, 80, 'pay.catalog_product_category_invalid'),
    sku: blank(f.sku, 64, 'pay.catalog_product_sku_invalid'),
  };
}

function fieldsOf(r: Row) {
  return {
    name: r.name,
    description: r.description,
    imageRef: r.image_ref,
    taxCode: r.tax_code,
    statementDescriptor: r.statement_descriptor,
    unitLabel: r.unit_label,
    type: r.type,
    typeFields: Object.fromEntries(Object.entries(r.type_fields ?? {}).sort(([a], [b]) => a.localeCompare(b))),
    category: r.category,
    sku: r.sku,
  };
}

const fingerprint = (action: string, payload: unknown) =>
  createHash('sha256')
    .update(JSON.stringify([action, payload]))
    .digest('hex');
const uniqueViolation = (e: unknown) => (e as { code?: string } | null)?.code === '23505';

export class CatalogProductService {
  constructor(private readonly sql: Sql) {}

  async create(caller: MerchantCaller, input: ProductFields & { requestId: string; productRef?: string | null }): Promise<ProductView> {
    assertCatalog(caller, 'catalog.write');
    const f = normalize(input);
    const productRef = input.productRef?.trim() || null;
    if (productRef !== null && !/^[A-Za-z0-9._-]{1,64}$/.test(productRef)) {
      throw new MerchantOpsError('pay.catalog_product_id_invalid', 'bad_request');
    }
    const fp = fingerprint('create', { ...f, productRef });
    const prior = await this.action(caller.merchantId, input.requestId);
    if (prior) return this.replay(caller, prior, 'create', fp);
    if (productRef !== null) {
      const existing = await this.sql<Row[]>`
        SELECT ${this.sql.unsafe(COLS)} FROM pay.catalog_products WHERE merchant_id = ${caller.merchantId} AND product_ref = ${productRef}`;
      // Same merchant product id with the same fields is the same product; with other fields it is refused.
      if (existing[0]) {
        if (fingerprint('create', { ...fieldsOf(existing[0]), productRef }) === fp) return view(existing[0]);
        throw new MerchantOpsError('pay.catalog_product_id_taken', 'conflict');
      }
    }
    try {
      const row = await this.sql.begin(async (tx) => {
        const rows = await tx<Row[]>`
          INSERT INTO pay.catalog_products
            (merchant_id, product_ref, name, description, image_ref, tax_code, statement_descriptor, unit_label, type, type_fields, category, sku, created_by)
          VALUES (${caller.merchantId}, ${productRef}, ${f.name}, ${f.description}, ${f.imageRef}, ${f.taxCode}, ${f.statementDescriptor},
                  ${f.unitLabel}, ${f.type}, ${tx.json(f.typeFields)}, ${f.category}, ${f.sku}, ${caller.userId})
          RETURNING ${tx.unsafe(COLS)}`;
        await this.record(tx as unknown as Sql, caller.merchantId, input.requestId, rows[0]!.id, 'create', fp);
        return rows[0]!;
      });
      return view(row);
    } catch (e) {
      if (!uniqueViolation(e)) throw e;
      const raced = await this.action(caller.merchantId, input.requestId);
      if (raced) return this.replay(caller, raced, 'create', fp);
      throw new MerchantOpsError('pay.catalog_product_id_taken', 'conflict');
    }
  }

  async get(caller: MerchantCaller, productId: string): Promise<ProductView> {
    assertCatalog(caller, 'catalog.read');
    const rows = await this.sql<Row[]>`
      SELECT ${this.sql.unsafe(COLS)} FROM pay.catalog_products WHERE id = ${productId} AND merchant_id = ${caller.merchantId}`;
    if (!rows[0]) throw new MerchantOpsError('pay.catalog_product_not_found', 'not_found');
    return view(rows[0]);
  }

  async list(
    caller: MerchantCaller,
    input: { limit: number; archived?: boolean; cursor?: string },
  ): Promise<{ items: ProductView[]; nextCursor: string | null }> {
    assertCatalog(caller, 'catalog.read');
    const limit = Math.min(Math.max(input.limit, 1), 100);
    let after: { at: string; id: string } | null = null;
    if (input.cursor) {
      try {
        after = JSON.parse(Buffer.from(input.cursor, 'base64url').toString('utf8'));
      } catch {
        throw new MerchantOpsError('pay.catalog_cursor_invalid', 'bad_request');
      }
      // Round-trip: only a cursor this service minted (Date#toISOString of a real instant) is accepted.
      const at = after && typeof after.at === 'string' ? new Date(after.at) : null;
      if (
        !after ||
        typeof after.id !== 'string' ||
        !at ||
        Number.isNaN(at.getTime()) ||
        at.toISOString() !== after.at ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(after.id)
      )
        throw new MerchantOpsError('pay.catalog_cursor_invalid', 'bad_request');
    }
    const archived = input.archived ?? false;
    const rows = await this.sql<Row[]>`
      SELECT ${this.sql.unsafe(COLS)} FROM pay.catalog_products
       WHERE merchant_id = ${caller.merchantId}
         AND (archived_at IS NOT NULL) = ${archived}
         ${after ? this.sql`AND (created_at, id) < (${after.at}::timestamptz, ${after.id}::uuid)` : this.sql``}
       ORDER BY created_at DESC, id DESC
       LIMIT ${limit + 1}`;
    const items = rows.slice(0, limit).map(view);
    const last = rows.length > limit ? rows[limit - 1]! : null;
    const nextCursor = last ? Buffer.from(JSON.stringify({ at: last.created_at.toISOString(), id: last.id })).toString('base64url') : null;
    return { items, nextCursor };
  }

  /** Edits the descriptive fields. The merchant product id is not editable. */
  async update(caller: MerchantCaller, input: ProductFields & { requestId: string; productId: string }): Promise<ProductView> {
    assertCatalog(caller, 'catalog.write');
    const f = normalize(input);
    const fp = fingerprint('update', { productId: input.productId, ...f });
    const prior = await this.action(caller.merchantId, input.requestId);
    if (prior) return this.replay(caller, prior, 'update', fp);
    const row = await this.raceSafe(caller, input.requestId, 'update', fp, (tx) => this.updateRow(tx, caller, input, f, fp));
    return view(row);
  }

  private async updateRow(
    tx: Sql,
    caller: MerchantCaller,
    input: { requestId: string; productId: string },
    f: ReturnType<typeof normalize>,
    fp: string,
  ) {
    {
      const rows = await tx<Row[]>`
        UPDATE pay.catalog_products SET
          name = ${f.name}, description = ${f.description}, image_ref = ${f.imageRef}, tax_code = ${f.taxCode},
          statement_descriptor = ${f.statementDescriptor}, unit_label = ${f.unitLabel}, type = ${f.type},
          type_fields = ${tx.json(f.typeFields)}, category = ${f.category}, sku = ${f.sku}, updated_at = now()
        WHERE id = ${input.productId} AND merchant_id = ${caller.merchantId}
        RETURNING ${tx.unsafe(COLS)}`;
      if (!rows[0]) throw new MerchantOpsError('pay.catalog_product_not_found', 'not_found');
      await this.record(tx, caller.merchantId, input.requestId, rows[0].id, 'update', fp);
      return rows[0];
    }
  }

  /** Runs a write in one transaction; a concurrent call with the same requestId (23505 on the log) replays instead of a 500. */
  private async raceSafe(
    caller: MerchantCaller,
    requestId: string,
    action: string,
    fp: string,
    write: (tx: Sql) => Promise<Row>,
  ): Promise<Row> {
    try {
      return await this.sql.begin((tx) => write(tx as unknown as Sql));
    } catch (e) {
      if (!uniqueViolation(e)) throw e;
      const raced = await this.action(caller.merchantId, requestId);
      if (!raced) throw e;
      if (raced.action !== action || raced.fingerprint !== fp) throw new MerchantOpsError('pay.request_id_reused', 'conflict');
      const rows = await this.sql<Row[]>`
        SELECT ${this.sql.unsafe(COLS)} FROM pay.catalog_products WHERE id = ${raced.product_id} AND merchant_id = ${caller.merchantId}`;
      if (!rows[0]) throw new MerchantOpsError('pay.catalog_product_not_found', 'not_found');
      return rows[0];
    }
  }

  archive(caller: MerchantCaller, input: { requestId: string; productId: string }): Promise<ProductView> {
    return this.setArchived(caller, input, true);
  }

  unarchive(caller: MerchantCaller, input: { requestId: string; productId: string }): Promise<ProductView> {
    return this.setArchived(caller, input, false);
  }

  /** Idempotent: archiving an archived product (or unarchiving an active one) returns it unchanged. */
  private async setArchived(
    caller: MerchantCaller,
    input: { requestId: string; productId: string },
    archived: boolean,
  ): Promise<ProductView> {
    assertCatalog(caller, 'catalog.write');
    const action = archived ? 'archive' : 'unarchive';
    const fp = fingerprint(action, { productId: input.productId });
    const prior = await this.action(caller.merchantId, input.requestId);
    if (prior) return this.replay(caller, prior, action, fp);
    const row = await this.raceSafe(caller, input.requestId, action, fp, async (tx) => {
      const rows = await tx<Row[]>`
        UPDATE pay.catalog_products
           SET archived_at = CASE WHEN ${archived} THEN COALESCE(archived_at, now()) ELSE NULL END,
               updated_at = CASE WHEN (archived_at IS NOT NULL) = ${archived} THEN updated_at ELSE now() END
         WHERE id = ${input.productId} AND merchant_id = ${caller.merchantId}
         RETURNING ${tx.unsafe(COLS)}`;
      if (!rows[0]) throw new MerchantOpsError('pay.catalog_product_not_found', 'not_found');
      await this.record(tx, caller.merchantId, input.requestId, rows[0].id, action, fp);
      return rows[0];
    });
    return view(row);
  }

  private async action(merchantId: string, requestId: string) {
    const rows = await this.sql<Array<{ product_id: string; action: string; fingerprint: string }>>`
      SELECT product_id, action, fingerprint FROM pay.catalog_product_actions WHERE merchant_id = ${merchantId} AND request_id = ${requestId}::uuid`;
    return rows[0] ?? null;
  }

  private async replay(
    caller: MerchantCaller,
    prior: { product_id: string; action: string; fingerprint: string },
    action: string,
    fp: string,
  ) {
    if (prior.action !== action || prior.fingerprint !== fp) throw new MerchantOpsError('pay.request_id_reused', 'conflict');
    const rows = await this.sql<Row[]>`SELECT ${this.sql.unsafe(COLS)} FROM pay.catalog_products WHERE id = ${prior.product_id}`;
    return view(rows[0]!);
  }

  private async record(db: Sql, merchantId: string, requestId: string, productId: string, action: string, fp: string) {
    await db`
      INSERT INTO pay.catalog_product_actions (merchant_id, request_id, product_id, action, fingerprint)
      VALUES (${merchantId}, ${requestId}::uuid, ${productId}, ${action}, ${fp})`;
  }
}
