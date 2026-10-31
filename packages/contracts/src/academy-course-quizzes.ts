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
 *
 * AC-quizzes-02: a question is single choice, multi-select (all correct and none wrong scores; with partial credit each
 * correct choice earns an equal whole share, and any wrong choice earns nothing), numeric (a decimal answer and
 * tolerance, compared as exact decimals) or essay (scored by staff: the attempt is pending review until then). Results
 * show always, only once the last attempt is used, or never. A survey is the other kind: no key, no score and no pass
 * mark, and an anonymous survey stores no account with an answer at all.
 * No money moves here.
 */
export const ACADEMY_COURSE_QUIZ_KINDS = ['quiz', 'survey'] as const;
export type AcademyCourseQuizKind = (typeof ACADEMY_COURSE_QUIZ_KINDS)[number];
export const ACADEMY_QUESTION_KINDS = ['single', 'multi', 'numeric', 'essay'] as const;
export type AcademyQuestionKind = (typeof ACADEMY_QUESTION_KINDS)[number];
export const ACADEMY_RESULTS_VISIBILITY = ['always', 'after_last_attempt', 'never'] as const;
export type AcademyResultsVisibility = (typeof ACADEMY_RESULTS_VISIBILITY)[number];
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

/** A choice id: letters, digits, `-` and `_`, so a multi-select answer travels as ids without a separator clash. */
export const ACADEMY_CHOICE_ID = /^[A-Za-z0-9_-]{1,40}$/;
const choice = z.object({ id: z.string().regex(ACADEMY_CHOICE_ID), text: z.string().trim().min(1).max(500) }).strict();
/** A signed decimal string with at most 18 places, never a JavaScript number. */
export const ACADEMY_QUIZ_DECIMAL = /^-?(?:0|[1-9]\d{0,17})(?:\.\d{1,18})?$/;
const questionBase = {
  id: z.string().trim().min(1).max(80),
  prompt: z.string().trim().min(1).max(2000),
  points: z.number().int().min(1).max(1000),
};
const uniqueChoices = (choices: readonly { id: string }[]) => new Set(choices.map((c) => c.id)).size === choices.length;

/**
 * A question with its key. Only staff reads carry the key; a learner's read never does. A key is null only on a survey,
 * which has none: saving a graded quiz with a question missing its key refuses.
 */
export const academyCourseQuizQuestionSchema = z
  .discriminatedUnion('kind', [
    z
      .object({
        kind: z.literal('single'),
        ...questionBase,
        choices: z.array(choice).min(2).max(20),
        correctChoiceId: z.string().regex(ACADEMY_CHOICE_ID).nullable(),
      })
      .strict(),
    z
      .object({
        kind: z.literal('multi'),
        ...questionBase,
        choices: z.array(choice).min(2).max(20),
        correctChoiceIds: z.array(z.string().regex(ACADEMY_CHOICE_ID)).min(1).max(20).nullable(),
        /** Each correct choice chosen earns an equal whole share of the points, unless any wrong one is chosen. */
        partialCredit: z.boolean(),
      })
      .strict(),
    z
      .object({
        kind: z.literal('numeric'),
        ...questionBase,
        answer: z.string().regex(ACADEMY_QUIZ_DECIMAL).nullable(),
        /** How far from the answer still scores, as a decimal from 0. */
        tolerance: z
          .string()
          .regex(ACADEMY_QUIZ_DECIMAL)
          .refine((v) => !v.startsWith('-'), { message: 'a tolerance is not negative' }),
      })
      .strict(),
    z.object({ kind: z.literal('essay'), ...questionBase }).strict(),
  ])
  .refine((q) => !('choices' in q) || uniqueChoices(q.choices), { message: 'choice ids are unique', path: ['choices'] })
  .refine((q) => q.kind !== 'single' || q.correctChoiceId === null || q.choices.some((c) => c.id === q.correctChoiceId), {
    message: 'the key is one of the choices',
    path: ['correctChoiceId'],
  })
  .refine(
    (q) =>
      q.kind !== 'multi' ||
      q.correctChoiceIds === null ||
      (new Set(q.correctChoiceIds).size === q.correctChoiceIds.length &&
        q.correctChoiceIds.every((id) => q.choices.some((c) => c.id === id))),
    { message: 'every key is one of the choices, once', path: ['correctChoiceIds'] },
  )
  .refine((q) => q.kind !== 'multi' || !q.partialCredit || q.correctChoiceIds === null || q.points % q.correctChoiceIds.length === 0, {
    message: 'with partial credit the points split into a whole share per correct choice',
    path: ['points'],
  });
export type AcademyCourseQuizQuestion = z.infer<typeof academyCourseQuizQuestionSchema>;

/** Whether a question carries its key (an essay has none to carry). */
export const questionHasKey = (q: AcademyCourseQuizQuestion) =>
  q.kind === 'essay' ||
  (q.kind === 'single' ? q.correctChoiceId !== null : q.kind === 'multi' ? q.correctChoiceIds !== null : q.answer !== null);

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
  /** AC-quizzes-02: a graded quiz, or a survey (no key, no score). */
  kind: z.enum(ACADEMY_COURSE_QUIZ_KINDS),
  /** A survey that stores no account with an answer. Only a survey is anonymous. */
  anonymous: z.boolean(),
  /** When a learner sees their score and the answers. `after_last_attempt` needs an attempt limit. */
  resultsVisibility: z.enum(ACADEMY_RESULTS_VISIBILITY),
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
  /** Finished attempts waiting for staff to score an essay. */
  pendingReview: z.number().int().nonnegative(),
  /** Survey answers received; for an anonymous survey nobody can be listed. */
  responses: z.number().int().nonnegative(),
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
  })
  .refine((v) => v.kind === 'survey' || v.questions.every(questionHasKey), {
    message: 'a graded quiz has the key to every question',
    path: ['questions'],
  })
  .refine((v) => v.kind === 'survey' || !v.anonymous, { message: 'only a survey is anonymous', path: ['anonymous'] })
  .refine((v) => v.resultsVisibility !== 'after_last_attempt' || v.attemptLimit !== null, {
    message: 'results after the last attempt need an attempt limit',
    path: ['resultsVisibility'],
  });
export type AcademySaveCourseQuizInput = z.infer<typeof academySaveCourseQuizInputSchema>;

/** `admin.setCourseQuizState`: publish, or take back to draft while no learner has an attempt, with a reason. */
export const academySetCourseQuizStateInputSchema = z
  .object({ itemId: z.string().guid(), state: z.enum(ACADEMY_COURSE_QUIZ_STATES), reason: z.string().trim().min(1).max(500) })
  .strict();
export type AcademySetCourseQuizStateInput = z.infer<typeof academySetCourseQuizStateInputSchema>;

/** `courseQuiz`: a published quiz or survey as an enrolled learner reads it: no key, no code, no filter. */
export const academyLearnerCourseQuizSchema = z.object({
  itemId: z.string().guid(),
  courseSlug: z.string().min(1),
  courseTitle: z.string().min(1),
  title: z.string().min(1),
  kind: z.enum(ACADEMY_COURSE_QUIZ_KINDS),
  anonymous: z.boolean(),
  /** Null on a survey, which has no pass mark. */
  passMark: z.number().int().nonnegative().nullable(),
  attemptLimit: z.number().int().positive().nullable(),
  timeLimitSeconds: z.number().int().positive().nullable(),
  reviewMode: z.enum(ACADEMY_QUIZ_REVIEW_MODES),
  resultsVisibility: z.enum(ACADEMY_RESULTS_VISIBILITY),
  accessCodeRequired: z.boolean(),
  attemptsUsed: z.number().int().nonnegative(),
  /** A survey this learner has already answered (a second answer refuses); false on a graded quiz. */
  responded: z.boolean(),
  questions: z.array(
    z.object({
      id: z.string().min(1),
      prompt: z.string().min(1),
      kind: z.enum(ACADEMY_QUESTION_KINDS),
      points: z.number().int().positive(),
      choices: z.array(z.object({ id: z.string().min(1), text: z.string().min(1) })).nullable(),
    }),
  ),
});
export type AcademyLearnerCourseQuiz = z.infer<typeof academyLearnerCourseQuizSchema>;

/** One answer: a choice id (single), choice ids (multi), a decimal (numeric) or text (essay). */
export const academyCourseQuizAnswerSchema = z.union([z.string().max(10_000), z.array(z.string().regex(ACADEMY_CHOICE_ID)).max(20)]);
export type AcademyCourseQuizAnswer = z.infer<typeof academyCourseQuizAnswerSchema>;

/**
 * An attempt on a quiz in a course staff made, as its learner sees it. `result` is null while open; `pending_review`
 * while an essay waits for staff; `withheld` while the quiz's results visibility hides the score; else the score.
 */
export const academyCourseQuizAttemptSchema = z.object({
  attemptId: z.string().guid(),
  itemId: z.string().guid(),
  number: z.number().int().positive(),
  startedAt: isoInstant,
  deadlineAt: isoInstant.nullable(),
  secondsLeft: z.number().int().nonnegative().nullable(),
  answers: z.record(z.string(), academyCourseQuizAnswerSchema),
  result: z
    .discriminatedUnion('state', [
      z.object({
        state: z.literal('graded'),
        score: z.number().int().nonnegative(),
        maxScore: z.number().int().nonnegative(),
        pass: z.boolean(),
        finishedAt: isoInstant,
        /** Each answer against the key, when the quiz's review mode shows answers; null when it shows the score only. */
        review: z
          .array(
            z.object({
              questionId: z.string(),
              kind: z.enum(ACADEMY_QUESTION_KINDS),
              given: academyCourseQuizAnswerSchema.nullable(),
              /** The key: a choice id, choice ids or a decimal; null on an essay, which staff scored. */
              key: academyCourseQuizAnswerSchema.nullable(),
              earned: z.number().int().nonnegative(),
              points: z.number().int().positive(),
            }),
          )
          .nullable(),
      }),
      z.object({ state: z.literal('pending_review'), finishedAt: isoInstant }),
      z.object({ state: z.literal('withheld'), finishedAt: isoInstant }),
    ])
    .nullable(),
});
export type AcademyCourseQuizAttempt = z.infer<typeof academyCourseQuizAttemptSchema>;

export const academyAnswerCourseQuizInputSchema = z
  .object({ attemptId: z.string().guid(), questionId: z.string().min(1).max(80), answer: academyCourseQuizAnswerSchema })
  .strict();
export type AcademyAnswerCourseQuizInput = z.infer<typeof academyAnswerCourseQuizInputSchema>;
export const academyFinishCourseQuizInputSchema = z.object({ attemptId: z.string().guid() }).strict();

/**
 * `submitCourseSurvey`: one response per learner. `clientToken` is a random value only the learner's device keeps. An
 * anonymous survey stores the answers with the token's one-way hash and no account; that the learner answered is a
 * separate row with no answers, written apart from them, so each learner answers once and staff see no names. Someone
 * with raw database access could still try to match the two by when they were written: it is not a sealed ballot.
 */
export const academySubmitCourseSurveyInputSchema = z
  .object({
    itemId: z.string().guid(),
    clientToken: z.string().min(16).max(128),
    answers: z.record(z.string().min(1).max(80), academyCourseQuizAnswerSchema),
  })
  .strict();
export type AcademySubmitCourseSurveyInput = z.infer<typeof academySubmitCourseSurveyInputSchema>;
export const academySurveySubmittedSchema = z.object({ itemId: z.string().guid(), anonymous: z.boolean(), submittedAt: isoInstant });

/** `admin.courseQuizReviews`: finished attempts waiting for an essay score, under per-quiz aliases, never the account. */
export const academyCourseQuizReviewSchema = z.object({
  attemptId: z.string().guid(),
  alias: z.number().int().positive(),
  number: z.number().int().positive(),
  finishedAt: isoInstant,
  autoScore: z.number().int().nonnegative(),
  essays: z.array(
    z.object({ questionId: z.string(), prompt: z.string(), points: z.number().int().positive(), text: z.string().nullable() }),
  ),
});
export type AcademyCourseQuizReview = z.infer<typeof academyCourseQuizReviewSchema>;
export const academyCourseQuizReviewsSchema = z.array(academyCourseQuizReviewSchema);

/**
 * `admin.scoreCourseQuizEssays`: whole points for every essay question of an attempt on the quiz named, each from 0 to its
 * points; the attempt is then graded. A blank score is not sent: a missing one refuses.
 */
export const academyScoreCourseQuizEssaysInputSchema = z
  .object({
    itemId: z.string().guid(),
    attemptId: z.string().guid(),
    points: z.record(z.string().min(1).max(80), z.number().int().nonnegative().max(1000)),
  })
  .strict();
export type AcademyScoreCourseQuizEssaysInput = z.infer<typeof academyScoreCourseQuizEssaysInputSchema>;

/** `startCourseQuiz`: start (or get back) the caller's attempt; the code is checked on every start. */
export const academyStartCourseQuizInputSchema = z
  .object({ itemId: z.string().guid(), accessCode: z.string().trim().max(64).nullable() })
  .strict();
export type AcademyStartCourseQuizInput = z.infer<typeof academyStartCourseQuizInputSchema>;

/**
 * AC-quizzes-04: score changes after grading. An attempt stays as the learner finished it; every change is an event in its
 * score trail: an override of one question's points with a comment and a reason (`override:<attempt>:<question>:<n>`), or
 * a rescore after an author fixes a key (`rescore:<attempt>:<revision>`, once per attempt and revision). The score the
 * learner and the gradebook see is the newest event's. A key fix is a new revision of a published quiz that changes only
 * keys (`academy.key_fix_invalid` otherwise) and keeps every attempt as it was until a rescore.
 */
export const academyFixCourseQuizKeyInputSchema = z
  .object({
    itemId: z.string().guid(),
    revision: z.number().int().nonnegative(),
    questions: z.array(academyCourseQuizQuestionSchema).max(ACADEMY_QUIZ_MAX_QUESTIONS),
    reason: z.string().trim().min(1).max(500),
  })
  .strict();
export type AcademyFixCourseQuizKeyInput = z.infer<typeof academyFixCourseQuizKeyInputSchema>;

/** `admin.rescoreCourseQuiz`: apply the quiz's current keys to every graded attempt whose answers they change. */
export const academyRescoreCourseQuizInputSchema = z
  .object({ itemId: z.string().guid(), reason: z.string().trim().min(1).max(500) })
  .strict();
export type AcademyRescoreCourseQuizInput = z.infer<typeof academyRescoreCourseQuizInputSchema>;

/** `admin.overrideCourseQuizScore`: one question's whole points on a graded attempt, as score event `n`. */
export const academyOverrideCourseQuizScoreInputSchema = z
  .object({
    itemId: z.string().guid(),
    attemptId: z.string().guid(),
    questionId: z.string().min(1).max(80),
    points: z.number().int().nonnegative().max(1000),
    n: z.number().int().positive(),
    comment: z.string().trim().max(2000).nullable(),
    reason: z.string().trim().min(1).max(500),
  })
  .strict();
export type AcademyOverrideCourseQuizScoreInput = z.infer<typeof academyOverrideCourseQuizScoreInputSchema>;

export const academyCourseQuizScoreEventSchema = z.object({
  n: z.number().int().positive(),
  kind: z.enum(['override', 'rescore', 'curve']),
  questionId: z.string().nullable(),
  revision: z.number().int().positive().nullable(),
  previousScore: z.number().int().nonnegative(),
  score: z.number().int().nonnegative(),
  passed: z.boolean(),
  comment: z.string().nullable(),
  reason: z.string(),
  at: isoInstant,
});
export type AcademyCourseQuizScoreEvent = z.infer<typeof academyCourseQuizScoreEventSchema>;

/** `admin.courseQuizAttempts`: every finished attempt under its per-quiz alias, never the account, with its score trail. */
export const academyCourseQuizAttemptsSchema = z.object({
  itemId: z.string().guid(),
  title: z.string(),
  revision: z.number().int().nonnegative(),
  passMark: z.number().int().nonnegative().nullable(),
  attempts: z.array(
    z.object({
      attemptId: z.string().guid(),
      alias: z.number().int().positive(),
      number: z.number().int().positive(),
      finishedAt: isoInstant,
      state: z.enum(['pending_review', 'graded']),
      /** The score as finished, and as it stands after its score trail; null while an essay waits. */
      originalScore: z.number().int().nonnegative().nullable(),
      score: z.number().int().nonnegative().nullable(),
      maxScore: z.number().int().nonnegative(),
      passed: z.boolean().nullable(),
      /** The pass mark this attempt is judged against: the one in force when it was taken. */
      passMark: z.number().int().nonnegative(),
      /** Graded on keys other than the quiz's current ones (graded after the last rescore, say): a rescore would apply them. */
      rescoreDue: z.boolean(),
      questions: z.array(
        z.object({ questionId: z.string(), prompt: z.string(), points: z.number().int().positive(), earned: z.number().nullable() }),
      ),
      events: z.array(academyCourseQuizScoreEventSchema),
      nextN: z.number().int().positive(),
    }),
  ),
});
export type AcademyCourseQuizAttempts = z.infer<typeof academyCourseQuizAttemptsSchema>;

/** `admin.rescoreCourseQuiz`'s answer: the attempts it changed now, and the trail as it stands. */
export const academyRescoreCourseQuizResultSchema = z.object({
  revision: z.number().int().positive(),
  rescored: z.array(
    z.object({ alias: z.number().int().positive(), number: z.number().int().positive(), from: z.number(), to: z.number() }),
  ),
  attempts: academyCourseQuizAttemptsSchema,
});
export type AcademyRescoreCourseQuizResult = z.infer<typeof academyRescoreCourseQuizResultSchema>;

/**
 * `admin.curveCourseQuiz`: a CSV file of new total scores, a header `learner,score` and one row per learner by the alias
 * staff see ("Learner 3" or "3"), applied to that learner's newest graded attempt. A dry run lists every row it would
 * change and every row it refuses (an unknown learner, a score above the maximum, an attempt waiting for an essay
 * score) and writes nothing. Applying refuses the whole file (`academy.bulk_file_invalid`) while any row is refused, so
 * a curve applies whole or not at all, in one transaction, each row an event keyed by the file's sha256 and its line. The
 * same file again answers with what it applied. The file's size limit is an owner value: blank refuses
 * `academy.bulk_limit_unset`, and a larger file refuses `academy.bulk_file_too_large` before it is read.
 */
export const ACADEMY_CURVE_FILE_MAX_CHARS = 900_000;
export const academyCurveCourseQuizInputSchema = z
  .object({
    itemId: z.string().guid(),
    fileName: z.string().trim().min(1).max(200),
    csv: z.string().min(1).max(ACADEMY_CURVE_FILE_MAX_CHARS),
    dryRun: z.boolean(),
    reason: z.string().trim().min(1).max(500),
  })
  .strict();
export type AcademyCurveCourseQuizInput = z.infer<typeof academyCurveCourseQuizInputSchema>;
export const academyCurveCourseQuizResultSchema = z.object({
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  fileName: z.string().min(1),
  dryRun: z.boolean(),
  /** True when this file was applied before: the rows are what it applied then, and nothing changed now. */
  repeated: z.boolean(),
  /** True when the rows below were written now. */
  applied: z.boolean(),
  rows: z.array(
    z.object({
      line: z.number().int().positive(),
      alias: z.number().int().positive(),
      number: z.number().int().positive(),
      from: z.number().int().nonnegative(),
      to: z.number().int().nonnegative(),
    }),
  ),
  rejected: z.array(
    z.object({
      line: z.number().int().positive(),
      alias: z.number().int().positive().nullable(),
      code: z.string().min(1),
      message: z.string().min(1),
    }),
  ),
});
export type AcademyCurveCourseQuizResult = z.infer<typeof academyCurveCourseQuizResultSchema>;

/**
 * `admin.courseQuizAnalytics`: item analysis and the score distribution, worked out from real graded attempts as their
 * score trail leaves them, never an invented figure. With no graded attempt, `graded` is 0, the distribution is empty and
 * every item has no answers. Shares are percentages as decimal strings with one place; null with nothing to divide by.
 * Answers learner by learner are `admin.courseQuizAnswers`, which needs the data researcher role (AC-roles-01).
 */
export const academyCourseQuizAnalyticsSchema = z.object({
  itemId: z.string().guid(),
  title: z.string(),
  revision: z.number().int().nonnegative(),
  graded: z.number().int().nonnegative(),
  learners: z.number().int().nonnegative(),
  /** How many graded attempts finished at each total, from 0 to the highest maximum; empty with none graded. */
  scoreDistribution: z.array(z.object({ score: z.number().int().nonnegative(), count: z.number().int().nonnegative() })),
  items: z.array(
    z.object({
      questionId: z.string(),
      prompt: z.string(),
      kind: z.enum(['single', 'multi', 'numeric', 'essay']),
      points: z.number().int().positive(),
      /** Graded attempts that hold this question. */
      attempts: z.number().int().nonnegative(),
      /** Share of those that earned the question's full points: its difficulty as the share who got it right. */
      fullMarksShare: z.string().nullable(),
      /** The mean points earned, as a decimal string with two places. */
      meanPoints: z.string().nullable(),
      /** The same share on each learner's first attempt only. */
      firstAttemptFullMarksShare: z.string().nullable(),
    }),
  ),
});
export type AcademyCourseQuizAnalytics = z.infer<typeof academyCourseQuizAnalyticsSchema>;

/** `admin.courseQuizAnswers`: each answer under an anonymised id; refuses `academy.permission_denied` without the role. */
export const academyCourseQuizAnswersSchema = z.object({
  itemId: z.string().guid(),
  rows: z.array(
    z.object({
      learner: z.string(),
      attempt: z.number().int().positive(),
      questionId: z.string(),
      answer: academyCourseQuizAnswerSchema.nullable(),
      earned: z.number(),
    }),
  ),
});
export type AcademyCourseQuizAnswers = z.infer<typeof academyCourseQuizAnswersSchema>;
