/**
 * AC-analytics-01 and AC-analytics-02 (J-academy-16), against a real database: learner summaries and their blank page
 * size, the daily table's unrecorded days, and a report task from request to sweep, abort, expiry and delete. Every
 * refusal has a test and writes nothing.
 */
import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { expectRefusal, useServiceDb } from '@intafaced/service-kit/testing';
import { LearnerSummaries } from './learner-summaries.js';
import { ReportTasks, type ReportTaskSettings } from './report-tasks.js';
import { AcademyCustomerStore } from '../learning/customer-store.js';

const db = useServiceDb({ service: 'academy', from: import.meta.url });
const A = '33333333-3333-4333-8333-333333333333';
const T0 = new Date('2026-11-12T08:00:00.000Z');
const later = (seconds: number) => new Date(T0.getTime() + seconds * 1000);
const SETTINGS: ReportTaskSettings = { pageSize: 50, retentionMinutes: 1440, rowLimit: 100, sweepSeconds: 10 };

const tagOf = () => `t-${Math.random().toString(36).slice(2, 10)}`;

/** A learner on the foundations path with `items` completions, carrying `tag`. */
async function learner(tag: string, items: number): Promise<string> {
  const id = randomUUID();
  await db.sql`INSERT INTO academy.cert_enrollments (user_id, path_slug, enrolled_at) VALUES (${id}, 'foundations', ${T0})`;
  for (let i = 0; i < items; i += 1)
    await db.sql`INSERT INTO academy.cert_item_completions (user_id, item_slug, completed_at) VALUES (${id}, ${`item-${i}`}, ${later(60 + i)})`;
  await db.sql`INSERT INTO academy.learner_tags (user_id, tag, added_by, added_at) VALUES (${id}, ${tag}, ${A}, ${T0})`;
  return id;
}

describe('learner summaries', () => {
  it('lists each learner carrying the tag with enrolments, items completed and last active; none is an empty page', async () => {
    const summaries = new LearnerSummaries(db.sql, 2);
    const tag = tagOf();
    expect(await summaries.page({ tag })).toEqual({ tag, pageSize: 2, rows: [], next: null });
    const ids = [await learner(tag, 2), await learner(tag, 0), await learner(tag, 1)].sort();
    const first = await summaries.page({ tag });
    expect(first.rows.map((r) => r.userId)).toEqual(ids.slice(0, 2));
    expect(first.next).toBe(ids[1]);
    const second = await summaries.page({ tag, after: first.next! });
    expect(second).toMatchObject({ rows: [{ userId: ids[2] }], next: null });
    const all = [...first.rows, ...second.rows];
    for (const row of all) {
      expect(row.enrolments).toBe(1);
      expect(row.tags).toEqual([tag]);
    }
    const counts = Object.fromEntries(all.map((r) => [r.userId, [r.itemsCompleted, r.lastActiveAt]]));
    const [two] = (
      await db.sql<Array<{ user_id: string }>>`
      SELECT user_id FROM academy.cert_item_completions WHERE user_id = ANY(${ids}) GROUP BY user_id HAVING count(*) = 2
    `
    ).map((r) => r.user_id);
    expect(counts[two!]).toEqual([2, later(61).toISOString()]);
  });

  it('refuses by name when the owner has not set the page size', async () => {
    await expectRefusal(new LearnerSummaries(db.sql, null).page({}), 'academy.learner_summaries_list_limit_unset');
  });
});

describe('the daily activity table', () => {
  it('reads "not recorded" for a day before the service recorded, and real counts from then on', async () => {
    const store = new AcademyCustomerStore(db.sql);
    await db.sql`DELETE FROM academy.metrics_recording`;
    await db.sql`INSERT INTO academy.metrics_recording (id, since) VALUES (1, '2026-11-10T09:00:00Z')`;
    const read = await store.opsMetrics({ from: '2026-11-08', to: '2026-11-10' });
    // Older rows already stored move the start back; with none, it is the recorded start.
    const [{ oldest } = { oldest: null }] = await db.sql<Array<{ oldest: string | null }>>`
      SELECT to_char(LEAST((SELECT min(touched_at) FROM academy.learning_touches),
        (SELECT min(completed_at) FROM academy.cert_item_completions),
        (SELECT min(granted_at) FROM academy.cert_grants)) AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS oldest
    `;
    const since = oldest && oldest < '2026-11-10' ? oldest : '2026-11-10';
    expect(read.recordingSince).toBe(since);
    for (const day of read.days) {
      const cell = day.date < since ? { value: null, reason: 'metric_not_recorded' } : { value: expect.any(Number), reason: null };
      expect(day.lessonsRead, day.date).toEqual(cell);
      expect(day.completions, day.date).toEqual(cell);
      expect(day.grants, day.date).toEqual(cell);
    }
    expect(read.days.map((d) => d.date)).toEqual(['2026-11-08', '2026-11-09', '2026-11-10']);
  });
});

describe('report tasks', () => {
  const reports = (settings: Partial<ReportTaskSettings> = {}) => new ReportTasks(db.sql, { ...SETTINGS, ...settings });
  const founder = () => randomUUID();

  it('runs a requested learners report on the sweep: queued, running, then done with its stored file, time and hash', async () => {
    const tag = tagOf();
    const tagged = [await learner(tag, 1), await learner(tag, 0)].sort();
    await learner(tagOf(), 3);
    const r = reports();
    const me = founder();
    expect((await r.list(me)).nextN).toBe(1);
    const task = await r.request({ actorId: me, kind: 'learners', tag, n: 1, now: T0 });
    expect(task).toMatchObject({ n: 1, state: 'queued', tag, requestedBy: me, startedAt: null });
    // A retry of the same request answers the same task; a number past the next refuses.
    expect((await r.request({ actorId: me, kind: 'learners', tag, n: 1, now: later(1) })).id).toBe(task.id);
    await expectRefusal(r.request({ actorId: me, kind: 'learners', tag, n: 3, now: T0 }), 'academy.report_out_of_order');
    await expectRefusal(r.file(task.id, T0), 'academy.report_not_ready');

    await r.sweep(later(10));
    expect((await r.list(me, later(10))).tasks.find((t) => t.id === task.id)).toMatchObject({ state: 'running' });
    await r.sweep(later(20));
    const file = await r.file(task.id, later(21));
    expect(file).toMatchObject({ state: 'done', rows: 2, finishedAt: later(20).toISOString(), expired: false });
    expect(file.expiresAt).toBe(new Date(later(20).getTime() + 24 * 3_600_000).toISOString());
    expect(createHash('sha256').update(file.csv, 'utf8').digest('hex')).toBe(file.sha256);
    const lines = file.csv.trimEnd().split('\r\n');
    expect(lines[0]).toBe(`learners report,1,made at,${later(20).toISOString()},tag,${tag}`);
    expect(lines[1]).toBe('learner,enrolments,items completed,last active,tags');
    expect(lines.slice(2).map((l) => l.split(',')[0])).toEqual(tagged);

    // After the retention the file is gone, and the sweep drops its bytes.
    const gone = new Date(Date.parse(file.expiresAt!) + 1);
    await expectRefusal(r.file(task.id, gone), 'academy.report_expired');
    await r.sweep(gone);
    const [{ csv } = { csv: 'x' }] = await db.sql<
      Array<{ csv: string | null }>
    >`SELECT csv FROM academy.report_centre_tasks WHERE id = ${task.id}`;
    expect(csv).toBeNull();
    expect((await r.list(me, gone)).tasks.find((t) => t.id === task.id)).toMatchObject({ expired: true });
  });

  it('aborts a running task: it never gets a file, even when the sweep comes round again', async () => {
    const r = reports();
    const me = founder();
    const task = await r.request({ actorId: me, kind: 'learners', tag: null, n: 1, now: T0 });
    await r.sweep(later(10));
    expect((await r.abort({ actorId: me, taskId: task.id, now: later(11) })).state).toBe('aborted');
    expect((await r.abort({ actorId: me, taskId: task.id, now: later(12) })).state).toBe('aborted');
    await r.sweep(later(20));
    await expectRefusal(r.file(task.id, later(21)), 'academy.report_not_ready');
    const [{ events } = { events: [] }] = await db.sql<Array<{ events: string[] }>>`
      SELECT array_agg(event ORDER BY n) AS events FROM academy.report_centre_events WHERE task_id = ${task.id}
    `;
    expect(events).toEqual(['requested', 'started', 'aborted']);
  });

  it('refuses to abort a finished task, and deletes any task: off the list, its file gone', async () => {
    const r = reports();
    const me = founder();
    const task = await r.request({ actorId: me, kind: 'learners', tag: tagOf(), n: 1, now: T0 });
    await r.sweep(later(10));
    await r.sweep(later(20));
    await expectRefusal(r.abort({ actorId: me, taskId: task.id, now: later(21) }), 'academy.report_not_abortable');
    expect(await r.delete({ actorId: me, taskId: task.id, now: later(22) })).toEqual({ taskId: task.id, deleted: true });
    expect(await r.delete({ actorId: me, taskId: task.id, now: later(23) })).toEqual({ taskId: task.id, deleted: true });
    expect((await r.list(me, later(24))).tasks.map((t) => t.id)).not.toContain(task.id);
    await expectRefusal(r.file(task.id, later(24)), 'academy.report_not_found');
    await expectRefusal(r.abort({ actorId: me, taskId: task.id, now: later(24) }), 'academy.report_not_found');
    expect((await r.list(me)).nextN).toBe(2);
  });

  it('fails a report with more learners than one may hold, by name', async () => {
    const tag = tagOf();
    await learner(tag, 0);
    await learner(tag, 0);
    const r = reports({ rowLimit: 1 });
    const task = await r.request({ actorId: founder(), kind: 'learners', tag, n: 1, now: T0 });
    await r.sweep(later(10));
    await r.sweep(later(20));
    expect((await r.list(A, later(21))).tasks.find((t) => t.id === task.id)).toMatchObject({
      state: 'failed',
      failure: 'academy.report_too_large',
      sha256: null,
    });
  });

  it('refuses a request by name while an owner value is blank, and writes nothing', async () => {
    const me = founder();
    for (const [blank, code] of [
      [{ retentionMinutes: null }, 'academy.report_retention_unset'],
      [{ rowLimit: null }, 'academy.report_limit_unset'],
      [{ sweepSeconds: null }, 'academy.report_sweep_unset'],
    ] as const)
      await expectRefusal(reports(blank).request({ actorId: me, kind: 'learners', tag: null, n: 1, now: T0 }), code);
    await expectRefusal(reports({ pageSize: null }).list(me), 'academy.report_tasks_list_limit_unset');
    const [{ n } = { n: -1 }] = await db.sql<
      Array<{ n: number }>
    >`SELECT count(*)::int AS n FROM academy.report_centre_tasks WHERE requested_by = ${me}`;
    expect(n).toBe(0);
  });
});
