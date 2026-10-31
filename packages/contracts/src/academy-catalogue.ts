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

/**
 * A course lesson staff featured on the Learn hub (AC-articles-01), as a visitor sees it: its title and its course's.
 * `courseSlug` is set only while the course is published, so the hub links only to a page a visitor can open.
 */
export const academyPublicHubLessonSchema = z.object({
  title: z.string().min(1),
  courseTitle: z.string().min(1),
  courseSlug: z.string().min(1).nullable(),
});
export type AcademyPublicHubLesson = z.infer<typeof academyPublicHubLessonSchema>;
/**
 * `publicHub`: the hub's one featured slot as staff chose it, a curriculum item or a course lesson, never both; both null
 * when nobody chose one. Never auto-promoted. A reply without `lesson` (a server from before it) reads as no lesson.
 */
export const academyPublicHubSchema = z.object({
  featured: academyCurriculumSummarySchema.nullable(),
  lesson: academyPublicHubLessonSchema.nullable().default(null),
});
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
  /** A paid track on a course staff made: course payments are not switched on (AC-commerce-01), so nothing is sold. */
  'payments_off',
] as const;
export type AcademyEnrolmentClosedReason = (typeof ACADEMY_ENROLMENT_CLOSED_REASONS)[number];

const isoInstant = z.string().datetime({ offset: true });

/**
 * `courseEnrolment` (signed in): the terms of enrolling and the caller's own enrolment. `startsAt` null means the course
 * is self-paced and opens when you enrol. `seatCap` null means no cap is set, and then `seatsRemaining` is null too.
 * `activationMail` names the outside piece the activation mail needs while it is switched off; null once it is sent.
 */
const enrolmentTerms = <S extends z.ZodTypeAny>(slug: S) =>
  z
    .object({
      slug,
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
export const academyCourseEnrolmentSchema = enrolmentTerms(z.enum(ACADEMY_CURRICULUM_PATHS));
/** `authoredCourseEnrolment`: the same terms for a course staff made, keyed by its address. */
export const academyAuthoredCourseEnrolmentSchema = enrolmentTerms(z.string().min(1));
export type AcademyAuthoredCourseEnrolment = z.infer<typeof academyAuthoredCourseEnrolmentSchema>;
export type AcademyCourseEnrolment = z.infer<typeof academyCourseEnrolmentSchema>;

/** `enrolCourse` input. A repeat while enrolled answers with the same enrolment; nothing is created twice. */
export const academyEnrolCourseInputSchema = z
  .object({ slug: z.string().min(1).max(64), track: z.enum(ACADEMY_ENROLMENT_TRACKS) })
  .strict();
export type AcademyEnrolCourseInput = z.infer<typeof academyEnrolCourseInputSchema>;

/**
 * AC-catalogue-02: My learning, one row per course the caller is enrolled in. `completed` counts the course's items the
 * caller has completed; `resumeItemSlug` is null until they have completed something in it, and then names
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

/**
 * AC-course-structure-02: the outline beside an open item, for the signed-in learner. Each item carries the caller's
 * own release state; a locked item says why (`prerequisite` with the missing items, or `window` with when it opens,
 * null when the window has closed) and its body is never part of the outline.
 */
export const ACADEMY_ITEM_STATES = ['locked', 'unlocked', 'started', 'completed'] as const;
/**
 * AC-progress-01: what completes an item. `view` is met by opening it (the Complete button sits on the open item);
 * `score` needs a passing quiz attempt; `watch` needs the video watched past the course threshold.
 */
export const ACADEMY_COMPLETION_RULES = ['view', 'score', 'watch'] as const;
export type AcademyCompletionRule = (typeof ACADEMY_COMPLETION_RULES)[number];
export const academyCourseOutlineItemSchema = z.object({
  slug: z.string().min(1),
  title: z.string().min(1),
  kind: z.enum(ACADEMY_CURRICULUM_KINDS),
  state: z.enum(ACADEMY_ITEM_STATES),
  lock: z.enum(['prerequisite', 'window']).nullable(),
  missing: z.array(z.string().min(1)),
  opensAt: isoInstant.nullable(),
  rule: z.enum(ACADEMY_COMPLETION_RULES),
  /** Whether the caller has met `rule`; a completed item stays completed either way. */
  ruleMet: z.boolean(),
  /** When the current completion was recorded; null while the item is not complete (or was undone). */
  completedAt: isoInstant.nullable(),
});
export type AcademyCourseOutlineItem = z.infer<typeof academyCourseOutlineItemSchema>;
export const academyCourseOutlineSchema = z.object({
  slug: z.enum(ACADEMY_CURRICULUM_PATHS),
  items: z.array(academyCourseOutlineItemSchema).min(1),
});
export type AcademyCourseOutline = z.infer<typeof academyCourseOutlineSchema>;

/** `markCurriculumComplete`: the stored completion. A repeat answers with the first one; nothing is recorded twice. */
export const academyItemCompletionSchema = z.object({ userId: z.string().guid(), itemSlug: z.string().min(1), completedAt: isoInstant });
export type AcademyItemCompletion = z.infer<typeof academyItemCompletionSchema>;

/**
 * AC-progress-01 Undo of the completion recorded at `completedAt` (as the outline gave it), so a late replay never undoes a
 * newer completion. The request id is the learner's own key for this one press; a replay answers the same.
 */
export const academyUndoCompletionInputSchema = z
  .object({ itemSlug: z.string().min(1).max(120), completedAt: isoInstant, clientRequestId: z.string().trim().min(1).max(200) })
  .strict();
/** `undoneAt` null: nothing was complete, so nothing changed. */
export const academyUndoCompletionSchema = z.object({
  userId: z.string().guid(),
  itemSlug: z.string().min(1),
  undoneAt: isoInstant.nullable(),
});
export type AcademyUndoCompletion = z.infer<typeof academyUndoCompletionSchema>;

/**
 * AC-quizzes-03: a quiz as the learner reads it. `timeLimitSeconds` and `attemptLimit` are null when staff set none (no
 * limit applies); `reviewMode` says whether a finished attempt shows each answer against the key or the score only.
 */
export const ACADEMY_QUIZ_REVIEW_MODES = ['answers', 'score_only'] as const;
export type AcademyQuizReviewMode = (typeof ACADEMY_QUIZ_REVIEW_MODES)[number];
const quizChoice = z.object({ id: z.string().min(1).max(80), text: z.string().min(1).max(500) });
export const academyQuizSchema = z.object({
  slug: z.string().min(1),
  kind: z.literal('quiz'),
  passMark: z.number().int().nonnegative(),
  timeLimitSeconds: z.number().int().positive().nullable(),
  attemptLimit: z.number().int().positive().nullable(),
  reviewMode: z.enum(ACADEMY_QUIZ_REVIEW_MODES),
  questions: z.array(
    z.object({
      id: z.string().min(1),
      prompt: z.string().min(1),
      kind: z.literal('single'),
      points: z.number().int().positive(),
      choices: z.array(quizChoice),
    }),
  ),
});
export type AcademyQuiz = z.infer<typeof academyQuizSchema>;

/**
 * One timed attempt. The deadline is the server's, set at Start; `secondsLeft` is counted on the server at this read, so
 * a refresh shows the same time left. `answers` are the saved choices by question id. `result` is null while open.
 */
export const academyQuizAttemptSchema = z.object({
  attemptId: z.string().guid(),
  slug: z.string().min(1),
  number: z.number().int().positive(),
  startedAt: isoInstant,
  deadlineAt: isoInstant.nullable(),
  secondsLeft: z.number().int().nonnegative().nullable(),
  answers: z.record(z.string(), z.string()),
  /**
   * Null while open. A finished attempt on a quiz whose results staff hide until a date (AC-progress-02) carries
   * `hiddenUntil` and no score, pass or maximum until then.
   */
  result: z
    .discriminatedUnion('hidden', [
      z.object({
        hidden: z.literal(false),
        score: z.number().int().nonnegative(),
        maxScore: z.number().int().nonnegative(),
        pass: z.boolean(),
        finishedAt: isoInstant,
      }),
      z.object({ hidden: z.literal(true), hiddenUntil: isoInstant, finishedAt: isoInstant }),
    ])
    .nullable(),
});
export type AcademyQuizAttempt = z.infer<typeof academyQuizAttemptSchema>;

/** A finished attempt's review: the learner's own choices against the key, or `questions: null` when the quiz shows the score only. */
export const academyQuizReviewSchema = z.object({
  attemptId: z.string().guid(),
  slug: z.string().min(1),
  number: z.number().int().positive(),
  score: z.number().int().nonnegative(),
  maxScore: z.number().int().nonnegative(),
  pass: z.boolean(),
  finishedAt: isoInstant,
  reviewMode: z.enum(ACADEMY_QUIZ_REVIEW_MODES),
  questions: z
    .array(
      z.object({
        id: z.string().min(1),
        prompt: z.string().min(1),
        choices: z.array(quizChoice),
        chosenChoiceId: z.string().nullable(),
        correctChoiceId: z.string(),
        correct: z.boolean(),
      }),
    )
    .nullable(),
});
export type AcademyQuizReview = z.infer<typeof academyQuizReviewSchema>;

/** Staff publish (or, with `quiz: null`, take down) the quiz on one curriculum item, with a reason. */
export const academySetQuizInputSchema = z
  .object({
    slug: z.string().min(1).max(120),
    quiz: z
      .object({
        passMark: z.number().int().nonnegative().nullable(),
        attemptLimit: z.number().int().positive().nullable(),
        timeLimitSeconds: z.number().int().positive().nullable(),
        reviewMode: z.enum(ACADEMY_QUIZ_REVIEW_MODES),
        /** AC-progress-02: results stay hidden (a pending grade, no score) until this instant; null or absent shows them at once. */
        resultsHiddenUntil: isoInstant.nullable().optional(),
        questions: z
          .array(
            z.object({
              id: z.string().min(1).max(80),
              prompt: z.string().min(1).max(2000),
              points: z.number().int().positive(),
              choices: z.array(quizChoice).min(2).max(20),
              correctChoiceId: z.string().min(1).max(80),
            }),
          )
          .min(1)
          .max(100),
      })
      .nullable(),
    reason: z.string().trim().min(1).max(500),
  })
  .strict();
export type AcademySetQuizInput = z.infer<typeof academySetQuizInputSchema>;

/**
 * AC-progress-02: the learner's progress page. Per enrolled course, percent complete from the items the learner can see
 * (every published item of the course; nothing is hidden from a learner today), with a check mark per item. Percentages
 * are decimal strings with one decimal place.
 */
const percent = z.string().regex(/^\d{1,3}\.\d$/);
export const academyCourseProgressSchema = z
  .object({
    slug: z.enum(ACADEMY_CURRICULUM_PATHS),
    visible: z.number().int().positive(),
    completed: z.number().int().nonnegative(),
    percent,
    items: z.array(
      z.object({
        slug: z.string().min(1),
        title: z.string().min(1),
        kind: z.enum(ACADEMY_CURRICULUM_KINDS),
        completedAt: isoInstant.nullable(),
      }),
    ),
  })
  .refine((row) => row.completed <= row.visible && row.items.length === row.visible, { message: 'progress does not add up' });
export type AcademyCourseProgress = z.infer<typeof academyCourseProgressSchema>;

/**
 * AC-progress-02: the learner's grades. One row per quiz they have finished an attempt on, at their best score, as
 * decimal strings. A result staff hide until a date is `pending`: no score, the date it shows. Averages are per item type
 * over released results only (sum of points over sum of possible); no row means no average, never a zero.
 */
export const ACADEMY_GRADE_TYPES = ['quiz'] as const;
const points = z.string().regex(/^\d+$/);
export const academyGradesSchema = z.object({
  rows: z.array(
    z.discriminatedUnion('pending', [
      z.object({
        pending: z.literal(false),
        slug: z.string().min(1),
        title: z.string().min(1),
        type: z.enum(ACADEMY_GRADE_TYPES),
        attempts: z.number().int().positive(),
        score: points,
        possible: points,
        percent,
        passed: z.boolean(),
      }),
      z.object({
        pending: z.literal(true),
        slug: z.string().min(1),
        title: z.string().min(1),
        type: z.enum(ACADEMY_GRADE_TYPES),
        attempts: z.number().int().positive(),
        hiddenUntil: isoInstant,
      }),
    ]),
  ),
  averages: z.array(z.object({ type: z.enum(ACADEMY_GRADE_TYPES), percent, count: z.number().int().positive() })),
});
export type AcademyGrades = z.infer<typeof academyGradesSchema>;

/**
 * AC-progress-02 for authored courses: per enrolled published course, one row per assignment with a brief, in outline
 * order. `graded` carries the newest hand-in's grade out of the points it was graded against; `handed_in` has no score
 * yet; `not_attempted` is never a zero; `withdrawn` is an assignment staff closed before the learner handed in. Averages per type are sum of score over sum of possible across graded rows only; no graded row, no average.
 */
export const ACADEMY_COURSE_GRADE_TYPES = ['assignment'] as const;
const decimal = z.string().regex(/^\d+(?:\.\d{1,2})?$/);
export const academyCourseGradesSchema = z.object({
  slug: z.string().min(1),
  title: z.string().min(1),
  rows: z.array(
    z.discriminatedUnion('state', [
      z.object({
        state: z.literal('graded'),
        itemId: z.string().guid(),
        title: z.string().min(1),
        type: z.enum(ACADEMY_COURSE_GRADE_TYPES),
        score: decimal,
        possible: decimal,
      }),
      z.object({
        state: z.enum(['handed_in', 'not_attempted', 'withdrawn']),
        itemId: z.string().guid(),
        title: z.string().min(1),
        type: z.enum(ACADEMY_COURSE_GRADE_TYPES),
        possible: decimal,
      }),
    ]),
  ),
  averages: z.array(z.object({ type: z.enum(ACADEMY_COURSE_GRADE_TYPES), percent, count: z.number().int().positive() })),
});
export type AcademyCourseGrades = z.infer<typeof academyCourseGradesSchema>;

export const academyProgressPageSchema = z.object({
  courses: z.array(academyCourseProgressSchema),
  grades: academyGradesSchema,
  courseGrades: z.array(academyCourseGradesSchema),
});
export type AcademyProgressPage = z.infer<typeof academyProgressPageSchema>;

/**
 * AC-progress-02: the learner's planner. To-do items and a weekly goal are the learner's own and private. `todoLimit` is
 * the owner's per-learner cap (null: unset, and adding refuses `academy.planner_limit_unset`). `revision` counts every
 * to-do ever added, so a new item's key `todo:<revision>` names one add. The goal reminder's mail names `vendor.email`
 * while Academy has no mail sender.
 */
export const academyPlannerTodoSchema = z.object({
  id: z.string().guid(),
  text: z.string().min(1).max(200),
  createdAt: isoInstant,
  doneAt: isoInstant.nullable(),
});
export type AcademyPlannerTodo = z.infer<typeof academyPlannerTodoSchema>;
export const academyGoalSchema = z.object({
  itemsPerWeek: z.number().int().positive(),
  reminder: z.boolean(),
  setAt: isoInstant,
  /** Items the learner completed in the seven days up to this read. */
  doneThisWeek: z.number().int().nonnegative(),
});
export const academyPlannerSchema = z.object({
  todos: z.array(academyPlannerTodoSchema),
  todoLimit: z.number().int().positive().nullable(),
  revision: z.number().int().nonnegative(),
  goal: academyGoalSchema.nullable(),
  reminderMail: z.literal('vendor.email'),
});
export type AcademyPlanner = z.infer<typeof academyPlannerSchema>;
export const academyAddTodoInputSchema = z
  .object({ clientKey: z.string().trim().min(1).max(120), text: z.string().trim().min(1).max(200) })
  .strict();
export const academySetTodoDoneInputSchema = z.object({ todoId: z.string().guid(), done: z.boolean() }).strict();
export const academyRemoveTodoInputSchema = z.object({ todoId: z.string().guid() }).strict();
export const academySetGoalInputSchema = z.object({ itemsPerWeek: z.number().int(), reminder: z.boolean() }).strict();
/** Sending the goal reminder now: `sent` is false and `mail` names the missing dependency while Academy has no mail sender. */
export const academyGoalReminderSchema = z.object({ sent: z.literal(false), mail: z.literal('vendor.email') });

/**
 * AC-videos-01: the video staff attach to one curriculum item. An item with a video completes by the `watch` rule: the
 * stored watch position reaching the owner's threshold completes it without a button. `videoSlug` null: no video.
 */
export const academyItemVideoSchema = z.object({ itemSlug: z.string().min(1), videoSlug: z.string().min(1).nullable() });
export type AcademyItemVideo = z.infer<typeof academyItemVideoSchema>;
export const academySetItemVideoInputSchema = z
  .object({
    itemSlug: z.string().min(1).max(120),
    videoSlug: z.string().min(1).max(120).nullable(),
    reason: z.string().trim().min(1).max(500),
  })
  .strict();

/** One caption cue, in whole milliseconds from the start of the video. */
export const academyVideoCueSchema = z.object({
  startMs: z.number().int().nonnegative(),
  endMs: z.number().int().positive(),
  text: z.string().min(1).max(1000),
});
export type AcademyVideoCue = z.infer<typeof academyVideoCueSchema>;
/** A BCP 47 language tag, such as `en` or `pt-BR`. */
const languageTag = z.string().regex(/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/);
export const academyVideoTrackSchema = z.object({
  language: languageTag,
  label: z.string().min(1).max(60),
  cues: z.array(academyVideoCueSchema),
});
export type AcademyVideoTrack = z.infer<typeof academyVideoTrackSchema>;

/**
 * AC-videos-01: what the player needs besides the signed playback URL. Caption tracks come as cues (the transcript is the
 * same cues, so it follows the chosen language); an empty list means the video has no captions. `renditions` lists only
 * the files that exist. `saveEverySeconds` is the owner's position save interval (null: unset, so the position is saved
 * on pause and on leaving only); `watchThresholdSeconds` is the owner's watch threshold (null: unset, and a watch item
 * cannot complete). Behind the same tier and stake gate as playback.
 */
export const academyVideoPlayerSchema = z.object({
  slug: z.string().min(1),
  title: z.string().min(1),
  renditions: z.array(z.object({ id: z.literal('original') })).min(1),
  tracks: z.array(academyVideoTrackSchema),
  saveEverySeconds: z.number().int().positive().nullable(),
  watchThresholdSeconds: z.number().int().positive().nullable(),
});
export type AcademyVideoPlayer = z.infer<typeof academyVideoPlayerSchema>;
/** Staff replace every caption track of one video, with a reason. Each track is a WebVTT file in UTF-8; `[]` removes them. */
export const academySetVideoTracksInputSchema = z
  .object({
    videoSlug: z.string().min(1).max(120),
    tracks: z
      .array(z.object({ language: languageTag, label: z.string().trim().min(1).max(60), vtt: z.string().min(1).max(200_000) }))
      .max(12),
    reason: z.string().trim().min(1).max(500),
  })
  .strict();

/** The learner's stored watch position. `completedItems`: the watch items this save completed (a set only says so). */
export const academyVideoPositionSchema = z.object({
  videoSlug: z.string().min(1),
  positionSeconds: z.number().int().nonnegative().nullable(),
});
export const academyVideoPositionSavedSchema = academyVideoPositionSchema.extend({ completedItems: z.array(z.string().min(1)) });
/** A signed, expiring playback URL for one video, as the wire carries it; `grant` binds it to the caller. */
export const academyVideoPlaybackSchema = z.object({
  slug: z.string().min(1),
  playbackUrl: z.string().url(),
  expiresAt: isoInstant,
  grant: z.string().min(1),
});
export type AcademyVideoPlayback = z.infer<typeof academyVideoPlaybackSchema>;
