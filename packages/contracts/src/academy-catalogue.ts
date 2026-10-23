import { z } from 'zod';

/**
 * AC-catalogue-01: the signed-out Academy, owned by svc-academy. A visitor with no account reads the published
 * catalogue, one item and its related items, and the video list; no learner data is in any of these shapes.
 * Per-address limits on these reads are svc-edge's, the one hop that sees the caller's address.
 */
export const ACADEMY_CURRICULUM_PATHS = ['foundations', 'markets', 'builder', 'sovereign'] as const;
export const ACADEMY_CURRICULUM_KINDS = ['playbook', 'workbook', 'lesson'] as const;
/** `recommended` is the shipped list order until courses are rows (AC-course-structure-01). */
export const ACADEMY_PUBLIC_CATALOGUE_SORTS = ['recommended', 'name_asc', 'name_desc'] as const;
export type AcademyPublicCatalogueSort = (typeof ACADEMY_PUBLIC_CATALOGUE_SORTS)[number];

export const academyCurriculumSummarySchema = z.object({
  slug: z.string().min(1),
  title: z.string().min(1),
  kind: z.enum(ACADEMY_CURRICULUM_KINDS),
  path: z.enum(ACADEMY_CURRICULUM_PATHS),
  order: z.number().int(),
  summary: z.string(),
  /** Derived from the body, never hand-typed. */
  estimatedMinutes: z.number().int().positive(),
});
export type AcademyCurriculumSummary = z.infer<typeof academyCurriculumSummarySchema>;

/** `publicCurriculum` input. `q` matches title and summary, case-folded. The page size is the caller's to send. */
export const academyPublicCatalogueInputSchema = z
  .object({
    q: z.string().max(120).optional(),
    path: z.enum(ACADEMY_CURRICULUM_PATHS).optional(),
    kind: z.enum(ACADEMY_CURRICULUM_KINDS).optional(),
    sort: z.enum(ACADEMY_PUBLIC_CATALOGUE_SORTS).optional(),
    limit: z.number().optional(),
  })
  .strict();
export type AcademyPublicCatalogueInput = z.infer<typeof academyPublicCatalogueInputSchema>;

/** `publicCurriculumItem`: the reader's item, with its teaching scaffolding and no learner state. */
export const academyPublicItemSchema = academyCurriculumSummarySchema.extend({
  body: z.string(),
  objectives: z.array(z.string()),
  keyTerms: z.array(z.object({ term: z.string(), definition: z.string() })),
  selfCheck: z.array(z.string()),
});
export type AcademyPublicItem = z.infer<typeof academyPublicItemSchema>;

/** `publicVideos`: titles only; playback stays behind sign-in and the tier and stake gate. */
export const academyPublicVideoSchema = z.object({ slug: z.string(), title: z.string(), path: z.enum(ACADEMY_CURRICULUM_PATHS) });
export type AcademyPublicVideo = z.infer<typeof academyPublicVideoSchema>;

/**
 * `publicCourse`: until courses are rows (AC-course-structure-01) a course is one curriculum path. Summary and instructor
 * are null while nobody has written them; outcomes are the lessons' own objectives, the syllabus is the path's published
 * items in order. `certificate` is the path's published certificate title, or null when the owner has published none.
 */
export const academyPublicCourseSchema = z.object({
  slug: z.enum(ACADEMY_CURRICULUM_PATHS),
  summary: z.string().nullable(),
  instructor: z.string().nullable(),
  outcomes: z.array(z.string()),
  syllabus: z.array(academyCurriculumSummarySchema).min(1),
  certificate: z.string().nullable(),
});
export type AcademyPublicCourse = z.infer<typeof academyPublicCourseSchema>;

/** `publicCourses`: one card per course that has published items. */
export const academyPublicCourseCardSchema = z.object({
  slug: z.enum(ACADEMY_CURRICULUM_PATHS),
  items: z.number().int().positive(),
  estimatedMinutes: z.number().int().positive(),
});
export type AcademyPublicCourseCard = z.infer<typeof academyPublicCourseCardSchema>;

/** `publicHub`: the item staff chose for the hub's featured slot, or null when nobody chose one. Never auto-promoted. */
export const academyPublicHubSchema = z.object({ featured: academyCurriculumSummarySchema.nullable() });
export type AcademyPublicHub = z.infer<typeof academyPublicHubSchema>;

/**
 * AC-enrolment-01: enrolling in one course from its page. `audit` is the free track; `certificate` is the paid track and
 * stays closed with `no_price` until the owner publishes a price (AC-commerce-01). A closed course or track carries its
 * reason, never a guess.
 */
export const ACADEMY_ENROLMENT_TRACKS = ['audit', 'certificate'] as const;
export type AcademyEnrolmentTrack = (typeof ACADEMY_ENROLMENT_TRACKS)[number];
export const ACADEMY_ENROLMENT_CLOSED_REASONS = [
  'unpublished',
  'hidden',
  'no_price',
  'window_not_started',
  'window_ended',
  'full',
] as const;
export type AcademyEnrolmentClosedReason = (typeof ACADEMY_ENROLMENT_CLOSED_REASONS)[number];

const isoInstant = z.string().datetime({ offset: true });

/**
 * `courseEnrolment` (signed in): the terms of enrolling and the caller's own enrolment. `startsAt` null means the course
 * is self-paced and opens when you enrol. `seatCap` null means no cap is set, and then `seatsRemaining` is null too.
 * `activationMail` names the outside piece the activation mail needs while it is switched off; null once it is sent.
 */
export const academyCourseEnrolmentSchema = z
  .object({
    slug: z.enum(ACADEMY_CURRICULUM_PATHS),
    startsAt: isoInstant.nullable(),
    seatCap: z.number().int().positive().nullable(),
    seatsRemaining: z.number().int().nonnegative().nullable(),
    closed: z.enum(ACADEMY_ENROLMENT_CLOSED_REASONS).nullable(),
    tracks: z
      .array(
        z.object({
          track: z.enum(ACADEMY_ENROLMENT_TRACKS),
          free: z.boolean(),
          closed: z.enum(ACADEMY_ENROLMENT_CLOSED_REASONS).nullable(),
        }),
      )
      .min(1),
    enrolment: z.object({ track: z.enum(ACADEMY_ENROLMENT_TRACKS), enrolledAt: isoInstant }).nullable(),
    activationMail: z.literal('vendor.email').nullable(),
  })
  .refine((row) => (row.seatCap === null) === (row.seatsRemaining === null), {
    message: 'seatsRemaining is set exactly when a seat cap is',
  });
export type AcademyCourseEnrolment = z.infer<typeof academyCourseEnrolmentSchema>;

/** `enrolCourse` input. A repeat while enrolled answers with the same enrolment; nothing is created twice. */
export const academyEnrolCourseInputSchema = z
  .object({ slug: z.string().min(1).max(64), track: z.enum(ACADEMY_ENROLMENT_TRACKS) })
  .strict();
export type AcademyEnrolCourseInput = z.infer<typeof academyEnrolCourseInputSchema>;

/**
 * AC-catalogue-02: My learning, one row per course the caller is enrolled in. `completed` counts the course's items the
 * caller has completed; `resumeItemSlug` is null until they have opened or completed something in it, and then names
 * where Continue goes. `firstItemSlug` is where Start course goes.
 */
export const ACADEMY_MY_COURSE_STATUSES = ['in_progress', 'completed', 'future_start'] as const;
export const academyMyCourseSchema = z
  .object({
    slug: z.enum(ACADEMY_CURRICULUM_PATHS),
    status: z.enum(ACADEMY_MY_COURSE_STATUSES),
    enrolledAt: isoInstant,
    startsAt: isoInstant.nullable(),
    items: z.number().int().positive(),
    completed: z.number().int().nonnegative(),
    firstItemSlug: z.string().min(1),
    resumeItemSlug: z.string().min(1).nullable(),
  })
  .refine((row) => row.completed <= row.items, { message: 'more items completed than the course has' });
export type AcademyMyCourse = z.infer<typeof academyMyCourseSchema>;

/**
 * AC-access-grants-01: the caller's access records, one per course they may learn in. `source` says how the access was
 * given; `expiresAt` null means it does not expire. Free enrolment is the only source today.
 */
export const ACADEMY_ACCESS_SOURCES = ['free', 'purchase', 'staff', 'invitation'] as const;
export const academyAccessGrantSchema = z.object({
  slug: z.enum(ACADEMY_CURRICULUM_PATHS),
  source: z.enum(ACADEMY_ACCESS_SOURCES),
  grantedAt: isoInstant,
  expiresAt: isoInstant.nullable(),
});
export type AcademyAccessGrant = z.infer<typeof academyAccessGrantSchema>;
