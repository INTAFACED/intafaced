import { createHash } from 'node:crypto';
import type { Sql } from 'postgres';
import { formatAmount, parseAmount } from '@intafaced/ledger-client';
import { MerchantOpsError } from './errors.js';
import { maskCustomerEmail } from './invoices.js';
import { assertPermission, canUnmaskPayments, type MerchantCaller, type MerchantRole } from './roles.js';

/**
 * Saved payment-list views and shopper reveal (M-adv-payments-core-01).
 *
 * The payments list at `/pay/payments` stores a filter, a sort and the columns
 * the person chose. A private view is idempotent on (user, name). A shared
 * view is idempotent on (business, name) and only an owner or admin may write
 * it. The same definition returns the first row. A different definition for
 * that name refuses. Nothing here moves money, and no amount is invented.
 *
 * Shopper email and name come from the payment's created-event metadata.
 * A missing field is null. `shopper` always returns the masked form. `unmask`
 * returns the stored values and writes the audit row in the same transaction.
 */

export const PAYMENT_VIEW_COLUMNS = [
  'id',
  'createdAt',
  'status',
  'amount',
  'assetId',
  'capturedAmount',
  'refundedAmount',
  'method',
  'customerRef',
  'description',
  'customerEmail',
  'customerName',
  'railRef',
] as const;
export type PaymentViewColumn = (typeof PAYMENT_VIEW_COLUMNS)[number];

export const PAYMENT_VIEW_SORT_FIELDS = ['createdAt', 'amount', 'status'] as const;
export type PaymentViewSortField = (typeof PAYMENT_VIEW_SORT_FIELDS)[number];

const PAYMENT_STATUSES = ['created', 'authorized', 'captured', 'settled', 'refunded', 'disputed', 'failed'] as const;
type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const COLUMN_SET = new Set<string>(PAYMENT_VIEW_COLUMNS);
const SORT_SET = new Set<string>(PAYMENT_VIEW_SORT_FIELDS);
const STATUS_SET = new Set<string>(PAYMENT_STATUSES);

export interface PaymentViewFilters {
  status?: PaymentStatus;
  search?: string;
  assetId?: string;
  from?: string;
  to?: string;
  linkId?: string;
  amountMin?: string;
  amountMax?: string;
}

export interface PaymentViewBody {
  filters: PaymentViewFilters;
  sort: { field: PaymentViewSortField; direction: 'asc' | 'desc' };
  columns: PaymentViewColumn[];
}

export interface PaymentViewRecord extends PaymentViewBody {
  id: string;
  name: string;
  visibility: 'private' | 'shared';
  createdAt: string;
  updatedAt: string;
}

export interface ShopperFields {
  paymentId: string;
  customerEmail: string | null;
  customerName: string | null;
  railRef: string | null;
  /** True when this caller may call unmask. The fields above stay masked either way. */
  canUnmask: boolean;
}

interface ViewRow {
  id: string;
  merchant_id: string;
  user_id: string;
  name: string;
  visibility: 'private' | 'shared';
  filters: unknown;
  sort_field: string;
  sort_direction: string;
  columns: string[];
  definition_hash: string;
  created_at: Date | string;
  updated_at: Date | string;
}

interface ShopperRow {
  id: string;
  rail_ref: string | null;
  payload: unknown;
}

const FILTER_KEYS = ['status', 'search', 'assetId', 'from', 'to', 'linkId', 'amountMin', 'amountMax'] as const;

export function maskShopperName(name: string | null): string | null {
  if (name === null) return null;
  const chars = [...name.trim()];
  const first = chars[0];
  if (!first) return null;
  return `${first}***`;
}

export function maskRailRef(railRef: string | null): string | null {
  if (railRef === null) return null;
  const trimmed = railRef.trim();
  if (!trimmed) return null;
  if (trimmed.length <= 4) return '****';
  return `****${trimmed.slice(-4)}`;
}

export function definitionHash(body: PaymentViewBody): string {
  const filters: Record<string, string> = {};
  if (body.filters.status !== undefined) filters.status = body.filters.status;
  if (body.filters.search !== undefined) filters.search = body.filters.search;
  if (body.filters.assetId !== undefined) filters.assetId = body.filters.assetId;
  if (body.filters.from !== undefined) filters.from = body.filters.from;
  if (body.filters.to !== undefined) filters.to = body.filters.to;
  if (body.filters.linkId !== undefined) filters.linkId = body.filters.linkId;
  if (body.filters.amountMin !== undefined) filters.amountMin = body.filters.amountMin;
  if (body.filters.amountMax !== undefined) filters.amountMax = body.filters.amountMax;
  return createHash('sha256')
    .update(JSON.stringify({ filters, sort: body.sort, columns: body.columns }))
    .digest('hex');
}

export function parseViewName(raw: string): string {
  const name = raw.trim();
  if (!name) throw new MerchantOpsError('pay.payment_view_name_blank', 'bad_request');
  if (name.length > 80) throw new MerchantOpsError('pay.payment_view_name_invalid', 'bad_request');
  return name;
}

export function parseVisibility(raw: string): 'private' | 'shared' {
  if (raw !== 'private' && raw !== 'shared') throw new MerchantOpsError('pay.payment_view_visibility_invalid', 'bad_request');
  return raw;
}

export function parseViewBody(input: { filters?: unknown; sort?: unknown; columns?: unknown }): PaymentViewBody {
  return { filters: parseFilters(input.filters), sort: parseSort(input.sort), columns: parseColumns(input.columns) };
}

function canShare(role: MerchantRole): boolean {
  return role === 'owner' || role === 'admin';
}

function filtersDocument(filters: PaymentViewFilters): Record<string, string> {
  const out: Record<string, string> = {};
  if (filters.status !== undefined) out.status = filters.status;
  if (filters.search !== undefined) out.search = filters.search;
  if (filters.assetId !== undefined) out.assetId = filters.assetId;
  if (filters.from !== undefined) out.from = filters.from;
  if (filters.to !== undefined) out.to = filters.to;
  if (filters.linkId !== undefined) out.linkId = filters.linkId;
  if (filters.amountMin !== undefined) out.amountMin = filters.amountMin;
  if (filters.amountMax !== undefined) out.amountMax = filters.amountMax;
  return out;
}

const asDb = (tx: unknown): Sql => tx as Sql;

function parseColumns(raw: unknown): PaymentViewColumn[] {
  if (!Array.isArray(raw) || raw.length === 0) throw new MerchantOpsError('pay.payment_view_columns_blank', 'bad_request');
  const columns: PaymentViewColumn[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (typeof item !== 'string' || !COLUMN_SET.has(item)) throw new MerchantOpsError('pay.payment_view_column_unknown', 'bad_request');
    if (seen.has(item)) throw new MerchantOpsError('pay.payment_view_column_repeated', 'bad_request');
    seen.add(item);
    columns.push(item as PaymentViewColumn);
  }
  return columns;
}

function parseSort(raw: unknown): PaymentViewBody['sort'] {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new MerchantOpsError('pay.payment_view_sort_unknown', 'bad_request');
  const rec = raw as Record<string, unknown>;
  const field = rec.field;
  const direction = rec.direction;
  if (typeof field !== 'string' || !field.trim() || !SORT_SET.has(field)) {
    throw new MerchantOpsError('pay.payment_view_sort_unknown', 'bad_request');
  }
  if (direction !== 'asc' && direction !== 'desc') throw new MerchantOpsError('pay.payment_view_sort_unknown', 'bad_request');
  if (Object.keys(rec).some((key) => key !== 'field' && key !== 'direction')) {
    throw new MerchantOpsError('pay.payment_view_sort_unknown', 'bad_request');
  }
  return { field: field as PaymentViewSortField, direction };
}

function parseFilters(raw: unknown): PaymentViewFilters {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new MerchantOpsError('pay.payment_view_filter_invalid', 'bad_request');
  const rec = raw as Record<string, unknown>;
  for (const key of Object.keys(rec)) {
    if (!(FILTER_KEYS as readonly string[]).includes(key)) throw new MerchantOpsError('pay.payment_view_filter_invalid', 'bad_request');
  }
  const filters: PaymentViewFilters = {};
  if (rec.status !== undefined) {
    if (typeof rec.status !== 'string' || !STATUS_SET.has(rec.status)) {
      throw new MerchantOpsError('pay.payment_view_filter_invalid', 'bad_request');
    }
    filters.status = rec.status as PaymentStatus;
  }
  if (rec.search !== undefined) {
    if (typeof rec.search !== 'string') throw new MerchantOpsError('pay.payment_view_filter_invalid', 'bad_request');
    const search = rec.search.trim();
    if (!search || search.length > 200) throw new MerchantOpsError('pay.payment_view_filter_invalid', 'bad_request');
    filters.search = search;
  }
  if (rec.assetId !== undefined) {
    if (typeof rec.assetId !== 'string' || !/^[A-Za-z0-9._-]{1,16}$/.test(rec.assetId)) {
      throw new MerchantOpsError('pay.payment_view_filter_invalid', 'bad_request');
    }
    filters.assetId = rec.assetId;
  }
  if (rec.linkId !== undefined) {
    if (typeof rec.linkId !== 'string' || !UUID.test(rec.linkId)) {
      throw new MerchantOpsError('pay.payment_view_filter_invalid', 'bad_request');
    }
    filters.linkId = rec.linkId.toLowerCase();
  }
  const from = instant(rec.from);
  const to = instant(rec.to);
  if (from) filters.from = from;
  if (to) filters.to = to;
  if (from && to && from >= to) throw new MerchantOpsError('pay.payment_view_filter_invalid', 'bad_request');
  const amountMin = moneyFilter(rec.amountMin);
  const amountMax = moneyFilter(rec.amountMax);
  if (amountMin !== undefined) filters.amountMin = amountMin;
  if (amountMax !== undefined) filters.amountMax = amountMax;
  if (amountMin !== undefined && amountMax !== undefined && parseAmount(amountMin) > parseAmount(amountMax)) {
    throw new MerchantOpsError('pay.payment_view_filter_invalid', 'bad_request');
  }
  return filters;
}

function instant(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !value.trim()) throw new MerchantOpsError('pay.payment_view_filter_invalid', 'bad_request');
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new MerchantOpsError('pay.payment_view_filter_invalid', 'bad_request');
  return date.toISOString();
}

function moneyFilter(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !value.trim()) throw new MerchantOpsError('pay.payment_view_filter_invalid', 'bad_request');
  try {
    return formatAmount(parseAmount(value));
  } catch {
    throw new MerchantOpsError('pay.payment_view_filter_invalid', 'bad_request');
  }
}

function textField(metadata: unknown, keys: readonly string[]): string | null {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
  const rec = metadata as Record<string, unknown>;
  for (const key of keys) {
    const value = rec[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function iso(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new MerchantOpsError('pay.payment_view_corrupt', 'unavailable');
  return date.toISOString();
}

function uniqueViolation(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);
    if ((current as { code?: string }).code === '23505') return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

function assertShare(caller: MerchantCaller, visibility: 'private' | 'shared'): void {
  if (visibility === 'shared' && !canShare(caller.role)) {
    throw new MerchantOpsError('pay.payment_view_shared_forbidden', 'forbidden');
  }
}

export class PaymentViews {
  constructor(private readonly sql: Sql) {}

  async list(caller: MerchantCaller): Promise<{ items: PaymentViewRecord[] }> {
    assertPermission(caller, 'payments.read');
    const rows = await this.sql<ViewRow[]>`
      SELECT id, merchant_id, user_id, name, visibility, filters, sort_field, sort_direction, columns,
             definition_hash, created_at, updated_at
        FROM pay.merchant_payment_views
       WHERE merchant_id = ${caller.merchantId}
         AND (visibility = 'shared' OR user_id = ${caller.userId})
       ORDER BY name, id`;
    return { items: rows.map((row) => this.toView(row)) };
  }

  async create(
    caller: MerchantCaller,
    input: { name: string; visibility: string; filters?: unknown; sort?: unknown; columns?: unknown },
  ): Promise<PaymentViewRecord> {
    assertPermission(caller, 'payments.read');
    const name = parseViewName(input.name);
    const visibility = parseVisibility(input.visibility);
    assertShare(caller, visibility);
    const body = parseViewBody(input);
    const hash = definitionHash(body);
    try {
      return await this.sql.begin(async (tx) => {
        const db = asDb(tx);
        const existing = await this.findByName(db, caller, visibility, name);
        if (existing) return this.replayOrConflict(existing, caller, hash);
        const inserted = await this.insert(db, caller, name, visibility, body, hash);
        return this.toView(inserted);
      });
    } catch (error) {
      if (error instanceof MerchantOpsError) throw error;
      if (!uniqueViolation(error)) throw error;
      const existing = await this.findByName(this.sql, caller, visibility, name);
      if (!existing) throw error;
      return this.replayOrConflict(existing, caller, hash);
    }
  }

  async update(
    caller: MerchantCaller,
    input: { viewId: string; name?: string; filters?: unknown; sort?: unknown; columns?: unknown },
  ): Promise<PaymentViewRecord> {
    assertPermission(caller, 'payments.read');
    if (!UUID.test(input.viewId)) throw new MerchantOpsError('pay.payment_view_not_found', 'not_found');
    const body = parseViewBody(input);
    const renamed = input.name === undefined ? null : parseViewName(input.name);
    const hash = definitionHash(body);
    try {
      return await this.sql.begin(async (tx) => {
        const db = asDb(tx);
        const row = await this.locked(db, caller, input.viewId);
        const name = renamed ?? row.name;
        if (name !== row.name) {
          const clash = await this.findByName(db, caller, row.visibility, name);
          if (clash && clash.id !== row.id) throw new MerchantOpsError('pay.payment_view_name_taken', 'conflict');
        }
        const [updated] = await db<ViewRow[]>`
          UPDATE pay.merchant_payment_views
             SET name = ${name},
                 filters = ${db.json(filtersDocument(body.filters))},
                 sort_field = ${body.sort.field},
                 sort_direction = ${body.sort.direction},
                 columns = ${db.array(body.columns)}::text[],
                 definition_hash = ${hash},
                 updated_at = now()
           WHERE id = ${row.id}
          RETURNING id, merchant_id, user_id, name, visibility, filters, sort_field, sort_direction, columns,
                    definition_hash, created_at, updated_at`;
        if (!updated) throw new MerchantOpsError('pay.payment_view_not_found', 'not_found');
        return this.toView(updated);
      });
    } catch (error) {
      if (error instanceof MerchantOpsError) throw error;
      if (!uniqueViolation(error)) throw error;
      throw new MerchantOpsError('pay.payment_view_name_taken', 'conflict');
    }
  }

  async delete(caller: MerchantCaller, viewId: string): Promise<{ deleted: true }> {
    assertPermission(caller, 'payments.read');
    if (!UUID.test(viewId)) throw new MerchantOpsError('pay.payment_view_not_found', 'not_found');
    await this.sql.begin(async (tx) => {
      const db = asDb(tx);
      const row = await this.locked(db, caller, viewId);
      await db`DELETE FROM pay.merchant_payment_views WHERE id = ${row.id}`;
    });
    return { deleted: true };
  }

  async shopper(caller: MerchantCaller, paymentId: string): Promise<ShopperFields> {
    assertPermission(caller, 'payments.read');
    const stored = await this.loadShopper(this.sql, caller.merchantId, paymentId);
    if (!stored) throw new MerchantOpsError('pay.payment_not_found', 'not_found');
    return {
      paymentId: stored.paymentId,
      customerEmail: maskCustomerEmail(stored.customerEmail),
      customerName: maskShopperName(stored.customerName),
      railRef: maskRailRef(stored.railRef),
      canUnmask: canUnmaskPayments(caller.role) && caller.interactive && !caller.viaApiKey,
    };
  }

  async unmask(caller: MerchantCaller, paymentId: string, reason: string): Promise<Omit<ShopperFields, 'canUnmask'>> {
    assertPermission(caller, 'payments.read');
    if (!canUnmaskPayments(caller.role)) throw new MerchantOpsError('pay.payment_unmask_forbidden', 'forbidden');
    if (!caller.interactive || caller.viaApiKey) throw new MerchantOpsError('pay.payment_unmask_interactive_only', 'forbidden');
    const trimmed = reason.trim();
    if (!trimmed) throw new MerchantOpsError('pay.payment_unmask_reason_blank', 'bad_request');
    if (trimmed.length > 500) throw new MerchantOpsError('pay.payment_unmask_reason_invalid', 'bad_request');
    if (!UUID.test(paymentId)) throw new MerchantOpsError('pay.payment_not_found', 'not_found');
    return this.sql.begin(async (tx) => {
      const db = asDb(tx);
      const stored = await this.loadShopper(db, caller.merchantId, paymentId);
      if (!stored) throw new MerchantOpsError('pay.payment_not_found', 'not_found');
      await db`
        INSERT INTO pay.control_audit (scope, scope_id, merchant_id, kind, outcome, actor_id, reason, after)
        VALUES (
          'merchant',
          ${stored.paymentId},
          ${caller.merchantId},
          'payment.unmask',
          'shown',
          ${caller.userId},
          ${trimmed},
          ${db.json({ paymentId: stored.paymentId })}
        )`;
      return {
        paymentId: stored.paymentId,
        customerEmail: stored.customerEmail,
        customerName: stored.customerName,
        railRef: stored.railRef,
      };
    });
  }

  private async findByName(sql: Sql, caller: MerchantCaller, visibility: 'private' | 'shared', name: string): Promise<ViewRow | null> {
    const rows =
      visibility === 'private'
        ? await sql<ViewRow[]>`
            SELECT id, merchant_id, user_id, name, visibility, filters, sort_field, sort_direction, columns,
                   definition_hash, created_at, updated_at
              FROM pay.merchant_payment_views
             WHERE merchant_id = ${caller.merchantId}
               AND user_id = ${caller.userId}
               AND visibility = 'private'
               AND name = ${name}`
        : await sql<ViewRow[]>`
            SELECT id, merchant_id, user_id, name, visibility, filters, sort_field, sort_direction, columns,
                   definition_hash, created_at, updated_at
              FROM pay.merchant_payment_views
             WHERE merchant_id = ${caller.merchantId}
               AND visibility = 'shared'
               AND name = ${name}`;
    return rows[0] ?? null;
  }

  private replayOrConflict(existing: ViewRow, caller: MerchantCaller, hash: string): PaymentViewRecord {
    if (existing.user_id !== caller.userId) throw new MerchantOpsError('pay.payment_view_name_taken', 'conflict');
    if (existing.definition_hash !== hash) throw new MerchantOpsError('pay.payment_view_conflict', 'conflict');
    return this.toView(existing);
  }

  private async insert(
    tx: Sql,
    caller: MerchantCaller,
    name: string,
    visibility: 'private' | 'shared',
    body: PaymentViewBody,
    hash: string,
  ): Promise<ViewRow> {
    const [row] = await tx<ViewRow[]>`
      INSERT INTO pay.merchant_payment_views (
        merchant_id, user_id, name, visibility, filters, sort_field, sort_direction, columns, definition_hash
      ) VALUES (
        ${caller.merchantId},
        ${caller.userId},
        ${name},
        ${visibility},
        ${tx.json(filtersDocument(body.filters))},
        ${body.sort.field},
        ${body.sort.direction},
        ${tx.array(body.columns)}::text[],
        ${hash}
      )
      RETURNING id, merchant_id, user_id, name, visibility, filters, sort_field, sort_direction, columns,
                definition_hash, created_at, updated_at`;
    if (!row) throw new MerchantOpsError('pay.payment_view_corrupt', 'unavailable');
    return row;
  }

  private async locked(tx: Sql, caller: MerchantCaller, viewId: string): Promise<ViewRow> {
    const [row] = await tx<ViewRow[]>`
      SELECT id, merchant_id, user_id, name, visibility, filters, sort_field, sort_direction, columns,
             definition_hash, created_at, updated_at
        FROM pay.merchant_payment_views
       WHERE id = ${viewId}::uuid AND merchant_id = ${caller.merchantId}
       FOR UPDATE`;
    if (!row || (row.visibility === 'private' && row.user_id !== caller.userId)) {
      throw new MerchantOpsError('pay.payment_view_not_found', 'not_found');
    }
    assertShare(caller, row.visibility);
    return row;
  }

  private async loadShopper(
    sql: Sql,
    merchantId: string,
    paymentId: string,
  ): Promise<{ paymentId: string; customerEmail: string | null; customerName: string | null; railRef: string | null } | null> {
    if (!UUID.test(paymentId)) return null;
    const [row] = await sql<ShopperRow[]>`
      SELECT p.id, p.rail_ref, e.payload
        FROM pay.payments p
        LEFT JOIN LATERAL (
          SELECT payload FROM pay.payment_events
           WHERE payment_id = p.id AND event = 'created'
           ORDER BY seq ASC
           LIMIT 1
        ) e ON true
       WHERE p.id = ${paymentId}::uuid AND p.merchant_id = ${merchantId}`;
    if (!row) return null;
    const payload = row.payload;
    const metadata =
      payload && typeof payload === 'object' && !Array.isArray(payload) ? (payload as { metadata?: unknown }).metadata : undefined;
    const railRef = typeof row.rail_ref === 'string' && row.rail_ref.trim() ? row.rail_ref : null;
    return {
      paymentId: row.id,
      customerEmail: textField(metadata, ['email', 'customerEmail']),
      customerName: textField(metadata, ['name', 'customerName']),
      railRef,
    };
  }

  private toView(row: ViewRow): PaymentViewRecord {
    const columns = parseColumns(row.columns);
    const sort = parseSort({ field: row.sort_field, direction: row.sort_direction });
    const filters = parseFilters(row.filters);
    return {
      id: row.id,
      name: row.name,
      visibility: row.visibility,
      filters,
      sort,
      columns,
      createdAt: iso(row.created_at),
      updatedAt: iso(row.updated_at),
    };
  }
}
