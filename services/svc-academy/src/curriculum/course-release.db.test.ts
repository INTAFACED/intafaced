/**
 * AC-release-access-01 — scheduled release and pacing on a course staff made: a section opens at an instant or some days
 * after the learner's enrolment, its items stay closed until then, and the pacing stays once a learner has enrolled.
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
import { CourseRelease, opensAt } from './course-release.js';

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
const DAY = 86_400_000;
// The item guards read the clock, so times here are relative to it.
const NOW = new Date();

afterAll(async () => {
  await db.drop();
}, 30_000);

beforeEach(async () => {
  await db.truncateAll();
});

const courses = () => new CourseRecords(db.sql, { maxSections: 5, maxItems: 5 });
const preview = () => new CoursePreview(db.sql);
const learners = () => new CourseLearners(db.sql, preview());
const quizzes = () => new CourseQuizzes(db.sql);
const release = () => new CourseRelease(db.sql);

/** A published free course: an opening section with a link, and a second section with a link and a published quiz. */
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
  await courses().saveOutline({
    courseId: created.id,
    revision: 1,
    sections: [
      { title: 'Start here', items: [{ kind: 'link', title: 'Reading', indent: 0, url: 'https://example.com/read' }] },
      {
        title: 'Week two',
        items: [
          { kind: 'link', title: 'Notes', indent: 0, url: 'https://example.com/notes' },
          { kind: 'quiz', title: 'Check yourself', indent: 0, url: null },
        ],
      },
    ],
    operatorId: A,
    now: NOW,
  });
  const current = await courses().get(created.id);
  const quiz = current.outline[1]!.items[1]!;
  await quizzes().save({
    itemId: quiz.id,
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
        prompt: 'TEST What caps the loss on a trade?',
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
  await quizzes().setState({ itemId: quiz.id, state: 'published', reason: 'TEST', operatorId: A, now: NOW });
  await courses().setState({
    courseId: created.id,
    to: 'published',
    revision: (await courses().get(created.id)).course.revision,
    reason: 'TEST',
    operatorId: A,
    now: NOW,
  });
  return { courseId: created.id, sections: current.outline.map((s) => s.id), quiz };
}

const enrol = (at: Date) => learners().enrol({ userId: L, slug: 'risk-basics', track: 'audit', now: at });

describe('pacing (AC-release-access-01)', () => {
  it('is unset at first, set with who and why before anyone enrols, and refuses a change once a learner has', async () => {
    const { courseId } = await course();
    expect(await release().adminView(courseId)).toMatchObject({ pacing: null, pacingLocked: false });
    await release().setPacing({ courseId, pacing: 'instructor_paced', reason: 'TEST cohort', operatorId: A, now: NOW });
    await release().setPacing({ courseId, pacing: 'self_paced', reason: 'TEST own pace', operatorId: A, now: NOW });
    await enrol(NOW);
    const view = await release().adminView(courseId);
    expect(view).toMatchObject({ pacing: 'self_paced', pacingLocked: true, pacingSetBy: A });
    await expect(
      release().setPacing({ courseId, pacing: 'instructor_paced', reason: 'TEST late', operatorId: A, now: NOW }),
    ).rejects.toMatchObject({ code: 'academy.pacing_locked' });
    // The same pacing again answers as stored.
    await expect(release().setPacing({ courseId, pacing: 'self_paced', reason: 'TEST', operatorId: A, now: NOW })).resolves.toMatchObject({
      pacing: 'self_paced',
    });
    expect((await preview().view(courseId, L))!.pacing).toBe('self_paced');
    const events =
      await db.sql`SELECT kind, rule, reason FROM academy.course_release_events WHERE course_id = ${courseId} ORDER BY at, reason`;
    expect(events.map((e) => e.reason)).toEqual(['TEST cohort', 'TEST own pace']);
  });

  it('refuses a course that does not exist', async () => {
    await expect(
      release().setPacing({
        courseId: '77777777-7777-4777-8777-777777777777',
        pacing: 'self_paced',
        reason: 'TEST',
        operatorId: A,
        now: NOW,
      }),
    ).rejects.toMatchObject({ code: 'academy.course_not_found' });
  });
});

describe('a section released after enrolment (AC-release-access-01)', () => {
  it('stays scheduled with its local instant for 7 days after enrolling, and its quiz refuses until then', async () => {
    const { courseId, sections, quiz } = await course();
    const view = await release().setSectionRelease({
      courseId,
      sectionId: sections[1]!,
      rule: { kind: 'after_enrolment', days: 7 },
      reason: 'TEST drip',
      operatorId: A,
      now: NOW,
    });
    expect(view.sections[1]).toMatchObject({ rule: { kind: 'after_enrolment', days: 7 }, setBy: A, reason: 'TEST drip' });
    expect(view.sections[0]!.rule).toBeNull();

    // Not enrolled: no instant to count from.
    const outsider = (await preview().view(courseId, L))!;
    expect(outsider.sections[1]!.release).toEqual({ at: null, afterEnrolmentDays: 7, open: false });
    expect(outsider.sections[1]!.items[0]!.lock).toBe('enrol');

    const enrolledAt = new Date(NOW.getTime() - 2 * DAY);
    await enrol(enrolledAt);
    const opens = new Date(enrolledAt.getTime() + 7 * DAY).toISOString();
    const reader = (await preview().view(courseId, L))!;
    expect(reader.sections[0]!.release).toBeNull();
    expect(reader.sections[0]!.items[0]!.lock).toBeNull();
    expect(reader.sections[1]!.release).toEqual({ at: opens, afterEnrolmentDays: 7, open: false });
    expect(reader.sections[1]!.items[0]!.lock).toBe('scheduled');
    await expect(quizzes().learnerView({ itemId: quiz.id, userId: L })).rejects.toMatchObject({ code: 'academy.not_released_yet' });

    // Day 8: open.
    const later = (await preview().view(courseId, L, new Date(enrolledAt.getTime() + 8 * DAY)))!;
    expect(later.sections[1]!.release).toMatchObject({ at: opens, open: true });
    expect(later.sections[1]!.items[0]!.lock).toBeNull();
  });

  it('opens the quiz once the days have passed since enrolling', async () => {
    const { courseId, sections, quiz } = await course();
    await release().setSectionRelease({
      courseId,
      sectionId: sections[1]!,
      rule: { kind: 'after_enrolment', days: 7 },
      reason: 'TEST drip',
      operatorId: A,
      now: NOW,
    });
    await enrol(new Date(NOW.getTime() - 8 * DAY));
    await expect(quizzes().learnerView({ itemId: quiz.id, userId: L })).resolves.toMatchObject({ itemId: quiz.id });
  });
});

describe('a section released at an instant (AC-release-access-01)', () => {
  it('shows the same instant to every reader, opens when it passes, and clearing the rule opens it at once', async () => {
    const { courseId, sections, quiz } = await course();
    const at = new Date(NOW.getTime() + 3 * DAY);
    await release().setSectionRelease({
      courseId,
      sectionId: sections[1]!,
      rule: { kind: 'at', at: at.toISOString().replace('Z', '+00:00') },
      reason: 'TEST launch day',
      operatorId: A,
      now: NOW,
    });
    // A repeat in another spelling of the same instant writes nothing.
    await release().setSectionRelease({
      courseId,
      sectionId: sections[1]!,
      rule: { kind: 'at', at: at.toISOString() },
      reason: 'TEST again',
      operatorId: A,
      now: NOW,
    });
    expect((await preview().view(courseId, null))!.sections[1]!.release).toEqual({
      at: at.toISOString(),
      afterEnrolmentDays: null,
      open: false,
    });
    await enrol(NOW);
    await expect(quizzes().learnerView({ itemId: quiz.id, userId: L })).rejects.toMatchObject({ code: 'academy.not_released_yet' });
    expect((await preview().view(courseId, L, new Date(at.getTime() + 1)))!.sections[1]!.items[0]!.lock).toBeNull();

    const cleared = await release().setSectionRelease({
      courseId,
      sectionId: sections[1]!,
      rule: null,
      reason: 'TEST open now',
      operatorId: A,
      now: NOW,
    });
    expect(cleared.sections[1]!.rule).toBeNull();
    await expect(quizzes().learnerView({ itemId: quiz.id, userId: L })).resolves.toMatchObject({ itemId: quiz.id });
    const events =
      await db.sql`SELECT reason, rule FROM academy.course_release_events WHERE section_id = ${sections[1]!} ORDER BY at, reason`;
    expect(events.map((e) => e.reason).sort()).toEqual(['TEST launch day', 'TEST open now']);
  });

  it('refuses a section of another course', async () => {
    const { courseId } = await course();
    await expect(
      release().setSectionRelease({
        courseId,
        sectionId: '77777777-7777-4777-8777-777777777777',
        rule: { kind: 'after_enrolment', days: 1 },
        reason: 'TEST',
        operatorId: A,
        now: NOW,
      }),
    ).rejects.toMatchObject({ code: 'academy.outline_item_unknown' });
  });
});

describe('opensAt', () => {
  it('counts whole days from enrolment, and has no instant without one', () => {
    expect(opensAt({ kind: 'after_enrolment', days: 7 }, new Date('2026-10-01T10:00:00Z'))!.toISOString()).toBe('2026-10-08T10:00:00.000Z');
    expect(opensAt({ kind: 'after_enrolment', days: 7 }, null)).toBeNull();
    expect(opensAt({ kind: 'at', at: '2026-11-01T09:00:00+02:00' }, null)!.toISOString()).toBe('2026-11-01T07:00:00.000Z');
  });
});
