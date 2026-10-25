/**
 * AC-quizzes-01 — quizzes on the items of a course staff made: draft and publish rules, attempts, access code and IP filter.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import type { AcademySaveCourseQuizInput } from '@intafaced/contracts';
import { AssessmentRepository } from '../assessment/repository.js';
import { CourseRecords } from './courses.js';
import { CoursePreview } from './course-preview.js';
import { CourseLearners } from './course-learners.js';
import {
  CourseQuizzes,
  type StartAttemptFn,
  accessCodeMatches,
  addressAllowed,
  createQuizAddressResolver,
  hashAccessCode,
} from './course-quizzes.js';

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
const engine = () => new AssessmentRepository(db.sql, []);
const startAttempt: StartAttemptFn = (input) => engine().start(input);

const QUESTIONS: AcademySaveCourseQuizInput['questions'] = [
  {
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
  quizzes().start({ itemId, userId: L, accessCode: null, clientAddress: null, now: NOW, ...over }, startAttempt);

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
    expect(attempt).toMatchObject({ slug: id, number: 1, result: null });
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
    // An attempt made straight through the engine, as a learner's would be once the course is open.
    await engine().start({
      userId: L,
      slug: item.id,
      now: NOW,
      definition: {
        slug: item.id,
        kind: 'quiz',
        passMark: 1,
        attemptLimit: 1,
        cooldownSeconds: null,
        questions: [{ ...QUESTIONS[0]!, kind: 'single' }],
      },
    });
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
