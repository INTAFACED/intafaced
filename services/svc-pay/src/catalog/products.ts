import { createHash, randomBytes } from 'node:crypto';
import type { Sql, TransactionSql } from 'postgres';
import { PRODUCT_IMAGE_TYPES, type MerchantProduct, type ProductCreateInput, type ProductImageRules } from '@intafaced/contracts';
import { MerchantOpsError } from '../merchant-ops/errors.js';
import { iso } from '../merchant-ops/money.js';
import { decodeCursor, encodeCursor, requireLimit, toPage } from '../merchant-ops/pagination.js';
import { assertPermission, type MerchantCaller } from '../merchant-ops/roles.js';
import type { ProductImageRule } from './image-rules.js';

/**
 * The product catalogue (M-catalogue-01, J-merchant-03 steps 1 and 2; archive and delete, M-adv-payments-core-20, step 4).
 *
 * Scoped to the caller's own business, resolved from the signed principal (`resolveMerchantCaller`): another
 * business's product or image answers exactly as one that does not exist. Every role reads (`products.read`); the
 * owner, an admin or a developer adds (`products.manage`), from an interactive session only, since an API key or a
 * session without a second factor holds no writes. The portal writes `live` products; nothing here writes `test`.
 *
 * A create is keyed by the client's request id: the same id with the same details answers with the product it made,
 * the same id with other details is refused. An archived product leaves the lists and pickers that offer products
 * (`status` filter, `prices.choices`) and still reads by id, so old documents resolve; it can be unarchived. A product is
 * deleted only while it has no price, so nothing that ever named one of its prices loses it, and its image goes with it
 * when no other product shows that image. Nothing here moves money; prices are in `prices.ts`.
 */

const MODE = 'live' as const;

type ImageType = (typeof PRODUCT_IMAGE_TYPES)[number];

export interface ProductRow {
  id: string;
  product_key: string;
  mode: 'live' | 'test';
  request_hash: string;
  name: string;
  type: MerchantProduct['type'];
  unit_label: string | null;
  statement_descriptor: string | null;
  event_starts_at: Date | null;
  event_location: string | null;
  image_id: string | null;
  status: 'active' | 'archived';
  version: number;
  created_by: string;
  created_at: Date;
  updated_at: Date;
  cursor_ts: string;
}

export const FIELDS = (sql: Sql | TransactionSql) => sql`
  id, product_key, mode, request_hash, name, type, unit_label, statement_descriptor, event_starts_at, event_location,
  image_id, status, version, created_by, created_at, updated_at,
  to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_ts`;

export const view = (row: ProductRow): MerchantProduct => ({
  id: row.id,
  productKey: row.product_key,
  mode: row.mode,
  name: row.name,
  type: row.type,
  unitLabel: row.unit_label,
  statementDescriptor: row.statement_descriptor,
  event: row.event_starts_at && row.event_location ? { startsAt: iso(row.event_starts_at), location: row.event_location } : null,
  imageId: row.image_id,
  status: row.status,
  version: row.version,
  createdAt: iso(row.created_at),
  createdBy: row.created_by,
  updatedAt: iso(row.updated_at),
});

export const productNotFound = () => new MerchantOpsError('pay.product_not_found', 'not_found');
const imageNotFound = () => new MerchantOpsError('pay.product_image_not_found', 'not_found');

export function assertWriter(caller: MerchantCaller): void {
  assertPermission(caller, 'products.manage');
  if (!caller.interactive) throw new MerchantOpsError('pay.catalog_interactive_only', 'forbidden');
}

/** What a create asked for, so a replay can tell the same request from a reused id. */
export function requestHash(input: ProductCreateInput): string {
  const canonical = {
    productKey: input.productKey ?? null,
    name: input.name,
    type: input.type,
    unitLabel: input.unitLabel ?? null,
    statementDescriptor: input.statementDescriptor ?? null,
    event: input.event ? { startsAt: new Date(input.event.startsAt).toISOString(), location: input.event.location } : null,
    imageId: input.imageId ?? null,
  };
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

/** `prod_` and 16 base32 characters: what svc-pay names a product the business did not name. */
export function generatedKey(): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz234567';
  return `prod_${[...randomBytes(16)].map((b) => alphabet[b % 32]).join('')}`;
}

export const isUnique = (err: unknown, constraint: string): boolean =>
  typeof err === 'object' &&
  err !== null &&
  (err as { code?: string }).code === '23505' &&
  (err as { constraint_name?: string }).constraint_name === constraint;

/** Which of the allowed image types these bytes are, from their first bytes; null for anything else (a GIF included). */
export function sniffImageType(bytes: Buffer): ImageType | null {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 12 && bytes.toString('latin1', 0, 4) === 'RIFF' && bytes.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

/** Row ids are uuids; anything else in an address or a cursor names no row, so it never reaches a `::uuid` cast. */
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export class ProductCatalog {
  constructor(
    private readonly sql: Sql,
    private readonly imageRule: ProductImageRule,
  ) {}

  /** The owner's image rule as the portal shows it before an upload. */
  imageRules(caller: MerchantCaller): ProductImageRules {
    assertPermission(caller, 'products.read');
    return { maxBytes: this.imageRule.maxBytes, types: [...PRODUCT_IMAGE_TYPES] };
  }

  async list(
    caller: MerchantCaller,
    input: { status?: 'active' | 'archived' | undefined; limit?: number | undefined; cursor?: string | undefined },
  ) {
    assertPermission(caller, 'products.read');
    const limit = requireLimit(input.limit);
    const after = decodeCursor(input.cursor);
    if (after && !UUID.test(after.key)) throw new MerchantOpsError('pay.cursor_invalid', 'bad_request');
    const sql = this.sql;
    const rows = await sql<ProductRow[]>`
      SELECT ${FIELDS(sql)} FROM pay.catalog_products
       WHERE merchant_id = ${caller.merchantId} AND mode = ${MODE}
         ${input.status ? sql`AND status = ${input.status}` : sql``}
         ${after ? sql`AND (created_at, id) < ((${after.ts}::text)::timestamptz, ${after.key}::uuid)` : sql``}
       ORDER BY created_at DESC, id DESC
       LIMIT ${limit + 1}`;
    return toPage(rows, limit, view, (row) => encodeCursor(row.cursor_ts, row.id));
  }

  async get(caller: MerchantCaller, productId: string): Promise<MerchantProduct> {
    assertPermission(caller, 'products.read');
    if (!UUID.test(productId)) throw productNotFound();
    const sql = this.sql;
    const rows = await sql<ProductRow[]>`
      SELECT ${FIELDS(sql)} FROM pay.catalog_products
       WHERE id = ${productId}::uuid AND merchant_id = ${caller.merchantId} AND mode = ${MODE}`;
    if (!rows[0]) throw productNotFound();
    return view(rows[0]);
  }

  async create(caller: MerchantCaller, input: ProductCreateInput): Promise<{ product: MerchantProduct; replayed: boolean }> {
    assertWriter(caller);
    if ((input.type === 'event') !== (input.event !== undefined))
      throw new MerchantOpsError(
        input.type === 'event' ? 'pay.product_event_details_required' : 'pay.product_event_details_not_event',
        'bad_request',
      );
    const hash = requestHash(input);
    const replay = await this.replay(caller, input.requestId, hash);
    if (replay) return { product: replay, replayed: true };
    if (input.imageId) {
      const image = await this.sql<Array<{ id: string }>>`
        SELECT id FROM pay.catalog_product_images WHERE id = ${input.imageId}::uuid AND merchant_id = ${caller.merchantId}`;
      if (!image[0]) throw imageNotFound();
    }
    const sql = this.sql;
    try {
      const rows = await sql<ProductRow[]>`
        INSERT INTO pay.catalog_products
          (merchant_id, mode, product_key, request_id, request_hash, name, type, unit_label, statement_descriptor,
           event_starts_at, event_location, image_id, created_by)
        VALUES
          (${caller.merchantId}, ${MODE}, ${input.productKey ?? generatedKey()}, ${input.requestId}::uuid, ${hash}, ${input.name},
           ${input.type}, ${input.unitLabel ?? null}, ${input.statementDescriptor ?? null},
           ${input.event ? new Date(input.event.startsAt) : null}, ${input.event?.location ?? null}, ${input.imageId ?? null},
           ${caller.userId})
        RETURNING ${FIELDS(sql)}`;
      return { product: view(rows[0]!), replayed: false };
    } catch (err) {
      if (isUnique(err, 'catalog_products_request_once')) {
        // The same request won a race with this one: answer as its replay.
        const raced = await this.replay(caller, input.requestId, hash);
        if (raced) return { product: raced, replayed: true };
      }
      if (isUnique(err, 'catalog_products_key_once')) throw new MerchantOpsError('pay.product_id_taken', 'conflict');
      // Its image was deleted with another product between the check above and this insert.
      if ((err as { code?: string }).code === '23503') throw imageNotFound();
      throw err;
    }
  }

  /** Archive or unarchive a product. Setting the status it already has answers with the product unchanged. */
  async setStatus(caller: MerchantCaller, productId: string, status: 'active' | 'archived'): Promise<MerchantProduct> {
    assertWriter(caller);
    if (!UUID.test(productId)) throw productNotFound();
    const sql = this.sql;
    const rows = await sql<ProductRow[]>`
      UPDATE pay.catalog_products SET status = ${status}, version = version + 1, updated_at = now()
       WHERE id = ${productId}::uuid AND merchant_id = ${caller.merchantId} AND mode = ${MODE} AND status <> ${status}
      RETURNING ${FIELDS(sql)}`;
    return rows[0] ? view(rows[0]) : this.get(caller, productId);
  }

  /**
   * Delete a product that has no price. One with a price, archived or not, is refused (`pay.product_has_prices`): a
   * price may be named by a subscription or a document, so the product is archived instead. Its image is deleted with
   * it unless another product shows the same image.
   */
  async delete(caller: MerchantCaller, productId: string): Promise<{ productId: string; deleted: true }> {
    assertWriter(caller);
    if (!UUID.test(productId)) throw productNotFound();
    return this.sql.begin(async (tx) => {
      const [row] = await tx<Array<{ id: string; image_id: string | null; request_id: string; request_hash: string }>>`
        SELECT id, image_id, request_id, request_hash FROM pay.catalog_products
         WHERE id = ${productId}::uuid AND merchant_id = ${caller.merchantId} AND mode = ${MODE}
         FOR UPDATE`;
      if (!row) throw productNotFound();
      // Prices take the product's lock to be made, so none can appear between this check and the delete.
      const [priced] = await tx`SELECT 1 FROM pay.catalog_prices WHERE product_id = ${productId}::uuid LIMIT 1`;
      if (priced) throw new MerchantOpsError('pay.product_has_prices', 'precondition');
      await tx`DELETE FROM pay.catalog_products WHERE id = ${productId}::uuid`;
      // The create that made it stays known, so a retry of it is told the product was deleted, not made again.
      await tx`
        INSERT INTO pay.catalog_product_tombstones (merchant_id, request_id, request_hash, product_id, deleted_by)
        VALUES (${caller.merchantId}, ${row.request_id}::uuid, ${row.request_hash}, ${row.id}::uuid, ${caller.userId})`;
      if (row.image_id) {
        // A product being made with the same image at this moment keeps it: the image's delete gives way (in a
        // savepoint, so the product's delete still commits) rather than failing the whole request.
        await tx
          .savepoint(
            (sp) => sp`
              DELETE FROM pay.catalog_product_images i
               WHERE i.id = ${row.image_id}::uuid AND i.merchant_id = ${caller.merchantId}
                 AND NOT EXISTS (SELECT 1 FROM pay.catalog_products p WHERE p.image_id = i.id)`,
          )
          .catch((err: unknown) => {
            if ((err as { code?: string }).code !== '23503') throw err;
          });
      }
      return { productId: row.id, deleted: true as const };
    });
  }

  private async replay(caller: MerchantCaller, requestId: string, hash: string): Promise<MerchantProduct | null> {
    const sql = this.sql;
    const [gone] = await sql<Array<{ request_hash: string }>>`
      SELECT request_hash FROM pay.catalog_product_tombstones WHERE merchant_id = ${caller.merchantId} AND request_id = ${requestId}::uuid`;
    if (gone) throw new MerchantOpsError(gone.request_hash === hash ? 'pay.product_deleted' : 'pay.request_id_reused', 'conflict');
    const rows = await sql<ProductRow[]>`
      SELECT ${FIELDS(sql)} FROM pay.catalog_products WHERE merchant_id = ${caller.merchantId} AND request_id = ${requestId}::uuid`;
    if (!rows[0]) return null;
    if (rows[0].request_hash !== hash) throw new MerchantOpsError('pay.request_id_reused', 'conflict');
    return view(rows[0]);
  }

  /**
   * Keep one product image. Refused while the owner has published no size, when the file is over it, and when its
   * bytes are not one of the allowed types or not the type the browser named. The same request id with the same file
   * answers with the image it kept.
   */
  async uploadImage(caller: MerchantCaller, input: { requestId: string; contentType: string; dataBase64: string }) {
    assertWriter(caller);
    const maxBytes = this.imageRule.maxBytes;
    if (maxBytes === null) throw new MerchantOpsError('pay.product_image_rules_unset', 'precondition');
    // Refuse an oversized file before decoding it; the decoded size is checked again below.
    if (Math.floor((input.dataBase64.length * 3) / 4) - 2 > maxBytes)
      throw new MerchantOpsError('pay.product_image_too_large', 'bad_request');
    if (!BASE64.test(input.dataBase64)) throw new MerchantOpsError('pay.product_image_unreadable', 'bad_request');
    const bytes = Buffer.from(input.dataBase64, 'base64');
    if (bytes.length === 0) throw new MerchantOpsError('pay.product_image_unreadable', 'bad_request');
    if (bytes.length > maxBytes) throw new MerchantOpsError('pay.product_image_too_large', 'bad_request');
    const type = sniffImageType(bytes);
    if (!type || type !== input.contentType.toLowerCase()) throw new MerchantOpsError('pay.product_image_type_refused', 'bad_request');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const sql = this.sql;
    const prior = async () => {
      const rows = await sql<Array<{ id: string; content_type: ImageType; byte_size: number; sha256: string }>>`
        SELECT id, content_type, byte_size, sha256 FROM pay.catalog_product_images
         WHERE merchant_id = ${caller.merchantId} AND request_id = ${input.requestId}::uuid`;
      if (!rows[0]) return null;
      if (rows[0].sha256 !== sha256 || rows[0].content_type !== type) throw new MerchantOpsError('pay.request_id_reused', 'conflict');
      return { imageId: rows[0].id, contentType: rows[0].content_type, byteSize: rows[0].byte_size, sha256: rows[0].sha256 };
    };
    const kept = await prior();
    if (kept) return kept;
    try {
      const rows = await sql<Array<{ id: string }>>`
        INSERT INTO pay.catalog_product_images (merchant_id, request_id, content_type, byte_size, sha256, bytes, uploaded_by)
        VALUES (${caller.merchantId}, ${input.requestId}::uuid, ${type}, ${bytes.length}, ${sha256}, ${bytes}, ${caller.userId})
        RETURNING id`;
      return { imageId: rows[0]!.id, contentType: type, byteSize: bytes.length, sha256 };
    } catch (err) {
      if (isUnique(err, 'catalog_product_images_request_once')) {
        const raced = await prior();
        if (raced) return raced;
      }
      throw err;
    }
  }

  async image(caller: MerchantCaller, imageId: string) {
    assertPermission(caller, 'products.read');
    const rows = await this.sql<Array<{ id: string; content_type: ImageType; byte_size: number; sha256: string; bytes: Buffer }>>`
      SELECT id, content_type, byte_size, sha256, bytes FROM pay.catalog_product_images
       WHERE id = ${imageId}::uuid AND merchant_id = ${caller.merchantId}`;
    const row = rows[0];
    if (!row) throw imageNotFound();
    return {
      imageId: row.id,
      contentType: row.content_type,
      byteSize: row.byte_size,
      sha256: row.sha256,
      dataBase64: row.bytes.toString('base64'),
    };
  }
}
