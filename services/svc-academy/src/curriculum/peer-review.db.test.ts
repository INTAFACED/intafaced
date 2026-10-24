/**
 * AC-assignments-03 — rubrics and peer or self review: the steps staff save, and how learners are handed work to review.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { CourseRecords } from './courses.js';
import { CoursePreview } from './course-preview.js';
import { CourseLearners } from './course-learners.js';
import { CourseAssignments } from './assignments.js';
import { PeerReviews, rubricTotal } from './peer-review.js';

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

beforeEach(async () => {
  await db.truncateAll();
});

const courses = () => new CourseRecords(db.sql, { maxSections: 5, maxItems: 5 });
const learners = () => new CourseLearners(db.sql, new CoursePreview(db.sql));
const assignments = () => new CourseAssignments(db.sql, null, { maxBytes: null, types: null });
const reviews = () => new PeerReviews(db.sql, assignments());

const CRITERIA = [
  { name: 'Sizing', levels: ['0', '1', '2'] },
  { name: 'Working shown', levels: ['0', '0.5'] },
];

/** A free course with one text-only assignment, its brief saved, and learners L, M, N and X enrolled. Published unless asked. */
async function openAssignment({ publish = true } = {}) {
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
    sections: [{ title: 'Work', items: [{ kind: 'assignment', title: 'Write-up', indent: 0, url: null }] }],
    operatorId: A,
    now: NOW,
  });
  const item = detail.outline[0]!.items[0]!;
  await assignments().save({
    itemId: item.id,
    revision: 0,
    instructions: 'Size one trade.',
    points: '10',
    dueAt: null,
    text: 'required',
    file: 'off',
    operatorId: A,
    now: NOW,
  });
  const publishIt = async () => {
    const current = await courses().get(course.id);
    await courses().setState({ courseId: course.id, to: 'published', revision: current.course.revision, reason: 'TEST', operatorId: A, now: NOW });
    for (const userId of [L, M, N, X]) await learners().enrol({ userId, slug: 'risk-basics', track: 'audit', now: NOW });
  };
  if (publish) await publishIt();
  return { course, item, publishIt };
}

const steps = (itemId: string, over: Partial<{ revision: number; peer: boolean; peerCount: number | null; self: boolean }> = {}) =>
  reviews().save({ itemId, revision: 0, peer: true, peerCount: 2, self: true, criteria: CRITERIA, operatorId: A, now: NOW, ...over });

const handIn = (itemId: string, userId: string, text: string, minutes = 0) =>
  assignments().submit({ itemId, version: 1, text, fileId: null, userId, now: later(minutes) });

const state = (itemId: string, userId: string) => reviews().state({ itemId, userId, now: NOW });

describe('review steps on the founder console (AC-assignments-03)', () => {
  it('saves over the revision read, keeps an unchanged rubric and writes a new one for other criteria', async () => {
    const { item } = await openAssignment();
    await steps(item.id);
    const first = (await assignments().adminView(item.id)).review!;
    expect(first).toMatchObject({ revision: 1, peer: true, peerCount: 2, self: true, rubric: { criteria: CRITERIA } });
    await expect(steps(item.id)).rejects.toMatchObject({ code: 'academy.revision_stale' });
    await steps(item.id, { revision: 1, peerCount: 3 });
    const same = (await assignments().adminView(item.id)).review!;
    expect(same.rubric!.id).toBe(first.rubric!.id);
    await reviews().save({ itemId: item.id, revision: 2, peer: true, peerCount: 3, self: false, criteria: [CRITERIA[0]!], operatorId: A, now: NOW });
    const other = (await assignments().adminView(item.id)).review!;
    expect(other.rubric!.id).not.toBe(first.rubric!.id);
    // The first rubric stays as it was, for the reviews scored against it.
    const [kept] = await db.sql<Array<{ criteria: unknown }>>`SELECT criteria FROM academy.assignment_rubrics WHERE id = ${first.rubric!.id}`;
    expect(kept!.criteria).toEqual(CRITERIA);
  });

  it('a published course refuses peer review with no count; a draft takes it and then is not published', async () => {
    const published = await openAssignment();
    await expect(steps(published.item.id, { peerCount: null })).rejects.toMatchObject({ code: 'academy.peer_count_unset' });
    await db.truncateAll();
    const draft = await openAssignment({ publish: false });
    await steps(draft.item.id, { peerCount: null });
    await expect(draft.publishIt()).rejects.toMatchObject({ code: 'academy.peer_count_unset' });
  });

  it('a step with no rubric, or two criteria of one name, refuses as an invalid rubric', async () => {
    const { item } = await openAssignment();
    await expect(reviews().save({ itemId: item.id, revision: 0, peer: true, peerCount: 1, self: false, criteria: [], operatorId: A, now: NOW })).rejects.toMatchObject({
      code: 'academy.rubric_invalid',
    });
    await expect(
      reviews().save({ itemId: item.id, revision: 0, peer: false, peerCount: null, self: true, criteria: [CRITERIA[0]!, { ...CRITERIA[1]!, name: 'sizing' }], operatorId: A, now: NOW }),
    ).rejects.toMatchObject({ code: 'academy.rubric_invalid' });
  });
});

describe('peer and self review for learners (AC-assignments-03)', () => {
  it('two peers, then the self review: never my own work as a peer, and a waiting list while too few others handed in', async () => {
    const { item } = await openAssignment();
    await steps(item.id);
    expect((await state(item.id, L)).stage).toBe('hand_in_first');
    await handIn(item.id, L, 'L sizes by risk.');
    // Nobody else has handed in: L waits and is never handed their own work.
    expect(await state(item.id, L)).toMatchObject({ stage: 'waiting', task: null, peerDone: 0 });
    expect((await assignments().adminView(item.id)).review).toMatchObject({ authorsShortOfReviews: 1, reviewersWaiting: 1 });

    await handIn(item.id, M, 'M sizes by a fixed amount.', 1);
    const one = await state(item.id, L);
    expect(one).toMatchObject({ stage: 'peer', task: { kind: 'peer', ordinal: 1, text: 'M sizes by a fixed amount.', criteria: CRITERIA } });
    // Reading again hands out nothing new.
    expect((await state(item.id, L)).task!.id).toBe(one.task!.id);
    const afterOne = await reviews().submit({ itemId: item.id, taskId: one.task!.id, marks: ['1', '0.5'], userId: L, now: NOW });
    expect(afterOne).toMatchObject({ stage: 'waiting', peerDone: 1, task: null });

    await handIn(item.id, N, 'N sizes from the stop.', 2);
    const two = await state(item.id, L);
    expect(two.task).toMatchObject({ ordinal: 2, text: 'N sizes from the stop.' });
    const afterTwo = await reviews().submit({ itemId: item.id, taskId: two.task!.id, marks: ['2', '0'], userId: L, now: NOW });
    expect(afterTwo).toMatchObject({ stage: 'self', peerDone: 2, task: { kind: 'self', ordinal: null, text: 'L sizes by risk.' } });
    const done = await reviews().submit({ itemId: item.id, taskId: afterTwo.task!.id, marks: ['2', '0.5'], userId: L, now: NOW });
    expect(done).toMatchObject({ stage: 'done', peerDone: 2, selfDone: true, task: null });

    const [totals] = await db.sql<Array<{ totals: string[] }>>`
      SELECT array_agg(total::text ORDER BY reviewed_at, id) AS totals FROM academy.assignment_reviews WHERE reviewer_id = ${L}
    `;
    expect(totals!.totals.map((t) => rubricTotal([t]))).toEqual(expect.arrayContaining(['1.5', '2', '2.5']));
    const own = await db.sql`SELECT 1 FROM academy.assignment_reviews WHERE reviewer_id = ${L} AND author_id = ${L} AND marks IS NOT NULL`;
    expect(own).toHaveLength(1);
  });

  it('hands out the least-reviewed work first, then the earliest hand-in', async () => {
    const { item } = await openAssignment();
    await steps(item.id, { peerCount: 1, self: false });
    await handIn(item.id, M, 'M', 1);
    await handIn(item.id, N, 'N', 2);
    await handIn(item.id, X, 'X', 3);
    // X reviews first and gets M, the earliest; L then gets N, which nobody reviews yet.
    expect((await state(item.id, X)).task!.text).toBe('M');
    await handIn(item.id, L, 'L', 4);
    expect((await state(item.id, L)).task!.text).toBe('N');
  });

  it('two learners asking at once are handed different work', async () => {
    const { item } = await openAssignment();
    await steps(item.id, { peerCount: 1, self: false });
    for (const [n, who] of [M, N, L, X].entries()) await handIn(item.id, who, `work ${n}`, n);
    const [l, x] = await Promise.all([state(item.id, L), state(item.id, X)]);
    expect(l.task!.text).not.toBe(x.task!.text);
    expect([l.task!.text, x.task!.text].sort()).toEqual(['work 0', 'work 1']);
  });

  it('the same marks again answer as stored; other marks, a bad level, or a stranger’s review id refuse by name', async () => {
    const { item } = await openAssignment();
    await steps(item.id, { peerCount: 1, self: false });
    await handIn(item.id, L, 'L');
    await handIn(item.id, M, 'M', 1);
    const task = (await state(item.id, L)).task!;
    await expect(reviews().submit({ itemId: item.id, taskId: task.id, marks: ['3', '0'], userId: L, now: NOW })).rejects.toMatchObject({
      code: 'academy.review_marks_invalid',
    });
    await expect(reviews().submit({ itemId: item.id, taskId: task.id, marks: ['1'], userId: L, now: NOW })).rejects.toMatchObject({
      code: 'academy.review_marks_invalid',
    });
    await expect(reviews().submit({ itemId: item.id, taskId: task.id, marks: ['1', '0'], userId: M, now: NOW })).rejects.toMatchObject({
      code: 'academy.review_task_not_found',
    });
    const first = await reviews().submit({ itemId: item.id, taskId: task.id, marks: ['1', '0'], userId: L, now: NOW });
    const again = await reviews().submit({ itemId: item.id, taskId: task.id, marks: ['1', '0'], userId: L, now: NOW });
    expect(again).toEqual(first);
    await expect(reviews().submit({ itemId: item.id, taskId: task.id, marks: ['2', '0'], userId: L, now: NOW })).rejects.toMatchObject({
      code: 'academy.review_already_sent',
    });
  });

  it('a learner who is not enrolled is refused, and an assignment with no steps is off', async () => {
    const { item } = await openAssignment();
    await expect(state(item.id, OUTSIDER)).rejects.toMatchObject({ code: 'academy.enrolment_required' });
    expect((await state(item.id, L)).stage).toBe('off');
  });

  it('sums rubric levels as decimals', () => {
    expect(rubricTotal(['0.5', '0.25', '1'])).toBe('1.75');
    expect(rubricTotal(['0', '0'])).toBe('0');
    expect(rubricTotal(['999999.99', '0.01'])).toBe('1000000');
  });
});
