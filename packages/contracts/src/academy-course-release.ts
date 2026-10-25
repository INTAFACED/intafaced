import { z } from 'zod';

/**
 * AC-release-access-01: scheduled release and pacing on a course staff made. A section is released at an instant (stored
 * in UTC, shown in each reader's own time) or a number of days after the learner's enrolment; availability is worked out
 * on each read from the rule and the enrolment, with no timer per learner. Until a section opens, its items are refused
 * to the learner (`academy.not_released_yet`). A course is self-paced or instructor-paced; once any learner has enrolled
 * the pacing is fixed (`academy.pacing_locked`). Every change keeps who made it and why. Suggested dates and a minimum
 * lead time before a release are later parts. No money moves here.
 */
export const ACADEMY_COURSE_PACING = ['self_paced', 'instructor_paced'] as const;
export type AcademyCoursePacing = (typeof ACADEMY_COURSE_PACING)[number];
export const ACADEMY_RELEASE_MAX_DAYS = 365;

const isoInstant = z.string().datetime({ offset: true });

/** A section's release: at an instant, or whole days after the learner enrols. */
export const academySectionReleaseRuleSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('at'), at: isoInstant }).strict(),
  z.object({ kind: z.literal('after_enrolment'), days: z.number().int().min(1).max(ACADEMY_RELEASE_MAX_DAYS) }).strict(),
]);
export type AcademySectionReleaseRule = z.infer<typeof academySectionReleaseRuleSchema>;

/** `admin.courseRelease`: a course's pacing and each section's release rule, as staff see them. */
export const academyCourseReleaseSchema = z.object({
  courseId: z.string().guid(),
  /** Null while staff have not said. */
  pacing: z.enum(ACADEMY_COURSE_PACING).nullable(),
  /** Learners have enrolled, so the pacing stays as it is. */
  pacingLocked: z.boolean(),
  pacingSetBy: z.string().guid().nullable(),
  pacingSetAt: isoInstant.nullable(),
  sections: z.array(
    z.object({
      sectionId: z.string().guid(),
      title: z.string().min(1),
      /** Null is no rule: the section opens with the course. */
      rule: academySectionReleaseRuleSchema.nullable(),
      setBy: z.string().guid().nullable(),
      setAt: isoInstant.nullable(),
      reason: z.string().nullable(),
    }),
  ),
});
export type AcademyCourseRelease = z.infer<typeof academyCourseReleaseSchema>;

export const academyCourseReleaseInputSchema = z.object({ courseId: z.string().guid() }).strict();

/** `admin.setSectionRelease`: a rule, or null to clear it, with a reason. */
export const academySetSectionReleaseInputSchema = z
  .object({
    courseId: z.string().guid(),
    sectionId: z.string().guid(),
    rule: academySectionReleaseRuleSchema.nullable(),
    reason: z.string().trim().min(1).max(500),
  })
  .strict();
export type AcademySetSectionReleaseInput = z.infer<typeof academySetSectionReleaseInputSchema>;

/** `admin.setCoursePacing`: self-paced or instructor-paced, while no learner has enrolled, with a reason. */
export const academySetCoursePacingInputSchema = z
  .object({
    courseId: z.string().guid(),
    pacing: z.enum(ACADEMY_COURSE_PACING),
    reason: z.string().trim().min(1).max(500),
  })
  .strict();
export type AcademySetCoursePacingInput = z.infer<typeof academySetCoursePacingInputSchema>;
