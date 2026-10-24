/**
 * AC-enrolment-01 — enrolling in one course from its page. Until courses are rows (AC-course-structure-01) a course is
 * one curriculum path, and a course enrolment is the learner's one active path enrolment (`academy.cert_enrollments`),
 * so Programmes and the course page read the same record.
 *
 * What is not set stays unset: no start date unless staff set one (self-paced, opens on enrolment), no seat cap, no enrolment window. The
 * certificate track has no published price (AC-commerce-01), so it is closed with `no_price` and refuses. The academy
 * has no mail sender, so the activation mail names `vendor.email`; enrolment never waits on it.
 */
import {
  ACADEMY_CURRICULUM_PATHS,
  type AcademyAccessGrant,
  type AcademyCourseEnrolment,
  type AcademyEnrolmentTrack,
  type AcademyMyCourse,
} from '@intafaced/contracts';
import { AcademyError } from '../errors.js';
import type { EnrollmentRow } from '../learning/customer-store.js';
import { listCurriculum, type CurriculumPath } from './catalog.js';

/** The published course by slug; an unknown course and one with no published item are the same `academy.course_not_found`. */
export function publishedCourse(slug: string): CurriculumPath {
  const path = ACADEMY_CURRICULUM_PATHS.find((row) => row === slug.trim());
  if (!path || listCurriculum({ path }).length === 0)
    throw new AcademyError(`Course "${slug}" is not published`, 'academy.course_not_found');
  return path;
}

const TRACKS: AcademyCourseEnrolment['tracks'] = [
  { track: 'audit', free: true, closed: null },
  { track: 'certificate', free: false, closed: 'no_price' },
];

/** The terms of enrolling in `path`, with the caller's own active enrolment or null. `startsAt` is what staff set, or null. */
export function courseEnrolmentView(path: CurriculumPath, active: EnrollmentRow | null, startsAt: Date | null): AcademyCourseEnrolment {
  return {
    slug: path,
    startsAt: startsAt?.toISOString() ?? null,
    seatCap: null,
    seatsRemaining: null,
    closed: null,
    tracks: TRACKS.map((row) => ({ ...row })),
    // Every stored enrolment is on the free track: the certificate track has never been open to enrol in.
    enrolment: active ? { track: 'audit', enrolledAt: active.enrolledAt.toISOString() } : null,
    activationMail: 'vendor.email',
  };
}

/** Refuses a track that is closed for enrolment, naming the reason. */
export function assertTrackOpen(track: AcademyEnrolmentTrack): void {
  const row = TRACKS.find((candidate) => candidate.track === track);
  if (!row) throw new AcademyError(`academy.enrolment_closed track=${track} reason=unpublished`, 'academy.enrolment_closed');
  if (row.closed) throw new AcademyError(`academy.enrolment_closed track=${track} reason=${row.closed}`, 'academy.enrolment_closed');
}

/**
 * AC-catalogue-02: one My learning row. A course is started once an item in it is completed (the reading position is
 * one per learner, not per course, so it cannot say a course was started). Start course and Continue only ever point
 * at an item the caller may open now (`open`, in course order): Continue goes to the last item opened when that is
 * open, else the first open item not completed. With every item locked they point at the first item, whose page says
 * why. A course whose start date is still ahead reads `future_start` with that date until it starts.
 */
export function myCourseView(
  path: CurriculumPath,
  enrolment: EnrollmentRow,
  completed: ReadonlySet<string>,
  lastItemSlug: string | null,
  open: readonly string[],
  startsAt: Date | null,
  now: Date,
): AcademyMyCourse {
  const items = listCurriculum({ path });
  const done = items.filter((row) => completed.has(row.slug)).length;
  const startsLater = startsAt !== null && startsAt.getTime() > now.getTime();
  const first = open[0] ?? items[0]!.slug;
  const resume =
    (lastItemSlug !== null && open.includes(lastItemSlug) ? lastItemSlug : null) ?? open.find((slug) => !completed.has(slug)) ?? first;
  return {
    slug: path,
    status: done === items.length ? 'completed' : startsLater ? 'future_start' : 'in_progress',
    enrolledAt: enrolment.enrolledAt.toISOString(),
    startsAt: startsAt?.toISOString() ?? null,
    items: items.length,
    completed: done,
    firstItemSlug: first,
    resumeItemSlug: done > 0 ? resume : null,
  };
}

/** AC-access-grants-01: an active free enrolment is the access record; it was given free and does not expire. */
export function accessGrantView(enrolment: EnrollmentRow): AcademyAccessGrant {
  return { slug: enrolment.pathSlug as CurriculumPath, source: 'free', grantedAt: enrolment.enrolledAt.toISOString(), expiresAt: null };
}
