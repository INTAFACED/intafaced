/**
 * AC-assignments-02 — staff grading: the queue under aliases, the grader lease, the grade trail and the learner's read.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { CourseRecords } from './courses.js';
import { CoursePreview } from './course-preview.js';
import { CourseLearners } from './course-learners.js';
import { CourseAssignments, type PutObjectFn } from './assignments.js';
import { PeerReviews, type GetObjectFn } from './peer-review.js';
import { AssignmentGrading } from './grading.js';

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', '..', 'drizzle');
const MIGRATIONS = readdirSync(drizzle)
  .filter((name) => name.endsWith('.sql') && !name.endsWith('.down.sql'))
  .sort()
  .map((name) => readFileSync(join(drizzle, name), 'utf8'));

function adminUrl(): string {
  const raw = process.env.TEST_DATABASE_URL ?? 'postgres://test:test@127.0.0.1:55432/intafaced_test';
  const url = new URL(raw);
  if (!url.pathname.replace(/^\//, '').endsWith('_test')) url.pathname = '/intafaced_test';
  return url.toString();
}

const db: TestDatabase = await createTestDatabase({ service: 'academy', url: adminUrl(), migrations: MIGRATIONS });
const A = '33333333-3333-4333-8333-333333333333';
const L = '55555555-5555-4555-8555-555555555555';
const M = '77777777-7777-4777-8777-777777777777';
const N = '88888888-8888-4888-8888-888888888888';
const X = '99999999-9999-4999-8999-999999999999';
const OUTSIDER = '66666666-6666-4666-8666-666666666666';
const NOW = new Date('2026-10-23T12:00:00.000Z');
const later = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000);

afterAll(async () => {
  await db.drop();
}, 30_000);

/** A fake object store keyed by path: what a signed PUT stored, a signed GET of the same key reads. */
let store = new Map<string, Uint8Array>();
beforeEach(async () => {
  await db.truncateAll();
  store = new Map();
});
const STORAGE = { endpoint: 'http://store.test', bucket: 'b', accessKey: 'k', secretKey: 's', region: 'r', ttlSeconds: 300 };
const put: PutObjectFn = async (url, bytes) => {
  store.set(new URL(url).pathname, bytes);
  return 200;
};
const get: GetObjectFn = async (url) => {
  const bytes = store.get(new URL(url).pathname);
  return bytes ? { status: 200, bytes } : { status: 404, bytes: new Uint8Array() };
};
const PDF = Buffer.from('%PDF-1.4\nTEST\n%%EOF\n');

const courses = () => new CourseRecords(db.sql, { maxSections: 5, maxItems: 5 });
const learners = () => new CourseLearners(db.sql, new CoursePreview(db.sql));
const assignments = () => new CourseAssignments(db.sql, STORAGE, { maxBytes: 1024, types: ['application/pdf'] }, put);
const reviews = () => new PeerReviews(db.sql, assignments(), STORAGE, get);
const B = '44444444-4444-4444-8444-444444444444';
const grading = (lease: number | null = 900) => new AssignmentGrading(db.sql, assignments(), lease);

const CRITERIA = [
  { name: 'Sizing', levels: ['0', '1', '2'] },
  { name: 'Working shown', levels: ['0', '0.5'] },
];

/** A free course with one text-only assignment, its brief saved, and learners L, M, N and X enrolled. Published unless asked. */
async function openAssignment({ publish = true, file = 'off' as 'off' | 'optional', titles = ['Write-up'] } = {}) {
  const course = await courses().create({
    slug: 'risk-basics',
    title: 'Risk basics',
    summary: null,
    thumbnailUrl: null,
    pricing: 'free',
    price: null,
    priceAsset: null,
    operatorId: A,
    now: NOW,
  });
  const detail = await courses().saveOutline({
    courseId: course.id,
    revision: 1,
    sections: [{ title: 'Work', items: titles.map((title) => ({ kind: 'assignment' as const, title, indent: 0, url: null })) }],
    operatorId: A,
    now: NOW,
  });
  const items = detail.outline[0]!.items;
  const item = items[0]!;
  for (const { id } of items)
    await assignments().save({
      itemId: id,
      revision: 0,
      instructions: 'Size one trade.',
      points: '10',
      dueAt: null,
      text: 'required',
      file,
      operatorId: A,
      now: NOW,
    });
  const publishIt = async () => {
    const current = await courses().get(course.id);
    await courses().setState({
      courseId: course.id,
      to: 'published',
      revision: current.course.revision,
      reason: 'TEST',
      operatorId: A,
      now: NOW,
    });
    for (const userId of [L, M, N, X]) await learners().enrol({ userId, slug: 'risk-basics', track: 'audit', now: NOW });
  };
  if (publish) await publishIt();
  return { course, item, items, publishIt };
}

const steps = (itemId: string, over: Partial<{ revision: number; peer: boolean; peerCount: number | null; self: boolean }> = {}) =>
  reviews().save({ itemId, revision: 0, peer: true, peerCount: 2, self: true, criteria: CRITERIA, operatorId: A, now: NOW, ...over });

const handIn = (itemId: string, userId: string, text: string, minutes = 0) =>
  assignments().submit({ itemId, version: 1, text, fileId: null, userId, now: later(minutes) });

const state = (itemId: string, userId: string) => reviews().state({ itemId, userId, now: NOW });

const grade = (
  itemId: string,
  submissionId: string,
  over: Partial<{ n: number; score: string; comment: string | null; reason: string | null; operatorId: string; now: Date }> = {},
) => grading().grade({ itemId, submissionId, n: 1, score: '8', comment: 'Clear sizing.', reason: null, operatorId: A, now: NOW, ...over });

describe('grading hand-ins (AC-assignments-02)', () => {
  it('the queue shows each learner under an alias with peer reviews; a grade is released to the learner with no grader', async () => {
    const { item } = await openAssignment();
    await reviews().save({
      itemId: item.id,
      revision: 0,
      peer: true,
      peerCount: 1,
      self: false,
      criteria: CRITERIA,
      operatorId: A,
      now: NOW,
    });
    await handIn(item.id, L, 'L sizes by risk.');
    await handIn(item.id, M, 'M sizes by a fixed amount.', 1);
    await reviews().submit({ itemId: item.id, taskId: (await state(item.id, M)).task!.id, marks: ['2', '0.5'], userId: M, now: NOW });
    const queue = await grading().queue({ itemId: item.id, operatorId: A, now: NOW });
    expect(queue).toMatchObject({ points: '10', leaseSeconds: 900 });
    expect(queue.rows.map((r) => [r.alias, r.text])).toEqual([
      [1, 'L sizes by risk.'],
      [2, 'M sizes by a fixed amount.'],
    ]);
    expect(JSON.stringify(queue)).not.toContain(L);
    expect(queue.rows[0]!.peerReviews).toEqual({ received: 1, meanTotal: '2.5' });
    const graded = await grade(item.id, queue.rows[0]!.submissionId);
    expect(graded.rows[0]).toMatchObject({ grade: { score: '8', comment: 'Clear sizing.', overrides: 0 }, nextN: 2, lease: null });
    const view = await assignments().learnerView({ itemId: item.id, userId: L });
    expect(view.grade).toEqual({
      version: 1,
      n: 1,
      score: '8',
      points: '10',
      comment: 'Clear sizing.',
      gradedAt: NOW.toISOString(),
      readAt: null,
    });
    expect(view.submissions[0]!.state).toBe('graded');
    expect(JSON.stringify(view)).not.toContain(A);
    expect((await assignments().learnerView({ itemId: item.id, userId: M })).grade).toBeNull();
  });

  it('a second grader is locked out while the lease is live and takes it once it expires; a blank lease refuses', async () => {
    const { item } = await openAssignment();
    await handIn(item.id, L, 'L');
    const [row] = (await grading().queue({ itemId: item.id, operatorId: A, now: NOW })).rows;
    await expect(grading(null).open({ itemId: item.id, submissionId: row!.submissionId, operatorId: A, now: NOW })).rejects.toMatchObject({
      code: 'academy.grader_lease_unset',
    });
    const opened = await grading().open({ itemId: item.id, submissionId: row!.submissionId, operatorId: A, now: NOW });
    expect(opened.rows[0]!.lease).toMatchObject({ mine: true });
    expect((await grading().queue({ itemId: item.id, operatorId: B, now: NOW })).rows[0]!.lease).toMatchObject({ mine: false });
    await expect(grading().open({ itemId: item.id, submissionId: row!.submissionId, operatorId: B, now: NOW })).rejects.toMatchObject({
      code: 'academy.grader_locked',
    });
    await expect(grade(item.id, row!.submissionId, { operatorId: B })).rejects.toMatchObject({ code: 'academy.grader_locked' });
    const afterExpiry = later(16);
    await grading().open({ itemId: item.id, submissionId: row!.submissionId, operatorId: B, now: afterExpiry });
    await expect(grade(item.id, row!.submissionId, { operatorId: B, now: afterExpiry })).resolves.toBeDefined();
  });

  it('a retry of the same grade answers as stored; an override needs a reason; a score above the points and a stale n refuse', async () => {
    const { item } = await openAssignment();
    await handIn(item.id, L, 'L');
    const id = (await grading().queue({ itemId: item.id, operatorId: A, now: NOW })).rows[0]!.submissionId;
    await expect(grade(item.id, id, { score: '10.5' })).rejects.toMatchObject({ code: 'academy.grade_invalid' });
    await grade(item.id, id);
    await grade(item.id, id);
    const [events] = await db.sql<Array<{ n: number }>>`SELECT count(*)::int AS n FROM academy.assignment_grade_events`;
    expect(events!.n).toBe(1);
    await expect(grade(item.id, id, { score: '9' })).rejects.toMatchObject({ code: 'academy.revision_stale' });
    // The same n with another comment is a different grade, not a retry: refused, and the stored one stands.
    await expect(grade(item.id, id, { comment: 'Units missing.' })).rejects.toMatchObject({ code: 'academy.revision_stale' });
    await expect(grade(item.id, id, { n: 2, score: '9' })).rejects.toMatchObject({ code: 'academy.reason_required' });
    const over = await grade(item.id, id, { n: 2, score: '9', reason: 'TEST regraded on appeal' });
    expect(over.rows[0]!.grade).toMatchObject({ score: '9', overrides: 1 });
    expect((await assignments().learnerView({ itemId: item.id, userId: L })).grade!.score).toBe('9');
    await expect(grade(item.id, '00000000-0000-4000-8000-000000000000')).rejects.toMatchObject({ code: 'academy.submission_not_found' });
    await assignments().withdraw({ itemId: item.id, reason: 'TEST', operatorId: A, now: NOW });
    await expect(grade(item.id, id, { n: 3, score: '7', reason: 'TEST late change' })).rejects.toMatchObject({
      code: 'academy.assignment_closed',
    });
  });

  it('marking feedback read is recorded once and changes no grade; a hand-in with no grade refuses', async () => {
    const { item } = await openAssignment();
    await handIn(item.id, L, 'L');
    await expect(grading().markRead({ itemId: item.id, version: 1, n: 1, userId: L, now: NOW })).rejects.toMatchObject({
      code: 'academy.submission_not_found',
    });
    await grade(item.id, (await grading().queue({ itemId: item.id, operatorId: A, now: NOW })).rows[0]!.submissionId);
    await grading().markRead({ itemId: item.id, version: 1, n: 1, userId: L, now: later(5) });
    await grading().markRead({ itemId: item.id, version: 1, n: 1, userId: L, now: later(9) });
    const grade1 = (await assignments().learnerView({ itemId: item.id, userId: L })).grade!;
    expect(grade1).toMatchObject({ score: '8', readAt: later(5).toISOString() });
    // A change of grade after the read is unread again; a read sent for the old event leaves it so.
    const id = (await grading().queue({ itemId: item.id, operatorId: A, now: NOW })).rows[0]!.submissionId;
    await grade(item.id, id, { n: 2, score: '9', reason: 'TEST regraded' });
    await grading().markRead({ itemId: item.id, version: 1, n: 1, userId: L, now: later(10) });
    expect((await assignments().learnerView({ itemId: item.id, userId: L })).grade).toMatchObject({ n: 2, score: '9', readAt: null });
    // A brief saved later with other points leaves a grade out of the points it was given against.
    await assignments().save({
      itemId: item.id,
      revision: 1,
      instructions: 'Size one trade.',
      points: '5',
      dueAt: null,
      text: 'required',
      file: 'off',
      operatorId: A,
      now: later(11),
    });
    expect((await assignments().learnerView({ itemId: item.id, userId: L })).grade).toMatchObject({ score: '9', points: '10' });
    await expect(grading().markRead({ itemId: item.id, version: 1, n: 1, userId: OUTSIDER, now: NOW })).rejects.toMatchObject({
      code: 'academy.enrolment_required',
    });
  });

  it('the grades table lists each assignment in outline order: a grade, a hand-in waiting, and never a zero for one not tried', async () => {
    const { items } = await openAssignment({ titles: ['Write-up', 'Journal review'] });
    await handIn(items[0]!.id, L, 'L');
    await handIn(items[0]!.id, M, 'M');
    const rows = (await grading().queue({ itemId: items[0]!.id, operatorId: A, now: NOW })).rows;
    await grade(items[0]!.id, rows[0]!.submissionId);
    const [course] = await grading().courseGrades(L);
    expect(course).toEqual({
      slug: 'risk-basics',
      title: 'Risk basics',
      rows: [
        { state: 'graded', itemId: items[0]!.id, title: 'Write-up', type: 'assignment', score: '8', possible: '10' },
        { state: 'not_attempted', itemId: items[1]!.id, title: 'Journal review', type: 'assignment', possible: '10' },
      ],
      averages: [{ type: 'assignment', count: 1, percent: '80.0' }],
    });
    const [waiting] = await grading().courseGrades(M);
    expect(waiting!.rows.map((r) => r.state)).toEqual(['handed_in', 'not_attempted']);
    expect(waiting!.averages).toEqual([]);
    // A newer hand-in after the grade waits for its own; an assignment staff withdrew reads as withdrawn, not a zero.
    await assignments().submit({ itemId: items[0]!.id, version: 2, text: 'L again', fileId: null, userId: L, now: later(5) });
    await assignments().withdraw({ itemId: items[1]!.id, reason: 'TEST', operatorId: A, now: NOW });
    const [again] = await grading().courseGrades(L);
    expect(again!.rows.map((r) => r.state)).toEqual(['handed_in', 'withdrawn']);
    expect(again!.averages).toEqual([]);
    expect(await grading().courseGrades(OUTSIDER)).toEqual([]);
  });
  it('a bulk file grades good rows by alias, lists the bad ones by line, and the same file again changes nothing', async () => {
    const { item } = await openAssignment();
    await handIn(item.id, L, 'L', 0);
    await handIn(item.id, M, 'M', 1);
    await handIn(item.id, N, 'N', 2);
    const queue = await grading().queue({ itemId: item.id, operatorId: A, now: NOW });
    const [, two, three] = queue.rows;
    // Learner 2 already has a grade, so changing it needs a reason; B holds Learner 3.
    await grade(item.id, two!.submissionId);
    await grading().open({ itemId: item.id, submissionId: three!.submissionId, operatorId: B, now: NOW });
    const csv = [
      'learner,score,comment,reason',
      'Learner 1,7.5,"Good, clear sizing.",',
      'Learner 2,9,,',
      'Learner 3,6,,',
      'Learner 9,5,,',
      'Learner 1,4,,',
      'Learner 1x,4,,',
      '',
    ].join('\r\n');
    const bulk = (text = csv, now = NOW) => grading().bulkGrade({ itemId: item.id, fileName: 'grades.csv', csv: text, operatorId: A, now });
    const first = await bulk();
    expect(first.repeated).toBe(false);
    expect(first.applied).toEqual([{ line: 2, alias: 1, score: '7.5' }]);
    expect(first.rejected.map((r) => [r.line, r.alias, r.code])).toEqual([
      [3, 2, 'academy.reason_required'],
      [4, 3, 'academy.grader_locked'],
      [5, 9, 'academy.submission_not_found'],
      [6, 1, 'academy.bulk_row_invalid'],
      [7, null, 'academy.bulk_row_invalid'],
    ]);
    expect(first.queue.rows[0]!.grade).toMatchObject({ score: '7.5', comment: 'Good, clear sizing.', overrides: 0 });
    expect(JSON.stringify(first)).not.toContain(L);
    const view = await assignments().learnerView({ itemId: item.id, userId: L });
    expect(view.grade).toMatchObject({ score: '7.5', comment: 'Good, clear sizing.' });

    const again = await bulk(csv, later(5));
    expect(again).toMatchObject({ repeated: true, sha256: first.sha256, at: first.at, applied: first.applied, rejected: first.rejected });
    const events = await db.sql<Array<{ n: number }>>`
      SELECT g.n FROM academy.assignment_grade_events g JOIN academy.assignment_submissions s ON s.id = g.submission_id
      WHERE s.item_id = ${item.id}
    `;
    expect(events).toHaveLength(2);

    // A fixed file with a reason is a new file: Learner 2's grade changes and keeps its first event.
    const fixed = await bulk('learner,score,comment,reason\n2,9,,Re-marked after review\n');
    expect(fixed.applied).toEqual([{ line: 2, alias: 2, score: '9' }]);
    expect(fixed.queue.rows[1]!.grade).toMatchObject({ score: '9', overrides: 1 });
  });

  it('a bulk file with the wrong header or no rows refuses whole; a blank lease refuses it', async () => {
    const { item } = await openAssignment();
    await handIn(item.id, L, 'L');
    const bulk = (csv: string, lease: number | null = 900) =>
      grading(lease).bulkGrade({ itemId: item.id, fileName: 'g.csv', csv, operatorId: A, now: NOW });
    await expect(bulk('alias,score\n1,5\n')).rejects.toMatchObject({ code: 'academy.bulk_file_invalid' });
    await expect(bulk('learner,score,comment,reason\n')).rejects.toMatchObject({ code: 'academy.bulk_file_invalid' });
    await expect(bulk('learner,score,comment,reason\n1,"5,,\n')).rejects.toMatchObject({ code: 'academy.bulk_file_invalid' });
    await expect(bulk('learner,score,comment,reason\n1,5,,\n', null)).rejects.toMatchObject({ code: 'academy.grader_lease_unset' });
    const files = await db.sql<
      Array<{ n: number }>
    >`SELECT count(*)::int AS n FROM academy.assignment_bulk_grades WHERE item_id = ${item.id}`;
    expect(files[0]!.n).toBe(0);
  });
});
