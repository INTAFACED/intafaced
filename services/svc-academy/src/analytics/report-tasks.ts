/**
 * AC-analytics-02 (J-academy-16 #3 to #5): the reports centre. Staff request a report; it is a task, written first and
 * run by the report sweep, never inside the request:
 *
 * - `request` writes the task `queued`. A founder's requests are numbered and the desk sends the number it read as next
 *   (`report:<kind>:<founder>:<n>`): a retry of a request that already made task n answers task n, so a retry never
 *   makes a second task; only pressing Request again does. It refuses before writing anything when the owner has left
 *   blank the retention (`ACADEMY_REPORT_RETENTION_HOURS`, `academy.report_retention_unset`), the rows one report may
 *   hold (`ACADEMY_LEARNER_EXPORT_ROWS`, shared with learner exports, `academy.report_limit_unset`) or the sweep interval (`ACADEMY_REPORT_SWEEP_SECONDS`,
 *   `academy.report_sweep_unset`: with no sweep a task would never run).
 * - Each sweep first finishes the tasks that were already running (it stores the CSV, its row count and SHA-256 and marks
 *   the task `done`, kept until the retention ends; or `failed` with the refusal that stopped it), then starts the queued
 *   ones (`running`). So a task runs for one sweep interval, and staff can watch it and abort it.
 * - `abort` stops a queued or running task: it becomes `aborted` and no file is ever served for it (a sweep finishing
 *   it only updates a task that is still running).
 * - `delete` takes any task off the list and drops its file.
 * - `file` serves a done task's stored CSV byte for byte; once the retention has passed it refuses
 *   `academy.report_expired`, and the sweep drops the bytes.
 *
 * The learners report holds exactly the columns the desk's learner summaries show (learner id, open enrolments, items
 * completed, last active, tags), filtered by a learner tag when one is given. Every change writes an event with its
 * actor. No money moves.
 */
import { createHash } from 'node:crypto';
import type { Sql, TransactionSql } from 'postgres';
import type { AcademyReportCentreFile, AcademyReportCentreTask, AcademyReportCentreTasks } from '@intafaced/contracts';
import { requireSetting } from '@intafaced/service-kit';
import { csvField } from '../curriculum/grade-reports.js';
import { analyticsRefusals, learnerIds, summariesOf } from './learner-summaries.js';

const refuse = analyticsRefusals.refuse;
type Db = Sql | TransactionSql;

type Row = {
  id: string;
  requested_by: string;
  n: number;
  kind: 'learners';
  tag: string | null;
  state: AcademyReportCentreTask['state'];
  requested_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
  expires_at: Date | null;
  rows: number | null;
  sha256: string | null;
  failure: string | null;
  deleted_at: Date | null;
};
const COLUMNS =
  'id, requested_by, n, kind, tag, state, requested_at, started_at, finished_at, expires_at, rows, sha256, failure, deleted_at';

const iso = (d: Date | null) => (d ? d.toISOString() : null);

function view(r: Row, now: Date): AcademyReportCentreTask {
  return {
    id: r.id,
    n: r.n,
    kind: r.kind,
    tag: r.tag,
    state: r.state,
    requestedBy: r.requested_by,
    requestedAt: r.requested_at.toISOString(),
    startedAt: iso(r.started_at),
    finishedAt: iso(r.finished_at),
    expiresAt: iso(r.expires_at),
    expired: r.state === 'done' && r.expires_at !== null && r.expires_at.getTime() <= now.getTime(),
    rows: r.rows,
    sha256: r.sha256,
    failure: r.failure,
  };
}

/** The learners report as CSV: its number, when it was made and its filter on the first line, then one row a learner. */
export function learnersReportCsv(
  task: { n: number; tag: string | null },
  madeAt: Date,
  rows: Awaited<ReturnType<typeof summariesOf>>,
): string {
  const line = (cells: string[]) => cells.map(csvField).join(',');
  const lines = [
    line(['learners report', String(task.n), 'made at', madeAt.toISOString(), 'tag', task.tag ?? 'every learner']),
    line(['learner', 'enrolments', 'items completed', 'last active', 'tags']),
    ...rows.map((r) =>
      line([r.userId, String(r.enrolments), String(r.itemsCompleted), r.lastActiveAt ?? 'not recorded', r.tags.join(' ')]),
    ),
  ];
  return `${lines.join('\r\n')}\r\n`;
}

export interface ReportTaskSettings {
  /** `ACADEMY_REPORT_TASKS_PAGE_SIZE`: tasks one list shows. */
  readonly pageSize: number | null;
  /** `ACADEMY_REPORT_RETENTION_HOURS`: how long a finished file is served. */
  readonly retentionHours: number | null;
  /** `ACADEMY_REPORT_ROWS`: learner rows one report may hold. */
  readonly rowLimit: number | null;
  /** `ACADEMY_REPORT_SWEEP_SECONDS`: seconds between report sweeps; null runs none. */
  readonly sweepSeconds: number | null;
}

export class ReportTasks {
  constructor(
    private readonly sql: Sql,
    private readonly settings: ReportTaskSettings,
  ) {}

  private async event(tx: Db, taskId: string, event: string, actorId: string | null, at: Date): Promise<void> {
    await tx`
      INSERT INTO academy.report_centre_events (task_id, n, event, actor_id, at)
      SELECT ${taskId}, coalesce(max(n), 0) + 1, ${event}, ${actorId}, ${at}
        FROM academy.report_centre_events WHERE task_id = ${taskId}
    `;
  }

  private async nextN(tx: Db, actorId: string): Promise<number> {
    const [{ next } = { next: 1 }] = await tx<Array<{ next: number }>>`
      SELECT coalesce(max(n), 0)::int + 1 AS next FROM academy.report_centre_tasks WHERE requested_by = ${actorId}
    `;
    return next;
  }

  /** Every task not deleted, newest first, up to the owner's page size, and the number the caller's next request takes. */
  async list(actorId: string, now: Date = new Date()): Promise<AcademyReportCentreTasks> {
    const pageSize = requireSetting(this.settings.pageSize, analyticsRefusals, 'academy.report_tasks_list_limit_unset');
    const rows = await this.sql<Row[]>`
      SELECT ${this.sql.unsafe(COLUMNS)} FROM academy.report_centre_tasks
       WHERE deleted_at IS NULL ORDER BY requested_at DESC, id LIMIT ${pageSize}
    `;
    return { pageSize, tasks: rows.map((r) => view(r, now)), nextN: await this.nextN(this.sql, actorId) };
  }

  /** Task n of this founder: queued now when n is their next, the stored one when it already exists. */
  async request(input: { actorId: string; kind: 'learners'; tag: string | null; n: number; now: Date }): Promise<AcademyReportCentreTask> {
    requireSetting(this.settings.retentionHours, analyticsRefusals, 'academy.report_retention_unset');
    requireSetting(this.settings.rowLimit, analyticsRefusals, 'academy.report_limit_unset');
    requireSetting(this.settings.sweepSeconds, analyticsRefusals, 'academy.report_sweep_unset');
    return this.sql.begin(async (tx) => {
      // One request per founder at a time, so two presses cannot both take the next number.
      await tx`SELECT pg_advisory_xact_lock(hashtext(${`report:${input.actorId}`}))`;
      const [existing] = await tx<Row[]>`
        SELECT ${tx.unsafe(COLUMNS)} FROM academy.report_centre_tasks WHERE requested_by = ${input.actorId} AND n = ${input.n}
      `;
      if (existing) return view(existing, input.now);
      const next = await this.nextN(tx, input.actorId);
      if (input.n !== next) refuse('academy.report_out_of_order', `your next report request is ${next}, not ${input.n}`);
      const [made] = await tx<Row[]>`
        INSERT INTO academy.report_centre_tasks (requested_by, n, kind, tag, state, requested_at)
        VALUES (${input.actorId}, ${input.n}, ${input.kind}, ${input.tag}, 'queued', ${input.now})
        RETURNING ${tx.unsafe(COLUMNS)}
      `;
      await this.event(tx, made!.id, 'requested', input.actorId, input.now);
      return view(made!, input.now);
    });
  }

  /** Stops a queued or running task. Aborting an aborted task answers it again; any other state refuses. */
  async abort(input: { actorId: string; taskId: string; now: Date }): Promise<AcademyReportCentreTask> {
    return this.sql.begin(async (tx) => {
      const [task] = await tx<Row[]>`
        SELECT ${tx.unsafe(COLUMNS)} FROM academy.report_centre_tasks WHERE id = ${input.taskId} AND deleted_at IS NULL FOR UPDATE
      `;
      if (!task) return refuse('academy.report_not_found', 'no report task has that id');
      if (task.state === 'aborted') return view(task, input.now);
      if (task.state !== 'queued' && task.state !== 'running')
        refuse('academy.report_not_abortable', `the task is ${task.state}, so there is nothing to abort`);
      const [done] = await tx<Row[]>`
        UPDATE academy.report_centre_tasks SET state = 'aborted', finished_at = ${input.now}
         WHERE id = ${input.taskId} RETURNING ${tx.unsafe(COLUMNS)}
      `;
      await this.event(tx, input.taskId, 'aborted', input.actorId, input.now);
      return view(done!, input.now);
    });
  }

  /** Takes a task off the list and drops its file. Deleting a deleted task answers the same. */
  async delete(input: { actorId: string; taskId: string; now: Date }): Promise<{ taskId: string; deleted: true }> {
    return this.sql.begin(async (tx) => {
      const [task] = await tx<Row[]>`SELECT ${tx.unsafe(COLUMNS)} FROM academy.report_centre_tasks WHERE id = ${input.taskId} FOR UPDATE`;
      if (!task) return refuse('academy.report_not_found', 'no report task has that id');
      if (task.deleted_at) return { taskId: input.taskId, deleted: true as const };
      await tx`UPDATE academy.report_centre_tasks SET deleted_at = ${input.now}, csv = NULL WHERE id = ${input.taskId}`;
      await this.event(tx, input.taskId, 'deleted', input.actorId, input.now);
      return { taskId: input.taskId, deleted: true as const };
    });
  }

  /** A done task's stored CSV, exactly as it was made, while its retention lasts. */
  async file(taskId: string, now: Date = new Date()): Promise<AcademyReportCentreFile> {
    const [task] = await this.sql<Array<Row & { csv: string | null }>>`
      SELECT ${this.sql.unsafe(COLUMNS)}, csv FROM academy.report_centre_tasks WHERE id = ${taskId} AND deleted_at IS NULL
    `;
    if (!task) return refuse('academy.report_not_found', 'no report task has that id');
    if (task.state !== 'done') return refuse('academy.report_not_ready', `the task is ${task.state}, so it has no file`);
    if (task.csv === null || (task.expires_at && task.expires_at.getTime() <= now.getTime()))
      return refuse('academy.report_expired', `the file expired at ${iso(task.expires_at)}`);
    return { ...view(task, now), csv: task.csv };
  }

  /**
   * One pass of the report sweep: drops expired files, finishes the tasks already running, then starts the queued ones.
   * Returns how many tasks it finished and started.
   */
  async sweep(now: Date = new Date()): Promise<{ finished: number; started: number }> {
    const expired = await this.sql<Array<{ id: string }>>`
      UPDATE academy.report_centre_tasks SET csv = NULL
       WHERE state = 'done' AND csv IS NOT NULL AND expires_at <= ${now} RETURNING id
    `;
    for (const { id } of expired) await this.event(this.sql, id, 'expired', null, now);

    const running = await this.sql<Array<{ id: string }>>`
      SELECT id FROM academy.report_centre_tasks WHERE state = 'running' AND deleted_at IS NULL ORDER BY requested_at
    `;
    let finished = 0;
    for (const { id } of running) if (await this.finish(id, now)) finished += 1;

    const started = await this.sql<Array<{ id: string }>>`
      UPDATE academy.report_centre_tasks SET state = 'running', started_at = ${now}
       WHERE state = 'queued' AND deleted_at IS NULL RETURNING id
    `;
    for (const { id } of started) await this.event(this.sql, id, 'started', null, now);
    return { finished, started: started.length };
  }

  /** Makes one running task's file, or fails it with the refusal that stops it. False when it was no longer running. */
  private finish(taskId: string, now: Date): Promise<boolean> {
    return this.sql.begin(async (tx) => {
      const [task] = await tx<Row[]>`
        SELECT ${tx.unsafe(COLUMNS)} FROM academy.report_centre_tasks
         WHERE id = ${taskId} AND state = 'running' AND deleted_at IS NULL FOR UPDATE SKIP LOCKED
      `;
      if (!task) return false;
      const fail = async (failure: string) => {
        await tx`UPDATE academy.report_centre_tasks SET state = 'failed', failure = ${failure}, finished_at = ${now} WHERE id = ${taskId}`;
        await this.event(tx, taskId, 'failed', null, now);
        return true;
      };
      const { rowLimit, retentionHours } = this.settings;
      if (rowLimit === null) return fail('academy.report_limit_unset');
      if (retentionHours === null) return fail('academy.report_retention_unset');
      const ids = await learnerIds(tx, { tag: task.tag, after: null, limit: rowLimit + 1 });
      if (ids.length > rowLimit) return fail('academy.report_too_large');
      const rows = await summariesOf(tx, ids);
      const csv = learnersReportCsv(task, now, rows);
      const sha256 = createHash('sha256').update(csv, 'utf8').digest('hex');
      const expiresAt = new Date(now.getTime() + retentionHours * 3_600_000);
      await tx`
        UPDATE academy.report_centre_tasks
           SET state = 'done', csv = ${csv}, rows = ${rows.length}, sha256 = ${sha256}, finished_at = ${now}, expires_at = ${expiresAt}
         WHERE id = ${taskId}
      `;
      await this.event(tx, taskId, 'done', null, now);
      return true;
    });
  }
}
