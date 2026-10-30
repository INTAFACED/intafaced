/**
 * AC-quizzes-04 — score changes after grading: a key fix is a new revision that changes only keys, a rescore applies it
 * once per attempt and revision, an override changes one question with a reason; the learner and the gradebook read the
 * newest score event.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import type { AcademySaveCourseQuizInput } from '@intafaced/contracts';
import { CourseRecords } from './courses.js';
import { CoursePreview } from './course-preview.js';
import { CourseLearners } from './course-learners.js';
import { CourseQuizzes } from './course-quizzes.js';
import { CourseQuizTrail } from './course-quiz-trail.js';
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
const OUTSIDER = '66666666-6666-4666-8666-666666666666';
const NOW = new Date('2026-10-23T12:00:00.000Z');

afterAll(async () => {
  await db.drop();
}, 30_000);

beforeEach(async () => {
  await db.truncateAll();
});

const courses = () => new CourseRecords(db.sql, { maxSections: 5, maxItems: 5 });
const learners = () => new CourseLearners(db.sql, new CoursePreview(db.sql));
const quizzes = () => new CourseQuizzes(db.sql);
const trail = () => new CourseQuizTrail(db.sql);
const M = '77777777-7777-4777-8777-777777777777';

const QUESTIONS: AcademySaveCourseQuizInput['questions'] = [
  {
    kind: 'single',
    id: 'q1',
    prompt: 'TEST What caps the loss on a trade?',
    points: 2,
    choices: [
      { id: 'a', text: 'A stop' },
      { id: 'b', text: 'Hope' },
    ],
    correctChoiceId: 'a',
  },
];

const draft = (over: Partial<AcademySaveCourseQuizInput> = {}): Omit<AcademySaveCourseQuizInput, 'itemId' | 'revision'> => ({
  passMark: 1,
  attemptLimit: 1,
  scoringPolicy: null,
  timeLimitSeconds: null,
  reviewMode: 'score_only',
  ipAllow: null,
  kind: 'quiz',
  anonymous: false,
  resultsVisibility: 'always',
  questions: QUESTIONS,
  ...over,
});

/** A free course with one quiz item (and a lesson item), published, with learner L enrolled. */
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
        title: 'Check',
        items: [
          { kind: 'quiz', title: 'Check yourself', indent: 0, url: null },
          { kind: 'lesson', title: 'Read me', indent: 0, url: null },
        ],
      },
    ],
    operatorId: A,
    now: NOW,
  });
  const current = await courses().get(created.id);
  await courses().setState({
    courseId: created.id,
    to: 'published',
    revision: current.course.revision,
    reason: 'TEST',
    operatorId: A,
    now: NOW,
  });
  for (const userId of [L, M]) await learners().enrol({ userId, slug: 'risk-basics', track: 'audit', now: NOW });
  return { courseId: created.id, quiz: detail.outline[0]!.items[0]!, lesson: detail.outline[0]!.items[1]! };
}

const start = (itemId: string, over: { userId?: string; accessCode?: string | null; clientAddress?: string | null } = {}) =>
  quizzes().start({ itemId, userId: L, accessCode: null, clientAddress: null, now: NOW, ...over });

/** Q1 single (2 points, key a), Q2 numeric (3 points, key 10 ± 0); pass mark 3. Published. L answers b and 10; M answers a and 12. */
const TWO: AcademySaveCourseQuizInput['questions'] = [
  QUESTIONS[0]!,
  { kind: 'numeric', id: 'n1', prompt: 'TEST Size?', points: 3, answer: '10', tolerance: '0' },
];
async function taken() {
  const { courseId, quiz } = await course();
  await quizzes().save({ itemId: quiz.id, revision: 0, ...draft({ questions: TWO, passMark: 3 }), operatorId: A, now: NOW });
  await quizzes().setState({ itemId: quiz.id, state: 'published', reason: 'TEST', operatorId: A, now: NOW });
  const ids: Record<string, string> = {};
  for (const [userId, choice, size] of [
    [L, 'b', '10'],
    [M, 'a', '12'],
  ] as const) {
    const attempt = await start(quiz.id, { userId });
    await quizzes().answer({ attemptId: attempt.attemptId, userId, questionId: 'q1', answer: choice, now: NOW });
    await quizzes().answer({ attemptId: attempt.attemptId, userId, questionId: 'n1', answer: size, now: NOW });
    await quizzes().finish({ attemptId: attempt.attemptId, userId, now: NOW });
    ids[userId] = attempt.attemptId;
  }
  return { courseId, itemId: quiz.id, ids };
}

const later = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000);

describe('score changes after grading (AC-quizzes-04)', () => {
  it('an override is a new event with the new total, keeps the old one, and the learner and gradebook see the new score', async () => {
    const { courseId, itemId, ids } = await taken();
    const before = await trail().attempts(itemId);
    const lRow = before.attempts.find((a) => a.attemptId === ids[L])!;
    expect(lRow).toMatchObject({ alias: 1, score: 3, originalScore: 3, maxScore: 5, nextN: 1, events: [] });
    expect(JSON.stringify(before)).not.toContain(L);
    const override = (over: Partial<{ n: number; points: number; reason: string }> = {}) =>
      trail().override({
        itemId,
        attemptId: ids[L]!,
        questionId: 'q1',
        points: 2,
        n: 1,
        comment: 'TEST stop named in words',
        reason: 'TEST regrade',
        operatorId: A,
        now: later(1),
        ...over,
      });
    const after = await override();
    const row = after.attempts.find((a) => a.attemptId === ids[L])!;
    expect(row).toMatchObject({ score: 5, originalScore: 3, passed: true, nextN: 2 });
    expect(row.events).toEqual([
      expect.objectContaining({
        n: 1,
        kind: 'override',
        questionId: 'q1',
        previousScore: 3,
        score: 5,
        comment: 'TEST stop named in words',
      }),
    ]);
    // The same n again answers as stored; a stale n and points above the question's refuse.
    await expect(override()).resolves.toBeDefined();
    await expect(override({ points: 1 })).rejects.toMatchObject({ code: 'academy.revision_stale' });
    await expect(override({ n: 2, points: 9 })).rejects.toMatchObject({ code: 'academy.assessment_invalid' });
    const mine = await quizzes().current({ itemId, userId: L, now: later(2) });
    expect(mine?.result).toMatchObject({ state: 'graded', score: 5, pass: true });
    const book = await new CourseGradebook(db.sql).view(courseId);
    expect(JSON.stringify(book)).toContain('"score":"1"');
  });

  it('a key fix changes only keys as a new revision; a rescore applies it once per attempt, and learners see the new score', async () => {
    const { itemId, ids } = await taken();
    const quiz = await quizzes().adminView(itemId);
    const fixed: AcademySaveCourseQuizInput['questions'] = TWO.map((q) => (q.kind === 'numeric' ? { ...q, answer: '12' } : q));
    const fix = (questions = fixed, revision = quiz.revision) =>
      trail().fixKey({ itemId, revision, questions, reason: 'TEST the size was 12', operatorId: A, now: later(1) });
    await expect(fix(TWO)).rejects.toMatchObject({ code: 'academy.key_fix_invalid' });
    await expect(fix(fixed.map((q) => ({ ...q, prompt: `${q.prompt}!` })))).rejects.toMatchObject({ code: 'academy.key_fix_invalid' });
    await expect(fix(fixed.slice(0, 1))).rejects.toMatchObject({ code: 'academy.key_fix_invalid' });
    await fix();
    await expect(fix()).rejects.toMatchObject({ code: 'academy.revision_stale' });
    // Until a rescore, every attempt keeps its score.
    expect((await trail().attempts(itemId)).attempts.map((a) => a.score)).toEqual([3, 2]);
    const rescored = await trail().rescore({ itemId, reason: 'TEST key fixed', operatorId: A, now: later(2) });
    expect(rescored.revision).toBe(quiz.revision + 1);
    expect(rescored.rescored).toEqual([
      { alias: 1, number: 1, from: 3, to: 0 },
      { alias: 2, number: 1, from: 2, to: 5 },
    ]);
    const m = rescored.attempts.attempts.find((a) => a.attemptId === ids[M])!;
    expect(m).toMatchObject({ score: 5, originalScore: 2, passed: true });
    expect(m.events).toEqual([expect.objectContaining({ kind: 'rescore', revision: quiz.revision + 1, previousScore: 2, score: 5 })]);
    expect((await quizzes().current({ itemId, userId: M, now: later(3) }))?.result).toMatchObject({ score: 5, pass: true });
    // Again at the same revision: nothing changes.
    expect((await trail().rescore({ itemId, reason: 'TEST again', operatorId: A, now: later(4) })).rescored).toEqual([]);
  });

  it('an attempt waiting for an essay score, or on another quiz, is not overridden', async () => {
    const { itemId, ids } = await taken();
    await expect(
      trail().override({
        itemId: OUTSIDER,
        attemptId: ids[L]!,
        questionId: 'q1',
        points: 1,
        n: 1,
        comment: null,
        reason: 'TEST',
        operatorId: A,
        now: NOW,
      }),
    ).rejects.toMatchObject({ code: 'academy.attempt_not_found' });
    await expect(trail().rescore({ itemId: OUTSIDER, reason: 'TEST', operatorId: A, now: NOW })).rejects.toMatchObject({
      code: 'academy.quiz_not_found',
    });
  });
  it('an override survives a later key fix on another question; a fix of its own question rescores it', async () => {
    const { itemId, ids } = await taken();
    // L answered q1 "b" (0 of 2) and n1 10 (3 of 3). Staff give q1 2 by hand: 5.
    await trail().override({
      itemId,
      attemptId: ids[L]!,
      questionId: 'q1',
      points: 2,
      n: 1,
      comment: null,
      reason: 'TEST by hand',
      operatorId: A,
      now: later(1),
    });
    const fixN1: AcademySaveCourseQuizInput['questions'] = TWO.map((q) => (q.kind === 'numeric' ? { ...q, answer: '12' } : q));
    let revision = (await quizzes().adminView(itemId)).revision;
    await trail().fixKey({ itemId, revision, questions: fixN1, reason: 'TEST n1 is 12', operatorId: A, now: later(2) });
    expect((await trail().attempts(itemId)).attempts.every((a) => a.rescoreDue)).toBe(true);
    await trail().rescore({ itemId, reason: 'TEST n1', operatorId: A, now: later(3) });
    let l = (await trail().attempts(itemId)).attempts.find((a) => a.attemptId === ids[L])!;
    // q1 keeps the override (2); n1 is rescored to 0: 2.
    expect(l).toMatchObject({ score: 2, rescoreDue: false });
    expect(l.questions.map((q) => q.earned)).toEqual([2, 0]);
    // Now q1's own key changes to "b": the rescore applies it to q1 (2 points for "b").
    const fixQ1 = fixN1.map((q) => (q.kind === 'single' ? { ...q, correctChoiceId: 'b' } : q));
    revision = (await quizzes().adminView(itemId)).revision;
    await trail().fixKey({ itemId, revision, questions: fixQ1, reason: 'TEST q1 is b', operatorId: A, now: later(4) });
    const again = await trail().rescore({ itemId, reason: 'TEST q1', operatorId: A, now: later(5) });
    expect(again.rescored.map((r) => r.alias)).toEqual([2]);
    l = again.attempts.attempts.find((a) => a.attemptId === ids[L])!;
    expect(l.questions.map((q) => q.earned)).toEqual([2, 0]);
    expect(l.events.map((e) => e.kind)).toEqual(['override', 'rescore']);
  });
});
