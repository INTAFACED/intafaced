import { createHash } from 'node:crypto';
import type { Sql } from 'postgres';
import { formatAmount, merchantClearing, merchantProceeds, type LedgerClient } from '@intafaced/ledger-client';
import type { DisputeCaseStore } from '../fraud/dispute-case.js';
import { MerchantOpsError } from './errors.js';
import { iso, money } from './money.js';
import { recordMerchantNotification } from './notifications.js';
import { decodeCursor, encodeCursor, requireLimit, toPage } from './pagination.js';
import { payoutReference } from './payouts.js';
import { boundAmount } from '../payments/amounts.js';
import { assertPermission, roleHasPermission, type MerchantCaller, type MerchantRole } from './roles.js';

/**
 * ASYNC CSV EXPORT JOBS (G5).
 *
 * `create` records a request and returns at once (`queued`). A runner picks the
 * job up, builds the file on the server, stores it with the job and marks it
 * `ready`. A download hands back that stored file; it never re-runs the query,
 * so a report cannot widen between "ready" and "download".
 *
 * ONLY THE CALLER'S ROWS (M6). Every generating query is
 * `WHERE merchant_id = <the job's merchant>`, and the merchant on a job is the
 * one resolved from the requesting principal at create time, never a field in
 * the request. The columns are an allowlist: no `risk_score`, no profile id, no
 * operator or founder field exists to leak. Text cells that start with = + - @
 * are neutralised so the file is safe to open in a spreadsheet.
 *
 * VISIBILITY. Owner and admin see every export of their merchant; other roles
 * see the ones they requested. A job id outside that is "not found".
 */
export const EXPORT_KINDS = ['payments', 'settlements', 'payouts', 'refunds', 'ledger_statement', 'disputes', 'fees'] as const;
export type ExportKind = (typeof EXPORT_KINDS)[number];

/**
 * Column allowlist per kind. A request that names anything else, including a
 * pricing rule id or a spread, is refused. Viewer and developer fee files omit
 * the rule layer; the fee amount itself is the booked snapshot.
 */
const EXPORT_COLUMNS: Record<ExportKind, readonly string[]> = {
  payments: [
    'payment_id',
    'created_at',
    'status',
    'asset',
    'amount',
    'captured_amount',
    'refunded_amount',
    'method',
    'rail',
    'rail_reference',
    'customer_reference',
  ],
  settlements: ['settlement_id', 'window', 'asset', 'gross', 'fees', 'net', 'status', 'payout_method', 'payout_reference', 'created_at'],
  payouts: ['settlement_id', 'window', 'asset', 'net_paid', 'status', 'payout_method', 'payout_reference', 'created_at'],
  refunds: ['event_id', 'payment_id', 'occurred_at', 'amount', 'asset'],
  ledger_statement: ['account', 'asset', 'kind', 'available'],
  disputes: ['dispute_id', 'payment_id', 'status', 'amount', 'asset', 'opened_at', 'reason_code'],
  fees: ['subject_kind', 'subject_id', 'asset', 'fee', 'recorded_at', 'fee_bps', 'applied_layer'],
};
const FEE_LAYER_COLUMNS = new Set(['fee_bps', 'applied_layer']);

export function resolveExportColumns(kind: ExportKind, role: MerchantRole, requested: readonly string[] | undefined): string[] {
  const known = EXPORT_COLUMNS[kind];
  const permit =
    kind === 'fees' && (role === 'viewer' || role === 'developer')
      ? known.filter((c) => !FEE_LAYER_COLUMNS.has(c))
      : // A role that reads the rail reference masked (M-adv-payments-core-01) gets no rail reference column at all.
        kind === 'payments' && !roleHasPermission(role, 'payments.unmask')
        ? known.filter((c) => c !== 'rail_reference')
        : known;
  if (requested === undefined) return [...permit];
  if (requested.length === 0 || new Set(requested).size !== requested.length || requested.some((c) => !permit.includes(c))) {
    throw new MerchantOpsError('pay.export_columns_forbidden', 'bad_request');
  }
  return [...requested];
}

const PAYMENT_STATUSES = ['created', 'authorized', 'captured', 'settled', 'refunded', 'disputed', 'failed'] as const;
const SETTLEMENT_STATUSES = ['pending', 'posted', 'paid_out', 'failed'] as const;

export interface ExportFilters {
  readonly from?: string;
  readonly to?: string;
  readonly status?: string;
  readonly assetId?: string;
  /** Inclusive decimal bounds. Only a payments export accepts them. */
  readonly amountMin?: string;
  readonly amountMax?: string;
}

/** Engineering ceiling so one request cannot hold the whole table in memory. A bigger report must be narrowed. */
export const DEFAULT_EXPORT_ROW_CEILING = 100_000;
const DEFAULT_BATCH = 1000;

export interface ExportDeps {
  readonly rowCeiling?: number;
  /** Rows read per query while generating. A test knob; the default is an engineering batch size, not a business number. */
  readonly batchSize?: number;
  /** How long (ms) a ready file stays downloadable. Unset = no expiry (no invented lifetime). */
  readonly ttlMs?: number;
  readonly now?: () => Date;
  /** Current clearing and proceeds balances. Absent: a ledger statement refuses. */
  readonly ledger?: Pick<LedgerClient, 'balances'>;
  /** Dispute cases. Absent: a disputes export refuses rather than inventing rows. */
  readonly disputes?: DisputeCaseStore;
}

interface JobRow {
  id: string;
  merchant_id: string;
  request_id: string;
  requested_by: string;
  kind: ExportKind;
  filters: ExportFilters;
  columns: string[] | null;
  status: 'queued' | 'running' | 'ready' | 'failed' | 'expired';
  failure_code: string | null;
  file_name: string | null;
  size_bytes: string | null;
  row_count: number | null;
  sha256: string | null;
  as_of: Date | null;
  generated_at: Date | null;
  expires_at: Date | null;
  created_at: Date;
  completed_at: Date | null;
  cursor_ts: string;
}

const JOB_FIELDS = (sql: Sql) => sql`
  id, merchant_id, request_id, requested_by, kind, filters, columns, status, failure_code, file_name, size_bytes::text, row_count, sha256,
  as_of, generated_at, expires_at, created_at, completed_at,
  to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_ts`;

const jobView = (r: JobRow) => ({
  jobId: r.id,
  kind: r.kind,
  filters: r.filters,
  columns: r.columns ?? [],
  status: r.status,
  failureCode: r.failure_code,
  fileName: r.file_name,
  sizeBytes: r.size_bytes,
  rowCount: r.row_count,
  sha256: r.sha256,
  requestedBy: r.requested_by,
  asOf: r.as_of ? iso(r.as_of) : null,
  generatedAt: r.generated_at ? iso(r.generated_at) : null,
  expiresAt: r.expires_at ? iso(r.expires_at) : null,
  createdAt: iso(r.created_at),
  completedAt: r.completed_at ? iso(r.completed_at) : null,
});
export type ExportJobView = ReturnType<typeof jobView>;

/** Quote a CSV cell; neutralise spreadsheet formulas in free text. */
export function csvText(value: string | null | undefined): string {
  let v = value ?? '';
  if (/^[=+\-@\t\r]/.test(v)) v = `'${v}`;
  return /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}
const csvRaw = (v: string | number | null | undefined) => (v === null || v === undefined ? '' : String(v));

function projectLine(header: readonly string[], cells: readonly string[], chosen: readonly string[]): string {
  const byName = new Map(header.map((name, i) => [name, cells[i] ?? '']));
  return chosen.map((name) => byName.get(name) ?? '').join(',');
}

export function validateFilters(kind: ExportKind, f: ExportFilters): void {
  const bad = () => new MerchantOpsError('pay.export_filter_invalid', 'bad_request');
  for (const key of ['from', 'to'] as const) {
    const v = f[key];
    if (v !== undefined && Number.isNaN(Date.parse(v))) throw bad();
  }
  if (f.from && f.to && Date.parse(f.from) >= Date.parse(f.to)) throw bad();
  if (f.status !== undefined) {
    const allowed: readonly string[] | undefined =
      kind === 'payments'
        ? PAYMENT_STATUSES
        : kind === 'settlements' || kind === 'payouts'
          ? SETTLEMENT_STATUSES
          : kind === 'disputes'
            ? ['open', 'contested', 'accepted', 'won', 'lost']
            : undefined;
    if (!allowed || !allowed.includes(f.status)) throw bad();
  }
  if (kind !== 'payments' && (f.amountMin !== undefined || f.amountMax !== undefined)) throw bad();
  if (kind === 'payments') {
    const min = boundAmount(f.amountMin);
    const max = boundAmount(f.amountMax);
    if (min.kind === 'invalid' || max.kind === 'invalid') throw bad();
    if (min.kind === 'amount' && max.kind === 'amount' && min.scaled > max.scaled) throw bad();
  }
}

export class ExportService {
  constructor(
    private readonly sql: Sql,
    private readonly deps: ExportDeps = {},
  ) {}

  private now() {
    return (this.deps.now ?? (() => new Date()))();
  }

  private canSeeAll(caller: MerchantCaller) {
    return caller.role === 'owner' || caller.role === 'admin';
  }

  async create(caller: MerchantCaller, input: { requestId: string; kind: ExportKind; filters: ExportFilters; columns?: string[] }) {
    assertPermission(caller, 'exports.create');
    validateFilters(input.kind, input.filters);
    if (input.kind === 'ledger_statement' && !this.deps.ledger)
      throw new MerchantOpsError('pay.export_ledger_unconfigured', 'precondition');
    if (input.kind === 'disputes' && !this.deps.disputes) throw new MerchantOpsError('pay.export_disputes_unconfigured', 'precondition');
    const columns = resolveExportColumns(input.kind, caller.role, input.columns);
    const sql = this.sql;
    const inserted = await sql<Array<{ id: string }>>`
      INSERT INTO pay.merchant_export_jobs (merchant_id, request_id, requested_by, kind, filters, columns)
      VALUES (${caller.merchantId}, ${input.requestId}::uuid, ${caller.userId}, ${input.kind}, ${sql.json(input.filters as never)}, ${sql.json(columns)})
      ON CONFLICT (merchant_id, request_id) DO NOTHING
      RETURNING id`;
    if (inserted[0]) return { job: await this.load(caller, inserted[0].id), created: true as const };
    const prior = await sql<JobRow[]>`
      SELECT ${JOB_FIELDS(sql)} FROM pay.merchant_export_jobs WHERE merchant_id = ${caller.merchantId} AND request_id = ${input.requestId}::uuid`;
    const row = prior[0]!;
    if (
      row.kind !== input.kind ||
      JSON.stringify(sorted(row.filters)) !== JSON.stringify(sorted(input.filters)) ||
      JSON.stringify(row.columns ?? []) !== JSON.stringify(columns) ||
      row.requested_by !== caller.userId
    ) {
      throw new MerchantOpsError('pay.request_id_reused', 'conflict');
    }
    return { job: jobView(row), created: false as const };
  }

  private async load(caller: MerchantCaller, jobId: string) {
    const sql = this.sql;
    const rows = await sql<JobRow[]>`
      SELECT ${JOB_FIELDS(sql)} FROM pay.merchant_export_jobs
       WHERE id = ${jobId}::uuid AND merchant_id = ${caller.merchantId}
         ${this.canSeeAll(caller) ? sql`` : sql`AND requested_by = ${caller.userId}`}`;
    if (!rows[0]) throw new MerchantOpsError('pay.export_not_found', 'not_found');
    return jobView(rows[0]);
  }

  async get(caller: MerchantCaller, jobId: string) {
    assertPermission(caller, 'exports.read');
    return this.load(caller, jobId);
  }

  async list(
    caller: MerchantCaller,
    input: {
      limit?: number | undefined;
      cursor?: string;
      kind?: ExportKind;
      status?: JobRow['status'];
      search?: string;
      from?: string;
      to?: string;
    },
  ) {
    assertPermission(caller, 'exports.read');
    const limit = requireLimit(input.limit);
    const after = decodeCursor(input.cursor);
    if (input.from && input.to && Date.parse(input.from) > Date.parse(input.to))
      throw new MerchantOpsError('pay.cursor_invalid', 'bad_request');
    const sql = this.sql;
    const rows = await sql<JobRow[]>`
      SELECT ${JOB_FIELDS(sql)} FROM pay.merchant_export_jobs
       WHERE merchant_id = ${caller.merchantId}
         ${this.canSeeAll(caller) ? sql`` : sql`AND requested_by = ${caller.userId}`}
         ${input.kind ? sql`AND kind = ${input.kind}` : sql``}
         ${input.status ? sql`AND status = ${input.status}` : sql``}
         ${input.search ? sql`AND id::text = lower(${input.search})` : sql``}
         ${input.from ? sql`AND created_at >= (${input.from}::text)::timestamptz` : sql``}
         ${input.to ? sql`AND created_at < (${input.to}::text)::timestamptz` : sql``}
         ${after ? sql`AND (created_at, id) < ((${after.ts}::text)::timestamptz, ${after.key}::uuid)` : sql``}
       ORDER BY created_at DESC, id DESC
       LIMIT ${limit + 1}`;
    return toPage(rows, limit, jobView, (r) => encodeCursor(r.cursor_ts, r.id));
  }

  /** Drop a file the merchant no longer wants. A job another worker is writing stays until that worker finishes. */
  async expire(caller: MerchantCaller, jobId: string) {
    assertPermission(caller, 'exports.create');
    const sql = this.sql;
    const rows = await sql<JobRow[]>`
      UPDATE pay.merchant_export_jobs
         SET status = 'expired', expires_at = now(), content = NULL, updated_at = now()
       WHERE id = ${jobId}::uuid AND merchant_id = ${caller.merchantId}
         ${this.canSeeAll(caller) ? sql`` : sql`AND requested_by = ${caller.userId}`}
         AND status IN ('queued', 'ready', 'failed', 'expired')
       RETURNING ${JOB_FIELDS(sql)}`;
    if (rows[0]) return jobView(rows[0]);
    const running = await sql<Array<{ id: string }>>`
      SELECT id FROM pay.merchant_export_jobs
       WHERE id = ${jobId}::uuid AND merchant_id = ${caller.merchantId}
         ${this.canSeeAll(caller) ? sql`` : sql`AND requested_by = ${caller.userId}`}
         AND status = 'running'`;
    if (running[0]) throw new MerchantOpsError('pay.export_in_progress', 'conflict');
    throw new MerchantOpsError('pay.export_not_found', 'not_found');
  }

  /** The stored file of a ready, unexpired job. */
  async download(caller: MerchantCaller, jobId: string) {
    assertPermission(caller, 'exports.read');
    const sql = this.sql;
    const rows = await sql<Array<JobRow & { content: string | null; content_type: string | null }>>`
      SELECT ${JOB_FIELDS(sql)}, content, content_type FROM pay.merchant_export_jobs
       WHERE id = ${jobId}::uuid AND merchant_id = ${caller.merchantId}
         ${this.canSeeAll(caller) ? sql`` : sql`AND requested_by = ${caller.userId}`}`;
    const row = rows[0];
    if (!row) throw new MerchantOpsError('pay.export_not_found', 'not_found');
    if (row.status !== 'ready' || row.content === null) throw new MerchantOpsError('pay.export_not_ready', 'conflict');
    if (row.expires_at && row.expires_at.getTime() <= this.now().getTime()) throw new MerchantOpsError('pay.export_expired', 'conflict');
    return {
      fileName: row.file_name!,
      contentType: row.content_type ?? 'text/csv; charset=utf-8',
      content: row.content,
      sha256: row.sha256!,
      rowCount: row.row_count!,
    };
  }

  // ── the runner ────────────────────────────────────────────────────────────

  /** Process every queued job once, oldest first. Safe to call from several workers: a job is claimed by one. */
  async processQueued(max: number): Promise<number> {
    const ids = await this.sql<Array<{ id: string }>>`
      SELECT id FROM pay.merchant_export_jobs WHERE status = 'queued' ORDER BY created_at, id LIMIT ${max}`;
    let done = 0;
    for (const { id } of ids) if (await this.process(id)) done += 1;
    return done;
  }

  /** Generate one job. Returns false when another worker already claimed it. */
  async process(jobId: string): Promise<boolean> {
    const sql = this.sql;
    const claimed = await sql<
      Array<{ id: string; merchant_id: string; kind: ExportKind; filters: ExportFilters; columns: string[] | null }>
    >`
      UPDATE pay.merchant_export_jobs SET status = 'running', updated_at = now()
       WHERE id = ${jobId}::uuid AND status = 'queued' RETURNING id, merchant_id, kind, filters, columns`;
    const job = claimed[0];
    if (!job) return false;
    const asOf = this.now();
    try {
      const file = await this.build(job.merchant_id, job.kind, job.filters, job.columns ?? []);
      const expiresAt = this.deps.ttlMs === undefined ? null : new Date(asOf.getTime() + this.deps.ttlMs);
      const fileName = `${job.kind}-${job.id.slice(0, 8)}.csv`;
      const sha = createHash('sha256').update(file.content).digest('hex');
      await sql`
        UPDATE pay.merchant_export_jobs
           SET status = 'ready', file_name = ${fileName}, content_type = 'text/csv; charset=utf-8', content = ${file.content},
               size_bytes = ${Buffer.byteLength(file.content)}, row_count = ${file.rows}, sha256 = ${sha}, as_of = ${asOf},
               generated_at = ${asOf}, expires_at = ${expiresAt}, completed_at = now(), updated_at = now()
         WHERE id = ${job.id}`;
      await recordMerchantNotification(sql, {
        merchantId: job.merchant_id,
        kind: 'export_ready',
        title: `Your ${job.kind} export is ready`,
        subjectType: 'export',
        subjectId: job.id,
        dedupeKey: `export_ready:${job.id}`,
      });
    } catch (error) {
      const code = error instanceof MerchantOpsError ? error.code : 'pay.export_failed';
      await sql`
        UPDATE pay.merchant_export_jobs SET status = 'failed', failure_code = ${code}, completed_at = now(), updated_at = now()
         WHERE id = ${job.id}`;
    }
    return true;
  }

  private async build(
    merchantId: string,
    kind: ExportKind,
    filters: ExportFilters,
    columns: readonly string[],
  ): Promise<{ content: string; rows: number }> {
    validateFilters(kind, filters);
    if (kind === 'refunds' || kind === 'fees') return this.buildSqlKind(merchantId, kind, filters, columns);
    if (kind === 'disputes') return await this.buildDisputes(merchantId, filters, columns);
    if (kind === 'ledger_statement') return this.buildLedger(merchantId, filters, columns);
    const ceiling = this.deps.rowCeiling ?? DEFAULT_EXPORT_ROW_CEILING;
    const BATCH = this.deps.batchSize ?? DEFAULT_BATCH;
    const lines: string[] = [];
    let rows = 0;
    let cursor: { ts: string; id: string } | null = null;
    const sql = this.sql;
    const header = {
      payments: [
        'payment_id',
        'created_at',
        'status',
        'asset',
        'amount',
        'captured_amount',
        'refunded_amount',
        'method',
        'rail',
        'rail_reference',
        'customer_reference',
      ],
      settlements: [
        'settlement_id',
        'window',
        'asset',
        'gross',
        'fees',
        'net',
        'status',
        'payout_method',
        'payout_reference',
        'created_at',
      ],
      payouts: ['settlement_id', 'window', 'asset', 'net_paid', 'status', 'payout_method', 'payout_reference', 'created_at'],
    }[kind];
    const chosen = columns.length > 0 ? columns : header;
    lines.push(chosen.join(','));
    for (;;) {
      const page: Array<Record<string, string | null | Date>> =
        kind === 'payments'
          ? await sql`
              SELECT p.id::text AS id, p.created_at, p.status::text AS status, p.currency, p.amount::text AS amount, p.method, p.rail_adapter, p.rail_ref,
                     c.payload->>'customerRef' AS customer_ref,
                     (SELECT coalesce(sum((x.payload->>'amount')::numeric), 0)::text FROM pay.payment_events x WHERE x.payment_id = p.id AND x.event = 'captured') AS captured,
                     (SELECT coalesce(sum((x.payload->>'amount')::numeric), 0)::text FROM pay.payment_events x WHERE x.payment_id = p.id AND x.event = 'refunded') AS refunded,
                     to_char(p.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_ts
                FROM pay.payments p
                LEFT JOIN pay.payment_events c ON c.payment_id = p.id AND c.event = 'created'
               WHERE p.merchant_id = ${merchantId}
                 ${filters.from ? sql`AND p.created_at >= (${filters.from}::text)::timestamptz` : sql``}
                 ${filters.to ? sql`AND p.created_at < (${filters.to}::text)::timestamptz` : sql``}
                 ${filters.status ? sql`AND p.status = ${filters.status}::pay.payment_status` : sql``}
                 ${filters.assetId ? sql`AND p.currency = ${filters.assetId}` : sql``}
                 ${filters.amountMin ? sql`AND p.amount >= ${filters.amountMin}::numeric` : sql``}
                 ${filters.amountMax ? sql`AND p.amount <= ${filters.amountMax}::numeric` : sql``}
                 ${cursor ? sql`AND (p.created_at, p.id) > ((${cursor.ts}::text)::timestamptz, ${cursor.id}::uuid)` : sql``}
               ORDER BY p.created_at, p.id LIMIT ${BATCH}`
          : await sql`
              SELECT s.id::text AS id, s.window, s.asset_id, s.gross::text AS gross, s.fees::text AS fees, s.net::text AS net, s.status::text AS status,
                     s.payout_method, s.payout_ref, s.created_at,
                     to_char(s.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_ts
                FROM pay.settlements s
               WHERE s.merchant_id = ${merchantId}
                 ${kind === 'payouts' ? sql`AND (s.payout_method IS NOT NULL OR s.status = 'paid_out')` : sql``}
                 ${filters.from ? sql`AND s.created_at >= (${filters.from}::text)::timestamptz` : sql``}
                 ${filters.to ? sql`AND s.created_at < (${filters.to}::text)::timestamptz` : sql``}
                 ${filters.status ? sql`AND s.status = ${filters.status}::pay.settlement_status` : sql``}
                 ${filters.assetId ? sql`AND s.asset_id = ${filters.assetId}` : sql``}
                 ${cursor ? sql`AND (s.created_at, s.id) > ((${cursor.ts}::text)::timestamptz, ${cursor.id}::uuid)` : sql``}
               ORDER BY s.created_at, s.id LIMIT ${BATCH}`;
      for (const r of page) {
        rows += 1;
        if (rows > ceiling) throw new MerchantOpsError('pay.export_too_large', 'precondition');
        const at = (r.created_at as Date).toISOString();
        const s = (k: string) => r[k] as string | null;
        const ref = payoutReference(s('payout_ref'));
        const cells =
          kind === 'payments'
            ? [
                csvRaw(s('id')),
                at,
                csvRaw(s('status')),
                csvText(s('currency')),
                money(s('amount')),
                money(s('captured')),
                money(s('refunded')),
                csvText(s('method')),
                csvText(s('rail_adapter')),
                csvText(s('rail_ref')),
                csvText(s('customer_ref')),
              ]
            : kind === 'settlements'
              ? [
                  csvRaw(s('id')),
                  csvText(s('window')),
                  csvText(s('asset_id')),
                  money(s('gross')),
                  money(s('fees')),
                  money(s('net')),
                  csvRaw(s('status')),
                  csvText(s('payout_method')),
                  csvText(ref),
                  at,
                ]
              : [
                  csvRaw(s('id')),
                  csvText(s('window')),
                  csvText(s('asset_id')),
                  money(s('net')),
                  csvRaw(s('status')),
                  csvText(s('payout_method')),
                  csvText(ref),
                  at,
                ];
        lines.push(projectLine(header, cells, chosen));
      }
      const last = page[page.length - 1];
      if (page.length < BATCH || !last) break;
      cursor = { ts: last.cursor_ts as string, id: last.id as string };
    }
    return { content: `${lines.join('\r\n')}\r\n`, rows };
  }

  private async buildSqlKind(
    merchantId: string,
    kind: 'refunds' | 'fees',
    filters: ExportFilters,
    columns: readonly string[],
  ): Promise<{ content: string; rows: number }> {
    const header = EXPORT_COLUMNS[kind];
    const chosen = columns.length > 0 ? columns : header;
    const ceiling = this.deps.rowCeiling ?? DEFAULT_EXPORT_ROW_CEILING;
    const BATCH = this.deps.batchSize ?? DEFAULT_BATCH;
    const lines = [chosen.join(',')];
    let rows = 0;
    let cursor: { ts: string; id: string } | null = null;
    const sql = this.sql;
    for (;;) {
      const page: Array<Record<string, string | Date | number | null>> =
        kind === 'refunds'
          ? await sql<Array<Record<string, string | Date>>>`
              SELECT e.id::text AS id, e.payment_id::text AS payment_id, e.ts AS occurred_at, e.payload->>'amount' AS amount, p.currency AS asset,
                     to_char(e.ts AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_ts
                FROM pay.payment_events e
                JOIN pay.payments p ON p.id = e.payment_id
               WHERE p.merchant_id = ${merchantId} AND e.event = 'refunded'
                 ${filters.from ? sql`AND e.ts >= (${filters.from}::text)::timestamptz` : sql``}
                 ${filters.to ? sql`AND e.ts < (${filters.to}::text)::timestamptz` : sql``}
                 ${filters.assetId ? sql`AND p.currency = ${filters.assetId}` : sql``}
                 ${cursor ? sql`AND (e.ts, e.id) > ((${cursor.ts}::text)::timestamptz, ${cursor.id}::uuid)` : sql``}
               ORDER BY e.ts, e.id LIMIT ${BATCH}`
          : await sql<Array<Record<string, string | Date | number>>>`
              SELECT id::text AS id, subject_kind, subject_id::text AS subject_id, asset_code AS asset, fee::text AS fee,
                     fee_bps::text AS fee_bps, applied_layer, created_at AS recorded_at,
                     to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_ts
                FROM pay.control_pricing_snapshots
               WHERE merchant_id = ${merchantId}
                 ${filters.from ? sql`AND created_at >= (${filters.from}::text)::timestamptz` : sql``}
                 ${filters.to ? sql`AND created_at < (${filters.to}::text)::timestamptz` : sql``}
                 ${filters.assetId ? sql`AND asset_code = ${filters.assetId}` : sql``}
                 ${cursor ? sql`AND (created_at, id) > ((${cursor.ts}::text)::timestamptz, ${cursor.id}::uuid)` : sql``}
               ORDER BY created_at, id LIMIT ${BATCH}`;
      for (const r of page) {
        rows += 1;
        if (rows > ceiling) throw new MerchantOpsError('pay.export_too_large', 'precondition');
        const at = (r.occurred_at ?? r.recorded_at) as Date;
        const cells =
          kind === 'refunds'
            ? [
                csvRaw(r.id as string),
                csvRaw(r.payment_id as string),
                at.toISOString(),
                r.amount === null || r.amount === undefined || String(r.amount).trim() === '' ? '' : money(String(r.amount)),
                csvText(r.asset as string),
              ]
            : [
                csvText(r.subject_kind as string),
                csvRaw(r.subject_id as string),
                csvText(r.asset as string),
                money(String(r.fee)),
                (r.recorded_at as Date).toISOString(),
                csvRaw(r.fee_bps as string),
                csvText(r.applied_layer as string),
              ];
        lines.push(projectLine(header, cells, chosen));
      }
      const last = page[page.length - 1];
      if (page.length < BATCH || !last) break;
      cursor = { ts: last.cursor_ts as string, id: last.id as string };
    }
    return { content: `${lines.join('\r\n')}\r\n`, rows };
  }

  private async buildDisputes(
    merchantId: string,
    filters: ExportFilters,
    columns: readonly string[],
  ): Promise<{ content: string; rows: number }> {
    const store = this.deps.disputes;
    if (!store) throw new MerchantOpsError('pay.export_disputes_unconfigured', 'precondition');
    const header = EXPORT_COLUMNS.disputes;
    const chosen = columns.length > 0 ? columns : header;
    const ceiling = this.deps.rowCeiling ?? DEFAULT_EXPORT_ROW_CEILING;
    const from = filters.from ? Date.parse(filters.from) : null;
    const to = filters.to ? Date.parse(filters.to) : null;
    const cases = (await store.listForMerchant(merchantId))
      .filter((c) => (filters.status ? c.status === filters.status : true))
      .filter((c) => (filters.assetId ? c.assetId === filters.assetId : true))
      .filter((c) => (from === null ? true : Date.parse(c.openedAt) >= from))
      .filter((c) => (to === null ? true : Date.parse(c.openedAt) < to));
    if (cases.length > ceiling) throw new MerchantOpsError('pay.export_too_large', 'precondition');
    const lines = [chosen.join(',')];
    for (const c of cases) {
      lines.push(
        projectLine(
          header,
          [
            csvRaw(c.disputeId),
            csvRaw(c.paymentId),
            csvRaw(c.status),
            money(c.amount),
            csvText(c.assetId),
            c.openedAt,
            csvText(c.reasonCode),
          ],
          chosen,
        ),
      );
    }
    return { content: `${lines.join('\r\n')}\r\n`, rows: cases.length };
  }

  private async buildLedger(
    merchantId: string,
    filters: ExportFilters,
    columns: readonly string[],
  ): Promise<{ content: string; rows: number }> {
    const ledger = this.deps.ledger;
    if (!ledger) throw new MerchantOpsError('pay.export_ledger_unconfigured', 'precondition');
    const header = EXPORT_COLUMNS.ledger_statement;
    const chosen = columns.length > 0 ? columns : header;
    const owners = [merchantClearing(merchantId, 'ledger').ownerId, merchantProceeds(merchantId, 'ledger').ownerId];
    const lines = [chosen.join(',')];
    let rows = 0;
    for (const ownerId of owners) {
      const balances = await ledger.balances('module', ownerId);
      for (const balance of balances) {
        if (filters.assetId && balance.account.assetId !== filters.assetId) continue;
        rows += 1;
        const account = ownerId.startsWith('pay:proceeds:') ? 'proceeds' : 'clearing';
        lines.push(
          projectLine(
            header,
            [account, csvText(balance.account.assetId), csvText(balance.account.kind), formatAmount(balance.amount)],
            chosen,
          ),
        );
      }
    }
    return { content: `${lines.join('\r\n')}\r\n`, rows };
  }
}

function sorted(f: ExportFilters): Record<string, string> {
  return Object.fromEntries(
    Object.entries(f)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b)),
  ) as Record<string, string>;
}
