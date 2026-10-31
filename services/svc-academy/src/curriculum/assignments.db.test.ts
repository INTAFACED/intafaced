/**
 * AC-assignments-01 — an assignment's brief on the founder console, and the work an enrolled learner hands in.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { CourseRecords } from './courses.js';
import { CoursePreview } from './course-preview.js';
import { CourseLearners } from './course-learners.js';
import type { AcademyAnswerMode } from '@intafaced/contracts/academy-courses';
import { CourseAssignments, type PutObjectFn, type SubmissionFileLimits } from './assignments.js';
import { LessonRecords } from './lessons.js';

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
const DUE = '2026-10-24T12:00:00.000Z';
const AFTER_DUE = new Date('2026-10-25T12:00:00.000Z');
const STORAGE = { endpoint: 'http://store.test', bucket: 'b', accessKey: 'k', secretKey: 's', region: 'r', ttlSeconds: 300 };
const PDF = Buffer.from('%PDF-1.4\nTEST\n%%EOF\n');
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

afterAll(async () => {
  await db.drop();
}, 30_000);

let stored: { url: string; bytes: number; type: string }[] = [];
let storeStatus = 200;
beforeEach(async () => {
  await db.truncateAll();
  stored = [];
  storeStatus = 200;
});

const put: PutObjectFn = async (url, bytes, type) => {
  stored.push({ url, bytes: bytes.byteLength, type });
  return storeStatus;
};
const courses = () => new CourseRecords(db.sql, { maxSections: 5, maxItems: 5 });
const lessons = () => new LessonRecords(db.sql, courses());
const learners = () => new CourseLearners(db.sql, new CoursePreview(db.sql));
const assignments = (limits: SubmissionFileLimits = { maxBytes: 1024, types: ['application/pdf', 'image/png'] }) =>
  new CourseAssignments(db.sql, STORAGE, limits, put);

const BRIEF: { instructions: string; points: string; dueAt: string | null; text: AcademyAnswerMode; file: AcademyAnswerMode } = {
  instructions: 'Size one trade.',
  points: '10',
  dueAt: DUE,
  text: 'required',
  file: 'required',
};

/** A free course with one assignment item, its brief saved, published, and learner L enrolled. */
async function openAssignment(brief: Partial<typeof BRIEF> = {}) {
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
  const saved = await assignments().save({ itemId: item.id, revision: 0, ...BRIEF, ...brief, operatorId: A, now: NOW });
  const current = await courses().get(course.id);
  await courses().setState({
    courseId: course.id,
    to: 'published',
    revision: current.course.revision,
    reason: 'TEST',
    operatorId: A,
    now: NOW,
  });
  await learners().enrol({ userId: L, slug: 'risk-basics', track: 'audit', now: NOW });
  return { course, item, saved };
}

const counts = async () => {
  const [row] = await db.sql<Array<{ submissions: number; files: number }>>`
    SELECT (SELECT count(*)::int FROM academy.assignment_submissions) AS submissions,
           (SELECT count(*)::int FROM academy.assignment_files) AS files
  `;
  return row!;
};

describe('an assignment brief on the founder console (AC-assignments-01)', () => {
  it('saves over the revision read, refuses a stale one, and releases the item to enrolled learners only once saved', async () => {
    const { course, item, saved } = await openAssignment();
    expect(saved).toMatchObject({ revision: 1, brief: { points: '10', dueAt: DUE, text: 'required', file: 'required' }, savedBy: A });
    await expect(assignments().save({ itemId: item.id, revision: 0, ...BRIEF, operatorId: A, now: NOW })).rejects.toMatchObject({
      code: 'academy.revision_stale',
    });
    const next = await assignments().save({ itemId: item.id, revision: 1, ...BRIEF, points: '12.50', operatorId: A, now: NOW });
    expect(next.brief?.points).toBe('12.5');
    const page = await learners().page('risk-basics', L);
    expect(page.sections[0]!.items[0]).toMatchObject({ id: item.id, kind: 'assignment', lock: null });
    expect((await learners().page('risk-basics', OUTSIDER)).sections[0]!.items[0]!.lock).toBe('enrol');
    expect((await learners().published(10))[0]!.items).toBe(1);
    void course;
  });

  it('an item with no brief is not released, and is not an assignment a learner can open', async () => {
    const course = await courses().create({
      slug: 'no-brief',
      title: 'No brief',
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
    expect((await assignments().adminView(item.id)).brief).toBeNull();
    expect((await new CoursePreview(db.sql).preview(course.id))!.sections[0]!.items[0]!.lock).toBe('not_released');
    await expect(assignments().learnerView({ itemId: item.id, userId: L })).rejects.toMatchObject({ code: 'academy.assignment_not_found' });
  });
});

describe('handing in work (AC-assignments-01)', () => {
  it('text without the required file is refused as incomplete and nothing is recorded', async () => {
    const { item } = await openAssignment();
    await expect(
      assignments().submit({ itemId: item.id, version: 1, text: 'My answer', fileId: null, userId: L, now: NOW }),
    ).rejects.toMatchObject({ code: 'academy.submission_incomplete', message: expect.stringContaining('missing=file') });
    expect(await counts()).toEqual({ submissions: 0, files: 0 });
    expect((await assignments().learnerView({ itemId: item.id, userId: L })).nextVersion).toBe(1);
  });

  it('text and a file hand in once; the same version again returns the stored hand-in and records nothing twice', async () => {
    const { item } = await openAssignment();
    const upload = { itemId: item.id, fileName: 'sizing.pdf', contentType: 'application/pdf', contentBase64: PDF.toString('base64') };
    const file = await assignments().uploadFile({ ...upload, userId: L, now: NOW });
    expect(stored).toHaveLength(1);
    expect(stored[0]!.url).toContain(`/submissions/${L}/`);
    // The same file again is the same row, and is not stored a second time.
    expect((await assignments().uploadFile({ ...upload, userId: L, now: NOW })).id).toBe(file.id);
    expect(stored).toHaveLength(1);
    const first = await assignments().submit({ itemId: item.id, version: 1, text: 'My answer', fileId: file.id, userId: L, now: NOW });
    const again = await assignments().submit({ itemId: item.id, version: 1, text: 'Other', fileId: null, userId: L, now: NOW });
    expect(again).toEqual(first);
    expect(first.submissions).toEqual([
      {
        version: 1,
        state: 'submitted',
        text: 'My answer',
        file: { id: file.id, fileName: 'sizing.pdf', contentType: 'application/pdf', bytes: PDF.byteLength },
        submittedAt: NOW.toISOString(),
        late: false,
      },
    ]);
    expect(first.nextVersion).toBe(2);
    expect(await counts()).toEqual({ submissions: 1, files: 1 });
    // A version that skips ahead is stale, never a second hand-in.
    await expect(
      assignments().submit({ itemId: item.id, version: 3, text: 'x', fileId: file.id, userId: L, now: NOW }),
    ).rejects.toMatchObject({ code: 'academy.submission_version_stale' });
  });

  it('two sends of the same version at once record one hand-in and both answer with it', async () => {
    const { item } = await openAssignment({ file: 'off' });
    const send = () => assignments().submit({ itemId: item.id, version: 1, text: 'Once', fileId: null, userId: L, now: NOW });
    const [a, b] = await Promise.all([send(), send()]);
    expect(a).toEqual(b);
    expect(a.submissions).toHaveLength(1);
    expect(await counts()).toEqual({ submissions: 1, files: 0 });
  });

  it('the file limit shown is the owner limit, bounded by what travels inline', async () => {
    const { item } = await openAssignment();
    expect((await assignments().learnerView({ itemId: item.id, userId: L })).fileLimits.maxBytes).toBe(1024);
    const big = await assignments({ maxBytes: 500 * 1_048_576, types: ['application/pdf'] }).learnerView({ itemId: item.id, userId: L });
    expect(big.fileLimits.maxBytes).toBe(786_432);
  });

  it('a hand-in after the due date reads as late; the flag is worked out on read, not stored', async () => {
    const { item } = await openAssignment({ file: 'off' });
    const view = await assignments().submit({ itemId: item.id, version: 1, text: 'Late answer', fileId: null, userId: L, now: AFTER_DUE });
    expect(view.submissions[0]).toMatchObject({ version: 1, late: true });
    expect(view.latePolicy).toBeNull();
    const [columns] = await db.sql<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM information_schema.columns
      WHERE table_schema = 'academy' AND table_name = 'assignment_submissions' AND column_name = 'late'
    `;
    expect(columns!.n).toBe(0);
  });

  it('a learner who is not enrolled is refused, and reads nothing of the brief', async () => {
    const { item } = await openAssignment();
    await expect(assignments().learnerView({ itemId: item.id, userId: OUTSIDER })).rejects.toMatchObject({
      code: 'academy.enrolment_required',
    });
    await expect(
      assignments().submit({ itemId: item.id, version: 1, text: 'x', fileId: null, userId: OUTSIDER, now: NOW }),
    ).rejects.toMatchObject({ code: 'academy.enrolment_required' });
    await expect(
      assignments().uploadFile({
        itemId: item.id,
        fileName: 'a.pdf',
        contentType: 'application/pdf',
        contentBase64: PDF.toString('base64'),
        userId: OUTSIDER,
        now: NOW,
      }),
    ).rejects.toMatchObject({ code: 'academy.enrolment_required' });
    expect(await counts()).toEqual({ submissions: 0, files: 0 });
  });

  it('a file is refused by the owner limits, its type and its content; with the limits blank nothing is taken', async () => {
    const { item } = await openAssignment();
    const send = (contentType: string, bytes: Buffer, limits?: Parameters<typeof assignments>[0]) =>
      assignments(limits).uploadFile({
        itemId: item.id,
        fileName: 'f',
        contentType,
        contentBase64: bytes.toString('base64'),
        userId: L,
        now: NOW,
      });
    await expect(send('application/pdf', Buffer.alloc(2048, 0x25))).rejects.toMatchObject({ code: 'academy.upload_too_large' });
    await expect(send('video/webm', PDF)).rejects.toMatchObject({ code: 'academy.upload_type_refused' });
    await expect(send('application/pdf', PNG_BYTES)).rejects.toMatchObject({ code: 'academy.file_type_mismatch' });
    await expect(send('application/pdf', PDF, { maxBytes: null, types: null })).rejects.toMatchObject({
      code: 'academy.upload_limits_unset',
    });
    storeStatus = 503;
    await expect(send('application/pdf', PDF)).rejects.toMatchObject({ code: 'academy.upload_incomplete' });
    expect(await counts()).toEqual({ submissions: 0, files: 0 });
  });

  it('withdrawn, nothing more is handed in and what was handed in stays readable', async () => {
    const { item } = await openAssignment({ file: 'off' });
    await assignments().submit({ itemId: item.id, version: 1, text: 'Kept', fileId: null, userId: L, now: NOW });
    const withdrawn = await assignments().withdraw({ itemId: item.id, reason: 'TEST', operatorId: A, now: NOW });
    expect(withdrawn).toMatchObject({ withdrawReason: 'TEST', learnersHandedIn: 1 });
    await expect(
      assignments().submit({ itemId: item.id, version: 2, text: 'More', fileId: null, userId: L, now: NOW }),
    ).rejects.toMatchObject({ code: 'academy.assignment_closed' });
    // A retry of the stored version still answers with it.
    const retry = await assignments().submit({ itemId: item.id, version: 1, text: 'Kept', fileId: null, userId: L, now: NOW });
    expect(retry.submissions.map((s) => s.text)).toEqual(['Kept']);
    expect(retry.withdrawnAt).toBe(NOW.toISOString());
    await expect(assignments().save({ itemId: item.id, revision: 1, ...BRIEF, operatorId: A, now: NOW })).rejects.toMatchObject({
      code: 'academy.assignment_closed',
    });
    // The course page still opens it, so the learner reaches what they handed in.
    expect((await learners().page('risk-basics', L)).sections[0]!.items[0]!.lock).toBeNull();
  });

  it('an assignment learners handed in to stays in the outline and stays an assignment', async () => {
    const { course, item } = await openAssignment({ file: 'off' });
    await assignments().submit({ itemId: item.id, version: 1, text: 'Kept', fileId: null, userId: L, now: NOW });
    await db.sql`UPDATE academy.courses SET state = 'draft' WHERE id = ${course.id}`;
    const revision = (await courses().get(course.id)).course.revision;
    await expect(
      courses().saveOutline({
        courseId: course.id,
        revision,
        sections: [{ title: 'Work', items: [{ kind: 'lesson', title: 'Other', indent: 0, url: null }] }],
        operatorId: A,
        now: NOW,
      }),
    ).rejects.toMatchObject({ code: 'academy.assignment_has_submissions' });
    await expect(
      courses().saveOutline({
        courseId: course.id,
        revision,
        sections: [{ title: 'Work', items: [{ id: item.id, kind: 'lesson', title: 'Write-up', indent: 0, url: null }] }],
        operatorId: A,
        now: NOW,
      }),
    ).rejects.toMatchObject({ code: 'academy.item_kind_locked' });
    expect(await counts()).toEqual({ submissions: 1, files: 0 });
  });

  it('a duplicated assignment copies its brief as revision 1 and none of the hand-ins', async () => {
    const { course, item } = await openAssignment({ file: 'off' });
    await assignments().submit({ itemId: item.id, version: 1, text: 'Kept', fileId: null, userId: L, now: NOW });
    await db.sql`UPDATE academy.courses SET state = 'draft' WHERE id = ${course.id}`;
    const revision = (await courses().get(course.id)).course.revision;
    const copy = await lessons().duplicate({ itemId: item.id, courseRevision: revision, operatorId: A, now: NOW });
    const copied = await assignments().adminView(copy.item.id);
    expect(copied).toMatchObject({ revision: 1, brief: { instructions: 'Size one trade.', points: '10' }, learnersHandedIn: 0 });
  });
});
