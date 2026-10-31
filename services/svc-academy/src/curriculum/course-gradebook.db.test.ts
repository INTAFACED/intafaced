/**
 * AC-assignments-04, first part — the grading policy and the gradebook of a course staff made.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { CourseRecords } from './courses.js';
import { CoursePreview } from './course-preview.js';
import { CourseLearners } from './course-learners.js';
import { CourseQuizzes } from './course-quizzes.js';
import { CourseAssignments } from './assignments.js';
import { CourseGradebook } from './course-gradebook.js';
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
const M = '66666666-6666-4666-8666-666666666666';
const NOW = new Date();

afterAll(async () => {
  await db.drop();
}, 30_000);

beforeEach(async () => {
  await db.truncateAll();
});

const courses = () => new CourseRecords(db.sql, { maxSections: 5, maxItems: 5 });
const learners = () => new CourseLearners(db.sql, new CoursePreview(db.sql));
const quizzes = () => new CourseQuizzes(db.sql);
const STORAGE = { endpoint: 'http://store.test', bucket: 'b', accessKey: 'k', secretKey: 's', region: 'r', ttlSeconds: 300 };
const assignments = () => new CourseAssignments(db.sql, STORAGE, { maxBytes: 1024, types: ['application/pdf'] }, async () => 200);
const book = () => new CourseGradebook(db.sql);

/** A published course with three assignments and a quiz, learners L and M enrolled. */
async function course() {
  const created = await courses().create({
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
    courseId: created.id,
    revision: 1,
    sections: [
      {
        title: 'Work',
        items: [
          { kind: 'assignment', title: 'One', indent: 0, url: null },
          { kind: 'assignment', title: 'Two', indent: 0, url: null },
          { kind: 'assignment', title: 'Three', indent: 0, url: null },
          { kind: 'quiz', title: 'Check', indent: 0, url: null },
          { kind: 'lesson', title: 'Read me', indent: 0, url: null },
        ],
      },
    ],
    operatorId: A,
    now: NOW,
  });
  const [one, two, three, quiz, lesson] = detail.outline[0]!.items.map((i) => i.id) as [string, string, string, string, string];
  for (const itemId of [one, two, three])
    await assignments().save({
      itemId,
      revision: 0,
      instructions: 'Size one trade.',
      points: '10',
      dueAt: null,
      text: 'required',
      file: 'off',
      operatorId: A,
      now: NOW,
    });
  await quizzes().save({
    itemId: quiz,
    revision: 0,
    passMark: 1,
    attemptLimit: 1,
    scoringPolicy: null,
    timeLimitSeconds: null,
    reviewMode: 'score_only',
    ipAllow: null,
    kind: 'quiz',
    anonymous: false,
    resultsVisibility: 'always',
    questions: [
      {
        kind: 'single',
        id: 'q1',
        prompt: 'TEST What caps the loss?',
        points: 1,
        choices: [
          { id: 'a', text: 'A stop' },
          { id: 'b', text: 'Hope' },
        ],
        correctChoiceId: 'a',
      },
    ],
    operatorId: A,
    now: NOW,
  });
  await quizzes().setState({ itemId: quiz, state: 'published', reason: 'TEST', operatorId: A, now: NOW });
  await courses().setState({
    courseId: created.id,
    to: 'published',
    revision: (await courses().get(created.id)).course.revision,
    reason: 'TEST',
    operatorId: A,
    now: NOW,
  });
  for (const userId of [L, M]) await learners().enrol({ userId, slug: 'risk-basics', track: 'audit', now: NOW });
  return { courseId: created.id, one, two, three, quiz, lesson };
}

/** A hand-in by L graded `score` of 10, written as the grading desk writes it. */
async function graded(itemId: string, score: string) {
  const view = await assignments().submit({ itemId, version: 1, text: 'TEST working', fileId: null, userId: L, now: NOW });
  const [s] = await db.sql<Array<{ id: string }>>`
    SELECT id FROM academy.assignment_submissions WHERE item_id = ${itemId} AND user_id = ${L} AND version = ${view.nextVersion - 1}
  `;
  await db.sql`
    INSERT INTO academy.assignment_grade_events (submission_id, n, score, points, comment, actor, reason, at)
    VALUES (${s!.id}, 1, ${score}, 10, null, ${A}, null, ${NOW})
  `;
}

const policy = (ids: { one: string; two: string; three: string; quiz: string }, weights: [string, string]) => [
  { name: 'Homework', weight: weights[0], dropLowest: 1, itemIds: [ids.one, ids.two, ids.three] },
  { name: 'Quizzes', weight: weights[1], dropLowest: 0, itemIds: [ids.quiz] },
];

describe('grading policy and gradebook (AC-assignments-04)', () => {
  it('refuses weights that add up wrongly, saves the right set, and drops the lowest before averaging', async () => {
    const ids = await course();
    const save = (weights: [string, string], revision: number) =>
      book().savePolicy({ courseId: ids.courseId, revision, types: policy(ids, weights), reason: 'TEST', operatorId: A, now: NOW });
    await expect(save(['0.7', '0.4'], 0)).rejects.toMatchObject({
      code: 'academy.weights_invalid',
      message: expect.stringContaining('sum=1.1'),
    });
    const saved = await save(['0.6', '0.4'], 0);
    expect(saved.policy).toMatchObject({ revision: 1, setBy: A });
    // Before anything is graded: not attempted, never zero.
    expect(saved.learners.find((l) => l.userId === L)).toMatchObject({ total: null });
    expect(saved.learners[0]!.items.every((i) => i.state === 'not_attempted' && i.score === null)).toBe(true);

    await graded(ids.one, '10');
    await graded(ids.two, '5');
    await graded(ids.three, '8');
    const attempt = await quizzes().start({ itemId: ids.quiz, userId: L, accessCode: null, clientAddress: null, now: NOW });
    await quizzes().answer({ attemptId: attempt.attemptId, questionId: 'q1', answer: 'a', userId: L, now: NOW });
    await quizzes().finish({ attemptId: attempt.attemptId, userId: L, now: NOW });

    const view = await book().view(ids.courseId);
    const row = view.learners.find((l) => l.userId === L)!;
    expect(row.types).toEqual([
      { name: 'Homework', average: '0.9', counted: [ids.one, ids.three].sort(), dropped: [ids.two] },
      { name: 'Quizzes', average: '1', counted: [ids.quiz], dropped: [] },
    ]);
    expect(row.total).toBe('0.94');
    expect(view.learners.find((l) => l.userId === M)).toMatchObject({ total: null });
    // A stale revision refuses; the same set again writes no event.
    await expect(save(['0.5', '0.5'], 0)).rejects.toMatchObject({ code: 'academy.revision_stale' });
    await save(['0.6', '0.4'], 1);
    expect(await db.sql`SELECT revision FROM academy.course_grading_policy_events`).toHaveLength(1);
  });

  it('reads a newer hand-in waiting for a grade as pending, not the older grade', async () => {
    const ids = await course();
    await graded(ids.one, '4');
    await assignments().submit({ itemId: ids.one, version: 2, text: 'TEST second try', fileId: null, userId: L, now: NOW });
    const row = (await book().view(ids.courseId)).learners.find((l) => l.userId === L)!;
    expect(row.items.find((i) => i.itemId === ids.one)).toEqual({ itemId: ids.one, state: 'pending', score: null, entered: null });
  });

  it('refuses a lesson, an item in two types, a type that drops every score, and two types of one name', async () => {
    const ids = await course();
    const save = (types: Parameters<CourseGradebook['savePolicy']>[0]['types']) =>
      book().savePolicy({ courseId: ids.courseId, revision: 0, types, reason: 'TEST', operatorId: A, now: NOW });
    const invalid = { code: 'academy.grading_policy_invalid' };
    await expect(save([{ name: 'All', weight: '1', dropLowest: 0, itemIds: [ids.lesson] }])).rejects.toMatchObject(invalid);
    await expect(
      save([
        { name: 'A', weight: '0.5', dropLowest: 0, itemIds: [ids.one] },
        { name: 'B', weight: '0.5', dropLowest: 0, itemIds: [ids.one] },
      ]),
    ).rejects.toMatchObject(invalid);
    await expect(save([{ name: 'All', weight: '1', dropLowest: 1, itemIds: [ids.one] }])).rejects.toMatchObject(invalid);
    await expect(
      save([
        { name: 'Work', weight: '0.5', dropLowest: 0, itemIds: [ids.one] },
        { name: 'work', weight: '0.5', dropLowest: 0, itemIds: [ids.two] },
      ]),
    ).rejects.toMatchObject(invalid);
  });

  it('shows an empty policy and no rows on a course nobody joined', async () => {
    const created = await courses().create({
      slug: 'empty-course',
      title: 'Empty',
      summary: null,
      thumbnailUrl: null,
      pricing: 'free',
      price: null,
      priceAsset: null,
      operatorId: A,
      now: NOW,
    });
    expect(await book().view(created.id)).toEqual({ courseId: created.id, policy: null, latePolicy: null, items: [], learners: [] });
  });
});

describe('late policy (AC-assignments-04, ENGINE GR-5)', () => {
  it('saves over the revision read, lowers a late hand-in at read on every screen, keeps the entered grade, and clears', async () => {
    const ids = await course();
    // Assignment One was due three days before L handed it in.
    await assignments().save({
      itemId: ids.one,
      revision: 1,
      instructions: 'Size one trade.',
      points: '10',
      dueAt: new Date(NOW.getTime() - 72 * 3_600_000).toISOString(),
      text: 'required',
      file: 'off',
      operatorId: A,
      now: NOW,
    });
    await graded(ids.one, '8');
    const late = (revision: number, policy: { graceHours: string; deductionPerDay: string } | null, hoursFromNow = 0) =>
      book().saveLatePolicy({
        courseId: ids.courseId,
        revision,
        policy,
        reason: 'TEST',
        operatorId: A,
        now: new Date(NOW.getTime() + hoursFromNow * 3_600_000),
      });
    const cell = (view: Awaited<ReturnType<CourseGradebook['view']>>) =>
      view.learners.find((l) => l.userId === L)!.items.find((i) => i.itemId === ids.one);

    // No policy: nothing is taken off, and the learner sees "none".
    expect(cell(await book().view(ids.courseId))).toEqual({ itemId: ids.one, state: 'graded', score: '0.8', entered: null });
    expect((await assignments().learnerView({ itemId: ids.one, userId: L })).latePolicy).toBeNull();
    // Clearing a course that has none writes nothing.
    await late(0, null);
    expect(await db.sql`SELECT 1 FROM academy.course_late_policy_events`).toHaveLength(0);

    // Set an hour before L handed in: 24 hours of grace, then 0.1 of the points per started day. 72 h late is 48 h past
    // the grace, two days, so 2 points come off.
    const saved = await late(0, { graceHours: '24', deductionPerDay: '0.1' }, -1);
    expect(saved.latePolicy).toMatchObject({ revision: 1, policy: { graceHours: '24', deductionPerDay: '0.1' }, setBy: A, reason: 'TEST' });
    expect(cell(saved)).toEqual({ itemId: ids.one, state: 'graded', score: '0.6', entered: '0.8' });
    const mine = await assignments().learnerView({ itemId: ids.one, userId: L });
    expect(mine.latePolicy).toEqual({ graceHours: '24', deductionPerDay: '0.1' });
    expect(mine.grade).toMatchObject({ score: '6', points: '10', entered: '8' });
    const grading = new AssignmentGrading(db.sql, assignments(), 900);
    expect((await grading.courseGrades(L))[0]!.rows.find((r) => r.itemId === ids.one)).toMatchObject({ state: 'graded', score: '6' });
    // The entered grade itself is untouched.
    expect(await db.sql`SELECT score::text FROM academy.assignment_grade_events`).toEqual([{ score: '8.00' }]);

    // A stale revision refuses; the same policy again writes no event.
    await expect(late(0, { graceHours: '0', deductionPerDay: '1' })).rejects.toMatchObject({ code: 'academy.revision_stale' });
    await late(1, { graceHours: '24.00', deductionPerDay: '0.1000' });
    expect(await db.sql`SELECT revision FROM academy.course_late_policy_events`).toHaveLength(1);

    // A harsher policy set after L handed in takes nothing off that hand-in: L was not shown it when they handed in.
    const later = await late(1, { graceHours: '0', deductionPerDay: '1' }, 1);
    expect(later.latePolicy).toMatchObject({ revision: 2, policy: { graceHours: '0', deductionPerDay: '1' } });
    expect(cell(later)).toEqual({ itemId: ids.one, state: 'graded', score: '0.8', entered: null });
    expect((await assignments().learnerView({ itemId: ids.one, userId: L })).grade).toMatchObject({ score: '8', entered: null });
    expect((await grading.courseGrades(L))[0]!.rows.find((r) => r.itemId === ids.one)).toMatchObject({ score: '8' });

    // Cleared: the revision goes on, nothing is taken off, and the history keeps every save.
    const cleared = await late(2, null, 2);
    expect(cleared.latePolicy).toMatchObject({ revision: 3, policy: null });
    expect(cell(cleared)).toEqual({ itemId: ids.one, state: 'graded', score: '0.8', entered: null });
    expect(
      await db.sql`SELECT revision, grace_hours::text, deduction_per_day::text, actor_id FROM academy.course_late_policy_events ORDER BY revision`,
    ).toEqual([
      { revision: 1, grace_hours: '24.00', deduction_per_day: '0.1000', actor_id: A },
      { revision: 2, grace_hours: '0.00', deduction_per_day: '1.0000', actor_id: A },
      { revision: 3, grace_hours: null, deduction_per_day: null, actor_id: A },
    ]);
  });

  it('refuses a course that does not exist', async () => {
    await expect(
      book().saveLatePolicy({
        courseId: '77777777-7777-4777-8777-777777777777',
        revision: 0,
        policy: { graceHours: '1', deductionPerDay: '0.5' },
        reason: 'TEST',
        operatorId: A,
        now: NOW,
      }),
    ).rejects.toMatchObject({ code: 'academy.course_not_found' });
  });
});
