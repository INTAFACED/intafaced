import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { AcademyService } from '../academy-service.js';
import { NullStreamProvider } from '../stream/provider.js';
import { listCurriculum } from '../curriculum/catalog.js';

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', '..', 'drizzle');
const MIGRATIONS = readdirSync(drizzle)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzle, f), 'utf8'));

/**
 * The shared test server's TEST_DATABASE_URL names database `test`.
 * createTestDatabase refuses any database whose name does not end in `_test`.
 * Same host, the existing `intafaced_test` database, when the env name is not already a test database.
 */
function adminUrl(): string {
  const raw = process.env.TEST_DATABASE_URL ?? 'postgres://test:test@127.0.0.1:55432/intafaced_test';
  const url = new URL(raw);
  const name = url.pathname.replace(/^\//, '');
  if (!name.endsWith('_test')) url.pathname = '/intafaced_test';
  return url.toString();
}

const ADMIN_URL = adminUrl();
const db: TestDatabase = await createTestDatabase({ service: 'academy', url: ADMIN_URL, migrations: MIGRATIONS });
const sql = db.sql;

const USER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';

afterAll(async () => {
  await db.drop();
}, 30_000);

beforeEach(async () => {
  await db.truncateAll();
});

function service(options: ConstructorParameters<typeof AcademyService>[4] = {}) {
  return new AcademyService(
    sql,
    {
      async stakeOf() {
        return 0n;
      },
    },
    {
      async perksOf() {
        throw new Error('host rights unused');
      },
    },
    new NullStreamProvider(),
    { tournamentEnabled: false, paperTradingEnabled: false, ...options },
  );
}

const STAFF = '44444444-4444-4444-8444-444444444444';
const SLUG = listCurriculum({ path: 'markets' })[1]!.slug;
const QUESTIONS = [
  {
    id: 'q1',
    prompt: 'TEST question one',
    points: 1,
    choices: [
      { id: 'a', text: 'TEST wrong' },
      { id: 'b', text: 'TEST right' },
    ],
    correctChoiceId: 'b',
  },
  {
    id: 'q2',
    prompt: 'TEST question two',
    points: 1,
    choices: [
      { id: 'c', text: 'TEST right' },
      { id: 'd', text: 'TEST wrong' },
    ],
    correctChoiceId: 'c',
  },
];
type Quiz = { passMark: number | null; attemptLimit: number | null; timeLimitSeconds: number | null; reviewMode: 'answers' | 'score_only' };
const TIMED: Quiz = { passMark: 2, attemptLimit: 2, timeLimitSeconds: 600, reviewMode: 'answers' };
const publish = (academy: AcademyService, quiz: Quiz | null = TIMED) =>
  academy.setQuiz({ slug: SLUG, quiz: quiz && { ...quiz, questions: QUESTIONS }, reason: 'TEST quiz', operatorId: STAFF });

const week = (from: Date) => new Date(from.getTime() + 7 * 24 * 60 * 60 * 1000);

describe('progress page (AC-progress-02)', () => {
  it('shows percent complete over the course’s items with each completion, and an empty grades list with no average', async () => {
    const academy = service();
    expect(await academy.progressPage(USER)).toEqual({ courses: [], grades: { rows: [], averages: [] } });
    await academy.enrolCourse({ userId: USER, slug: 'markets', track: 'audit' });
    const items = listCurriculum({ path: 'markets' });
    await academy.markCurriculumComplete({ userId: USER, itemSlug: items[0]!.slug });
    const page = await academy.progressPage(USER);
    expect(page.courses).toHaveLength(1);
    const [course] = page.courses;
    expect(course).toMatchObject({ slug: 'markets', visible: items.length, completed: 1 });
    const expected = Math.round(1000 / items.length) / 10;
    expect(Number(course!.percent)).toBeCloseTo(expected, 1);
    expect(course!.percent).toMatch(/^\d+\.\d$/);
    expect(course!.items.map((row) => row.completedAt !== null)).toEqual(items.map((_, i) => i === 0));
    expect(page.grades).toEqual({ rows: [], averages: [] });
    // Another learner's progress is not this learner's.
    expect((await academy.progressPage(OTHER)).courses).toEqual([]);
  });

  it('grades a quiz at the best attempt, hides results until their date everywhere the learner reads them, and averages released ones', async () => {
    const academy = service();
    await publish(academy, { ...TIMED, attemptLimit: null, timeLimitSeconds: null });
    const now = new Date();
    for (const choices of [
      ['a', 'd'],
      ['b', 'c'],
    ]) {
      const { attemptId } = await academy.startQuizAttempt({ userId: USER, slug: SLUG, now });
      await academy.answerQuizAttempt({ userId: USER, attemptId, questionId: 'q1', choiceId: choices[0]!, now });
      await academy.answerQuizAttempt({ userId: USER, attemptId, questionId: 'q2', choiceId: choices[1]!, now });
      await academy.finishQuizAttempt({ userId: USER, attemptId, now });
    }
    let page = await academy.progressPage(USER);
    expect(page.grades.rows).toEqual([
      {
        pending: false,
        slug: SLUG,
        title: expect.any(String),
        type: 'quiz',
        attempts: 2,
        score: '2',
        possible: '2',
        percent: '100.0',
        passed: true,
      },
    ]);
    expect(page.grades.averages).toEqual([{ type: 'quiz', percent: '100.0', count: 1 }]);

    // Staff hide results until next week: the grade is pending, the score is nowhere, the rule is not met yet.
    const until = week(now);
    await academy.setQuiz({
      slug: SLUG,
      quiz: { ...TIMED, attemptLimit: null, timeLimitSeconds: null, resultsHiddenUntil: until.toISOString(), questions: QUESTIONS },
      reason: 'TEST hide until due',
      operatorId: STAFF,
    });
    page = await academy.progressPage(USER);
    expect(page.grades.rows).toEqual([
      { pending: true, slug: SLUG, title: expect.any(String), type: 'quiz', attempts: 2, hiddenUntil: until.toISOString() },
    ]);
    expect(page.grades.averages).toEqual([]);
    expect(JSON.stringify(page.grades)).not.toMatch(/score|percent/);
    const { attemptId } = await academy.startQuizAttempt({ userId: USER, slug: SLUG, now });
    const finished = await academy.finishQuizAttempt({ userId: USER, attemptId, now });
    expect(finished.result).toEqual({ hidden: true, hiddenUntil: until.toISOString(), finishedAt: expect.any(String) });
    await expect(academy.reviewQuizAttempt({ userId: USER, attemptId })).rejects.toMatchObject({ code: 'academy.grades_hidden' });
    const listed = await academy.assessmentAttempts(USER, SLUG);
    expect(listed.every((row) => row.score === null && row.hiddenUntil?.getTime() === until.getTime())).toBe(true);
    expect((await academy.courseOutline({ userId: USER, itemSlug: SLUG })).items[1]).toMatchObject({ rule: 'score', ruleMet: false });

    // Past the date the results show again.
    const later = new Date(until.getTime() + 1000);
    const released = await academy.progressPage(USER, later);
    expect(released.grades.rows[0]).toMatchObject({ pending: false, attempts: 3, score: '2', percent: '100.0' });
  });
});

describe('planner (AC-progress-02)', () => {
  it('refuses an add while the owner has set no cap, in words', async () => {
    const academy = service();
    await expect(academy.addTodo({ userId: USER, clientKey: 'todo:0', text: 'TEST read' })).rejects.toMatchObject({
      code: 'academy.planner_limit_unset',
    });
    expect((await academy.planner(USER)).todoLimit).toBeNull();
  });

  it('adds once per key, refuses a reused key for other text, keeps to the cap, and is the learner’s own', async () => {
    const academy = service({ plannerTodoLimit: 2 });
    const first = await academy.addTodo({ userId: USER, clientKey: 'todo:0', text: ' TEST read chapter two ' });
    expect(first.text).toBe('TEST read chapter two');
    expect(await academy.addTodo({ userId: USER, clientKey: 'todo:0', text: 'TEST read chapter two' })).toEqual(first);
    await expect(academy.addTodo({ userId: USER, clientKey: 'todo:0', text: 'TEST other' })).rejects.toMatchObject({
      code: 'academy.request_reused',
    });
    const second = await academy.addTodo({ userId: USER, clientKey: 'todo:1', text: 'TEST quiz' });
    await expect(academy.addTodo({ userId: USER, clientKey: 'todo:2', text: 'TEST third' })).rejects.toMatchObject({
      code: 'academy.planner_full',
    });
    const done = await academy.setTodoDone({ userId: USER, todoId: second.id, done: true });
    expect(done.doneAt).not.toBeNull();
    expect((await academy.setTodoDone({ userId: USER, todoId: second.id, done: true })).doneAt).toBe(done.doneAt);
    await expect(academy.setTodoDone({ userId: OTHER, todoId: second.id, done: false })).rejects.toMatchObject({
      code: 'academy.todo_not_found',
    });
    await expect(academy.removeTodo({ userId: OTHER, todoId: first.id })).rejects.toMatchObject({ code: 'academy.todo_not_found' });
    await academy.removeTodo({ userId: USER, todoId: first.id });
    // A late replay of the removed item's add does not bring it back.
    await academy.addTodo({ userId: USER, clientKey: 'todo:0', text: 'TEST read chapter two' });
    const planner = await academy.planner(USER);
    expect(planner.todos.map((row) => row.text)).toEqual(['TEST quiz']);
    expect(planner.revision).toBe(2);
    expect((await academy.planner(OTHER)).todos).toEqual([]);
  });

  it('saves a weekly goal, counts this week’s completions, and the reminder names the missing mail sender', async () => {
    const academy = service();
    await expect(academy.sendGoalReminder({ userId: USER })).rejects.toMatchObject({ code: 'academy.goal_invalid' });
    await expect(academy.setGoal({ userId: USER, itemsPerWeek: 0, reminder: true })).rejects.toMatchObject({
      code: 'academy.goal_invalid',
    });
    await academy.markCurriculumComplete({ userId: USER, itemSlug: listCurriculum({ path: 'markets' })[0]!.slug });
    const goal = await academy.setGoal({ userId: USER, itemsPerWeek: 3, reminder: false });
    expect(goal).toMatchObject({ itemsPerWeek: 3, reminder: false, doneThisWeek: 1 });
    await expect(academy.sendGoalReminder({ userId: USER })).rejects.toMatchObject({ code: 'academy.goal_invalid' });
    await academy.setGoal({ userId: USER, itemsPerWeek: 3, reminder: true });
    expect(await academy.sendGoalReminder({ userId: USER })).toEqual({ sent: false, mail: 'vendor.email' });
    expect((await academy.planner(USER)).goal).toMatchObject({ itemsPerWeek: 3, reminder: true });
  });
});
