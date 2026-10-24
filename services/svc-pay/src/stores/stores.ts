import { createHash } from 'node:crypto';
import type { Sql } from 'postgres';
import type { MerchantStore, StoreCreateInput } from '@intafaced/contracts';
import { assertWriter, isUnique, UUID } from '../catalog/products.js';
import { MerchantOpsError } from '../merchant-ops/errors.js';
import { iso } from '../merchant-ops/money.js';
import { decodeCursor, encodeCursor, requireLimit, toPage } from '../merchant-ops/pagination.js';
import { assertPermission, type MerchantCaller } from '../merchant-ops/roles.js';

/**
 * A business's stores (M-adv-org-access-05, J-merchant-03 step 6): where it sells, each with a name unique in the
 * business, an optional address and its time zone. Every team role reads them; the roles that manage products add and
 * archive them, from an interactive session. A store is archived, never deleted (the table refuses a delete), so a
 * product's availability there and anything that names it later stay readable. Nothing here moves money.
 */

interface StoreRow {
  id: string;
  request_hash: string;
  name: string;
  address: string | null;
  timezone: string;
  status: 'active' | 'archived';
  version: number;
  created_at: Date;
  updated_at: Date;
  cursor_ts: string;
}

const FIELDS = (sql: Sql) => sql`
  id, request_hash, name, address, timezone, status, version, created_at, updated_at,
  to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_ts`;

const view = (row: StoreRow): MerchantStore => ({
  id: row.id,
  name: row.name,
  address: row.address,
  timezone: row.timezone,
  status: row.status,
  version: row.version,
  createdAt: iso(row.created_at),
  updatedAt: iso(row.updated_at),
});

export const storeNotFound = () => new MerchantOpsError('pay.store_not_found', 'not_found');

const requestHash = (input: StoreCreateInput) =>
  createHash('sha256')
    .update(JSON.stringify({ name: input.name, address: input.address ?? null, timezone: input.timezone }))
    .digest('hex');

export class MerchantStores {
  constructor(private readonly sql: Sql) {}

  async list(
    caller: MerchantCaller,
    input: { status?: 'active' | 'archived' | undefined; limit?: number | undefined; cursor?: string | undefined },
  ) {
    assertPermission(caller, 'products.read');
    const limit = requireLimit(input.limit);
    const after = decodeCursor(input.cursor);
    if (after && !UUID.test(after.key)) throw new MerchantOpsError('pay.cursor_invalid', 'bad_request');
    const sql = this.sql;
    const rows = await sql<StoreRow[]>`
      SELECT ${FIELDS(sql)} FROM pay.stores
       WHERE merchant_id = ${caller.merchantId}
         ${input.status ? sql`AND status = ${input.status}` : sql``}
         ${after ? sql`AND (created_at, id) > ((${after.ts}::text)::timestamptz, ${after.key}::uuid)` : sql``}
       ORDER BY created_at, id
       LIMIT ${limit + 1}`;
    return toPage(rows, limit, view, (row) => encodeCursor(row.cursor_ts, row.id));
  }

  /** Add a store. The same request id with the same details answers with the store it made. */
  async create(caller: MerchantCaller, input: StoreCreateInput): Promise<{ store: MerchantStore; replayed: boolean }> {
    assertWriter(caller);
    const hash = requestHash(input);
    const replay = await this.replay(caller, input.requestId, hash);
    if (replay) return { store: replay, replayed: true };
    const sql = this.sql;
    try {
      const rows = await sql<StoreRow[]>`
        INSERT INTO pay.stores (merchant_id, request_id, request_hash, name, address, timezone, created_by)
        VALUES (${caller.merchantId}, ${input.requestId}::uuid, ${hash}, ${input.name}, ${input.address ?? null}, ${input.timezone},
                ${caller.userId})
        RETURNING ${FIELDS(sql)}`;
      return { store: view(rows[0]!), replayed: false };
    } catch (err) {
      if (isUnique(err, 'stores_request_once')) {
        const raced = await this.replay(caller, input.requestId, hash);
        if (raced) return { store: raced, replayed: true };
      }
      if (isUnique(err, 'stores_name_once')) throw new MerchantOpsError('pay.store_name_taken', 'conflict');
      throw err;
    }
  }

  /** Archive or reopen a store. Setting the status it already has answers with the store unchanged. */
  async setStatus(caller: MerchantCaller, storeId: string, status: 'active' | 'archived'): Promise<MerchantStore> {
    assertWriter(caller);
    if (!UUID.test(storeId)) throw storeNotFound();
    const sql = this.sql;
    const rows = await sql<StoreRow[]>`
      UPDATE pay.stores SET status = ${status}, version = version + 1, updated_at = now()
       WHERE id = ${storeId}::uuid AND merchant_id = ${caller.merchantId} AND status <> ${status}
      RETURNING ${FIELDS(sql)}`;
    if (rows[0]) return view(rows[0]);
    const [same] = await sql<StoreRow[]>`
      SELECT ${FIELDS(sql)} FROM pay.stores WHERE id = ${storeId}::uuid AND merchant_id = ${caller.merchantId}`;
    if (!same) throw storeNotFound();
    return view(same);
  }

  private async replay(caller: MerchantCaller, requestId: string, hash: string): Promise<MerchantStore | null> {
    const sql = this.sql;
    const [row] = await sql<StoreRow[]>`
      SELECT ${FIELDS(sql)} FROM pay.stores WHERE merchant_id = ${caller.merchantId} AND request_id = ${requestId}::uuid`;
    if (!row) return null;
    if (row.request_hash !== hash) throw new MerchantOpsError('pay.request_id_reused', 'conflict');
    return view(row);
  }
}
