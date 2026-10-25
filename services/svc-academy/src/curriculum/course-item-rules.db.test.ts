/**
 * AC-release-access-02 — prerequisites and a learner's own due date on a course staff made.
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
import { CourseItemRules, dueFor } from './course-item-rules.js';

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
const UNKNOWN = '77777777-7777-4777-8777-777777777777';
const DAY = 86_400_000;
// The learner's item guard reads the clock, so times are relative to it.
const NOW = new Date();
const DUE = new Date(NOW.getTime() - DAY);

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
const rules = () => new CourseItemRules(db.sql);

/** A published free course: an assignment (due yesterday), a published quiz and a lesson, with learner L enrolled. */
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
        title: 'Week one',
        items: [
          { kind: 'assignment', title: 'Size write-up', indent: 0, url: null },
          { kind: 'quiz', title: 'Check yourself', indent: 0, url: null },
          { kind: 'lesson', title: 'Read me', indent: 0, url: null },
        ],
      },
    ],
    operatorId: A,
    now: NOW,
  });
  const [work, quiz, lesson] = detail.outline[0]!.items.map((item) => item.id) as [string, string, string];
  await assignments().save({
    itemId: work,
    revision: 0,
    instructions: 'Size one trade.',
    points: '10',
    dueAt: DUE.toISOString(),
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
  await learners().enrol({ userId: L, slug: 'risk-basics', track: 'audit', now: NOW });
  return { courseId: created.id, work, quiz, lesson };
}

const set = (courseId: string, itemId: string, prerequisiteIds: string[], reason = 'TEST order') =>
  rules().setPrerequisites({ courseId, itemId, prerequisiteIds, reason, operatorId: A, now: NOW });
const events = () => db.sql`SELECT kind, reason FROM academy.course_item_rule_events ORDER BY at, reason`;

describe('dueFor', () => {
  it('takes the learner’s own date only while it is later than the brief’s', () => {
    const brief = new Date('2026-11-01T00:00:00Z');
    expect(dueFor(brief, new Date('2026-11-03T00:00:00Z'))!.toISOString()).toBe('2026-11-03T00:00:00.000Z');
    expect(dueFor(new Date('2026-11-10T00:00:00Z'), new Date('2026-11-03T00:00:00Z'))!.toISOString()).toBe('2026-11-10T00:00:00.000Z');
    expect(dueFor(null, new Date('2026-11-03T00:00:00Z'))).toBeNull();
    expect(dueFor(brief, null)).toBe(brief);
  });
});

describe('prerequisites (AC-release-access-02)', () => {
  it('B requiring A saves with who and why; A requiring B then refuses as a cycle and nothing is written', async () => {
    const { courseId, work, quiz } = await course();
    const view = await set(courseId, quiz, [work]);
    expect(view.items.find((i) => i.itemId === quiz)).toMatchObject({ prerequisites: [work], setBy: A, reason: 'TEST order' });
    await expect(set(courseId, work, [quiz], 'TEST loop')).rejects.toMatchObject({
      code: 'academy.prerequisite_cycle',
      message: expect.stringContaining(`${work}>${quiz}>${work}`),
    });
    await expect(set(courseId, work, [work])).rejects.toMatchObject({ code: 'academy.prerequisite_cycle' });
    expect((await rules().adminView(courseId)).items.find((i) => i.itemId === work)!.prerequisites).toEqual([]);
    // The same set again writes nothing.
    await set(courseId, quiz, [work], 'TEST again');
    expect((await events()).map((e) => e.reason)).toEqual(['TEST order']);
  });

  it('refuses a lesson as a prerequisite, an item of another course, and a lesson as the gated item', async () => {
    const { courseId, quiz, lesson } = await course();
    await expect(set(courseId, quiz, [lesson])).rejects.toMatchObject({ code: 'academy.prerequisite_unmeasured' });
    await expect(set(courseId, quiz, [UNKNOWN])).rejects.toMatchObject({ code: 'academy.outline_item_unknown' });
    await expect(set(courseId, lesson, [])).rejects.toMatchObject({ code: 'academy.outline_item_unknown' });
  });

  it('keeps the quiz closed to the learner until the assignment it requires is handed in', async () => {
    const { courseId, work, quiz } = await course();
    await set(courseId, quiz, [work]);
    await expect(quizzes().learnerView({ itemId: quiz, userId: L })).rejects.toMatchObject({
      code: 'academy.prerequisite_unmet',
      message: expect.stringContaining(work),
    });
    await assignments().submit({ itemId: work, version: 1, text: 'TEST working', fileId: null, userId: L, now: NOW });
    await expect(quizzes().learnerView({ itemId: quiz, userId: L })).resolves.toMatchObject({ itemId: quiz });
    // Clearing the set is a change of its own.
    expect((await set(courseId, quiz, [], 'TEST open')).items.find((i) => i.itemId === quiz)!.prerequisites).toEqual([]);
  });
});

describe('a learner’s own due date (AC-release-access-02)', () => {
  const grant = (courseId: string, itemId: string, userId: string, dueAt: Date, reason = 'TEST illness') =>
    rules().grantExtension({ courseId, itemId, userId, dueAt: dueAt.toISOString(), reason, operatorId: A, now: NOW });

  it('shows who granted it and why, and a hand-in before it is not late for that learner', async () => {
    const { courseId, work } = await course();
    const until = new Date(NOW.getTime() + 3 * DAY);
    const view = await grant(courseId, work, L, until);
    expect(view.extensions).toEqual([
      { itemId: work, userId: L, dueAt: until.toISOString(), reason: 'TEST illness', grantedBy: A, grantedAt: NOW.toISOString() },
    ]);
    const handed = await assignments().submit({
      itemId: work,
      version: 1,
      text: 'TEST late but excused',
      fileId: null,
      userId: L,
      now: NOW,
    });
    expect(handed.extension).toEqual({ dueAt: until.toISOString(), reason: 'TEST illness' });
    expect(handed.submissions[0]!.late).toBe(false);
    // The same grant again writes nothing.
    await grant(courseId, work, L, until);
    expect((await events()).filter((e) => e.kind === 'extension')).toHaveLength(1);
  });

  it('refuses a date not after the assignment’s own, a learner not enrolled, and an item that is not an assignment', async () => {
    const { courseId, work, quiz } = await course();
    await expect(grant(courseId, work, L, DUE)).rejects.toMatchObject({ code: 'academy.window_invalid' });
    await expect(grant(courseId, work, OUTSIDER, new Date(NOW.getTime() + DAY))).rejects.toMatchObject({
      code: 'academy.enrolment_required',
    });
    await expect(grant(courseId, quiz, L, new Date(NOW.getTime() + DAY))).rejects.toMatchObject({ code: 'academy.assignment_not_found' });
    expect(await events()).toHaveLength(0);
  });
});
