import { randomUUID } from 'node:crypto';
import type { Sql } from 'postgres';
import { BankError } from '../errors.js';
import type { StatementFile, StatementReport, StatementRequest, StatementService } from './statement-service.js';

/**
 * Background exports with a document centre (PF-statements-02, J-portfolio-11 #4 and #5).
 *
 * A long export is asked for once and made later. `create` checks the request exactly as a direct download would
 * (`StatementService.plan`), then writes one job row keyed by what was asked: the same request from the same person
 * returns the same job, never a second one. A worker claims the oldest queued row, or a row whose claim lapsed because the
 * worker that held it died, renders the file as of the moment the job was asked for (`as_of`), and writes it once. A second
 * render of the same job reads the same lines as of the same moment, so it writes the same bytes.
 *
 * Nothing here moves money or states a balance: the file is the person's own posted lines, the same as the direct download.
 * Background exports are off until the worker's interval and claim lease are set; asking for one then refuses
 * `bank.statement_jobs_unset` rather than queueing a job nothing will make.
 */

export type StatementJobState = 'queued' | 'rendering' | 'ready' | 'failed';

export interface StatementJob {
  readonly id: string;
  readonly report: Exclude<StatementReport, 'balances'>;
  readonly format: 'csv' | 'pdf';
  readonly from: string;
  readonly to: string;
  readonly assetId: string | null;
  readonly spaceId: string | null;
  readonly state: StatementJobState;
  /** How many times a worker has claimed it: more than one means an earlier claim lapsed and it was re-queued. */
  readonly attempts: number;
  readonly createdAt: string;
  readonly finishedAt: string | null;
  readonly filename: string | null;
  readonly sha256: string | null;
  readonly rowCount: number | null;
  /** Why it failed, as the bank's typed code; null unless `state` is failed. */
  readonly errorCode: string | null;
}

export interface StatementJobsConfig {
  /** How long a worker's claim lasts before the job is re-queued on the same key. Null: background exports are off. */
  readonly leaseMs: number | null;
  /** TEST only: how long a render waits before it writes, so a journey can stop the worker mid-render. */
  readonly testRenderHoldMs?: number | null;
}

/** A claim of the worker can try again after: the activity read or the secret was missing for a moment. */
const RETRYABLE = new Set(['bank.statement_unavailable']);
/** Claims after which a job that still cannot be made is marked failed with the last reason. */
export const STATEMENT_JOB_MAX_ATTEMPTS = 5;
export const STATEMENT_JOBS_LIST_LIMIT = 50;
/** How far a request's end may be past the bank's clock and still count as ended (the caller's clock may run ahead). */
const CLOCK_SKEW_MS = 5 * 60 * 1000;

interface JobRow {
  id: string;
  user_id: string;
  report: StatementJob['report'];
  format: StatementJob['format'];
  from_at: string;
  to_at: string;
  asset_id: string | null;
  space_id: string | null;
  state: StatementJobState;
  attempts: number;
  as_of: Date;
  filename: string | null;
  content_type: string | null;
  body: Buffer | null;
  sha256: string | null;
  signature: string | null;
  row_count: number | null;
  error_code: string | null;
  created_at: Date;
  finished_at: Date | null;
}

const VIEW_COLUMNS = `id, user_id, report, format, from_at, to_at, asset_id, space_id, state, attempts, as_of, filename,
  content_type, sha256, signature, row_count, error_code, created_at, finished_at`;

function view(row: JobRow): StatementJob {
  return {
    id: row.id,
    report: row.report,
    format: row.format,
    from: row.from_at,
    to: row.to_at,
    assetId: row.asset_id,
    spaceId: row.space_id,
    state: row.state,
    attempts: row.attempts,
    createdAt: row.created_at.toISOString(),
    finishedAt: row.finished_at ? row.finished_at.toISOString() : null,
    filename: row.filename,
    sha256: row.sha256,
    rowCount: row.row_count,
    errorCode: row.error_code,
  };
}

/** One instant, one spelling: `…T00:00:00Z` and `…T00:00:00.000Z` are the same request. */
const instant = (at: string) => new Date(Date.parse(at)).toISOString();

/** The business key of a request: what was asked, so asking again finds the same job. */
export function statementJobKey(plan: {
  report: string;
  format: string;
  from: string;
  to: string;
  assetId?: string | null;
  spaceId?: string | null;
}): string {
  return ['statement-job', plan.report, plan.format, instant(plan.from), instant(plan.to), plan.assetId ?? '-', plan.spaceId ?? '-'].join(
    ':',
  );
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class StatementJobService {
  constructor(
    private readonly sql: Sql,
    private readonly statements: Pick<StatementService, 'plan' | 'render'>,
    private readonly config: StatementJobsConfig,
  ) {}

  /** Whether background exports are switched on here. */
  get enabled(): boolean {
    return this.config.leaseMs !== null;
  }

  /**
   * Asks for an export: refused now if the file would be, else the one job for this request (made if new). The range must
   * have ended (give or take a clock's skew), so the same request is always the same document. A request whose earlier job
   * failed is queued again on the same row.
   */
  async create(userId: string, input: StatementRequest, now = new Date()): Promise<StatementJob> {
    if (!this.enabled) {
      throw new BankError('Background exports are not switched on in this build', 'bank.statement_jobs_unset');
    }
    const plan = await this.statements.plan(userId, input);
    if (Date.parse(plan.to) > now.getTime() + CLOCK_SKEW_MS) {
      throw new BankError('A background export covers dates that have ended. End it now or earlier.', 'bank.statement_job_unfinished');
    }
    const spaceId = plan.space?.id ?? null;
    const assetId = plan.assetId ?? null;
    const key = statementJobKey({ report: plan.report, format: plan.format, from: plan.from, to: plan.to, assetId, spaceId });
    // The dates are kept as they were first asked for, so the worker plans and prints exactly what a direct download would.
    const [row] = await this.sql<JobRow[]>`
      INSERT INTO bank.statement_jobs (id, user_id, key, report, format, from_at, to_at, asset_id, space_id, as_of)
      VALUES (${randomUUID()}, ${userId}, ${key}, ${plan.report}, ${plan.format}, ${plan.from}, ${plan.to}, ${assetId}, ${spaceId}, ${now})
      ON CONFLICT (user_id, key) DO UPDATE
         SET state = 'queued', attempts = 0, lease_until = NULL, error_code = NULL, finished_at = NULL, as_of = EXCLUDED.as_of
       WHERE bank.statement_jobs.state = 'failed'
      RETURNING ${this.sql.unsafe(VIEW_COLUMNS)}
    `;
    if (row) return view(row);
    const [found] = await this.sql<JobRow[]>`
      SELECT ${this.sql.unsafe(VIEW_COLUMNS)} FROM bank.statement_jobs WHERE user_id = ${userId} AND key = ${key}
    `;
    if (!found) throw new Error('statement job vanished between insert and read');
    return view(found);
  }

  /** The caller's own export jobs, newest first. */
  async list(userId: string): Promise<StatementJob[]> {
    const rows = await this.sql<JobRow[]>`
      SELECT ${this.sql.unsafe(VIEW_COLUMNS)} FROM bank.statement_jobs
       WHERE user_id = ${userId}
       ORDER BY created_at DESC, id DESC
       LIMIT ${STATEMENT_JOBS_LIST_LIMIT}
    `;
    return rows.map(view);
  }

  /** The file of one of the caller's own jobs, once it is ready. Another person's job reads as not found. */
  async download(userId: string, id: string): Promise<StatementFile> {
    const [row] = await this.sql<JobRow[]>`
      SELECT ${this.sql.unsafe(VIEW_COLUMNS)}, body FROM bank.statement_jobs WHERE id = ${id} AND user_id = ${userId}
    `;
    if (!row) throw new BankError(`Export ${id} not found`, 'bank.statement_job_not_found');
    if (row.state !== 'ready' || !row.body || !row.sha256 || !row.signature || !row.filename || !row.content_type) {
      throw new BankError(`Export ${id} is ${row.state}, so it has no file yet`, 'bank.statement_job_not_ready');
    }
    const generatedAt = row.as_of.toISOString();
    const rowCount = row.row_count ?? 0;
    return {
      format: row.format,
      filename: row.filename,
      contentType: row.content_type,
      bodyBase64: row.body.toString('base64'),
      sha256: row.sha256,
      signature: row.signature,
      rowCount,
      generatedAt,
      proof: {
        holderUserId: row.user_id,
        from: row.from_at,
        to: row.to_at,
        assetId: row.asset_id,
        spaceId: row.space_id,
        report: row.report,
        rowCount,
        generatedAt,
        sha256: row.sha256,
      },
    };
  }

  /**
   * Claims the oldest job no live worker holds: a queued one whose retry time has come, or one whose claim lapsed (its worker
   * died mid-render), which is re-queued on the same key, the same row and the same `as_of`. Two workers never claim one row
   * at once. A lapsed claim that has used every attempt is marked failed instead, so a job that kills its worker every time
   * cannot loop for ever.
   */
  async claim(): Promise<JobRow | null> {
    if (this.config.leaseMs === null) return null;
    await this.sql`
      UPDATE bank.statement_jobs
         SET state = 'failed', lease_until = NULL, error_code = 'bank.statement_unavailable', finished_at = now()
       WHERE state = 'rendering' AND lease_until < now() AND attempts >= ${STATEMENT_JOB_MAX_ATTEMPTS}
    `;
    const [row] = await this.sql<JobRow[]>`
      UPDATE bank.statement_jobs
         SET state = 'rendering', attempts = attempts + 1,
             lease_until = now() + (${this.config.leaseMs} * interval '1 millisecond')
       WHERE id = (
         SELECT id FROM bank.statement_jobs
          WHERE (state = 'queued' AND (lease_until IS NULL OR lease_until < now()))
             OR (state = 'rendering' AND lease_until < now() AND attempts < ${STATEMENT_JOB_MAX_ATTEMPTS})
          ORDER BY created_at, id
          LIMIT 1
          FOR UPDATE SKIP LOCKED
       )
      RETURNING ${this.sql.unsafe(VIEW_COLUMNS)}
    `;
    return row ?? null;
  }

  /** The job as it stands now; used when this worker's claim was lost to another, so the caller never sees a stale view. */
  private async current(id: string): Promise<StatementJob> {
    const [row] = await this.sql<JobRow[]>`SELECT ${this.sql.unsafe(VIEW_COLUMNS)} FROM bank.statement_jobs WHERE id = ${id}`;
    if (!row) throw new Error(`statement job ${id} vanished`);
    return view(row);
  }

  /**
   * Claims and makes one job. Null when there was nothing to claim. While it renders, the claim is renewed every half lease,
   * so a long render is never taken by a second worker; a worker that dies stops renewing and its claim lapses.
   */
  async renderNext(): Promise<StatementJob | null> {
    const job = await this.claim();
    if (!job) return null;
    const leaseMs = this.config.leaseMs as number;
    const renew = setInterval(
      () => {
        void this.sql`
        UPDATE bank.statement_jobs SET lease_until = now() + (${leaseMs} * interval '1 millisecond')
         WHERE id = ${job.id} AND state = 'rendering' AND attempts = ${job.attempts}
      `.catch(() => undefined);
      },
      Math.max(1, Math.floor(leaseMs / 2)),
    );
    try {
      return await this.make(job, leaseMs);
    } finally {
      clearInterval(renew);
    }
  }

  private async make(job: JobRow, leaseMs: number): Promise<StatementJob> {
    const hold = this.config.testRenderHoldMs ?? 0;
    if (hold > 0) await sleep(hold);
    let file: StatementFile;
    try {
      const plan = await this.statements.plan(job.user_id, {
        from: job.from_at,
        to: job.to_at,
        format: job.format,
        report: job.report,
        ...(job.asset_id !== null && job.space_id === null ? { assetId: job.asset_id } : {}),
        ...(job.space_id !== null ? { spaceId: job.space_id } : {}),
      });
      file = await this.statements.render(job.user_id, plan, job.as_of);
    } catch (err) {
      const code = err instanceof BankError ? err.code : 'bank.statement_unavailable';
      const again = (RETRYABLE.has(code) || !(err instanceof BankError)) && job.attempts < STATEMENT_JOB_MAX_ATTEMPTS;
      // Only the claim this worker holds is changed: a claim that lapsed and was taken again belongs to the new worker.
      // A retry waits one lease before it can be claimed again, so a brief outage does not use every attempt at once.
      const [after] = again
        ? await this.sql<JobRow[]>`
            UPDATE bank.statement_jobs
               SET state = 'queued', lease_until = now() + (${leaseMs} * interval '1 millisecond')
             WHERE id = ${job.id} AND state = 'rendering' AND attempts = ${job.attempts}
            RETURNING ${this.sql.unsafe(VIEW_COLUMNS)}
          `
        : await this.sql<JobRow[]>`
            UPDATE bank.statement_jobs SET state = 'failed', lease_until = NULL, error_code = ${code}, finished_at = now()
             WHERE id = ${job.id} AND state = 'rendering' AND attempts = ${job.attempts}
            RETURNING ${this.sql.unsafe(VIEW_COLUMNS)}
          `;
      return after ? view(after) : this.current(job.id);
    }
    const body = Buffer.from(file.bodyBase64, 'base64');
    const [done] = await this.sql<JobRow[]>`
      UPDATE bank.statement_jobs
         SET state = 'ready', lease_until = NULL, filename = ${file.filename}, content_type = ${file.contentType},
             body = ${body}, sha256 = ${file.sha256}, signature = ${file.signature}, row_count = ${file.rowCount},
             finished_at = now()
       WHERE id = ${job.id} AND state = 'rendering' AND attempts = ${job.attempts}
      RETURNING ${this.sql.unsafe(VIEW_COLUMNS)}
    `;
    return done ? view(done) : this.current(job.id);
  }
}

export interface StatementJobWorkerHandle {
  stop(): void;
  readonly running: boolean;
}

/**
 * The in-process worker: every `intervalMs` it makes queued jobs one at a time, at most `batch` a tick, and never runs two
 * ticks at once. Off (a no-op handle) when no interval or lease is set. A failed tick is reported and the next one still runs.
 */
export function startStatementJobWorker(deps: {
  jobs: Pick<StatementJobService, 'renderNext' | 'enabled'>;
  intervalMs: number | null;
  batch?: number;
  onError?: (err: unknown) => void;
  onWarn?: (message: string) => void;
}): StatementJobWorkerHandle {
  if (deps.intervalMs === null || !deps.jobs.enabled) {
    deps.onWarn?.(
      'BANK_STATEMENT_JOBS_INTERVAL_MS or BANK_STATEMENT_JOBS_LEASE_MS is blank: background exports are off and asking for one refuses bank.statement_jobs_unset',
    );
    return { stop() {}, running: false };
  }
  const intervalMs = deps.intervalMs;
  const batch = deps.batch ?? 10;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  const tick = async () => {
    try {
      for (let i = 0; i < batch && !stopped; i += 1) {
        if (!(await deps.jobs.renderNext())) break;
      }
    } catch (err) {
      deps.onError?.(err);
    } finally {
      if (!stopped) timer = setTimeout(() => void tick(), intervalMs);
    }
  };
  timer = setTimeout(() => void tick(), intervalMs);
  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
    running: true,
  };
}

function optionalInteger(name: string, raw: unknown, min: number, max: number): number | null {
  if (raw === undefined || raw === null) return null;
  const text = typeof raw === 'number' ? String(raw) : typeof raw === 'string' ? raw.trim() : null;
  if (text === '') return null;
  if (text === null || !/^\d+$/.test(text) || Number(text) < min || Number(text) > max) {
    throw new Error(`${name} must be an integer ${min}–${max}, or empty to leave background exports off`);
  }
  return Number(text);
}

/** How often the export worker looks for queued jobs. Unset or blank: off. No invented default. */
export const parseStatementJobsInterval = (raw: unknown) => optionalInteger('BANK_STATEMENT_JOBS_INTERVAL_MS', raw, 500, 3_600_000);
/** How long one claim lasts before the job is re-queued. Unset or blank: off. No invented default. */
export const parseStatementJobsLease = (raw: unknown) => optionalInteger('BANK_STATEMENT_JOBS_LEASE_MS', raw, 1_000, 3_600_000);

/**
 * TEST only: a wait inside every render, so a journey can stop the worker while a job is rendering (J-portfolio-11 #5).
 * Set outside an explicit dev or test process, boot refuses.
 */
export function parseStatementJobsTestHold(raw: unknown, env: { APP_ENV?: string; NODE_ENV?: string }): number | null {
  const hold = optionalInteger('BANK_STATEMENT_JOBS_TEST_RENDER_HOLD_MS', raw, 0, 600_000);
  if (hold !== null && (!['dev', 'test'].includes(env.APP_ENV ?? '') || env.NODE_ENV === 'production')) {
    throw new Error('BANK_STATEMENT_JOBS_TEST_RENDER_HOLD_MS is a TEST fault and runs only with APP_ENV exactly dev or test');
  }
  return hold;
}
