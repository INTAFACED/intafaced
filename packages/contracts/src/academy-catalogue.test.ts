import { describe, expect, it } from 'vitest';
import {
  academyCourseEnrolmentSchema,
  academyCurriculumSummarySchema,
  academyEnrolCourseInputSchema,
  academyPublicCatalogueInputSchema,
  academyPublicCourseSchema,
  academyPublicHubSchema,
  academyPublicItemSchema,
} from './academy-catalogue.js';

const row = { slug: 's', title: 'T', kind: 'lesson', path: 'markets', order: 1, summary: '', estimatedMinutes: 2 };

describe('academy signed-out catalogue shapes (AC-catalogue-01)', () => {
  it('carries no learner field and refuses an unknown key on the input', () => {
    expect(academyCurriculumSummarySchema.parse(row)).toEqual(row);
    expect(academyPublicItemSchema.safeParse({ ...row, body: 'b', objectives: [], keyTerms: [], selfCheck: [] }).success).toBe(true);
    expect(academyPublicCatalogueInputSchema.safeParse({ q: 'risk', sort: 'name_desc', limit: 5 }).success).toBe(true);
    expect(academyPublicCatalogueInputSchema.safeParse({ userId: 'x', limit: 5 }).success).toBe(false);
    expect(academyPublicCatalogueInputSchema.safeParse({ sort: 'popular', limit: 5 }).success).toBe(false);
  });

  it('a course has at least one syllabus item; summary, instructor and certificate may be blank, never invented', () => {
    const course = { slug: 'markets', summary: null, instructor: null, outcomes: [], syllabus: [row], certificate: null };
    expect(academyPublicCourseSchema.parse(course)).toEqual(course);
    expect(academyPublicCourseSchema.safeParse({ ...course, syllabus: [] }).success).toBe(false);
    expect(academyPublicHubSchema.parse({ featured: null, lesson: null })).toEqual({ featured: null, lesson: null });
    // A featured lesson names its course; the course's address only while it is published, never an invented one.
    const lesson = { title: 'Position size', courseTitle: 'Risk basics', courseSlug: null };
    expect(academyPublicHubSchema.parse({ featured: null, lesson })).toEqual({ featured: null, lesson });
    expect(academyPublicHubSchema.safeParse({ featured: null, lesson: { ...lesson, courseSlug: '' } }).success).toBe(false);
    expect(academyPublicHubSchema.parse({ featured: null })).toEqual({ featured: null, lesson: null });
  });

  it('course enrolment terms: no cap means no seat count, and the input takes only a course and a track', () => {
    const terms = {
      slug: 'markets',
      startsAt: null,
      seatCap: null,
      seatsRemaining: null,
      closed: null,
      tracks: [
        { track: 'audit', free: true, closed: null },
        { track: 'certificate', free: false, closed: 'no_price' },
      ],
      enrolment: null,
      activationMail: 'vendor.email',
    };
    expect(academyCourseEnrolmentSchema.parse(terms)).toEqual(terms);
    expect(academyCourseEnrolmentSchema.safeParse({ ...terms, seatsRemaining: 3 }).success).toBe(false);
    expect(academyCourseEnrolmentSchema.safeParse({ ...terms, seatCap: 20 }).success).toBe(false);
    expect(academyCourseEnrolmentSchema.safeParse({ ...terms, seatCap: 20, seatsRemaining: 0 }).success).toBe(true);
    expect(academyCourseEnrolmentSchema.safeParse({ ...terms, tracks: [] }).success).toBe(false);
    expect(academyCourseEnrolmentSchema.safeParse({ ...terms, closed: 'sold_out' }).success).toBe(false);
    expect(academyEnrolCourseInputSchema.safeParse({ slug: 'markets', track: 'audit' }).success).toBe(true);
    expect(academyEnrolCourseInputSchema.safeParse({ slug: 'markets', track: 'audit', userId: 'x' }).success).toBe(false);
  });
});
