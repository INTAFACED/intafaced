import { z } from 'zod';

/**
 * AC-release-access-02 on a course staff made: an item's prerequisites and a learner's own due date.
 *
 * An assignment or quiz may require earlier assignments or quizzes of the same course, which count as met once the
 * learner has handed in, finished an attempt or answered the survey. A lesson, video, file or link records no completion
 * on a course staff made, so it cannot be a prerequisite (`academy.prerequisite_unmeasured`) rather than a gate nobody can
 * pass. A rule that would make an item require itself, directly or through others, refuses `academy.prerequisite_cycle`.
 * Staff may move one learner's due date on an assignment later, with a reason; the console shows who granted it and why,
 * and the learner's hand-ins count as late only after their own date. No money moves here.
 */
export const ACADEMY_ITEM_PREREQUISITES_MAX = 20;

const isoInstant = z.string().datetime({ offset: true });

/** `admin.courseItemRules`: each assignment and quiz with what it requires, and every learner's moved due date. */
export const academyCourseItemRulesSchema = z.object({
  courseId: z.string().guid(),
  items: z.array(
    z.object({
      itemId: z.string().guid(),
      title: z.string().min(1),
      kind: z.enum(['assignment', 'quiz']),
      /** The brief's due date for an assignment; null when it has none or the item is a quiz. */
      dueAt: isoInstant.nullable(),
      prerequisites: z.array(z.string().guid()),
      setBy: z.string().guid().nullable(),
      setAt: isoInstant.nullable(),
      reason: z.string().nullable(),
    }),
  ),
  extensions: z.array(
    z.object({
      itemId: z.string().guid(),
      userId: z.string().guid(),
      dueAt: isoInstant,
      reason: z.string().min(1),
      grantedBy: z.string().guid(),
      grantedAt: isoInstant,
    }),
  ),
});
export type AcademyCourseItemRules = z.infer<typeof academyCourseItemRulesSchema>;

export const academyCourseItemRulesInputSchema = z.object({ courseId: z.string().guid() }).strict();

/** `admin.setCourseItemPrerequisites`: the whole set an item requires (empty clears it), with a reason. */
export const academySetCourseItemPrerequisitesInputSchema = z
  .object({
    courseId: z.string().guid(),
    itemId: z.string().guid(),
    prerequisiteIds: z.array(z.string().guid()).max(ACADEMY_ITEM_PREREQUISITES_MAX),
    reason: z.string().trim().min(1).max(500),
  })
  .strict();
export type AcademySetCourseItemPrerequisitesInput = z.infer<typeof academySetCourseItemPrerequisitesInputSchema>;

/** `admin.grantCourseExtension`: one enrolled learner's own due date on an assignment, later than the brief's. */
export const academyGrantCourseExtensionInputSchema = z
  .object({
    courseId: z.string().guid(),
    itemId: z.string().guid(),
    userId: z.string().guid(),
    dueAt: isoInstant,
    reason: z.string().trim().min(1).max(500),
  })
  .strict();
export type AcademyGrantCourseExtensionInput = z.infer<typeof academyGrantCourseExtensionInputSchema>;
