import { createHash } from 'node:crypto';
import type { Sql } from 'postgres';
import { MerchantOpsError } from './errors.js';
import { iso, money } from './money.js';
import { recordMerchantNotification } from './notifications.js';
import { decodeCursor, encodeCursor, requireLimit, toPage } from './pagination.js';
import { assertPermission, type MerchantCaller } from './roles.js';

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
export const EXPORT_KINDS = ['payments', 'settlements', 'payouts'] as const;
export type ExportKind = (typeof EXPORT_KINDS)[number];

const PAYMENT_STATUSES = ['created', 'authorized', 'captured', 'settled', 'refunded', 'disputed', 'failed'] as const;
const SETTLEMENT_STATUSES = ['pending', 'posted', 'paid_out', 'failed'] as const;

export interface ExportFilters {
  readonly from?: string;
  readonly to?: string;
  readonly status?: string;
  readonly assetId?: string;
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
}

interface JobRow {
  id: string;
  merchant_id: string;
  request_id: string;
  requested_by: string;
  kind: ExportKind;
  filters: ExportFilters;
  status: 'queued' | 'running' | 'ready' | 'failed';
  failure_code: string | null;
  file_name: string | null;
  size_bytes: string | null;
  row_count: number | null;
  sha256: string | null;
  as_of: Date | null;
  expires_at: Date | null;
  created_at: Date;
  completed_at: Date | null;
  cursor_ts: string;
}

const JOB_FIELDS = (sql: Sql) => sql`
  id, merchant_id, request_id, requested_by, kind, filters, status, failure_code, file_name, size_bytes::text, row_count, sha256,
  as_of, expires_at, created_at, completed_at,
  to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_ts`;

const jobView = (r: JobRow) => ({
  jobId: r.id,
  kind: r.kind,
  filters: r.filters,
  status: r.status,
  failureCode: r.failure_code,
  fileName: r.file_name,
  sizeBytes: r.size_bytes,
  rowCount: r.row_count,
  sha256: r.sha256,
  requestedBy: r.requested_by,
  asOf: r.as_of ? iso(r.as_of) : null,
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

export function validateFilters(kind: ExportKind, f: ExportFilters): void {
  const bad = () => new MerchantOpsError('pay.export_filter_invalid', 'bad_request');
  for (const key of ['from', 'to'] as const) {
    const v = f[key];
    if (v !== undefined && Number.isNaN(Date.parse(v))) throw bad();
  }
  if (f.from && f.to && Date.parse(f.from) >= Date.parse(f.to)) throw bad();
  if (f.status !== undefined) {
    const allowed: readonly string[] = kind === 'payments' ? PAYMENT_STATUSES : SETTLEMENT_STATUSES;
    if (!allowed.includes(f.status)) throw bad();
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

  async create(caller: MerchantCaller, input: { requestId: string; kind: ExportKind; filters: ExportFilters }) {
    assertPermission(caller, 'exports.create');
    validateFilters(input.kind, input.filters);
    const sql = this.sql;
    const inserted = await sql<Array<{ id: string }>>`
      INSERT INTO pay.merchant_export_jobs (merchant_id, request_id, requested_by, kind, filters)
      VALUES (${caller.merchantId}, ${input.requestId}::uuid, ${caller.userId}, ${input.kind}, ${sql.json(input.filters as never)})
      ON CONFLICT (merchant_id, request_id) DO NOTHING
      RETURNING id`;
    if (inserted[0]) return { job: await this.load(caller, inserted[0].id), created: true as const };
    const prior = await sql<JobRow[]>`
      SELECT ${JOB_FIELDS(sql)} FROM pay.merchant_export_jobs WHERE merchant_id = ${caller.merchantId} AND request_id = ${input.requestId}::uuid`;
    const row = prior[0]!;
    if (row.kind !== input.kind || JSON.stringify(sorted(row.filters)) !== JSON.stringify(sorted(input.filters)) || row.requested_by !== caller.userId) {
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

  async list(caller: MerchantCaller, input: { limit?: number | undefined; cursor?: string; kind?: ExportKind; status?: JobRow['status'] }) {
    assertPermission(caller, 'exports.read');
    const limit = requireLimit(input.limit);
    const after = decodeCursor(input.cursor);
    const sql = this.sql;
    const rows = await sql<JobRow[]>`
      SELECT ${JOB_FIELDS(sql)} FROM pay.merchant_export_jobs
       WHERE merchant_id = ${caller.merchantId}
         ${this.canSeeAll(caller) ? sql`` : sql`AND requested_by = ${caller.userId}`}
         ${input.kind ? sql`AND kind = ${input.kind}` : sql``}
         ${input.status ? sql`AND status = ${input.status}` : sql``}
         ${after ? sql`AND (created_at, id) < ((${after.ts}::text)::timestamptz, ${after.key}::uuid)` : sql``}
       ORDER BY created_at DESC, id DESC
       LIMIT ${limit + 1}`;
    return toPage(rows, limit, jobView, (r) => encodeCursor(r.cursor_ts, r.id));
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
    const claimed = await sql<Array<{ id: string; merchant_id: string; kind: ExportKind; filters: ExportFilters }>>`
      UPDATE pay.merchant_export_jobs SET status = 'running', updated_at = now()
       WHERE id = ${jobId}::uuid AND status = 'queued' RETURNING id, merchant_id, kind, filters`;
    const job = claimed[0];
    if (!job) return false;
    const asOf = this.now();
    try {
      const file = await this.build(job.merchant_id, job.kind, job.filters);
      const expiresAt = this.deps.ttlMs === undefined ? null : new Date(asOf.getTime() + this.deps.ttlMs);
      const fileName = `${job.kind}-${job.id.slice(0, 8)}.csv`;
      const sha = createHash('sha256').update(file.content).digest('hex');
      await sql`
        UPDATE pay.merchant_export_jobs
           SET status = 'ready', file_name = ${fileName}, content_type = 'text/csv; charset=utf-8', content = ${file.content},
               size_bytes = ${Buffer.byteLength(file.content)}, row_count = ${file.rows}, sha256 = ${sha}, as_of = ${asOf},
               expires_at = ${expiresAt}, completed_at = now(), updated_at = now()
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

  private async build(merchantId: string, kind: ExportKind, filters: ExportFilters): Promise<{ content: string; rows: number }> {
    validateFilters(kind, filters);
    const ceiling = this.deps.rowCeiling ?? DEFAULT_EXPORT_ROW_CEILING;
    const BATCH = this.deps.batchSize ?? DEFAULT_BATCH;
    const lines: string[] = [];
    let rows = 0;
    let cursor: { ts: string; id: string } | null = null;
    const sql = this.sql;
    const header = {
      payments: ['payment_id', 'created_at', 'status', 'asset', 'amount', 'captured_amount', 'refunded_amount', 'method', 'rail', 'rail_reference', 'customer_reference'],
      settlements: ['settlement_id', 'window', 'asset', 'gross', 'fees', 'net', 'status', 'payout_method', 'payout_reference', 'created_at'],
      payouts: ['settlement_id', 'window', 'asset', 'net_paid', 'status', 'payout_method', 'payout_reference', 'created_at'],
    }[kind];
    lines.push(header.join(','));
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
        if (kind === 'payments') {
          lines.push(
            [
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
            ].join(','),
          );
        } else if (kind === 'settlements') {
          lines.push(
            [csvRaw(s('id')), csvText(s('window')), csvText(s('asset_id')), money(s('gross')), money(s('fees')), money(s('net')), csvRaw(s('status')), csvText(s('payout_method')), csvText(s('payout_ref')), at].join(','),
          );
        } else {
          lines.push(
            [csvRaw(s('id')), csvText(s('window')), csvText(s('asset_id')), money(s('net')), csvRaw(s('status')), csvText(s('payout_method')), csvText(s('payout_ref')), at].join(','),
          );
        }
      }
      const last = page[page.length - 1];
      if (page.length < BATCH || !last) break;
      cursor = { ts: last.cursor_ts as string, id: last.id as string };
    }
    return { content: `${lines.join('\r\n')}\r\n`, rows };
  }
}

function sorted(f: ExportFilters): Record<string, string> {
  return Object.fromEntries(Object.entries(f).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b))) as Record<string, string>;
}
