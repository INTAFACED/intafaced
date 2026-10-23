import { sql } from 'drizzle-orm';
import { boolean, date, index, integer, jsonb, pgSchema, primaryKey, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { amount, createdAt, tstz, updatedAt } from '@intafaced/db';

/**
 * ACADEMY LOBBIES (§8.3, §XIII "live session lobbies, capacity tiers").
 *
 * Four tables: rooms and their access terms, invitations into the invite-only
 * ones, the sessions that run inside a room, and who is sitting in one.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * NO MONEY MOVES IN THIS SERVICE, AND NO TABLE HERE COULD RECORD IT.
 *
 * `academy` is `custodial: false` in the module registry. The one money-shaped
 * column in this file is `rooms.min_stake`, and it is a THRESHOLD, not a
 * balance: svc-token owns the stake, this service asks whether a caller clears
 * a number, and the answer is never stored. It is still `numeric(38,18)` and
 * still read as a decimal string, because a threshold compared against a stake
 * has to be the same kind of number as the stake.
 *
 * Ambassador pay and lobby subscriptions — the §8.3 items that DO move value —
 * are deliberately not built here (see README). They need ledger recipes that
 * do not exist, and a half-built pay path is worse than an absent one.
 * ─────────────────────────────────────────────────────────────────────────────
 */
export const academy = pgSchema('academy');

/** §XIII specialist rooms — the taxonomy is data, so a new room type is a row. */
export const roomKindEnum = academy.enum('room_kind', [
  'general',
  'futures',
  'options',
  'meme_war_room',
  'forex',
  'defi_lab',
  'merchant_clinic',
]);

/** §XIII capacity tiers: open to all, gated on stake, or gated on an invite. */
export const roomAccessEnum = academy.enum('room_access', ['free', 'staked', 'invite']);

export const sessionStatusEnum = academy.enum('session_status', ['scheduled', 'live', 'ended', 'cancelled']);
export const attendeeRoleEnum = academy.enum('attendee_role', ['host', 'speaker', 'attendee']);

export const rooms = academy.table(
  'rooms',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    kind: roomKindEnum('kind').notNull().default('general'),
    access: roomAccessEnum('access').notNull().default('free'),
    /**
     * The stake a caller must clear for a `staked` room. A THRESHOLD compared
     * against `token.stakeOf`, never a balance this service holds. Zero and
     * meaningless for the other two access kinds.
     */
    minStake: amount('min_stake').notNull().default('0'),
    /** Seats. The lobby refuses the seat that would exceed it — see access.ts. */
    capacity: integer('capacity').notNull(),
    /** The ambassador or operator who runs the room. Always admitted to their own. */
    hostId: uuid('host_id').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('rooms_slug_idx').on(t.slug), index('rooms_kind_idx').on(t.kind, t.access)],
);

/**
 * An invitation to an `invite` room.
 *
 * Rows rather than a boolean on a membership table, because an invitation is an
 * event with a lifetime: who granted it, when it stops working, and whether it
 * has been taken up. A `used_at` that is set is a record, not a revocation —
 * an invitation admits its holder for as long as it has not expired.
 */
export const roomInvites = academy.table(
  'room_invites',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    roomId: uuid('room_id')
      .notNull()
      .references(() => rooms.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').notNull(),
    invitedBy: uuid('invited_by').notNull(),
    /** Null never expires. A room can invite someone permanently. */
    expiresAt: tstz('expires_at'),
    usedAt: tstz('used_at'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('room_invites_pk').on(t.roomId, t.userId), index('room_invites_user_idx').on(t.userId)],
);

/**
 * One live session in a room (§8.3 stage + chat + shared charts).
 *
 * `scene` holds the 2D spatial layer's state (§8.3: "spatial layer v1 = 2D
 * navigable room canvas… VR-ready = keep scene state serializable"). It is
 * jsonb precisely so the VR version is a different renderer over the same rows
 * rather than a migration.
 *
 * `stream_provider` and `stream_room` name the SFU that carries the audio and
 * video. They are nullable because a session may exist before streaming is
 * configured, and this service refuses to invent a join token when it is not
 * (SOCKET §13 `socket.stream-provider` — see stream/provider.ts).
 */
export const sessions = academy.table(
  'sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    roomId: uuid('room_id')
      .notNull()
      .references(() => rooms.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    hostId: uuid('host_id').notNull(),
    status: sessionStatusEnum('status').notNull().default('scheduled'),
    startsAt: tstz('starts_at').notNull(),
    endsAt: tstz('ends_at'),
    streamProvider: text('stream_provider'),
    streamRoom: text('stream_room'),
    /** Serializable scene state — avatars, stage, presence. Never user content. */
    scene: jsonb('scene').notNull().default({}),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('sessions_room_idx').on(t.roomId, t.startsAt), index('sessions_status_idx').on(t.status, t.startsAt)],
);

/**
 * Who is in a session, and who was.
 *
 * `left_at IS NULL` is presence — the count the capacity check reads. It is a
 * table rather than a number on `sessions` for the same reason svc-bank has no
 * `total_deposited`: a maintained counter is the single most certain thing in a
 * service to drift, and occupancy is one `COUNT(*)` away.
 */
export const sessionAttendees = academy.table(
  'session_attendees',
  {
    sessionId: uuid('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').notNull(),
    role: attendeeRoleEnum('role').notNull().default('attendee'),
    joinedAt: createdAt(),
    leftAt: tstz('left_at'),
  },
  (t) => [uniqueIndex('session_attendees_pk').on(t.sessionId, t.userId), index('session_attendees_live_idx').on(t.sessionId, t.leftAt)],
);

/**
 * Ambassador / residency programme membership (Stage-1 status only).
 *
 * NO pay columns. Appointed / frozen is operator-controlled programme state.
 * Hosting rights remain identity `lobbyHostRights` — see ambassadors/programme.ts.
 */
export const ambassadorStatusEnum = academy.enum('ambassador_status', ['active', 'frozen']);

export const ambassadors = academy.table(
  'ambassadors',
  {
    userId: uuid('user_id').primaryKey(),
    status: ambassadorStatusEnum('status').notNull().default('active'),
    appointedBy: uuid('appointed_by').notNull(),
    appointedAt: tstz('appointed_at').notNull().defaultNow(),
    frozenAt: tstz('frozen_at'),
    frozenBy: uuid('frozen_by'),
    freezeReason: text('freeze_reason'),
    updatedAt: updatedAt(),
  },
  (t) => [index('ambassadors_status_idx').on(t.status, t.appointedAt)],
);

/** Tournament seasons — Stage-1 ladder metadata (no prize balances). */
export const seasonStatusEnum = academy.enum('season_status', ['scheduled', 'live', 'frozen', 'ended']);

export const tournamentSeasons = academy.table(
  'tournament_seasons',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    slug: text('slug').notNull(),
    title: text('title').notNull(),
    status: seasonStatusEnum('status').notNull().default('scheduled'),
    rulesSummary: text('rules_summary').notNull(),
    startsAt: tstz('starts_at').notNull(),
    endsAt: tstz('ends_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('tournament_seasons_slug_idx').on(t.slug), index('tournament_seasons_status_idx').on(t.status, t.startsAt)],
);

export const tournamentStandings = academy.table(
  'tournament_standings',
  {
    seasonId: uuid('season_id')
      .notNull()
      .references(() => tournamentSeasons.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').notNull(),
    score: integer('score').notNull().default(0),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('tournament_standings_pk').on(t.seasonId, t.userId),
    index('tournament_standings_rank_idx').on(t.seasonId, t.score, t.updatedAt),
  ],
);

/**
 * Ranked standings captured at freeze — audit only, no prize columns.
 * Written on live→frozen; immutable thereafter (season_id PK).
 */
export const tournamentFreezeSnapshots = academy.table('tournament_freeze_snapshots', {
  seasonId: uuid('season_id')
    .primaryKey()
    .references(() => tournamentSeasons.id, { onDelete: 'cascade' }),
  frozenAt: tstz('frozen_at').notNull(),
  standings: jsonb('standings').notNull().$type<readonly { rank: number; userId: string; score: number; updatedAt: string }[]>(),
  createdAt: createdAt(),
});

/**
 * Residency applications Stage-1 (NO PAY) — mirrors drizzle/0003_residencies.sql.
 * Decision is accept|reject|withdraw only; IFC rates stay Class M refuse-closed.
 */
export const residencyStatusEnum = academy.enum('residency_status', ['applied', 'accepted', 'rejected', 'withdrawn']);

export const residencyApplications = academy.table(
  'residency_applications',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').notNull(),
    cohortSlug: text('cohort_slug').notNull(),
    statement: text('statement').notNull(),
    status: residencyStatusEnum('status').notNull().default('applied'),
    appliedAt: tstz('applied_at').notNull().defaultNow(),
    decidedAt: tstz('decided_at'),
    decidedBy: uuid('decided_by'),
    decisionNote: text('decision_note'),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('residency_user_idx').on(t.userId, t.appliedAt),
    index('residency_status_cohort_idx').on(t.status, t.cohortSlug, t.appliedAt),
  ],
);

/**
 * Cert progress + grants Stage-1 — mirrors drizzle/0004_certs.sql.
 * Definitions stay code-seeded (certs/catalog.ts). No XP amount columns here.
 */
export const certEnrollments = academy.table(
  'cert_enrollments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').notNull(),
    pathSlug: text('path_slug').notNull(),
    enrolledAt: tstz('enrolled_at').notNull().defaultNow(),
    leftAt: tstz('left_at'),
    leaveRequestId: text('leave_request_id'),
  },
  (t) => [
    uniqueIndex('cert_enrollments_active_uq')
      .on(t.userId, t.pathSlug)
      .where(sql`left_at IS NULL`),
  ],
);

export const learningState = academy.table('learning_state', {
  userId: uuid('user_id').primaryKey(),
  lastItemSlug: text('last_item_slug').notNull(),
  lastOpenedAt: tstz('last_opened_at').notNull(),
  secondsRead: integer('seconds_read').notNull(),
});

export const learningActiveDays = academy.table(
  'learning_active_days',
  {
    userId: uuid('user_id').notNull(),
    activeOn: date('active_on').notNull(),
  },
  (t) => [uniqueIndex('learning_active_days_pk').on(t.userId, t.activeOn)],
);

export const learningTouches = academy.table(
  'learning_touches',
  {
    userId: uuid('user_id').notNull(),
    clientRequestId: text('client_request_id').notNull(),
    itemSlug: text('item_slug').notNull(),
    secondsAdded: integer('seconds_added').notNull(),
    touchedAt: tstz('touched_at').notNull(),
    lastItemSlug: text('last_item_slug').notNull(),
    lastOpenedAt: tstz('last_opened_at').notNull(),
    secondsRead: integer('seconds_read').notNull(),
    activeDays: integer('active_days').notNull(),
  },
  (t) => [uniqueIndex('learning_touches_pk').on(t.userId, t.clientRequestId)],
);

export const videoProgress = academy.table(
  'video_progress',
  {
    userId: uuid('user_id').notNull(),
    videoSlug: text('video_slug').notNull(),
    positionSeconds: integer('position_seconds').notNull(),
    updatedAt: tstz('updated_at').notNull(),
  },
  (t) => [uniqueIndex('video_progress_pk').on(t.userId, t.videoSlug)],
);

export const videoProgressRequests = academy.table(
  'video_progress_requests',
  {
    userId: uuid('user_id').notNull(),
    clientRequestId: text('client_request_id').notNull(),
    videoSlug: text('video_slug').notNull(),
    positionSeconds: integer('position_seconds').notNull(),
  },
  (t) => [uniqueIndex('video_progress_requests_pk').on(t.userId, t.clientRequestId)],
);

export const residencyCohorts = academy.table('residency_cohorts', {
  slug: text('slug').primaryKey(),
  status: text('status').notNull(),
  published: boolean('published').notNull(),
  startsAt: tstz('starts_at'),
  endsAt: tstz('ends_at'),
  capacity: integer('capacity'),
  entryRules: text('entry_rules'),
});

export const certItemCompletions = academy.table(
  'cert_item_completions',
  {
    userId: uuid('user_id').notNull(),
    itemSlug: text('item_slug').notNull(),
    completedAt: tstz('completed_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('cert_item_completions_pk').on(t.userId, t.itemSlug),
    index('cert_item_completions_user_idx').on(t.userId, t.completedAt),
  ],
);

/** AC-progress-01: every Complete and Undo, in order. The current state stays in cert_item_completions. */
export const itemCompletionEvents = academy.table(
  'item_completion_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').notNull(),
    itemSlug: text('item_slug').notNull(),
    event: text('event').notNull(),
    clientRequestId: text('client_request_id'),
    recordedAt: tstz('recorded_at').notNull(),
  },
  (t) => [index('item_completion_events_user_item_idx').on(t.userId, t.itemSlug, t.recordedAt)],
);

export const certGrants = academy.table(
  'cert_grants',
  {
    userId: uuid('user_id').notNull(),
    certId: text('cert_id').notNull(),
    grantedAt: tstz('granted_at').notNull().defaultNow(),
    idempotencyKey: text('idempotency_key').notNull(),
    publicId: text('public_id').notNull(),
    status: text('status').notNull().default('valid'),
    holderName: text('holder_name'),
    holderConsentAt: tstz('holder_consent_at'),
  },
  (t) => [
    uniqueIndex('cert_grants_pk').on(t.userId, t.certId),
    uniqueIndex('cert_grants_idempotency_uq').on(t.idempotencyKey),
    uniqueIndex('cert_grants_public_id_uq').on(t.publicId),
    index('cert_grants_user_idx').on(t.userId, t.grantedAt),
  ],
);

export const assessmentAttempts = academy.table(
  'assessment_attempts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').notNull(),
    slug: text('slug').notNull(),
    clientAttemptId: text('client_attempt_id').notNull(),
    score: integer('score').notNull(),
    maxScore: integer('max_score').notNull(),
    passed: boolean('passed').notNull(),
    submittedAt: tstz('submitted_at').notNull().defaultNow(),
    /** AC-progress-02: the quiz's hide-until date at finish; the result shows after the later of this and the quiz's date. */
    hiddenUntil: tstz('hidden_until'),
  },
  (t) => [uniqueIndex('assessment_attempts_client_uq').on(t.userId, t.clientAttemptId)],
);

/** AC-quizzes-03: a staff-published quiz per curriculum item. The answer key is in `definition` and never leaves the service. */
export const quizzes = academy.table('quizzes', {
  slug: text('slug').primaryKey(),
  definition: jsonb('definition').notNull(),
  passMark: integer('pass_mark'),
  attemptLimit: integer('attempt_limit'),
  timeLimitSeconds: integer('time_limit_seconds'),
  reviewMode: text('review_mode').notNull(),
  reason: text('reason').notNull(),
  setBy: uuid('set_by').notNull(),
  setAt: tstz('set_at').notNull(),
  /** AC-progress-02: results are pending until this instant; null shows them at once. */
  resultsHiddenUntil: tstz('results_hidden_until'),
});

/** AC-quizzes-03: one started attempt; finishing writes its score row into assessment_attempts as well. */
export const quizAttempts = academy.table(
  'quiz_attempts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').notNull(),
    slug: text('slug').notNull(),
    number: integer('number').notNull(),
    startedAt: tstz('started_at').notNull(),
    deadlineAt: tstz('deadline_at'),
    answers: jsonb('answers').notNull(),
    finishedAt: tstz('finished_at'),
    score: integer('score'),
    maxScore: integer('max_score'),
    passed: boolean('passed'),
    quiz: jsonb('quiz').notNull(),
  },
  (t) => [
    uniqueIndex('quiz_attempts_number_uq').on(t.userId, t.slug, t.number),
    uniqueIndex('quiz_attempts_open_uq')
      .on(t.userId, t.slug)
      .where(sql`${t.finishedAt} IS NULL`),
  ],
);

export const itemPrerequisites = academy.table(
  'item_prerequisites',
  {
    itemSlug: text('item_slug').notNull(),
    prerequisiteSlug: text('prerequisite_slug').notNull(),
  },
  (t) => [uniqueIndex('item_prerequisites_pk').on(t.itemSlug, t.prerequisiteSlug)],
);

export const itemWindows = academy.table('item_windows', {
  itemSlug: text('item_slug').primaryKey(),
  availableFrom: tstz('available_from').notNull(),
  availableUntil: tstz('available_until').notNull(),
  dueAt: tstz('due_at'),
});

export const featuredItems = academy.table('featured_items', {
  slot: text('slot').primaryKey(),
  itemSlug: text('item_slug').notNull(),
  reason: text('reason').notNull(),
  chosenBy: uuid('chosen_by').notNull(),
  chosenAt: tstz('chosen_at').notNull(),
});

export const courseStarts = academy.table('course_starts', {
  path: text('path').primaryKey(),
  startsAt: tstz('starts_at'),
  reason: text('reason').notNull(),
  setBy: uuid('set_by').notNull(),
  setAt: tstz('set_at').notNull(),
});

export const itemExtensions = academy.table(
  'item_extensions',
  {
    userId: uuid('user_id').notNull(),
    itemSlug: text('item_slug').notNull(),
    revision: integer('revision').notNull(),
    reason: text('reason').notNull(),
    extendedUntil: tstz('extended_until').notNull(),
    clientRequestId: text('client_request_id').notNull(),
    grantedBy: uuid('granted_by').notNull(),
    grantedAt: tstz('granted_at').notNull(),
  },
  (t) => [
    uniqueIndex('item_extensions_pk').on(t.userId, t.itemSlug, t.revision),
    uniqueIndex('item_extensions_request_uq').on(t.userId, t.itemSlug, t.clientRequestId),
    uniqueIndex('item_extensions_request_once_uq').on(t.userId, t.clientRequestId),
  ],
);

export const certHolderNameRequests = academy.table(
  'cert_holder_name_requests',
  {
    userId: uuid('user_id').notNull(),
    clientRequestId: text('client_request_id').notNull(),
    publicId: text('public_id').notNull(),
    holderName: text('holder_name'),
    consentAt: tstz('consent_at'),
  },
  (t) => [uniqueIndex('cert_holder_name_requests_pk').on(t.userId, t.clientRequestId)],
);

/** AC-progress-02: the learner's own to-do items; `client_key` names one add, and a removed item keeps its row. */
export const plannerTodos = academy.table(
  'planner_todos',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').notNull(),
    clientKey: text('client_key').notNull(),
    text: text('text').notNull(),
    createdAt: tstz('created_at').notNull(),
    doneAt: tstz('done_at'),
    removedAt: tstz('removed_at'),
  },
  (t) => [uniqueIndex('planner_todos_key_uq').on(t.userId, t.clientKey)],
);

/** AC-videos-01: the video staff attach to one curriculum item; the item then completes by the `watch` rule. */
export const itemVideos = academy.table(
  'item_videos',
  {
    itemSlug: text('item_slug').primaryKey(),
    videoSlug: text('video_slug').notNull(),
    reason: text('reason').notNull(),
    setBy: uuid('set_by').notNull(),
    setAt: tstz('set_at').notNull(),
  },
  (t) => [index('item_videos_video_idx').on(t.videoSlug)],
);

/** AC-videos-01: one caption track per video and language (WebVTT text), in the order staff listed them. */
export const videoTracks = academy.table(
  'video_tracks',
  {
    videoSlug: text('video_slug').notNull(),
    language: text('language').notNull(),
    label: text('label').notNull(),
    vtt: text('vtt').notNull(),
    position: integer('position').notNull(),
    reason: text('reason').notNull(),
    setBy: uuid('set_by').notNull(),
    setAt: tstz('set_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.videoSlug, t.language] })],
);

/** AC-progress-02: one weekly goal per learner. */
export const learningGoals = academy.table('learning_goals', {
  userId: uuid('user_id').primaryKey(),
  itemsPerWeek: integer('items_per_week').notNull(),
  reminder: boolean('reminder').notNull(),
  setAt: tstz('set_at').notNull(),
});

/** AC-course-structure-01: a course staff create; the slug is fixed, details change by revision. `price` is a catalogue figure, not a balance. */
export const courses = academy.table(
  'courses',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    slug: text('slug').notNull(),
    title: text('title').notNull(),
    summary: text('summary'),
    thumbnailUrl: text('thumbnail_url'),
    pricing: text('pricing').notNull(),
    price: amount('price'),
    priceAsset: text('price_asset'),
    state: text('state').notNull().default('draft'),
    revision: integer('revision').notNull().default(1),
    createdBy: uuid('created_by').notNull(),
    createdAt: tstz('created_at').notNull(),
    updatedAt: tstz('updated_at').notNull(),
  },
  (t) => [uniqueIndex('courses_slug_uq').on(t.slug), index('courses_state_idx').on(t.state, t.createdAt.desc())],
);

/** AC-course-structure-01: every create, edit and lifecycle move of a course, one row per revision, with who and why. */
export const courseEvents = academy.table(
  'course_events',
  {
    courseId: uuid('course_id')
      .notNull()
      .references(() => courses.id),
    revision: integer('revision').notNull(),
    kind: text('kind').notNull(),
    fromState: text('from_state'),
    toState: text('to_state').notNull(),
    actor: uuid('actor').notNull(),
    reason: text('reason'),
    at: tstz('at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.courseId, t.revision] })],
);

/** AC-course-structure-02: a course's sections, in order. */
export const courseSections = academy.table(
  'course_sections',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    courseId: uuid('course_id')
      .notNull()
      .references(() => courses.id),
    position: integer('position').notNull(),
    title: text('title').notNull(),
  },
  (t) => [uniqueIndex('course_sections_position_uq').on(t.courseId, t.position)],
);

/** AC-course-structure-02: the typed items of one section, in order. Only a `link` has a url. */
export const courseItems = academy.table(
  'course_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    courseId: uuid('course_id')
      .notNull()
      .references(() => courses.id),
    sectionId: uuid('section_id')
      .notNull()
      .references(() => courseSections.id, { onDelete: 'cascade' }),
    position: integer('position').notNull(),
    kind: text('kind').notNull(),
    title: text('title').notNull(),
    indent: integer('indent').notNull().default(0),
    url: text('url'),
    /** The lesson revision learners see (AC-course-structure-03); only an explicit publish moves it. */
    liveRevision: integer('live_revision'),
  },
  (t) => [uniqueIndex('course_items_position_uq').on(t.sectionId, t.position), index('course_items_course_idx').on(t.courseId)],
);

/** AC-course-structure-03: every save of an item's lesson, as ordered blocks. Keyed `lesson:<item>:<revision>`. */
export const lessonRevisions = academy.table(
  'lesson_revisions',
  {
    itemId: uuid('item_id')
      .notNull()
      .references(() => courseItems.id, { onDelete: 'cascade' }),
    revision: integer('revision').notNull(),
    source: text('source').notNull(),
    fromRevision: integer('from_revision'),
    fromItemId: uuid('from_item_id'),
    blocks: jsonb('blocks').notNull(),
    actor: uuid('actor').notNull(),
    at: tstz('at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.itemId, t.revision] })],
);

export const schema = {
  courses,
  courseEvents,
  courseSections,
  courseItems,
  lessonRevisions,
  plannerTodos,
  learningGoals,
  itemVideos,
  videoTracks,
  rooms,
  roomInvites,
  sessions,
  sessionAttendees,
  ambassadors,
  tournamentSeasons,
  tournamentStandings,
  tournamentFreezeSnapshots,
  residencyApplications,
  certEnrollments,
  certItemCompletions,
  itemCompletionEvents,
  certGrants,
  assessmentAttempts,
  quizzes,
  quizAttempts,
  certHolderNameRequests,
  itemPrerequisites,
  itemWindows,
  itemExtensions,
  featuredItems,
  courseStarts,
  learningState,
  learningActiveDays,
  learningTouches,
  videoProgress,
  videoProgressRequests,
  residencyCohorts,
};
