/**
 * AC-catalogue-03 and AC-enrolment-01 — the courses staff made, on the learner side: the public catalogue, a course's
 * public page and enrolling in it.
 *
 * A published course is listed and its page is public; anything else is `academy.course_not_found`, so a draft is never
 * told apart from a missing course (a draft opens only through a private link, course-preview.ts). Enrolling is on the
 * free audit track, keyed `enrol:<user>:<course>` by the one open enrolment a learner may hold; a repeat answers with
 * it. The paid certificate track stays closed with `payments_off`: course payments (AC-commerce-01) are not switched on,
 * so nothing is sold. No seat cap,
 * window or start date is set, so none is shown. The academy has no mail sender, so the activation mail names
 * `vendor.email`; enrolment never waits on it. No money moves here.
 */
import type { Sql, TransactionSql } from 'postgres';
import type {
  AcademyAuthoredCourseEnrolment,
  AcademyCourseLearnerView,
  AcademyCourseState,
  AcademyEnrolmentTrack,
  AcademyPublishedCourseCard,
} from '@intafaced/contracts';
import { AcademyError } from '../errors.js';
import { canonicalPrice } from './courses.js';
import type { CoursePreview } from './course-preview.js';

type CourseRow = { id: string; slug: string; state: AcademyCourseState; pricing: 'free' | 'paid' };
type EnrolmentRow = { track: 'audit'; enrolled_at: Date };

const notFound = (slug: string) => new AcademyError(`no published course has the address "${slug}"`, 'academy.course_not_found');

export class CourseLearners {
  constructor(
    private readonly sql: Sql,
    private readonly preview: CoursePreview,
  ) {}

  /** The published courses, most recently published first, up to the page the caller asked for. */
  async published(limit: number): Promise<AcademyPublishedCourseCard[]> {
    const rows = await this.sql<
      Array<{
        slug: string;
        title: string;
        summary: string | null;
        thumbnail_url: string | null;
        pricing: 'free' | 'paid';
        price: string | null;
        price_asset: string | null;
        items: number;
      }>
    >`
      SELECT c.slug, c.title, c.summary, c.thumbnail_url, c.pricing, c.price, c.price_asset,
        (SELECT count(*)::int FROM academy.course_items i
          WHERE i.course_id = c.id AND (i.kind = 'link' OR (i.kind <> 'subheader' AND i.live_revision IS NOT NULL))) AS items
      FROM academy.courses c
      WHERE c.state = 'published'
      ORDER BY (SELECT max(e.at) FROM academy.course_events e
          WHERE e.course_id = c.id AND e.kind = 'state' AND e.to_state = 'published') DESC NULLS LAST, c.id
      LIMIT ${limit}
    `;
    return rows.map((r) => ({
      slug: r.slug,
      title: r.title,
      summary: r.summary,
      thumbnailUrl: r.thumbnail_url,
      pricing: r.pricing,
      price: canonicalPrice(r.price),
      priceAsset: r.price_asset,
      items: r.items,
    }));
  }

  /** A published course's page; signed in, the reader's own enrolment opens what is released. Writes nothing. */
  async page(slug: string, readerId: string | null): Promise<AcademyCourseLearnerView> {
    const course = await this.publishedRow(slug);
    const view = await this.preview.view(course.id, readerId);
    if (!view || view.state !== 'published') throw notFound(slug);
    return view;
  }

  /** The terms of enrolling and the caller's own open enrolment. */
  async terms(input: { userId: string; slug: string }): Promise<AcademyAuthoredCourseEnrolment> {
    const course = await this.publishedRow(input.slug);
    return this.termsOf(course, await this.open(this.sql, course.id, input.userId));
  }

  /** Enrol on an open track. A repeat while enrolled answers with the same enrolment; nothing is created twice. */
  async enrol(input: { userId: string; slug: string; track: AcademyEnrolmentTrack; now: Date }): Promise<AcademyAuthoredCourseEnrolment> {
    return this.sql.begin(async (tx) => {
      const [course] = await tx<CourseRow[]>`
        SELECT id, slug, state, pricing FROM academy.courses WHERE slug = ${input.slug} FOR SHARE
      `;
      if (!course || course.state !== 'published') throw notFound(input.slug);
      const track = this.tracks(course).find((row) => row.track === input.track);
      if (!track || track.closed) {
        throw new AcademyError(
          `academy.enrolment_closed track=${input.track} reason=${track?.closed ?? 'unpublished'}`,
          'academy.enrolment_closed',
        );
      }
      await tx`
        INSERT INTO academy.course_enrolments (course_id, user_id, track, enrolled_at)
        VALUES (${course.id}, ${input.userId}, ${input.track}, ${input.now})
        ON CONFLICT (course_id, user_id) WHERE left_at IS NULL DO NOTHING
      `;
      return this.termsOf(course, await this.open(tx, course.id, input.userId));
    });
  }

  /**
   * Leave the enrolment that began at `enrolledAt`. Its start is the business key: a repeat after a lost reply finds it
   * already closed and answers with the terms as they stand, and never closes a later enrolment.
   */
  async leave(input: { userId: string; slug: string; enrolledAt: string; now: Date }): Promise<AcademyAuthoredCourseEnrolment> {
    return this.sql.begin(async (tx) => {
      const [course] = await tx<CourseRow[]>`
        SELECT id, slug, state, pricing FROM academy.courses WHERE slug = ${input.slug}
      `;
      if (!course) throw notFound(input.slug);
      await tx`
        UPDATE academy.course_enrolments SET left_at = ${input.now}
        WHERE course_id = ${course.id} AND user_id = ${input.userId} AND left_at IS NULL
          AND date_trunc('milliseconds', enrolled_at) = date_trunc('milliseconds', ${input.enrolledAt}::timestamptz)
      `;
      return this.termsOf(course, await this.open(tx, course.id, input.userId));
    });
  }

  private async publishedRow(slug: string): Promise<CourseRow> {
    const [course] = await this.sql<CourseRow[]>`
      SELECT id, slug, state, pricing FROM academy.courses WHERE slug = ${slug}
    `;
    if (!course || course.state !== 'published') throw notFound(slug);
    return course;
  }

  private async open(sql: Sql | TransactionSql, courseId: string, userId: string) {
    const [row] = await sql<EnrolmentRow[]>`
      SELECT track, enrolled_at FROM academy.course_enrolments
      WHERE course_id = ${courseId} AND user_id = ${userId} AND left_at IS NULL
    `;
    return row ?? null;
  }

  private tracks(course: CourseRow): AcademyAuthoredCourseEnrolment['tracks'] {
    const audit = { track: 'audit' as const, free: true, closed: null };
    if (course.pricing === 'free') return [audit];
    // A published paid course always has its price (courses_published_price_chk); what is missing is payments.
    return [audit, { track: 'certificate', free: false, closed: 'payments_off' }];
  }

  private termsOf(course: CourseRow, enrolment: EnrolmentRow | null): AcademyAuthoredCourseEnrolment {
    return {
      slug: course.slug,
      startsAt: null,
      seatCap: null,
      seatsRemaining: null,
      closed: course.state === 'published' ? null : 'unpublished',
      tracks: this.tracks(course),
      enrolment: enrolment ? { track: enrolment.track, enrolledAt: enrolment.enrolled_at.toISOString() } : null,
      activationMail: 'vendor.email',
    };
  }
}
