/**
 * AC-assignments-04, report part: time-stamped grade reports, against a real database. Every refusal has a test, a
 * refusal writes nothing, and a download is the stored snapshot.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { AcademyCourseGradebook } from '@intafaced/contracts';
import { expectRefusal, useServiceDb } from '@intafaced/service-kit/testing';
import { CourseRecords } from './courses.js';
import { GradeReports, csvField, gradeReportCsv } from './grade-reports.js';

const db = useServiceDb({ service: 'academy', from: import.meta.url });
const A = '33333333-3333-4333-8333-333333333333';
const L = '55555555-5555-4555-8555-555555555555';
const M = '66666666-6666-4666-8666-666666666666';
const ITEM = '77777777-7777-4777-8777-777777777777';
const T1 = new Date('2026-10-27T07:00:00.000Z');
const T2 = new Date('2026-10-27T07:00:05.000Z');

/** A gradebook as course-gradebook.ts reads it: L graded 0.8, M has not attempted the item. */
const book = (courseId: string): AcademyCourseGradebook => ({
  courseId,
  policy: {
    revision: 1,
    types: [{ name: 'Homework', weight: '1', dropLowest: 0, itemIds: [ITEM] }],
    setBy: A,
    setAt: T1.toISOString(),
    reason: 'TEST',
  },
  latePolicy: null,
  items: [{ itemId: ITEM, title: 'Size, a trade', kind: 'assignment' }],
  learners: [
    {
      userId: L,
      items: [{ itemId: ITEM, state: 'graded', score: '0.8', entered: null }],
      types: [{ name: 'Homework', average: '0.8', counted: [ITEM], dropped: [] }],
      total: '0.8',
    },
    {
      userId: M,
      items: [{ itemId: ITEM, state: 'not_attempted', score: null, entered: null }],
      types: [{ name: 'Homework', average: null, counted: [], dropped: [] }],
      total: null,
    },
  ],
});

async function course(): Promise<string> {
  const records = new CourseRecords(db.sql, { maxSections: 5, maxItems: 5 });
  const made = await records.create({
    slug: `reports-${Math.random().toString(36).slice(2, 8)}`,
    title: 'Reports',
    summary: null,
    thumbnailUrl: null,
    pricing: 'free',
    price: null,
    priceAsset: null,
    operatorId: A,
    now: T1,
  });
  return made.id;
}

const reports = (rows: number | null = 10) => new GradeReports(db.sql, { viewIn: async (_tx, id) => book(id) }, rows);
const stored = async () => (await db.sql<Array<{ n: number }>>`SELECT n FROM academy.course_grade_reports`).length;

describe('grade report CSV', () => {
  it('writes decimal fractions, "not attempted" never zero, and the time it was made', () => {
    expect(gradeReportCsv(book('c'), 1, T1)).toBe(
      [
        `grade report,1,made at,${T1.toISOString()}`,
        'learner,"Size, a trade",Homework (1),total',
        `${L},0.8,0.8,0.8`,
        `${M},not attempted,not attempted,not attempted`,
        '',
      ].join('\r\n'),
    );
  });

  it('puts each score under its own column, whatever order a learner row lists them in', () => {
    const two = book('c');
    const OTHER = '99999999-9999-4999-8999-999999999999';
    two.items.push({ itemId: OTHER, title: 'Journal', kind: 'assignment' });
    two.learners[0] = {
      ...two.learners[0]!,
      items: [{ itemId: OTHER, state: 'pending', score: null, entered: null }, ...two.learners[0]!.items],
    };
    expect(gradeReportCsv(two, 1, T1).split('\r\n')[2]).toBe(`${L},0.8,pending,0.8,0.8`);
  });

  it('keeps a title that starts like a formula as text', () => {
    expect(csvField('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvField('-1')).toBe("'-1");
    expect(csvField(' =1+1')).toBe("' =1+1");
  });
});

describe('grade reports (AC-assignments-04)', () => {
  it('stores each report with its own time and hash, and a download is the stored snapshot', async () => {
    const courseId = await course();
    const first = await reports().make({ courseId, n: 1, operatorId: A, now: T1 });
    const second = await reports().make({ courseId, n: 2, operatorId: A, now: T2 });
    expect(first).toMatchObject({ courseId, n: 1, madeAt: T1.toISOString(), madeBy: A, rows: 2 });
    expect(second.madeAt).toBe(T2.toISOString());
    expect(second.sha256).not.toBe(first.sha256);
    const file = await reports().file(courseId, 1);
    expect(file.csv).toBe(gradeReportCsv(book(courseId), 1, T1));
    expect(createHash('sha256').update(file.csv, 'utf8').digest('hex')).toBe(first.sha256);
    expect((await reports().list(courseId)).reports.map((r) => r.n)).toEqual([2, 1]);
  });

  it('answers a retried report n with the report it made, never a new one', async () => {
    const courseId = await course();
    const made = await reports().make({ courseId, n: 1, operatorId: A, now: T1 });
    expect(await reports().make({ courseId, n: 1, operatorId: A, now: T2 })).toEqual(made);
    expect(await stored()).toBe(1);
  });

  it('refuses a number past the next, and writes nothing', async () => {
    const courseId = await course();
    await expectRefusal(reports().make({ courseId, n: 2, operatorId: A, now: T1 }), 'academy.report_out_of_order');
    expect(await stored()).toBe(0);
  });

  it('refuses academy.report_limit_unset when the owner left the row limit blank, and writes nothing', async () => {
    const courseId = await course();
    await expectRefusal(reports(null).make({ courseId, n: 1, operatorId: A, now: T1 }), 'academy.report_limit_unset');
    expect(await stored()).toBe(0);
  });

  it('refuses a course with more learners than one report holds, and writes nothing', async () => {
    const courseId = await course();
    const err = await expectRefusal(reports(1).make({ courseId, n: 1, operatorId: A, now: T1 }), 'academy.report_too_large');
    expect(err).toMatchObject({ details: { limit: '1' } });
    expect(await stored()).toBe(0);
  });

  it('refuses a missing course and a missing report', async () => {
    const courseId = await course();
    const nowhere = '88888888-8888-4888-8888-888888888888';
    await expectRefusal(reports().make({ courseId: nowhere, n: 1, operatorId: A, now: T1 }), 'academy.course_not_found');
    await expectRefusal(reports().list(nowhere), 'academy.course_not_found');
    await expectRefusal(reports().file(courseId, 1), 'academy.report_not_found');
  });

  it('gives two makers racing for the same number one report', async () => {
    const courseId = await course();
    const [a, b] = await Promise.all([
      reports().make({ courseId, n: 1, operatorId: A, now: T1 }),
      reports().make({ courseId, n: 1, operatorId: A, now: T2 }),
    ]);
    expect(a).toEqual(b);
    expect(await stored()).toBe(1);
  });
});
