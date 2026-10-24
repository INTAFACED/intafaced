import { z } from 'zod';
import { ACADEMY_QUIZ_REVIEW_MODES } from './academy-catalogue.js';

/**
 * AC-quizzes-01: quizzes on the items of a course staff made. A quiz item's questions and attempt rules are a row in
 * svc-academy, saved as a draft over the revision read and published when nothing blocks it. Publish refuses a blank pass
 * mark (`academy.pass_mark_unset`), and more than one attempt with no scoring policy across them
 * (`academy.scoring_policy_unset`). A published quiz with attempts keeps its questions and stays published
 * (`academy.item_has_attempts`). An access code is stored only as a salted hash and never read back; an IP filter is a
 * list of addresses and CIDR ranges, and a start whose caller address cannot be read refuses (`academy.ip_unreadable`).
 * A null attempt limit or time limit is an author choice: none applies. Pass mark 0 means taking the quiz completes it.
 * No money moves here.
 */
export const ACADEMY_QUIZ_SCORING_POLICIES = ['highest', 'latest', 'first', 'average'] as const;
export type AcademyQuizScoringPolicy = (typeof ACADEMY_QUIZ_SCORING_POLICIES)[number];
export const ACADEMY_COURSE_QUIZ_STATES = ['draft', 'published'] as const;
export type AcademyCourseQuizState = (typeof ACADEMY_COURSE_QUIZ_STATES)[number];
/** Refusal codes that stop a draft from being published, in the order the editor lists them. */
export const ACADEMY_COURSE_QUIZ_BLOCKERS = [
  'academy.quiz_no_questions',
  'academy.pass_mark_unset',
  'academy.scoring_policy_unset',
] as const;
export type AcademyCourseQuizBlocker = (typeof ACADEMY_COURSE_QUIZ_BLOCKERS)[number];
export const ACADEMY_QUIZ_MAX_QUESTIONS = 100;
export const ACADEMY_QUIZ_MAX_IP_RULES = 50;

const isoInstant = z.string().datetime({ offset: true });

/** One address or CIDR range, IPv4 or IPv6: "203.0.113.7", "203.0.113.0/24", "2001:db8::/32". Checked again by the service. */
export const ACADEMY_IP_RULE = /^(?:[0-9]{1,3}(?:\.[0-9]{1,3}){3}|[0-9a-fA-F:]*:[0-9a-fA-F:.]*)(?:\/[0-9]{1,3})?$/;
export const academyIpRuleSchema = z.string().trim().min(2).max(64).regex(ACADEMY_IP_RULE);

const choice = z.object({ id: z.string().trim().min(1).max(80), text: z.string().trim().min(1).max(500) }).strict();
/** A single-choice question with its key. Only staff reads carry the key; a learner's read never does. */
export const academyCourseQuizQuestionSchema = z
  .object({
    id: z.string().trim().min(1).max(80),
    prompt: z.string().trim().min(1).max(2000),
    points: z.number().int().min(1).max(1000),
    choices: z.array(choice).min(2).max(20),
    correctChoiceId: z.string().trim().min(1).max(80),
  })
  .strict()
  .refine((q) => new Set(q.choices.map((c) => c.id)).size === q.choices.length, { message: 'choice ids are unique', path: ['choices'] })
  .refine((q) => q.choices.some((c) => c.id === q.correctChoiceId), {
    message: 'the key is one of the choices',
    path: ['correctChoiceId'],
  });
export type AcademyCourseQuizQuestion = z.infer<typeof academyCourseQuizQuestionSchema>;

const rules = {
  /** Points needed to pass; null is not set and refuses publish; 0 means taking it completes it. */
  passMark: z.number().int().nonnegative().nullable(),
  /** Attempts allowed; null is no limit. */
  attemptLimit: z.number().int().min(1).max(100).nullable(),
  /** Which attempt counts when more than one is allowed; null is not set. */
  scoringPolicy: z.enum(ACADEMY_QUIZ_SCORING_POLICIES).nullable(),
  /** Seconds from Start, held by the server; null is no time limit. */
  timeLimitSeconds: z.number().int().min(1).max(86_400).nullable(),
  reviewMode: z.enum(ACADEMY_QUIZ_REVIEW_MODES),
  /** Addresses and ranges a start may come from; null is no filter. */
  ipAllow: z.array(academyIpRuleSchema).min(1).max(ACADEMY_QUIZ_MAX_IP_RULES).nullable(),
};

/** `admin.courseQuiz`: a quiz item as staff see it. Revision 0 is a quiz item with nothing saved yet. */
export const academyAdminCourseQuizSchema = z.object({
  itemId: z.string().guid(),
  courseId: z.string().guid(),
  title: z.string().min(1),
  revision: z.number().int().nonnegative(),
  state: z.enum(ACADEMY_COURSE_QUIZ_STATES),
  ...rules,
  /** Whether an access code is set. The code itself is never read back. */
  accessCodeSet: z.boolean(),
  questions: z.array(academyCourseQuizQuestionSchema),
  savedBy: z.string().guid().nullable(),
  savedAt: isoInstant.nullable(),
  publishedAt: isoInstant.nullable(),
  /** Attempts learners have started, finished or not. */
  attempts: z.number().int().nonnegative(),
  /** What stops Publish right now; empty when it can be published. */
  blockers: z.array(z.enum(ACADEMY_COURSE_QUIZ_BLOCKERS)),
});
export type AcademyAdminCourseQuiz = z.infer<typeof academyAdminCourseQuizSchema>;

export const academyCourseQuizInputSchema = z.object({ itemId: z.string().guid() }).strict();

/**
 * `admin.saveCourseQuiz`: the draft over the revision read (a stale one refuses `academy.revision_stale`). `accessCode`
 * absent keeps the stored one, null clears it, a string sets it. Questions change only while the quiz has no attempts.
 */
export const academySaveCourseQuizInputSchema = z
  .object({
    itemId: z.string().guid(),
    revision: z.number().int().nonnegative(),
    ...rules,
    accessCode: z.string().trim().min(4).max(64).nullable().optional(),
    questions: z.array(academyCourseQuizQuestionSchema).max(ACADEMY_QUIZ_MAX_QUESTIONS),
  })
  .strict()
  .refine((v) => new Set(v.questions.map((q) => q.id)).size === v.questions.length, {
    message: 'question ids are unique',
    path: ['questions'],
  });
export type AcademySaveCourseQuizInput = z.infer<typeof academySaveCourseQuizInputSchema>;

/** `admin.setCourseQuizState`: publish, or take back to draft while no learner has an attempt, with a reason. */
export const academySetCourseQuizStateInputSchema = z
  .object({ itemId: z.string().guid(), state: z.enum(ACADEMY_COURSE_QUIZ_STATES), reason: z.string().trim().min(1).max(500) })
  .strict();
export type AcademySetCourseQuizStateInput = z.infer<typeof academySetCourseQuizStateInputSchema>;

/** `courseQuiz`: a published quiz as an enrolled learner reads it: no key, no code, no filter. */
export const academyLearnerCourseQuizSchema = z.object({
  itemId: z.string().guid(),
  courseSlug: z.string().min(1),
  courseTitle: z.string().min(1),
  title: z.string().min(1),
  passMark: z.number().int().nonnegative(),
  attemptLimit: z.number().int().positive().nullable(),
  timeLimitSeconds: z.number().int().positive().nullable(),
  reviewMode: z.enum(ACADEMY_QUIZ_REVIEW_MODES),
  accessCodeRequired: z.boolean(),
  attemptsUsed: z.number().int().nonnegative(),
  questions: z.array(
    z.object({
      id: z.string().min(1),
      prompt: z.string().min(1),
      kind: z.literal('single'),
      points: z.number().int().positive(),
      choices: z.array(z.object({ id: z.string().min(1), text: z.string().min(1) })),
    }),
  ),
});
export type AcademyLearnerCourseQuiz = z.infer<typeof academyLearnerCourseQuizSchema>;

/** `startCourseQuiz`: start (or get back) the caller's attempt; the code is checked on every start. */
export const academyStartCourseQuizInputSchema = z
  .object({ itemId: z.string().guid(), accessCode: z.string().trim().max(64).nullable() })
  .strict();
export type AcademyStartCourseQuizInput = z.infer<typeof academyStartCourseQuizInputSchema>;
