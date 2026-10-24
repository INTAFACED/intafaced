import { z } from 'zod';
import { ACADEMY_CURRICULUM_PATHS } from './academy-catalogue.js';
import { ACADEMY_COURSE_SLUG } from './academy-courses.js';

/**
 * AC-programmes-01: a learning programme is an ordered set of published courses that staff make on the Academy desk. It
 * recommends an order and enforces none: a learner may start any of its courses. Finishing every course in it issues the
 * programme certificate once. A course in a programme is one of the published learning-path courses (a course staff made
 * has no completion record yet, so it cannot count towards one). How many courses a programme may hold is an owner value
 * with no default: a save with courses while it is blank refuses `academy.programme_limit_unset`. No money moves here.
 */
export const ACADEMY_PROGRAMME_COURSE_STATES = ['completed', 'enrolled', 'not_enrolled'] as const;
export type AcademyProgrammeCourseState = (typeof ACADEMY_PROGRAMME_COURSE_STATES)[number];
/** The most programmes one read lists. */
export const ACADEMY_PROGRAMMES_LIST_MAX = 200;
/** The certificate id a programme's certificate is stored under. */
export const academyProgrammeCertId = (slug: string) => `programme:${slug}`;

/**
 * The programme page's address, `/academy/programmes/<slug>`: the shape of a course address, at most 48 characters so its
 * certificate id stays within a certificate id's 64. `invitations` is reserved: that address is the invitations page.
 */
export const ACADEMY_PROGRAMME_RESERVED_SLUGS = ['invitations'] as const;
export const academyProgrammeSlugSchema = z.string().min(3).max(48).regex(ACADEMY_COURSE_SLUG);
export const academyProgrammeCourseSlugSchema = z.enum(ACADEMY_CURRICULUM_PATHS);

/**
 * `admin.saveProgramme`: creates a programme (`expectedRevision: null`) or replaces its details and ordered course list
 * over the revision staff read. A repeat of the stored programme answers it unchanged. Each change is a revision with an
 * event row naming the operator and the reason.
 */
export const academySaveProgrammeInputSchema = z
  .object({
    slug: academyProgrammeSlugSchema,
    title: z.string().trim().min(1).max(120),
    summary: z.string().trim().max(1000),
    courseSlugs: z.array(academyProgrammeCourseSlugSchema).max(ACADEMY_CURRICULUM_PATHS.length),
    expectedRevision: z.number().int().positive().nullable(),
    reason: z.string().trim().min(1).max(500),
  })
  .strict()
  .refine((input) => new Set(input.courseSlugs).size === input.courseSlugs.length, {
    message: 'a course is in a programme once',
    path: ['courseSlugs'],
  });
export type AcademySaveProgrammeInput = z.infer<typeof academySaveProgrammeInputSchema>;

/** One stored programme as staff see it. */
export const academyProgrammeRecordSchema = z.object({
  slug: academyProgrammeSlugSchema,
  title: z.string(),
  summary: z.string(),
  courseSlugs: z.array(academyProgrammeCourseSlugSchema),
  revision: z.number().int().positive(),
  updatedAt: z.coerce.date(),
});
export type AcademyProgrammeRecord = z.infer<typeof academyProgrammeRecordSchema>;

/** One course of a programme as the caller stands on it: every item recorded, enrolled, or not enrolled. */
export const academyProgrammeCourseSchema = z.object({
  slug: academyProgrammeCourseSlugSchema,
  state: z.enum(ACADEMY_PROGRAMME_COURSE_STATES),
  items: z.number().int().nonnegative(),
  completed: z.number().int().nonnegative(),
});
export type AcademyProgrammeCourse = z.infer<typeof academyProgrammeCourseSchema>;

/** The caller's programme certificate: earned with its serial and date, or not yet earned. */
export const academyProgrammeCertificateSchema = z.discriminatedUnion('state', [
  z.object({
    state: z.literal('earned'),
    certId: z.string(),
    publicId: z.string().regex(/^[0-9a-f]{32}$/),
    grantedAt: z.coerce.date(),
    status: z.enum(['valid', 'revoked']),
  }),
  z.object({ state: z.literal('not_earned'), certId: z.string() }),
]);
export type AcademyProgrammeCertificate = z.infer<typeof academyProgrammeCertificateSchema>;

/** `academy.programme` / `academy.programmes`: a programme with its courses in order, the caller's counts and certificate. */
export const academyProgrammeSchema = z.object({
  slug: academyProgrammeSlugSchema,
  title: z.string(),
  summary: z.string(),
  courses: z.array(academyProgrammeCourseSchema),
  counts: z.object({
    completed: z.number().int().nonnegative(),
    enrolled: z.number().int().nonnegative(),
    notEnrolled: z.number().int().nonnegative(),
  }),
  certificate: academyProgrammeCertificateSchema,
});
export type AcademyProgramme = z.infer<typeof academyProgrammeSchema>;

export const academyProgrammeInputSchema = z.object({ slug: academyProgrammeSlugSchema }).strict();
export const academyProgrammesInputSchema = z.object({ limit: z.number().int().min(1).max(ACADEMY_PROGRAMMES_LIST_MAX) }).strict();
