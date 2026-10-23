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

describe('staff-published timed quizzes (AC-quizzes-03)', () => {
  it('staff publish a quiz with a reason; the learner reads it without the key; a bad key or item is refused; null takes it down', async () => {
    const academy = service();
    await expect(
      academy.setQuiz({
        slug: SLUG,
        quiz: { ...TIMED, questions: [{ ...QUESTIONS[0]!, correctChoiceId: 'z' }] },
        reason: 'TEST',
        operatorId: STAFF,
      }),
    ).rejects.toMatchObject({ code: 'academy.assessment_invalid' });
    await expect(
      academy.setQuiz({ slug: 'no-such-item', quiz: { ...TIMED, questions: QUESTIONS }, reason: 'TEST', operatorId: STAFF }),
    ).rejects.toMatchObject({
      code: 'academy.curriculum_not_found',
    });
    expect(await publish(academy)).toEqual({ slug: SLUG, published: true });
    const quiz = await academy.getAssessment(SLUG);
    expect(quiz).toMatchObject({ passMark: 2, timeLimitSeconds: 600, attemptLimit: 2, reviewMode: 'answers' });
    expect(JSON.stringify(quiz)).not.toContain('correctChoiceId');
    expect(await publish(academy, null)).toEqual({ slug: SLUG, published: false });
    await expect(academy.getAssessment(SLUG)).rejects.toMatchObject({ code: 'academy.assessment_unpublished' });
  });

  it('Start twice or a refresh returns the same attempt with the server-held time left; answers autosave; another learner cannot touch it', async () => {
    const academy = service();
    await publish(academy);
    const t0 = new Date('2026-10-23T10:00:00.000Z');
    const started = await academy.startQuizAttempt({ userId: USER, slug: SLUG, now: t0 });
    expect(started).toMatchObject({ number: 1, deadlineAt: '2026-10-23T10:10:00.000Z', secondsLeft: 600, answers: {}, result: null });
    const t1 = new Date(t0.getTime() + 61_000);
    expect(await academy.startQuizAttempt({ userId: USER, slug: SLUG, now: t1 })).toMatchObject({
      attemptId: started.attemptId,
      secondsLeft: 539,
    });
    await academy.answerQuizAttempt({ userId: USER, attemptId: started.attemptId, questionId: 'q1', choiceId: 'b', now: t1 });
    const resumed = await academy.currentQuizAttempt({ userId: USER, slug: SLUG, now: new Date(t0.getTime() + 120_000) });
    expect(resumed).toMatchObject({ attemptId: started.attemptId, secondsLeft: 480, answers: { q1: 'b' } });
    await expect(
      academy.answerQuizAttempt({ userId: USER, attemptId: started.attemptId, questionId: 'q1', choiceId: 'zz', now: t1 }),
    ).rejects.toMatchObject({ code: 'academy.assessment_invalid' });
    await expect(
      academy.answerQuizAttempt({ userId: OTHER, attemptId: started.attemptId, questionId: 'q1', choiceId: 'a', now: t1 }),
    ).rejects.toMatchObject({ code: 'academy.attempt_not_found' });
    await expect(academy.reviewQuizAttempt({ userId: USER, attemptId: started.attemptId })).rejects.toMatchObject({
      code: 'academy.attempt_open',
    });
    expect(await academy.currentQuizAttempt({ userId: OTHER, slug: SLUG, now: t1 })).toBeNull();
  });

  it('Finish scores once, a second Finish answers the same, the review shows my own answers, and the limit refuses Start', async () => {
    const academy = service();
    await publish(academy, { ...TIMED, attemptLimit: 1 });
    const now = new Date();
    const { attemptId } = await academy.startQuizAttempt({ userId: USER, slug: SLUG, now });
    await academy.answerQuizAttempt({ userId: USER, attemptId, questionId: 'q1', choiceId: 'b', now });
    await academy.answerQuizAttempt({ userId: USER, attemptId, questionId: 'q2', choiceId: 'd', now });
    const first = await academy.finishQuizAttempt({ userId: USER, attemptId, now });
    expect(first.result).toMatchObject({ score: 1, maxScore: 2, pass: false });
    expect(await academy.finishQuizAttempt({ userId: USER, attemptId, now: new Date(now.getTime() + 5_000) })).toEqual(first);
    expect(await academy.assessmentAttempts(USER, SLUG)).toHaveLength(1);
    const review = await academy.reviewQuizAttempt({ userId: USER, attemptId });
    expect(review.questions?.map((q) => [q.id, q.chosenChoiceId, q.correct])).toEqual([
      ['q1', 'b', true],
      ['q2', 'd', false],
    ]);
    await expect(academy.reviewQuizAttempt({ userId: OTHER, attemptId })).rejects.toMatchObject({ code: 'academy.attempt_not_found' });
    await expect(academy.answerQuizAttempt({ userId: USER, attemptId, questionId: 'q2', choiceId: 'c', now })).rejects.toMatchObject({
      code: 'academy.attempt_closed',
    });
    await expect(academy.startQuizAttempt({ userId: USER, slug: SLUG, now })).rejects.toMatchObject({ code: 'academy.attempt_limit' });

    await publish(academy, { ...TIMED, attemptLimit: 1, reviewMode: 'score_only' });
    expect((await academy.reviewQuizAttempt({ userId: USER, attemptId })).questions).toBeNull();
  });

  it('an attempt past its deadline is finished with the answers saved by then, and takes no more', async () => {
    const academy = service();
    await publish(academy, { ...TIMED, timeLimitSeconds: 60 });
    const t0 = new Date('2026-10-23T10:00:00.000Z');
    const { attemptId } = await academy.startQuizAttempt({ userId: USER, slug: SLUG, now: t0 });
    await academy.answerQuizAttempt({ userId: USER, attemptId, questionId: 'q1', choiceId: 'b', now: t0 });
    const late = new Date(t0.getTime() + 61_000);
    await expect(academy.answerQuizAttempt({ userId: USER, attemptId, questionId: 'q2', choiceId: 'c', now: late })).rejects.toMatchObject({
      code: 'academy.attempt_closed',
    });
    expect(await academy.currentQuizAttempt({ userId: USER, slug: SLUG, now: late })).toBeNull();
    const done = await academy.finishQuizAttempt({ userId: USER, attemptId, now: late });
    expect(done.result).toEqual({ score: 1, maxScore: 2, pass: false, finishedAt: '2026-10-23T10:01:00.000Z' });
    const second = await academy.startQuizAttempt({ userId: USER, slug: SLUG, now: late });
    expect(second).toMatchObject({ number: 2 });
    expect(second.attemptId).not.toBe(attemptId);
  });

  it('a staff quiz sets the item rule to score: Complete refuses until an attempt passes', async () => {
    const academy = service();
    await publish(academy, { ...TIMED, timeLimitSeconds: null });
    expect((await academy.courseOutline({ userId: USER, itemSlug: SLUG })).items[1]).toMatchObject({ rule: 'score', ruleMet: false });
    await expect(academy.markCurriculumComplete({ userId: USER, itemSlug: SLUG })).rejects.toMatchObject({
      code: 'academy.completion_rule_unmet',
    });
    const { attemptId, deadlineAt, secondsLeft } = await academy.startQuizAttempt({ userId: USER, slug: SLUG });
    expect({ deadlineAt, secondsLeft }).toEqual({ deadlineAt: null, secondsLeft: null });
    await academy.answerQuizAttempt({ userId: USER, attemptId, questionId: 'q1', choiceId: 'b' });
    await academy.answerQuizAttempt({ userId: USER, attemptId, questionId: 'q2', choiceId: 'c' });
    expect((await academy.finishQuizAttempt({ userId: USER, attemptId })).result?.pass).toBe(true);
    expect((await academy.courseOutline({ userId: USER, itemSlug: SLUG })).items[1]).toMatchObject({ ruleMet: true });
    expect((await academy.markCurriculumComplete({ userId: USER, itemSlug: SLUG })).itemSlug).toBe(SLUG);
  });
});
