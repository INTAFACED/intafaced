/**
 * AC-quizzes-01 and AC-quizzes-02 — quizzes on the items of a course staff made: draft and publish rules, attempts, access
 * code and IP filter; question kinds, essay review, results visibility and surveys.
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
import { CourseQuizzes, accessCodeMatches, addressAllowed, createQuizAddressResolver, hashAccessCode } from './course-quizzes.js';

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
  await learners().enrol({ userId: L, slug: 'risk-basics', track: 'audit', now: NOW });
  return { courseId: created.id, quiz: detail.outline[0]!.items[0]!, lesson: detail.outline[0]!.items[1]! };
}

const start = (itemId: string, over: { userId?: string; accessCode?: string | null; clientAddress?: string | null } = {}) =>
  quizzes().start({ itemId, userId: L, accessCode: null, clientAddress: null, now: NOW, ...over });

describe('a quiz on a course staff made (AC-quizzes-01)', () => {
  it('a quiz item with nothing saved is revision 0 with every blocker listed; another kind is not a quiz', async () => {
    const { quiz, lesson } = await course();
    expect(await quizzes().adminView(quiz.id)).toMatchObject({
      revision: 0,
      state: 'draft',
      questions: [],
      attempts: 0,
      blockers: ['academy.quiz_no_questions', 'academy.pass_mark_unset', 'academy.scoring_policy_unset'],
    });
    await expect(quizzes().adminView(lesson.id)).rejects.toMatchObject({ code: 'academy.quiz_not_found' });
  });

  it('publish refuses a blank pass mark, then two attempts with no scoring policy, and publishes once both are set', async () => {
    const { quiz } = await course();
    const id = quiz.id;
    await quizzes().save({ itemId: id, revision: 0, ...draft({ passMark: null }), operatorId: A, now: NOW });
    await expect(quizzes().setState({ itemId: id, state: 'published', reason: 'TEST', operatorId: A, now: NOW })).rejects.toMatchObject({
      code: 'academy.pass_mark_unset',
    });
    await quizzes().save({ itemId: id, revision: 1, ...draft({ attemptLimit: 2 }), operatorId: A, now: NOW });
    await expect(quizzes().setState({ itemId: id, state: 'published', reason: 'TEST', operatorId: A, now: NOW })).rejects.toMatchObject({
      code: 'academy.scoring_policy_unset',
    });
    await expect(quizzes().save({ itemId: id, revision: 1, ...draft(), operatorId: A, now: NOW })).rejects.toMatchObject({
      code: 'academy.revision_stale',
    });
    await quizzes().save({ itemId: id, revision: 2, ...draft({ attemptLimit: 2, scoringPolicy: 'highest' }), operatorId: A, now: NOW });
    const published = await quizzes().setState({ itemId: id, state: 'published', reason: 'TEST ready', operatorId: A, now: NOW });
    expect(published).toMatchObject({ state: 'published', revision: 3, blockers: [], publishedAt: NOW.toISOString() });
    const events = await db.sql`SELECT kind, reason, actor_id FROM academy.course_quiz_events WHERE item_id = ${id} ORDER BY at, kind`;
    expect(events.map((e) => e.kind).sort()).toEqual(['published', 'saved', 'saved', 'saved']);
  });

  it('a pass mark above the points is refused, and an IP filter entry that is not an address or range is refused', async () => {
    const { quiz } = await course();
    await expect(
      quizzes().save({ itemId: quiz.id, revision: 0, ...draft({ passMark: 3 }), operatorId: A, now: NOW }),
    ).rejects.toMatchObject({
      code: 'academy.assessment_invalid',
    });
    await expect(
      quizzes().save({ itemId: quiz.id, revision: 0, ...draft({ ipAllow: ['10.0.0.0/33'] }), operatorId: A, now: NOW }),
    ).rejects.toMatchObject({ code: 'academy.ip_rule_invalid' });
  });

  it('a published quiz with an attempt keeps its questions and cannot be unpublished; without one it can', async () => {
    const { quiz } = await course();
    const id = quiz.id;
    await quizzes().save({ itemId: id, revision: 0, ...draft(), operatorId: A, now: NOW });
    await quizzes().setState({ itemId: id, state: 'published', reason: 'TEST', operatorId: A, now: NOW });
    expect((await quizzes().setState({ itemId: id, state: 'draft', reason: 'TEST', operatorId: A, now: NOW })).state).toBe('draft');
    await quizzes().setState({ itemId: id, state: 'published', reason: 'TEST', operatorId: A, now: NOW });

    const attempt = await start(id);
    expect(attempt).toMatchObject({ itemId: id, number: 1, result: null });
    expect((await quizzes().adminView(id)).attempts).toBe(1);
    await expect(quizzes().setState({ itemId: id, state: 'draft', reason: 'TEST', operatorId: A, now: NOW })).rejects.toMatchObject({
      code: 'academy.item_has_attempts',
    });
    const changed = [{ ...QUESTIONS[0]!, prompt: 'TEST changed' }];
    await expect(
      quizzes().save({ itemId: id, revision: 1, ...draft({ questions: changed }), operatorId: A, now: NOW }),
    ).rejects.toMatchObject({
      code: 'academy.item_has_attempts',
    });
    // Rules still change, and a save that would block a published quiz is refused.
    expect(
      (await quizzes().save({ itemId: id, revision: 1, ...draft({ timeLimitSeconds: 600 }), operatorId: A, now: NOW })).timeLimitSeconds,
    ).toBe(600);
    await expect(quizzes().save({ itemId: id, revision: 2, ...draft({ passMark: null }), operatorId: A, now: NOW })).rejects.toMatchObject({
      code: 'academy.pass_mark_unset',
    });
  });

  it('a quiz with an attempt stays a quiz and stays in the outline', async () => {
    const created = await courses().create({
      slug: 'draft-course',
      title: 'Draft course',
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
      sections: [{ title: 'Check', items: [{ kind: 'quiz', title: 'Check yourself', indent: 0, url: null }] }],
      operatorId: A,
      now: NOW,
    });
    const section = detail.outline[0]!;
    const item = section.items[0]!;
    const saved = await quizzes().save({ itemId: item.id, revision: 0, ...draft(), operatorId: A, now: NOW });
    const asLesson = [
      { id: section.id, title: 'Check', items: [{ id: item.id, kind: 'lesson' as const, title: 'x', indent: 0, url: null }] },
    ];
    await expect(
      courses().saveOutline({ courseId: created.id, revision: 2, sections: asLesson, operatorId: A, now: NOW }),
    ).rejects.toMatchObject({ code: 'academy.item_kind_locked' });
    // An attempt row as a learner's would be once the course is open.
    await db.sql`
      INSERT INTO academy.course_quiz_attempts (item_id, user_id, number, started_at, quiz, state)
      VALUES (${item.id}, ${L}, 1, ${NOW}, ${db.sql.json({ questions: QUESTIONS, passMark: 1 } as never)}, 'open')
    `;
    expect(saved.revision).toBe(1);
    await expect(
      courses().saveOutline({
        courseId: created.id,
        revision: 2,
        sections: [{ id: section.id, title: 'Check', items: [] }],
        operatorId: A,
        now: NOW,
      }),
    ).rejects.toMatchObject({ code: 'academy.item_has_attempts' });
  });

  it('a learner reads the published quiz without the key; a draft, an outsider and a non-quiz are refused', async () => {
    const { quiz } = await course();
    await quizzes().save({ itemId: quiz.id, revision: 0, ...draft({ accessCode: 'TEST-CODE-1' }), operatorId: A, now: NOW });
    await expect(quizzes().learnerView({ itemId: quiz.id, userId: L })).rejects.toMatchObject({ code: 'academy.assessment_unpublished' });
    await quizzes().setState({ itemId: quiz.id, state: 'published', reason: 'TEST', operatorId: A, now: NOW });
    const view = await quizzes().learnerView({ itemId: quiz.id, userId: L });
    expect(view).toMatchObject({ title: 'Check yourself', passMark: 1, accessCodeRequired: true, attemptsUsed: 0 });
    expect(JSON.stringify(view)).not.toContain('correctChoiceId');
    await expect(quizzes().learnerView({ itemId: quiz.id, userId: OUTSIDER })).rejects.toMatchObject({
      code: 'academy.enrolment_required',
    });
    await expect(start(quiz.id, { userId: OUTSIDER, accessCode: 'TEST-CODE-1' })).rejects.toMatchObject({
      code: 'academy.enrolment_required',
    });
  });

  it('a start without the access code or with a wrong one refuses; with it, an unreadable or outside address refuses', async () => {
    const { quiz } = await course();
    const id = quiz.id;
    await quizzes().save({
      itemId: id,
      revision: 0,
      ...draft({ accessCode: 'TEST-CODE-1', ipAllow: ['203.0.113.0/24'] }),
      operatorId: A,
      now: NOW,
    });
    const stored = await db.sql<Array<{ h: string }>>`SELECT access_code_hash AS h FROM academy.course_quizzes WHERE item_id = ${id}`;
    expect(stored[0]!.h).toMatch(/^scrypt\$[0-9a-f]{32}\$[0-9a-f]{64}$/);
    expect(stored[0]!.h).not.toContain('TEST-CODE-1');
    expect((await quizzes().adminView(id)).accessCodeSet).toBe(true);
    await quizzes().setState({ itemId: id, state: 'published', reason: 'TEST', operatorId: A, now: NOW });

    await expect(start(id)).rejects.toMatchObject({ code: 'academy.access_code_invalid' });
    await expect(start(id, { accessCode: 'wrong-code' })).rejects.toMatchObject({ code: 'academy.access_code_invalid' });
    await expect(start(id, { accessCode: 'TEST-CODE-1' })).rejects.toMatchObject({ code: 'academy.ip_unreadable' });
    await expect(start(id, { accessCode: 'TEST-CODE-1', clientAddress: '198.51.100.9' })).rejects.toMatchObject({
      code: 'academy.ip_not_allowed',
    });
    expect((await quizzes().adminView(id)).attempts).toBe(0);
    const attempt = await start(id, { accessCode: 'TEST-CODE-1', clientAddress: '203.0.113.9' });
    expect(attempt.number).toBe(1);
    // A save that leaves the code out keeps it; null clears it.
    await quizzes().save({ itemId: id, revision: 1, ...draft({ ipAllow: null }), operatorId: A, now: NOW });
    expect((await quizzes().adminView(id)).accessCodeSet).toBe(true);
    await quizzes().save({ itemId: id, revision: 2, ...draft({ ipAllow: null, accessCode: null }), operatorId: A, now: NOW });
    expect((await quizzes().adminView(id)).accessCodeSet).toBe(false);
  });
});

describe('question kinds, essay review, results visibility and surveys (AC-quizzes-02)', () => {
  const MIXED: AcademySaveCourseQuizInput['questions'] = [
    { kind: 'numeric', id: 'n1', prompt: 'TEST Risk on 1000 at 2%?', points: 2, answer: '20', tolerance: '0.5' },
    {
      kind: 'multi',
      id: 'm1',
      prompt: 'TEST Which cap a loss?',
      points: 2,
      choices: [
        { id: 'a', text: 'A stop' },
        { id: 'b', text: 'Position size' },
        { id: 'c', text: 'Hope' },
      ],
      correctChoiceIds: ['a', 'b'],
      partialCredit: true,
    },
    { kind: 'essay', id: 'e1', prompt: 'TEST Why size before entry?', points: 4 },
  ];
  const take = async (id: string, userId = L) => {
    const attempt = await start(id, { userId });
    await quizzes().answer({ attemptId: attempt.attemptId, userId, questionId: 'n1', answer: '20.4', now: NOW });
    await quizzes().answer({ attemptId: attempt.attemptId, userId, questionId: 'm1', answer: ['a'], now: NOW });
    await quizzes().answer({ attemptId: attempt.attemptId, userId, questionId: 'e1', answer: 'TEST Because the stop sets it.', now: NOW });
    return quizzes().finish({ attemptId: attempt.attemptId, userId, now: NOW });
  };

  it('an essay leaves the attempt pending until staff score it, under an alias; then it is graded', async () => {
    const { quiz } = await course();
    await quizzes().save({ itemId: quiz.id, revision: 0, ...draft({ questions: MIXED, passMark: 5 }), operatorId: A, now: NOW });
    await quizzes().setState({ itemId: quiz.id, state: 'published', reason: 'TEST', operatorId: A, now: NOW });
    const view = await quizzes().learnerView({ itemId: quiz.id, userId: L });
    expect(view.questions.map((q) => [q.kind, q.choices === null])).toEqual([
      ['numeric', true],
      ['multi', false],
      ['essay', true],
    ]);
    expect(JSON.stringify(view)).not.toMatch(/correctChoiceIds|tolerance|"answer"/);

    const finished = await take(quiz.id);
    expect(finished.result).toEqual({ state: 'pending_review', finishedAt: NOW.toISOString() });
    expect((await quizzes().adminView(quiz.id)).pendingReview).toBe(1);
    const [review] = await quizzes().reviews(quiz.id);
    expect(review).toMatchObject({
      alias: 1,
      autoScore: 3,
      essays: [{ questionId: 'e1', points: 4, text: 'TEST Because the stop sets it.' }],
    });
    expect(JSON.stringify(review)).not.toContain(L);

    await expect(
      quizzes().scoreEssays({ itemId: quiz.id, attemptId: review!.attemptId, points: { e1: 5 }, operatorId: A, now: NOW }),
    ).rejects.toMatchObject({ code: 'academy.assessment_invalid' });
    // A missing score, an inherited key and another quiz's id are refused, never read as 0 or scored on the wrong quiz.
    for (const points of [{}, { toString: 1 }, { e1: 3, other: 1 }] as Array<Record<string, number>>)
      await expect(
        quizzes().scoreEssays({ itemId: quiz.id, attemptId: review!.attemptId, points, operatorId: A, now: NOW }),
      ).rejects.toMatchObject({ code: 'academy.assessment_invalid' });
    await expect(
      quizzes().scoreEssays({ itemId: L, attemptId: review!.attemptId, points: { e1: 3 }, operatorId: A, now: NOW }),
    ).rejects.toMatchObject({ code: 'academy.attempt_not_found' });
    expect(
      await quizzes().scoreEssays({ itemId: quiz.id, attemptId: review!.attemptId, points: { e1: 3 }, operatorId: A, now: NOW }),
    ).toEqual([]);
    await expect(
      quizzes().scoreEssays({ itemId: quiz.id, attemptId: review!.attemptId, points: { e1: 3 }, operatorId: A, now: NOW }),
    ).rejects.toMatchObject({ code: 'academy.attempt_closed' });
    const graded = await quizzes().current({ itemId: quiz.id, userId: L, now: NOW });
    expect(graded!.result).toMatchObject({ state: 'graded', score: 6, maxScore: 8, pass: true, review: null });
    // With the review mode showing answers, each answer comes back against the key with what it earned.
    await quizzes().save({
      itemId: quiz.id,
      revision: 1,
      ...draft({ questions: MIXED, passMark: 5, reviewMode: 'answers' }),
      operatorId: A,
      now: NOW,
    });
    const reviewed = await quizzes().current({ itemId: quiz.id, userId: L, now: NOW });
    expect(reviewed!.result).toMatchObject({
      review: [
        { questionId: 'n1', given: '20.4', key: '20', earned: 2, points: 2 },
        { questionId: 'm1', given: ['a'], key: ['a', 'b'], earned: 1, points: 2 },
        { questionId: 'e1', key: null, earned: 3, points: 4 },
      ],
    });
    // The attempt is taken, so the questions stay as they are.
    await expect(
      quizzes().save({ itemId: quiz.id, revision: 2, ...draft({ questions: MIXED.slice(0, 2), passMark: 1 }), operatorId: A, now: NOW }),
    ).rejects.toMatchObject({ code: 'academy.item_has_attempts' });
  });

  it('an answer that does not fit its question refuses, and a finished attempt takes no more answers', async () => {
    const { quiz } = await course();
    await quizzes().save({ itemId: quiz.id, revision: 0, ...draft({ questions: MIXED, passMark: 1 }), operatorId: A, now: NOW });
    await quizzes().setState({ itemId: quiz.id, state: 'published', reason: 'TEST', operatorId: A, now: NOW });
    const attempt = await start(quiz.id);
    for (const [questionId, answer] of [
      ['n1', 'twenty'],
      ['m1', 'a'],
      ['m1', ['z']],
      ['zz', 'x'],
    ] as const)
      await expect(
        quizzes().answer({ attemptId: attempt.attemptId, userId: L, questionId, answer: answer as never, now: NOW }),
      ).rejects.toMatchObject({ code: 'academy.assessment_invalid' });
    await expect(
      quizzes().answer({ attemptId: attempt.attemptId, userId: OUTSIDER, questionId: 'n1', answer: '1', now: NOW }),
    ).rejects.toMatchObject({ code: 'academy.attempt_not_found' });
    await quizzes().finish({ attemptId: attempt.attemptId, userId: L, now: NOW });
    await expect(
      quizzes().answer({ attemptId: attempt.attemptId, userId: L, questionId: 'n1', answer: '20', now: NOW }),
    ).rejects.toMatchObject({ code: 'academy.attempt_closed' });
    await expect(start(quiz.id)).rejects.toMatchObject({ code: 'academy.attempt_limit' });
  });

  it('results show always, only after the last attempt, or never', async () => {
    const auto = MIXED.slice(0, 2);
    const { quiz } = await course();
    await quizzes().save({
      itemId: quiz.id,
      revision: 0,
      ...draft({ questions: auto, passMark: 1, attemptLimit: 2, scoringPolicy: 'highest', resultsVisibility: 'after_last_attempt' }),
      operatorId: A,
      now: NOW,
    });
    await quizzes().setState({ itemId: quiz.id, state: 'published', reason: 'TEST', operatorId: A, now: NOW });
    const first = await start(quiz.id);
    expect((await quizzes().finish({ attemptId: first.attemptId, userId: L, now: NOW })).result).toMatchObject({ state: 'withheld' });
    const second = await start(quiz.id);
    expect((await quizzes().finish({ attemptId: second.attemptId, userId: L, now: NOW })).result).toMatchObject({
      state: 'graded',
      score: 0,
      maxScore: 4,
      pass: false,
    });
    await quizzes().save({
      itemId: quiz.id,
      revision: 1,
      ...draft({ questions: auto, passMark: 1, attemptLimit: 2, scoringPolicy: 'highest', resultsVisibility: 'never' }),
      operatorId: A,
      now: NOW,
    });
    expect((await quizzes().current({ itemId: quiz.id, userId: L, now: NOW }))!.result).toMatchObject({ state: 'withheld' });
  });

  it('a timed attempt past its deadline is finished with what was saved by then', async () => {
    const { quiz } = await course();
    await quizzes().save({
      itemId: quiz.id,
      revision: 0,
      ...draft({ questions: MIXED.slice(0, 1), passMark: 1, timeLimitSeconds: 60 }),
      operatorId: A,
      now: NOW,
    });
    await quizzes().setState({ itemId: quiz.id, state: 'published', reason: 'TEST', operatorId: A, now: NOW });
    const attempt = await start(quiz.id);
    expect(attempt.secondsLeft).toBe(60);
    await quizzes().answer({ attemptId: attempt.attemptId, userId: L, questionId: 'n1', answer: '20', now: NOW });
    const later = new Date(NOW.getTime() + 61_000);
    await expect(
      quizzes().answer({ attemptId: attempt.attemptId, userId: L, questionId: 'n1', answer: '0', now: later }),
    ).rejects.toMatchObject({ code: 'academy.attempt_closed' });
    expect((await quizzes().current({ itemId: quiz.id, userId: L, now: later }))!.result).toMatchObject({
      state: 'graded',
      score: 2,
      finishedAt: new Date(NOW.getTime() + 60_000).toISOString(),
    });
  });

  it('an anonymous survey keeps no account with its answers, and the same device cannot answer twice', async () => {
    const { quiz } = await course();
    const survey = draft({
      kind: 'survey',
      anonymous: true,
      passMark: null,
      attemptLimit: null,
      questions: [{ kind: 'essay', id: 's1', prompt: 'TEST What would you change?', points: 1 }],
    });
    await expect(
      quizzes().save({ itemId: quiz.id, revision: 0, ...survey, accessCode: 'TEST-CODE-1', operatorId: A, now: NOW }),
    ).rejects.toMatchObject({ code: 'academy.assessment_invalid' });
    const saved = await quizzes().save({ itemId: quiz.id, revision: 0, ...survey, operatorId: A, now: NOW });
    expect(saved.blockers).toEqual([]);
    await quizzes().setState({ itemId: quiz.id, state: 'published', reason: 'TEST', operatorId: A, now: NOW });
    expect(await quizzes().learnerView({ itemId: quiz.id, userId: L })).toMatchObject({ kind: 'survey', anonymous: true, passMark: null });
    await expect(start(quiz.id)).rejects.toMatchObject({ code: 'academy.quiz_not_found' });

    const token = 'TEST-device-token-0001';
    const LATER = new Date(NOW.getTime() + 25 * 60_000);
    const sent = await quizzes().submitSurvey({
      itemId: quiz.id,
      userId: L,
      clientToken: token,
      answers: { s1: 'TEST More charts' },
      now: LATER,
    });
    expect(sent).toEqual({ itemId: quiz.id, anonymous: true, submittedAt: LATER.toISOString() });
    expect((await quizzes().learnerView({ itemId: quiz.id, userId: L })).responded).toBe(true);
    // Once per learner, whatever token the device sends.
    for (const clientToken of [token, 'TEST-device-token-0002'])
      await expect(
        quizzes().submitSurvey({ itemId: quiz.id, userId: L, clientToken, answers: { s1: 'TEST again' }, now: NOW }),
      ).rejects.toMatchObject({ code: 'academy.survey_duplicate' });
    const rows = await db.sql`SELECT * FROM academy.course_survey_responses WHERE item_id = ${quiz.id}`;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.user_id).toBeNull();
    expect((rows[0]!.submitted_at as Date).toISOString()).toBe('2026-10-23T12:00:00.000Z');
    const takers = await db.sql`SELECT * FROM academy.course_survey_takers WHERE item_id = ${quiz.id}`;
    expect(Object.keys(takers[0]!).sort()).toEqual(['item_id', 'user_id']);
    // Written apart: the answers and the record of who answered share no transaction id to join them by.
    const [xids] = await db.sql<Array<{ r: string; t: string }>>`
      SELECT (SELECT xmin::text FROM academy.course_survey_responses WHERE item_id = ${quiz.id}) AS r,
             (SELECT xmin::text FROM academy.course_survey_takers WHERE item_id = ${quiz.id}) AS t
    `;
    expect(xids!.r).not.toBe(xids!.t);
    expect(JSON.stringify(rows)).not.toContain(L);
    expect(JSON.stringify(rows)).not.toContain(token);
    expect((await quizzes().adminView(quiz.id)).responses).toBe(1);
    await expect(quizzes().setState({ itemId: quiz.id, state: 'draft', reason: 'TEST', operatorId: A, now: NOW })).rejects.toMatchObject({
      code: 'academy.item_has_attempts',
    });
  });

  it('a named survey keeps the account, once', async () => {
    const { quiz } = await course();
    const survey = draft({ kind: 'survey', passMark: null, questions: [{ kind: 'essay', id: 's1', prompt: 'TEST Thoughts?', points: 1 }] });
    await quizzes().save({ itemId: quiz.id, revision: 0, ...survey, operatorId: A, now: NOW });
    await quizzes().setState({ itemId: quiz.id, state: 'published', reason: 'TEST', operatorId: A, now: NOW });
    await quizzes().submitSurvey({ itemId: quiz.id, userId: L, clientToken: 'TEST-device-token-0001', answers: { s1: 'x' }, now: NOW });
    await expect(
      quizzes().submitSurvey({ itemId: quiz.id, userId: L, clientToken: 'TEST-device-token-0002', answers: { s1: 'y' }, now: NOW }),
    ).rejects.toMatchObject({ code: 'academy.survey_duplicate' });
    const rows = await db.sql<Array<{ user_id: string }>>`SELECT user_id FROM academy.course_survey_responses`;
    expect(rows.map((r) => r.user_id)).toEqual([L]);
  });
});

describe('access codes and addresses (AC-quizzes-01)', () => {
  it('a code matches only its own hash, and two hashes of one code differ', async () => {
    const one = await hashAccessCode('TEST-CODE-1');
    expect(await accessCodeMatches('TEST-CODE-1', one)).toBe(true);
    expect(await accessCodeMatches('TEST-CODE-2', one)).toBe(false);
    expect(await hashAccessCode('TEST-CODE-1')).not.toBe(one);
    expect(await accessCodeMatches('TEST-CODE-1', 'plain')).toBe(false);
  });

  it('addresses match single entries and ranges, IPv4 and IPv6', () => {
    expect(addressAllowed('203.0.113.7', ['203.0.113.7'])).toBe(true);
    expect(addressAllowed('203.0.113.8', ['203.0.113.7'])).toBe(false);
    expect(addressAllowed('2001:db8::1', ['2001:db8::/32'])).toBe(true);
    expect(addressAllowed('not-an-ip', ['0.0.0.0/0'])).toBe(false);
    expect(addressAllowed('::ffff:203.0.113.7', ['203.0.113.0/24'])).toBe(true);
  });

  it('the caller address is believed only from a trusted proxy that names it', () => {
    expect(createQuizAddressResolver(undefined)('127.0.0.1', '203.0.113.7')).toBeNull();
    const resolve = createQuizAddressResolver('127.0.0.0/8, 10.0.0.0/8');
    expect(resolve('127.0.0.1', '203.0.113.7')).toBe('203.0.113.7');
    expect(resolve('::ffff:127.0.0.1', '203.0.113.7')).toBe('203.0.113.7');
    expect(resolve('192.0.2.1', '203.0.113.7')).toBeNull();
    expect(resolve('127.0.0.1', undefined)).toBeNull();
    expect(resolve('127.0.0.1', 'garbage')).toBeNull();
    expect(resolve('127.0.0.1', '::ffff:203.0.113.7')).toBe('203.0.113.7');
    expect(() => createQuizAddressResolver('127.0.0.1')).toThrow(/not a CIDR range/);
  });
});
