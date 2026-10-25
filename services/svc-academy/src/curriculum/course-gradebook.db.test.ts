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
    expect(row.items.find((i) => i.itemId === ids.one)).toEqual({ itemId: ids.one, state: 'pending', score: null });
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
    expect(await book().view(created.id)).toEqual({ courseId: created.id, policy: null, items: [], learners: [] });
  });
});
