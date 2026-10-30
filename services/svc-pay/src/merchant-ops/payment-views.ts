import type { Sql } from 'postgres';
import {
  PAYMENT_VIEW_COLUMNS,
  type PaymentMaskedField,
  type PaymentView,
  type PaymentViewColumn,
  type PaymentViewFilters,
} from '@intafaced/contracts/pay-payment-views';
import { MerchantOpsError } from './errors.js';
import { maskCustomerEmail } from './invoices.js';
import { decodeCursor, encodeCursor, requireLimit, toPage, type Page } from './pagination.js';
import { assertPermission, roleHasPermission, type MerchantCaller, type MerchantRole } from './roles.js';

/**
 * SAVED VIEWS AND ROLE-GATED PAYMENT DETAILS (M-adv-payments-core-01).
 *
 * A view is one person's (private) or the team's (shared) filters and columns for the payments list. Every query starts
 * from the caller's own merchant, resolved from the principal, so another business's view id reads as one that does not
 * exist, and so does a teammate's private view. Only the owner or an admin makes, changes or removes a shared view.
 *
 * The payer's email on a payment is the one on the invoice that payment paid (`pay.merchant_invoices.payment_id`); no
 * new payer contact is stored. The list shows it masked to every role. `unmask` gives one clear value to a role holding
 * `payments.unmask`, from an interactive session, with a reason, and writes one audit row first: if the write fails no
 * value is returned. The audit row never holds the clear value.
 */

const SHARED_EDITORS = new Set<MerchantRole>(['owner', 'admin']);

interface ViewRow {
  id: string;
  owner_user_id: string;
  name: string;
  visibility: 'private' | 'shared';
  filters: PaymentViewFilters;
  columns: PaymentViewColumn[];
  revision: number;
  created_at: Date;
  updated_at: Date;
  cursor_ts: string;
}

/** Filters in one key order, so two equal sets compare equal. */
function canonicalFilters(filters: PaymentViewFilters): PaymentViewFilters {
  const out: Record<string, string> = {};
  for (const key of ['status', 'search', 'assetId', 'date'] as const) {
    const value = filters[key];
    if (typeof value === 'string' && value.length > 0) out[key] = value;
  }
  return out as PaymentViewFilters;
}

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Columns in the order the list draws them, so the same set saved in another order is the same view. */
const canonicalColumns = (columns: readonly PaymentViewColumn[]): PaymentViewColumn[] =>
  PAYMENT_VIEW_COLUMNS.filter((c) => columns.includes(c));

const uniqueViolation = (error: unknown) => (error as { code?: string }).code === '23505';

const viewNotFound = () => new MerchantOpsError('pay.payment_view_not_found', 'not_found');

function requireInteractive(caller: MerchantCaller, code: `pay.${string}`): void {
  if (!caller.interactive || caller.viaApiKey) throw new MerchantOpsError(code, 'forbidden');
}

function canEdit(caller: MerchantCaller, row: Pick<ViewRow, 'visibility' | 'owner_user_id'>): boolean {
  return row.visibility === 'shared' ? SHARED_EDITORS.has(caller.role) : row.owner_user_id === caller.userId;
}

function toView(caller: MerchantCaller, row: ViewRow): PaymentView {
  return {
    id: row.id,
    name: row.name,
    visibility: row.visibility,
    filters: canonicalFilters(row.filters),
    columns: row.columns,
    mine: row.owner_user_id === caller.userId,
    editable: canEdit(caller, row),
    revision: row.revision,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export class PaymentViews {
  constructor(private readonly sql: Sql) {}

  private cols() {
    return this.sql`id::text, owner_user_id, name, visibility, filters, columns, revision, created_at, updated_at,
      to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_ts`;
  }

  /** The caller's own views and the team's shared ones, newest first. */
  async list(caller: MerchantCaller, input: { limit?: number | undefined; cursor?: string | undefined }): Promise<Page<PaymentView>> {
    assertPermission(caller, 'payments.read');
    const limit = requireLimit(input.limit);
    const after = decodeCursor(input.cursor);
    const rows = await this.sql<ViewRow[]>`
      SELECT ${this.cols()} FROM pay.payment_views
       WHERE merchant_id = ${caller.merchantId}
         AND (visibility = 'shared' OR owner_user_id = ${caller.userId})
         ${after ? this.sql`AND (created_at, id::text) < ((${after.ts}::text)::timestamptz, ${after.key})` : this.sql``}
       ORDER BY created_at DESC, id DESC
       LIMIT ${limit + 1}`;
    return toPage(
      rows,
      limit,
      (row) => toView(caller, row),
      (row) => encodeCursor(row.cursor_ts, row.id),
    );
  }

  /** Idempotent on (person, name): the same view again answers the saved one; a different one under that name refuses. */
  async create(
    caller: MerchantCaller,
    input: { name: string; visibility: 'private' | 'shared'; filters: PaymentViewFilters; columns: PaymentViewColumn[] },
  ): Promise<PaymentView> {
    assertPermission(caller, 'payments.read');
    requireInteractive(caller, 'pay.payment_view_interactive_only');
    if (input.visibility === 'shared' && !SHARED_EDITORS.has(caller.role)) {
      throw new MerchantOpsError('pay.payment_view_shared_admin_only', 'forbidden');
    }
    const name = input.name.trim();
    const filters = canonicalFilters(input.filters);
    const columns = canonicalColumns(input.columns);
    const inserted = await this.sql<ViewRow[]>`
      INSERT INTO pay.payment_views (merchant_id, owner_user_id, name, visibility, filters, columns)
      VALUES (${caller.merchantId}, ${caller.userId}, ${name}, ${input.visibility}, ${this.sql.json(filters)}, ${columns}::text[])
      ON CONFLICT (merchant_id, owner_user_id, lower(name)) DO NOTHING
      RETURNING ${this.cols()}`;
    if (inserted[0]) return toView(caller, inserted[0]);
    const existing = await this.sql<ViewRow[]>`
      SELECT ${this.cols()} FROM pay.payment_views
       WHERE merchant_id = ${caller.merchantId} AND owner_user_id = ${caller.userId} AND lower(name) = lower(${name})`;
    const prior = existing[0];
    if (
      prior &&
      prior.name === name &&
      prior.visibility === input.visibility &&
      sameJson(canonicalFilters(prior.filters), filters) &&
      sameJson(canonicalColumns(prior.columns), columns)
    ) {
      return toView(caller, prior);
    }
    throw new MerchantOpsError('pay.payment_view_name_taken', 'conflict');
  }

  async update(
    caller: MerchantCaller,
    input: {
      viewId: string;
      expectedRevision: number;
      name?: string | undefined;
      filters?: PaymentViewFilters | undefined;
      columns?: PaymentViewColumn[] | undefined;
    },
  ): Promise<PaymentView> {
    const row = await this.editable(caller, input.viewId);
    const name = input.name?.trim() ?? row.name;
    const filters = input.filters ? canonicalFilters(input.filters) : canonicalFilters(row.filters);
    const columns = canonicalColumns(input.columns ?? row.columns);
    let saved: ViewRow[];
    try {
      saved = await this.sql<ViewRow[]>`
        UPDATE pay.payment_views
           SET name = ${name}, filters = ${this.sql.json(filters)}, columns = ${columns}::text[],
               revision = revision + 1, updated_at = now()
         WHERE id = ${row.id}::uuid AND merchant_id = ${caller.merchantId} AND revision = ${input.expectedRevision}
         RETURNING ${this.cols()}`;
    } catch (error) {
      if (uniqueViolation(error)) throw new MerchantOpsError('pay.payment_view_name_taken', 'conflict');
      throw error;
    }
    if (!saved[0]) throw new MerchantOpsError('pay.payment_view_stale', 'conflict');
    return toView(caller, saved[0]);
  }

  async remove(caller: MerchantCaller, input: { viewId: string }): Promise<{ deleted: true }> {
    const row = await this.editable(caller, input.viewId);
    await this.sql`DELETE FROM pay.payment_views WHERE id = ${row.id}::uuid AND merchant_id = ${caller.merchantId}`;
    return { deleted: true };
  }

  /** A view the caller can see, and may change: a teammate's private view reads as missing, a shared one as forbidden. */
  private async editable(caller: MerchantCaller, viewId: string): Promise<ViewRow> {
    assertPermission(caller, 'payments.read');
    requireInteractive(caller, 'pay.payment_view_interactive_only');
    const rows = await this.sql<ViewRow[]>`
      SELECT ${this.cols()} FROM pay.payment_views
       WHERE id = ${viewId}::uuid AND merchant_id = ${caller.merchantId}
         AND (visibility = 'shared' OR owner_user_id = ${caller.userId})`;
    const row = rows[0];
    if (!row) throw viewNotFound();
    if (!canEdit(caller, row)) throw new MerchantOpsError('pay.payment_view_forbidden', 'forbidden');
    return row;
  }
}

/** The last four characters, the rest hidden. Short references hide whole. */
export function maskRailRef(ref: string | null): string | null {
  if (ref === null) return null;
  return ref.length > 8 ? `***${ref.slice(-4)}` : '***';
}

/** Whether a reader sees the rail reference as it is. Roles that cannot unmask read it masked (viewer, developer). */
export function seesClearRailRef(role: MerchantRole): boolean {
  return roleHasPermission(role, 'payments.unmask');
}

interface UnmaskRow {
  id: string;
  payment_id: string;
  field: PaymentMaskedField;
  actor_id: string;
  actor_role: MerchantRole;
  reason: string;
  created_at: Date;
  cursor_ts: string;
}

export class PaymentPrivacy {
  constructor(private readonly sql: Sql) {}

  /** The masked payer email for each payment that paid an invoice of this merchant with one. */
  async maskedEmails(merchantId: string, paymentIds: readonly string[]): Promise<Map<string, string>> {
    if (paymentIds.length === 0) return new Map();
    const rows = await this.sql<Array<{ payment_id: string; customer_email: string }>>`
      SELECT payment_id::text, customer_email FROM pay.merchant_invoices
       WHERE merchant_id = ${merchantId} AND payment_id = ANY(${[...paymentIds]}::uuid[]) AND customer_email IS NOT NULL`;
    return new Map(rows.map((r) => [r.payment_id, maskCustomerEmail(r.customer_email) ?? '***']));
  }

  /** One clear value, after its audit row is written. */
  async unmask(
    caller: MerchantCaller,
    input: { paymentId: string; field: PaymentMaskedField; reason: string },
  ): Promise<{ paymentId: string; field: PaymentMaskedField; value: string | null; auditId: string }> {
    assertPermission(caller, 'payments.unmask');
    requireInteractive(caller, 'pay.payment_unmask_interactive_only');
    const reason = input.reason.trim();
    if (reason.length < 8) throw new MerchantOpsError('pay.payment_unmask_reason_required', 'bad_request');
    return this.sql.begin(async (tx) => {
      const payments = await tx<Array<{ id: string }>>`
        SELECT id::text FROM pay.payments WHERE id = ${input.paymentId}::uuid AND merchant_id = ${caller.merchantId}`;
      const payment = payments[0];
      if (!payment) throw new MerchantOpsError('pay.payment_not_found', 'not_found');
      // The one field there is today: the email on the invoice this payment paid.
      const emails = await tx<Array<{ customer_email: string | null }>>`
        SELECT customer_email FROM pay.merchant_invoices
         WHERE merchant_id = ${caller.merchantId} AND payment_id = ${payment.id}::uuid`;
      const value = emails[0]?.customer_email ?? null;
      const audit = await tx<Array<{ id: string }>>`
        INSERT INTO pay.payment_unmask_reads (merchant_id, payment_id, field, actor_id, actor_role, reason)
        VALUES (${caller.merchantId}, ${payment.id}::uuid, ${input.field}, ${caller.userId}, ${caller.role}, ${reason})
        RETURNING id::text`;
      return { paymentId: payment.id, field: input.field, value, auditId: audit[0]!.id };
    });
  }

  /** The audit of clear values shown, newest first. The owner and admins read it. */
  async reads(caller: MerchantCaller, input: { paymentId?: string | undefined; limit?: number | undefined; cursor?: string | undefined }) {
    assertPermission(caller, 'team.manage');
    const limit = requireLimit(input.limit);
    const after = decodeCursor(input.cursor);
    const rows = await this.sql<UnmaskRow[]>`
      SELECT id::text, payment_id::text, field, actor_id, actor_role, reason, created_at,
             to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_ts
        FROM pay.payment_unmask_reads
       WHERE merchant_id = ${caller.merchantId}
         ${input.paymentId ? this.sql`AND payment_id = ${input.paymentId}::uuid` : this.sql``}
         ${after ? this.sql`AND (created_at, id::text) < ((${after.ts}::text)::timestamptz, ${after.key})` : this.sql``}
       ORDER BY created_at DESC, id DESC
       LIMIT ${limit + 1}`;
    return toPage(
      rows,
      limit,
      (r) => ({
        id: r.id,
        paymentId: r.payment_id,
        field: r.field,
        actorId: r.actor_id,
        actorRole: r.actor_role,
        reason: r.reason,
        createdAt: r.created_at.toISOString(),
      }),
      (r) => encodeCursor(r.cursor_ts, r.id),
    );
  }
}
