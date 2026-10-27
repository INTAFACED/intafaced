import { z } from 'zod';

/**
 * AC-assignments-04, first part: the grading policy and the gradebook of a course staff made.
 *
 * Staff group the course's assignments and quizzes into types, each with a decimal weight (the weights must add up to
 * exactly 1, or `academy.weights_invalid`) and how many of its lowest scores to drop. The gradebook reads each enrolled
 * learner's scores: an assignment's newest grade over its points, a quiz's graded attempt (by the quiz's scoring policy)
 * over its maximum. An item with no grade yet is "not attempted" or "pending", never zero, and is left out of averages.
 * Within a type the lowest scores are dropped (never the last one) before averaging; the course total is the weighted
 * mean of the types the learner has a score in. Every figure is a decimal fraction string (0.65 is 65 percent), worked
 * out in scaled bigint to 18 places and cut, not rounded. Grading scales, periods, a late policy and the time-stamped
 * report are later parts. No money moves here.
 */
export const ACADEMY_GRADE_TYPES_MAX = 10;

/** A weight: a decimal fraction above 0 and at most 1, up to 4 places. */
export const ACADEMY_GRADE_WEIGHT = /^(?:0\.(?=\d*[1-9])\d{1,4}|1(?:\.0{1,4})?)$/;
const isoInstant = z.string().datetime({ offset: true });

export const academyGradeTypeSchema = z
  .object({
    name: z.string().trim().min(1).max(60),
    weight: z.string().regex(ACADEMY_GRADE_WEIGHT),
    dropLowest: z.number().int().min(0).max(20),
    itemIds: z.array(z.string().guid()).min(1).max(100),
  })
  .strict();
export type AcademyGradeType = z.infer<typeof academyGradeTypeSchema>;

/** `admin.saveGradingPolicy`: the whole set of types over the revision read (0 before the first save), with a reason. */
export const academySaveGradingPolicyInputSchema = z
  .object({
    courseId: z.string().guid(),
    revision: z.number().int().min(0),
    types: z.array(academyGradeTypeSchema).min(1).max(ACADEMY_GRADE_TYPES_MAX),
    reason: z.string().trim().min(1).max(500),
  })
  .strict();
export type AcademySaveGradingPolicyInput = z.infer<typeof academySaveGradingPolicyInputSchema>;

export const academyCourseGradebookInputSchema = z.object({ courseId: z.string().guid() }).strict();

const fraction = z.string().regex(/^(?:0|1|0\.\d{1,18}|1\.0{1,18})$/);

/** `admin.courseGradebook`: the policy (null before staff set one), the items, and a row per enrolled learner. */
export const academyCourseGradebookSchema = z.object({
  courseId: z.string().guid(),
  policy: z
    .object({
      revision: z.number().int().positive(),
      types: z.array(academyGradeTypeSchema),
      setBy: z.string().guid(),
      setAt: isoInstant,
      reason: z.string(),
    })
    .nullable(),
  items: z.array(z.object({ itemId: z.string().guid(), title: z.string().min(1), kind: z.enum(['assignment', 'quiz']) })),
  learners: z.array(
    z.object({
      userId: z.string().guid(),
      /** Each item's score as a fraction, or why there is none: never a zero for work not done. */
      items: z.array(
        z.object({
          itemId: z.string().guid(),
          state: z.enum(['graded', 'pending', 'not_attempted']),
          score: fraction.nullable(),
        }),
      ),
      types: z.array(
        z.object({
          name: z.string(),
          /** Null while the learner has no graded item of this type. */
          average: fraction.nullable(),
          counted: z.array(z.string().guid()),
          dropped: z.array(z.string().guid()),
        }),
      ),
      /** Null with no policy or no graded item: not attempted, never zero. */
      total: fraction.nullable(),
    }),
  ),
});
export type AcademyCourseGradebook = z.infer<typeof academyCourseGradebookSchema>;
