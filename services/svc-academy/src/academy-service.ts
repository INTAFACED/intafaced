import type { Sql } from 'postgres';
import { transaction } from '@intafaced/db';
import { formatAmount, parseAmount, type Amount } from '@intafaced/ledger-client';
import { AcademyError } from './errors.js';
import { isPaperOpsEnabled, paperOpsDisabledMessage, paperOpsStatus, type PaperOpsStatus } from './paper/ops-gate.js';
import { assertPaperNeverReadableAsRealMoney } from './paper/real-money-ban.js';
import { assertCallerCannotLiePaperFlag, type PaperMarketFlagPort } from './paper/market-flag-verify.js';
import { recordPaperCertItemProgress, type PaperCertProgressView } from './paper/cert-progress-hook.js';
import { isDrillComplete, type DrillRun, type PaperMarketRef } from './paper/workbook-loop.js';
import { emptyScene, parseScene } from './spatial/scene.js';
import { decideHostSceneWrite, sceneFingerprint } from './spatial/edit-policy.js';
import {
  assertFreezeReason,
  badgeOf,
  AmbassadorProgrammeError,
  type AmbassadorBadge,
  type AmbassadorRecord,
  type AmbassadorStatus,
} from './ambassadors/programme.js';
import { assertAmbassadorsListLimit } from './ambassadors/list-limit.js';
import {
  assertMyCertsListLimit,
  assertMyResidenciesListLimit,
  assertOpenResidenciesListLimit,
  assertRoomsListLimit,
  assertSeasonStandingsSqlLimit,
  assertSeasonsSqlListLimit,
  assertSessionsListLimit,
} from './sql-list-limit.js';
import {
  assertCohortSlug,
  assertStatement,
  ResidencyError,
  type ResidencyApplication,
  type ResidencyStatus,
} from './ambassadors/residency.js';
import { assertCertCatalog, certificateForPath, listCertCatalog } from './certs/catalog.js';
import { ASSESSMENT_CATALOG, type AssessmentDefinition } from './assessment/catalog.js';
import { AssessmentRepository, type AttemptRow, type VisibleAttemptRow } from './assessment/repository.js';
import { PlannerStore } from './learning/planner.js';
import { randomPublicId, isPublicId } from './certs/public-id.js';
import { ReleaseAccess } from './release/access.js';
import { FeaturedSlot } from './curriculum/featured.js';
import { CourseRecords } from './curriculum/courses.js';
import { LessonRecords } from './curriculum/lessons.js';
import { CourseMedia, type ReadBackFn } from './curriculum/media.js';
import { CourseAssignments, type PutObjectFn } from './curriculum/assignments.js';
import { CourseQuizzes } from './curriculum/course-quizzes.js';
import { CourseQuizTrail } from './curriculum/course-quiz-trail.js';
import { CourseRelease } from './curriculum/course-release.js';
import { CourseItemRules } from './curriculum/course-item-rules.js';
import { CourseGradebook } from './curriculum/course-gradebook.js';
import { GradeReports } from './curriculum/grade-reports.js';
import { PeerReviews, type GetObjectFn } from './curriculum/peer-review.js';
import { AssignmentGrading } from './curriculum/grading.js';
import { LearnHub } from './curriculum/learn-hub.js';
import { CoursePreview } from './curriculum/course-preview.js';
import { CourseLearners } from './curriculum/course-learners.js';
import type { VideoStorageConfig } from './video/storage.js';
import { CourseStarts } from './curriculum/course-start.js';
import { publicCourse } from './curriculum/public-catalogue.js';
import { accessGrantView, assertTrackOpen, courseEnrolmentView, myCourseView, publishedCourse } from './curriculum/course-enrolment.js';
import type {
  AcademyAccessGrant,
  AcademyCourseEnrolment,
  AcademyCompletionRule,
  AcademyCourseOutline,
  AcademyEnrolmentTrack,
  AcademyMyCourse,
  AcademyQuiz,
  AcademyProgressPage,
  AcademyQuizAttempt,
  AcademyQuizReview,
  AcademySetQuizInput,
  AcademyUndoCompletion,
  AcademyCourseListInput,
  AcademyCreateCourseInput,
  AcademySetCourseStateInput,
  AcademySaveOutlineInput,
  AcademySaveLessonInput,
  AcademyRevertLessonInput,
  AcademyPublishLessonInput,
  AcademyDuplicateItemInput,
  AcademySaveAssignmentInput,
  AcademySaveReviewStepsInput,
  AcademyGradeSubmissionInput,
  AcademyMarkFeedbackReadInput,
  AcademyOpenGradingInput,
  AcademyBulkGradeInput,
  AcademySubmitPeerReviewInput,
  AcademySubmitAssignmentInput,
  AcademyUploadAssignmentFileInput,
  AcademyWithdrawAssignmentInput,
  AcademyImportLessonInput,
  AcademyAssistantDraftInput,
  AcademyDecideDraftInput,
  AcademyMediaIntentInput,
  AcademyWithdrawLessonInput,
  AcademyCreateTopicInput,
  AcademySetCourseTopicsInput,
  AcademySetItemCaptionsInput,
  AcademyUpdateCourseInput,
  AcademyCertIssue,
  AcademyCertIssueRule,
  AcademyCertRevocation,
  AcademySetCertIssueRuleInput,
  AcademyProgramme,
  AcademyProgrammeCourseState,
  AcademyProgrammeRecord,
  AcademySaveProgrammeInput,
} from '@intafaced/contracts';
import { academyProgrammeCertId } from '@intafaced/contracts';
import { CertIssueRules, issueDueAt } from './certs/issue-rules.js';
import { ProgrammeRecords } from './curriculum/programme-records.js';
import { CourseDiscussion } from './curriculum/discussion.js';
import { CourseMessages } from './curriculum/course-messages.js';
import { normaliseHolderName } from './certs/holder-name.js';
import { PROGRAMME_SLUGS, type ProgrammeSlug } from './curriculum/programmes.js';
import {
  alreadyGrantedAfterInsert,
  CertError,
  certIdempotencyKey,
  decideGrant,
  assessmentRequirementSlug,
  decideItemComplete,
  progressReport,
  type CertDefinition,
  type CertGrantRecord,
  type EnrollmentRecord,
  type ItemCompletionRecord,
  type ProgressReport,
} from './certs/progress.js';
import {
  certXpPlaneStatus,
  NullCertXpPublisher,
  type CertXpEmitResult,
  type CertXpPlaneStatus,
  type CertXpPublisher,
} from './certs/xp-publish.js';
import {
  assertNoCertPerkMoneyAttachment,
  certPerkPlaneStatus,
  resolveCertPerkOutcome,
  type CertPerkOutcome,
  type CertPerkPlaneStatus,
} from './certs/perk-plane.js';
import { getCurriculumItem, hasCurriculumSlug, listCurriculum, type CurriculumPath } from './curriculum/catalog.js';
import { curriculumBodyForLocale, curriculumI18nStrategyLine } from './curriculum/i18n-strategy.js';
import { type ProgrammeDefinition } from './curriculum/programmes.js';
import { getVideoSpineItem, listVideoSpine, type VideoSpineEntry } from './video/catalog.js';
import { VideoTracks, type VideoTrack } from './video/tracks.js';
import { AcademyCustomerStore } from './learning/customer-store.js';
import {
  assertMayWriteScore,
  assertScore,
  assertSeasonSlug,
  rankStandings,
  TournamentError,
  type RankedStanding,
  type SeasonRecord,
  type SeasonStatus,
  type StandingRecord,
} from './tournaments/ladder.js';
import { assertScoreWindowOpen } from './tournaments/season-calendar.js';
import { freezeSeasonWithSnapshot, transitionSeason } from './tournaments/season-lifecycle.js';
import { assertNoPrizeAttachment } from './tournaments/prize-refuse.js';
import { validateBulkScoreWrite, type ScorePatch } from './tournaments/bulk-score.js';
import type { FreezeStandingsSnapshot } from './tournaments/season-lifecycle.js';
import { decideSeat, inviteIsLive, needsStakeCheck, type RoomAccessKind } from './access/room-access.js';
import { assertPublishedMaxRoomCapacity } from './access/max-room-capacity.js';
import { mayHost, type HostRightsSource } from './host-rights.js';
import type { StakeSource } from './stake-source.js';
import { isConstructed, type StreamCredential, type StreamProvider } from './stream/provider.js';
import { withAcademySpan } from './tracing.js';

/**
 * ACADEMY LOBBIES (§8.3, §XIII "live session lobbies, capacity tiers").
 *
 * Rooms with capacity tiers, sessions inside them, and who is sitting in one
 * right now. §8.3 names the tiers and this service implements exactly those
 * three — `free`, `staked`, `invite` — in access/room-access.ts, which holds
 * the whole admission rule as one pure function.
 *
 * ── What is deliberately NOT here ───────────────────────────────────────────
 *
 * Curriculum READ is a separate pure module (`curriculum/catalog.ts`) wired on
 * the router — not on this class. Progress, certifications and ambassador pay
 * remain absent on purpose:
 *
 *   · FULL DERIV//DESK library (20 playbooks + 3 workbooks) is residual —
 *     proprietary content is not in this monorepo; the thin spine is platform-
 *     native so the list + content path is real rather than empty.
 *   · CERTIFICATIONS track progress, publish XP (`certs/xp-publish.ts`), then
 *     surface real identity perks or refuse invent perk money (`certs/perk-plane.ts`).
 *     svc-identity remains the only writer to `rank_state` / perk SoT (§4.1) —
 *     academy never maps cert → perk and never invents perk money.
 *   · AMBASSADOR PAY and lobby subscriptions MOVE VALUE. They need ledger
 *     recipes that do not exist, and a half-built pay path is worse than an
 *     absent one.
 *
 * NO VALUE MOVES HERE. `academy` is `custodial: false`, this process holds no
 * ledger client and no LEDGER_URL, and the only money-shaped number it touches
 * is a room's stake THRESHOLD — compared against svc-token's answer, never
 * stored. It is an `Amount` (scaled bigint) in memory and a decimal string on
 * the wire, like every other amount in the OS.
 */

export type RoomKind = 'general' | 'futures' | 'options' | 'meme_war_room' | 'forex' | 'defi_lab' | 'merchant_clinic';
export type SessionStatus = 'scheduled' | 'live' | 'ended' | 'cancelled';
export type AttendeeRole = 'host' | 'speaker' | 'attendee';

export interface RoomRecord {
  id: string;
  slug: string;
  name: string;
  kind: RoomKind;
  access: RoomAccessKind;
  minStake: Amount;
  capacity: number;
  hostId: string;
}

export interface SessionRecord {
  id: string;
  roomId: string;
  title: string;
  hostId: string;
  status: SessionStatus;
  startsAt: Date;
  endsAt: Date | null;
  streamProvider: string | null;
  streamRoom: string | null;
  scene: Record<string, unknown>;
  /**
   * Optimistic concurrency token for host scene writes.
   * Always present on read so clients can supply expectedFingerprint without re-hashing.
   */
  sceneFingerprint: string;
}

interface RoomRow {
  id: string;
  slug: string;
  name: string;
  kind: RoomKind;
  access: RoomAccessKind;
  min_stake: string;
  capacity: number;
  host_id: string;
}

interface SessionRow {
  id: string;
  room_id: string;
  title: string;
  host_id: string;
  status: SessionStatus;
  starts_at: Date;
  ends_at: Date | null;
  stream_provider: string | null;
  stream_room: string | null;
  scene: Record<string, unknown>;
}

const toRoom = (row: RoomRow): RoomRecord => ({
  id: row.id,
  slug: row.slug,
  name: row.name,
  kind: row.kind,
  access: row.access,
  minStake: parseAmount(row.min_stake),
  capacity: row.capacity,
  hostId: row.host_id,
});

const toSession = (row: SessionRow): SessionRecord => {
  // Unreadable DB default `{}` → empty v1 fingerprint (same SoT as updateScene).
  const parsed = parseScene(row.scene);
  const scene = parsed.ok ? parsed.scene : emptyScene();
  return {
    id: row.id,
    roomId: row.room_id,
    title: row.title,
    hostId: row.host_id,
    status: row.status,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    streamProvider: row.stream_provider,
    streamRoom: row.stream_room,
    scene: row.scene,
    sceneFingerprint: sceneFingerprint(scene),
  };
};

export interface AcademyServiceOptions {
  /**
   * Owner-published operational ceiling. Undefined = unpublished —
   * createRoom refuses `academy.room_capacity_unset`. Never invent 5000.
   */
  maxRoomCapacity?: number;
  /** AC-progress-02: owner-set to-do items per learner (`ACADEMY_PLANNER_TODO_LIMIT`). Undefined: unset, adding refuses. */
  plannerTodoLimit?: number;
  /** AC-course-structure-02: owner-set sections and items per course outline. Undefined: unset, an outline save refuses. */
  outlineMaxSections?: number;
  outlineMaxItems?: number;
  /** AC-course-structure-03: the owner's lesson import size limit in bytes. Unset, an import refuses `academy.import_limit_unset`. */
  lessonImportMaxBytes?: number;
  /** AC-videos-02: our own object store for course files, and the owner's upload limits. Unset limits refuse `academy.upload_limits_unset`. */
  mediaStorage?: VideoStorageConfig | null;
  uploadMaxBytes?: number;
  uploadVideoTypes?: readonly string[];
  uploadHandoutTypes?: readonly string[];
  mediaReadBack?: ReadBackFn;
  /** Test seam: how a learner's file reaches the object store. Production PUTs over HTTP. */
  assignmentPut?: PutObjectFn;
  /** Test seam: how a reviewed file is read back from the object store. Production GETs over HTTP. */
  assignmentGet?: GetObjectFn;
  /** AC-assignments-02: seconds a grader holds a hand-in (`ACADEMY_GRADER_LEASE_SECONDS`). Unset, grading refuses. */
  graderLeaseSeconds?: number;
  /** AC-assignments-04: learner rows one grade report holds (`ACADEMY_GRADE_REPORT_ROWS`). Unset, a report refuses. */
  gradeReportRows?: number;
  /** AC-articles-01: how many topics a list shows (`ACADEMY_TOPICS_LIST_LIMIT`). Unset, the list refuses. */
  topicsListLimit?: number;
  /** Stage-1 tournament ladder kill-switch (`ACADEMY_TOURNAMENT_ENABLED`). */
  tournamentEnabled?: boolean;
  /** Stage-3 paper-trading ops kill-switch (`ACADEMY_PAPER_TRADING_ENABLED`). */
  paperTradingEnabled?: boolean;
  /**
   * Trade public-markets paper flag port. Undefined when TRADE_URL is unset —
   * paper drills then refuse `academy.paper_flag_unverified` rather than
   * trusting `paper: true` on the wire.
   */
  paperMarketFlagPort?: PaperMarketFlagPort;
  /** Test seam. Production uses the empty-prerequisite catalog. */
  programmeCatalog?: readonly ProgrammeDefinition[];
  /** Test seam. Production uses the spine, whose media fields are null until set. */
  videoSpine?: readonly VideoSpineEntry[];
  /** AC-videos-01: owner-set seconds of stored position that count as watched. Undefined: unset, a watch item cannot complete. */
  videoWatchThresholdSeconds?: number;
  /** AC-videos-01: owner-set seconds between position saves while playing. Undefined: saves on pause and on leaving only. */
  videoSaveEverySeconds?: number;
  /** Test seam. Production is the owner catalog, which is foundations-v1 only. */
  certCatalog?: readonly CertDefinition[];
  /**
   * AC-certificates-02: owner-set seconds between issue sweeps (`ACADEMY_CERT_ISSUE_SWEEP_SECONDS`). Undefined: no sweep
   * runs, so a delayed issue rule refuses `academy.cert_sweep_unset`.
   */
  certIssueSweepSeconds?: number;
  /** AC-programmes-01: owner-set courses per learning programme (`ACADEMY_PROGRAMME_MAX_COURSES`). Undefined: a save with courses refuses. */
  programmeMaxCourses?: number;
  /** AC-rooms-01: owner-set characters per discussion post (`ACADEMY_POST_MAX_CHARS`). Undefined: posting refuses. */
  postMaxChars?: number;
  /** AC-rooms-01: owner-set bytes per post image (`ACADEMY_POST_IMAGE_MAX_BYTES`). Undefined: a post with an image refuses. */
  postImageMaxBytes?: number;
  /** AC-rooms-04: owner-set characters per course-team message (`ACADEMY_MESSAGE_MAX_CHARS`). Undefined: sending refuses. */
  messageMaxChars?: number;
  /** Test seam. Production is empty: no owner-published scored assessment. */
  assessmentCatalog?: readonly AssessmentDefinition[];
}

const MANUAL_ISSUE: AcademyCertIssue = { mode: 'manual', delayMinutes: null, issuesAt: null };

/** AC-programmes-01: a programme's certificate is a grant under `programme:<slug>` (`academyProgrammeCertId`). */
const PROGRAMME_CERT_PREFIX = academyProgrammeCertId('');
type ProgrammeGrant = { publicId: string; grantedAt: Date; status: 'valid' | 'revoked' };
type LearnerCourses = {
  completed: ReadonlySet<string>;
  enrolled: ReadonlySet<string>;
  started: ReadonlySet<string>;
  grants: ReadonlyMap<string, ProgrammeGrant>;
};
/** A course is complete once every one of its items is recorded. */
const courseComplete = (course: CurriculumPath, completed: ReadonlySet<string>) => {
  const items = listCurriculum({ path: course });
  return items.length > 0 && items.every((row) => completed.has(row.slug));
};

/** Rows one pass of the issue sweep reads: a batch size of an internal loop that drains until nothing is due, not a list a person reads. */
const CERT_ISSUE_SWEEP_BATCH = 100;

const REVOCATION_COLUMNS = ['public_id', 'cert_id', 'proposed_by', 'approved_by', 'revoked_by', 'reason', 'revoked_at'] as const;
type RevocationRow = {
  public_id: string;
  cert_id: string;
  proposed_by: string;
  approved_by: string;
  revoked_by: string;
  reason: string;
  revoked_at: Date;
};
const revocationRecord = (r: RevocationRow): AcademyCertRevocation => ({
  publicId: r.public_id,
  certId: r.cert_id,
  proposedBy: r.proposed_by,
  approvedBy: r.approved_by,
  revokedBy: r.revoked_by,
  reason: r.reason,
  revokedAt: r.revoked_at,
});

export class AcademyService {
  private readonly customer: AcademyCustomerStore;
  private readonly assessments: AssessmentRepository;
  private readonly release: ReleaseAccess;
  private readonly featured: FeaturedSlot;
  private readonly courseRecords: CourseRecords;
  private readonly lessonRecords: LessonRecords;
  private readonly courseMedia: CourseMedia;
  private readonly courseAssignments: CourseAssignments;
  private readonly peerReviews: PeerReviews;
  private readonly grading: AssignmentGrading;
  private readonly learnHub: LearnHub;
  private readonly coursePreview: CoursePreview;
  private readonly courseLearners: CourseLearners;
  private readonly courseStarts: CourseStarts;
  private readonly plannerStore: PlannerStore;
  private readonly videoTracks: VideoTracks;
  private readonly issueRules: CertIssueRules;
  private readonly programmeRecords: ProgrammeRecords;
  /** AC-rooms-01: course discussions. The router calls it directly; it decides nothing about any other record. */
  readonly discussion: CourseDiscussion;
  /** AC-rooms-04: conversations with course teams. The router calls it directly. */
  readonly courseMessages: CourseMessages;
  /** AC-quizzes-01: quizzes on the items of a course staff made. The router calls it directly (AC-quizzes-02: its own attempts). */
  readonly courseQuizzes: CourseQuizzes;
  /** AC-quizzes-04: key fixes, rescores and score overrides after grading. */
  readonly courseQuizTrail: CourseQuizTrail;
  /** AC-release-access-01: scheduled release and pacing on a course staff made. The router calls it directly. */
  readonly courseRelease: CourseRelease;
  readonly courseItemRules: CourseItemRules;
  readonly courseGradebook: CourseGradebook;
  readonly gradeReports: GradeReports;

  constructor(
    private readonly sql: Sql,
    private readonly stakes: StakeSource,
    private readonly hostRights: HostRightsSource,
    private readonly stream: StreamProvider,
    private readonly options: AcademyServiceOptions,
    /**
     * Stage-2 cert XP emit (TRK-academy.certs). Defaults to the null publisher
     * so every existing construction of this service keeps working and keeps
     * being honest: no bus, no award, and `grantCert` says which.
     */
    private readonly certXp: CertXpPublisher = new NullCertXpPublisher(),
  ) {
    this.customer = new AcademyCustomerStore(sql);
    this.release = new ReleaseAccess(sql);
    this.featured = new FeaturedSlot(sql);
    this.courseRecords = new CourseRecords(sql, {
      maxSections: this.options.outlineMaxSections ?? null,
      maxItems: this.options.outlineMaxItems ?? null,
    });
    this.lessonRecords = new LessonRecords(sql, this.courseRecords, this.options.lessonImportMaxBytes ?? null);
    this.learnHub = new LearnHub(sql, this.options.topicsListLimit ?? null);
    this.coursePreview = new CoursePreview(sql);
    this.courseLearners = new CourseLearners(sql, this.coursePreview);
    this.courseMedia = new CourseMedia(
      sql,
      this.options.mediaStorage ?? null,
      {
        maxBytes: this.options.uploadMaxBytes ?? null,
        videoTypes: this.options.uploadVideoTypes ?? null,
        handoutTypes: this.options.uploadHandoutTypes ?? null,
      },
      this.options.mediaReadBack,
    );
    this.courseAssignments = new CourseAssignments(
      sql,
      this.options.mediaStorage ?? null,
      { maxBytes: this.options.uploadMaxBytes ?? null, types: this.options.uploadHandoutTypes ?? null },
      this.options.assignmentPut,
    );
    this.grading = new AssignmentGrading(sql, this.courseAssignments, this.options.graderLeaseSeconds ?? null);
    this.peerReviews = new PeerReviews(sql, this.courseAssignments, this.options.mediaStorage ?? null, this.options.assignmentGet);
    this.courseStarts = new CourseStarts(sql);
    this.plannerStore = new PlannerStore(sql, this.options.plannerTodoLimit ?? null);
    this.videoTracks = new VideoTracks(sql);
    this.issueRules = new CertIssueRules(sql);
    this.programmeRecords = new ProgrammeRecords(sql, this.options.programmeMaxCourses);
    this.courseMessages = new CourseMessages(sql, this.options.messageMaxChars ?? null);
    this.courseQuizzes = new CourseQuizzes(sql);
    this.courseQuizTrail = new CourseQuizTrail(sql);
    this.courseRelease = new CourseRelease(sql);
    this.courseItemRules = new CourseItemRules(sql);
    this.courseGradebook = new CourseGradebook(sql);
    this.gradeReports = new GradeReports(sql, this.courseGradebook, this.options.gradeReportRows ?? null);
    this.discussion = new CourseDiscussion(sql, {
      postMaxChars: this.options.postMaxChars ?? null,
      imageMaxBytes: this.options.postImageMaxBytes ?? null,
    });
    const assessments = this.options.assessmentCatalog ?? ASSESSMENT_CATALOG;
    this.assessments = new AssessmentRepository(sql, assessments);
    if (this.options.certCatalog) {
      assertCertCatalog(this.options.certCatalog, {
        lesson: hasCurriculumSlug,
        assessment: (slug) => assessments.some((row) => row.slug === slug),
      });
    }
  }

  private certs(): readonly CertDefinition[] {
    return this.options.certCatalog ?? listCertCatalog();
  }

  private certDefinition(id: string): CertDefinition | null {
    return this.certs().find((row) => row.id === id) ?? null;
  }

  private refuseUnpublishedPath(pathSlug: string): void {
    const path = pathSlug.trim().toLowerCase();
    if ((PROGRAMME_SLUGS as readonly string[]).includes(path) && !certificateForPath(path, this.certs())) {
      throw new AcademyError(`academy.certificate_unpublished path=${path}`, 'academy.certificate_unpublished');
    }
  }

  // ── Rooms ──────────────────────────────────────────────────────────────────

  /**
   * Open a room.
   *
   * The §4.1 host-rights check comes FIRST, before any validation of what the
   * room would look like. Someone who may not host does not need to be told
   * their capacity is too high — and checking the perk before writing anything
   * means an svc-identity outage costs a retry rather than a cleanup
   * (host-rights.ts on why it fails closed).
   */
  async createRoom(input: {
    hostId: string;
    slug: string;
    name: string;
    kind: RoomKind;
    access: RoomAccessKind;
    minStake?: Amount;
    capacity: number;
  }): Promise<RoomRecord> {
    await this.assertMayHost(input.hostId);

    const maxRoomCapacity = assertPublishedMaxRoomCapacity(this.options.maxRoomCapacity);
    if (input.capacity > maxRoomCapacity) {
      throw new AcademyError(`A lobby cannot seat more than ${maxRoomCapacity} — presence fans out over the gateway`, 'academy.room_full');
    }
    // The database asserts this too (`rooms_stake_gate_ck`). Asserting it here
    // as well means the caller gets a sentence rather than a constraint name.
    const minStake = input.access === 'staked' ? (input.minStake ?? 0n) : 0n;
    if (input.access === 'staked' && minStake <= 0n) {
      throw new AcademyError('A staked lobby needs a stake threshold above zero', 'academy.stake_required');
    }

    const rows = await this.sql<RoomRow[]>`
      INSERT INTO academy.rooms (slug, name, kind, access, min_stake, capacity, host_id)
      VALUES (${input.slug}, ${input.name}, ${input.kind}, ${input.access},
              ${formatAmount(minStake)}::numeric, ${input.capacity}, ${input.hostId})
      RETURNING id, slug, name, kind, access, min_stake, capacity, host_id
    `;
    return toRoom(rows[0]!);
  }

  async room(roomId: string): Promise<RoomRecord> {
    const rows = await this.sql<RoomRow[]>`
      SELECT id, slug, name, kind, access, min_stake, capacity, host_id FROM academy.rooms WHERE id = ${roomId}
    `;
    const row = rows[0];
    if (!row) throw new AcademyError(`Room ${roomId} not found`, 'academy.room_not_found');
    return toRoom(row);
  }

  async listRooms(filter: { kind?: RoomKind; limit?: number } = {}): Promise<RoomRecord[]> {
    const limit = assertRoomsListLimit(filter.limit);
    const rows = filter.kind
      ? await this.sql<RoomRow[]>`
          SELECT id, slug, name, kind, access, min_stake, capacity, host_id
            FROM academy.rooms WHERE kind = ${filter.kind} ORDER BY name ASC
            LIMIT ${limit}
        `
      : await this.sql<RoomRow[]>`
          SELECT id, slug, name, kind, access, min_stake, capacity, host_id FROM academy.rooms ORDER BY kind ASC, name ASC
          LIMIT ${limit}
        `;
    return rows.map(toRoom);
  }

  /** Invite someone into an `invite` room. The host's call, and only theirs. */
  async invite(input: { roomId: string; hostId: string; userId: string; expiresAt?: Date | null }): Promise<void> {
    const room = await this.room(input.roomId);
    this.assertHost(room.hostId, input.hostId, 'room');

    await this.sql`
      INSERT INTO academy.room_invites (room_id, user_id, invited_by, expires_at)
      VALUES (${input.roomId}, ${input.userId}, ${input.hostId}, ${input.expiresAt ?? null})
      ON CONFLICT (room_id, user_id) DO UPDATE SET expires_at = EXCLUDED.expires_at
    `;
  }

  // ── Sessions ───────────────────────────────────────────────────────────────

  async scheduleSession(input: { roomId: string; hostId: string; title: string; startsAt: Date }): Promise<SessionRecord> {
    const room = await this.room(input.roomId);
    this.assertHost(room.hostId, input.hostId, 'room');

    const rows = await this.sql<SessionRow[]>`
      INSERT INTO academy.sessions (room_id, title, host_id, starts_at)
      VALUES (${input.roomId}, ${input.title}, ${input.hostId}, ${input.startsAt})
      RETURNING *
    `;
    return toSession(rows[0]!);
  }

  async session(sessionId: string): Promise<SessionRecord> {
    const rows = await this.sql<SessionRow[]>`SELECT * FROM academy.sessions WHERE id = ${sessionId}`;
    const row = rows[0];
    if (!row) throw new AcademyError(`Session ${sessionId} not found`, 'academy.session_not_found');
    return toSession(row);
  }

  async listSessions(filter: { roomId?: string; status?: SessionStatus; limit?: number } = {}): Promise<SessionRecord[]> {
    const limit = assertSessionsListLimit(filter.limit);
    const rows = await this.sql<SessionRow[]>`
      SELECT * FROM academy.sessions
       WHERE (${filter.roomId ?? null}::uuid IS NULL OR room_id = ${filter.roomId ?? null})
         AND (${filter.status ?? null}::text IS NULL OR status::text = ${filter.status ?? null})
       ORDER BY starts_at ASC
       LIMIT ${limit}
    `;
    return rows.map(toSession);
  }

  /**
   * Open the doors.
   *
   * The stream room is opened here rather than at schedule time, so an SFU room
   * exists only while a session is actually running. When no provider is
   * configured the session still goes live as text, presence and the scene
   * canvas — `stream_room` stays null and `streamCredential` says why.
   */
  async startSession(input: { sessionId: string; hostId: string }): Promise<SessionRecord> {
    const session = await this.session(input.sessionId);
    this.assertHost(session.hostId, input.hostId, 'session');
    if (session.status !== 'scheduled') {
      throw new AcademyError(`A ${session.status} session cannot be started`, 'academy.session_not_live');
    }

    return withAcademySpan(
      'academy.session.start',
      { stage: 'session', operation: 'start', sessionId: session.id, roomId: session.roomId, streamProvider: this.stream.id },
      async () => {
        const streamRoom = isConstructed(this.stream) ? await this.stream.openRoom(session.id) : null;

        const rows = await this.sql<SessionRow[]>`
          UPDATE academy.sessions
             SET status = 'live', stream_provider = ${streamRoom ? this.stream.id : null},
                 stream_room = ${streamRoom}, updated_at = now()
           WHERE id = ${session.id} AND status = 'scheduled'
          RETURNING *
        `;
        const started = rows[0];
        if (!started) {
          // This call lost the conditional update, so it did not start the session.
          // Keep a same-name room only while its stored session is still live.
          const current = await this.session(session.id);
          if (streamRoom && (current.status !== 'live' || streamRoom !== current.streamRoom)) {
            await this.stream.closeRoom(streamRoom);
          }
          throw new AcademyError(`A ${current.status} session cannot be started`, 'academy.session_not_live');
        }
        return toSession(started);
      },
    );
  }

  /**
   * End it, and empty the room.
   *
   * Every live attendee is marked as having left in the same transaction that
   * ends the session. Leaving them open would make the next session in the same
   * room inherit an occupancy that nobody is actually occupying.
   */
  async endSession(input: { sessionId: string; hostId: string; now?: Date }): Promise<SessionRecord> {
    const now = input.now ?? new Date();
    const session = await this.session(input.sessionId);
    this.assertHost(session.hostId, input.hostId, 'session');

    await transaction(this.sql, async (tx) => {
      // Publish the terminal state before the external delete. A delayed start
      // that recreates the same-name room must see ended and compensate it.
      const ended = await tx<SessionRow[]>`
        UPDATE academy.sessions SET status = 'ended', ends_at = ${now}, updated_at = now()
         WHERE id = ${session.id} AND status IN ('scheduled', 'live')
        RETURNING *
      `;
      if (ended[0]) {
        await tx`
          UPDATE academy.session_attendees SET left_at = ${now} WHERE session_id = ${session.id} AND left_at IS NULL
        `;
      }
    });

    // Keep the stored room and original ended timestamp as the retry identity.
    // Failed or lost delete acknowledgements cannot reopen the session; an
    // authorized end retry re-drives cleanup without changing terminal state.
    const terminal = await this.session(session.id);
    if (terminal.streamRoom) await this.stream.closeRoom(terminal.streamRoom);
    return terminal;
  }

  /** Live attendees. A COUNT, never a maintained counter. */
  async occupancy(sessionId: string, tx: Sql = this.sql): Promise<number> {
    const rows = await tx<Array<{ count: string }>>`
      SELECT COUNT(*)::text AS count FROM academy.session_attendees WHERE session_id = ${sessionId} AND left_at IS NULL
    `;
    return Number(rows[0]?.count ?? '0');
  }

  /**
   * Take a seat.
   *
   * ── Why the seat is claimed under a lock ────────────────────────────────────
   *
   * Capacity is only a capacity if two people racing for the last seat cannot
   * both get it. The insert runs inside a transaction that locks the session
   * row first, so the occupancy count and the insert cannot interleave — which
   * is the whole reason `read committed` is correct here (see
   * packages/db/src/connection.ts on when it is, and when it is not).
   *
   * The GATE is evaluated before the lock is taken, deliberately: a stake
   * lookup is a network call, and holding the busiest row in a live lobby
   * across one would serialise every join behind svc-token's latency.
   */
  async join(input: { sessionId: string; userId: string; now?: Date }): Promise<{ role: AttendeeRole }> {
    const now = input.now ?? new Date();
    const session = await this.session(input.sessionId);
    if (session.status !== 'live') throw new AcademyError('That session is not live', 'academy.session_not_live');

    const room = await this.room(session.roomId);
    const isHost = room.hostId === input.userId || session.hostId === input.userId;

    // Only a staked room asks svc-token, so an outage there does not close the
    // free and invite lobbies too.
    const stake = needsStakeCheck(room, isHost) ? await this.stakes.stakeOf(input.userId) : 0n;

    const invited = room.access === 'invite' && !isHost ? inviteIsLive(await this.liveInvite(room.id, input.userId), now) : false;

    return withAcademySpan(
      'academy.session.join',
      { stage: 'lobby', operation: 'join', sessionId: session.id, roomId: room.id, userId: input.userId, capacity: room.capacity },
      async (span) => {
        const role: AttendeeRole = isHost ? 'host' : 'attendee';

        const decision = await transaction(
          this.sql,
          async (tx) => {
            const locked = await tx<Array<{ status: SessionRecord['status'] }>>`
              SELECT status FROM academy.sessions WHERE id = ${session.id} FOR UPDATE
            `;
            // The external gate may finish after end/cancel removed this seat.
            // Recheck under the existing lock before occupancy or attendee writes.
            if (locked[0]?.status !== 'live') {
              throw new AcademyError('That session is not live', 'academy.session_not_live');
            }
            const occupancy = await this.occupancy(session.id, tx);

            const seat = decideSeat(
              { access: room.access, minStake: room.minStake, capacity: room.capacity },
              { occupancy, stake, invited, isHost },
            );
            if (!seat.allowed) return { seat, occupancy };

            await tx`
              INSERT INTO academy.session_attendees (session_id, user_id, role, joined_at)
              VALUES (${session.id}, ${input.userId}, ${role}, ${now})
              ON CONFLICT (session_id, user_id) DO UPDATE SET left_at = NULL, role = EXCLUDED.role
            `;

            if (room.access === 'invite' && !isHost) {
              await tx`
                UPDATE academy.room_invites SET used_at = COALESCE(used_at, ${now})
                 WHERE room_id = ${room.id} AND user_id = ${input.userId}
              `;
            }

            return { seat, occupancy };
          },
          { isolation: 'read committed' },
        );

        span.setAttribute('intafaced.occupancy', decision.occupancy);
        // A refusal is invisible from the outside — nobody files a ticket for a
        // room they could not get into. This attribute is the only place
        // "how many bounced off the stake gate" is a number.
        span.setAttribute('intafaced.decision', decision.seat.allowed ? 'allowed' : decision.seat.code);

        if (!decision.seat.allowed) throw new AcademyError(decision.seat.reason, decision.seat.code);
        return { role };
      },
    );
  }

  async leave(input: { sessionId: string; userId: string; now?: Date }): Promise<void> {
    const now = input.now ?? new Date();
    await this.sql`
      UPDATE academy.session_attendees SET left_at = ${now}
       WHERE session_id = ${input.sessionId} AND user_id = ${input.userId} AND left_at IS NULL
    `;
  }

  /**
   * A join credential for the stream.
   *
   * Separate from `join` on purpose. A seat is granted by this service; a
   * stream credential is granted by the SFU, and when there is no SFU the
   * lobby still runs. Folding the two together would make every text lobby fail
   * to admit anyone the moment streaming was unconfigured.
   *
   * Refuses anyone not actually seated: a credential is a key to a live room.
   */
  async streamCredential(input: { sessionId: string; userId: string }): Promise<StreamCredential> {
    const session = await this.session(input.sessionId);
    if (session.status !== 'live' || !session.streamRoom) {
      throw new AcademyError('That session is not carrying a stream', 'academy.stream_unavailable');
    }

    const rows = await this.sql<Array<{ role: AttendeeRole }>>`
      SELECT role FROM academy.session_attendees
       WHERE session_id = ${session.id} AND user_id = ${input.userId} AND left_at IS NULL
    `;
    const role = rows[0]?.role;
    if (!role) throw new AcademyError('Take a seat in the lobby first', 'academy.session_not_live');

    return this.stream.credential({ sessionId: session.id, streamRoom: session.streamRoom, userId: input.userId, role });
  }

  /**
   * The 2D spatial layer's state (§8.3).
   *
   * Kept serializable and kept whole: the host writes the scene, everyone else
   * reads it. Merging per-attendee edits would need a conflict model this does
   * not have, and half a merge is a room that renders differently for different
   * people.
   */
  async updateScene(input: {
    sessionId: string;
    hostId: string;
    scene: Record<string, unknown>;
    /** Optional optimistic concurrency token — must match server scene fingerprint. */
    expectedFingerprint?: string;
  }): Promise<SessionRecord & { sceneFingerprint: string }> {
    const session = await this.session(input.sessionId);
    this.assertHost(session.hostId, input.hostId, 'session');

    // DB default was historically `{}`, which is not Scene v1. Treat unreadable
    // current state as empty v1 so reconnect/edit policy still has a SoT.
    const currentParsed = parseScene(session.scene);
    const current = currentParsed.ok ? currentParsed.scene : emptyScene();

    const decision = decideHostSceneWrite({
      current,
      next: input.scene,
      ...(input.expectedFingerprint !== undefined ? { expectedFingerprint: input.expectedFingerprint } : {}),
    });
    if (!decision.ok) {
      if (decision.reason === 'conflict') {
        throw new AcademyError(decision.message, 'academy.scene_conflict');
      }
      if (decision.reason === 'presence_collision') {
        throw new AcademyError(decision.message, 'academy.scene_presence_collision');
      }
      throw new AcademyError(decision.message, 'academy.scene_invalid');
    }

    const rows = await this.sql<SessionRow[]>`
      UPDATE academy.sessions SET scene = ${this.sql.json(decision.scene as never)}, updated_at = now() WHERE id = ${session.id} RETURNING *
    `;
    return { ...toSession(rows[0]!), sceneFingerprint: decision.fingerprint };
  }

  // ── Tournament ladders Stage-1 (NO PRIZE MONEY) ────────────────────────────

  private assertTournamentEnabled(): void {
    if (this.options.tournamentEnabled === false) {
      throw new AcademyError('Tournament ladder is disabled', 'academy.tournament_disabled');
    }
  }

  /** Stage-3 — ops kill paper drills without touching live trade. */
  assertPaperTradingEnabled(): void {
    if (!isPaperOpsEnabled(this.options.paperTradingEnabled)) {
      throw new AcademyError(paperOpsDisabledMessage(), 'academy.paper_trading_disabled');
    }
  }

  /**
   * D26-P1-C4 — claimed `paper: true` must match trade's public listing.
   * Unset port (no TRADE_URL) refuses by name rather than trusting the caller.
   */
  async assertCallerPaperFlagVerified(market: PaperMarketRef | null): Promise<void> {
    await assertCallerCannotLiePaperFlag(this.options.paperMarketFlagPort, market);
  }

  /** Stage-3 — ops status snapshot (live trade always unaffected). */
  paperOpsStatus(): PaperOpsStatus {
    const status = paperOpsStatus(this.options.paperTradingEnabled);
    assertPaperNeverReadableAsRealMoney(status);
    return status;
  }

  /**
   * After a sealed paper drill: record cert *item* completion when the workbook
   * is bound to a catalog cert. Unbound → `progress: 'unbound'`. Never grantCert,
   * never invent XP, never perk-map, never ledger.
   */
  async recordPaperDrillCertProgress(input: { userId: string; run: DrillRun }): Promise<PaperCertProgressView> {
    this.assertPaperTradingEnabled();
    const certs = listCertCatalog();
    const drillComplete = isDrillComplete(input.run);
    let existing: ItemCompletionRecord | null = null;
    if (drillComplete) {
      const slug = input.run.workbookSlug.trim();
      const existingRows = await this.sql<Array<{ user_id: string; item_slug: string; completed_at: Date }>>`
        SELECT user_id, item_slug, completed_at FROM academy.cert_item_completions
         WHERE user_id = ${input.userId} AND item_slug = ${slug}
      `;
      existing = existingRows[0]
        ? {
            userId: existingRows[0].user_id,
            itemSlug: existingRows[0].item_slug,
            completedAt: existingRows[0].completed_at,
          }
        : null;
    }

    const pending: { record: ItemCompletionRecord | null } = { record: null };
    const view = recordPaperCertItemProgress({
      userId: input.userId,
      run: input.run,
      certs,
      existing,
      persist: (record) => {
        pending.record = record;
      },
    });
    if (view.progress === 'recorded' && pending.record) {
      const row = await this.markCurriculumComplete({
        userId: input.userId,
        itemSlug: view.itemSlug,
      });
      const recorded: PaperCertProgressView = {
        ...view,
        completedAt: row.completedAt,
      };
      assertPaperNeverReadableAsRealMoney(recorded);
      return recorded;
    }
    assertPaperNeverReadableAsRealMoney(view);
    return view;
  }

  private mapTournamentErr(err: unknown): never {
    if (err instanceof TournamentError) {
      throw new AcademyError(err.message, err.code);
    }
    throw err;
  }

  private toSeason(row: {
    id: string;
    slug: string;
    title: string;
    status: SeasonStatus;
    rules_summary: string;
    starts_at: Date;
    ends_at: Date | null;
  }): SeasonRecord {
    return {
      id: row.id,
      slug: row.slug,
      title: row.title,
      status: row.status,
      rulesSummary: row.rules_summary,
      startsAt: row.starts_at,
      endsAt: row.ends_at,
    };
  }

  async createSeason(input: {
    slug: string;
    title: string;
    rulesSummary: string;
    startsAt: Date;
    endsAt?: Date | null;
  }): Promise<SeasonRecord> {
    this.assertTournamentEnabled();
    let slug: string;
    try {
      slug = assertSeasonSlug(input.slug);
    } catch (e) {
      this.mapTournamentErr(e);
    }
    const title = input.title.trim();
    const rules = input.rulesSummary.trim();
    if (title.length < 3 || title.length > 160) {
      throw new AcademyError('Season title 3–160 characters', 'academy.season_invalid');
    }
    if (rules.length < 8 || rules.length > 4000) {
      throw new AcademyError('Rules summary 8–4000 characters', 'academy.season_invalid');
    }
    // Refuse prize-shaped fields if a caller ever spreads invent payload into season shape.
    try {
      assertNoPrizeAttachment({
        slug,
        title,
        rulesSummary: rules,
        startsAt: input.startsAt,
        endsAt: input.endsAt ?? null,
        status: 'scheduled',
      });
    } catch (e) {
      this.mapTournamentErr(e);
    }
    const rows = await this.sql<
      Array<{
        id: string;
        slug: string;
        title: string;
        status: SeasonStatus;
        rules_summary: string;
        starts_at: Date;
        ends_at: Date | null;
      }>
    >`
      INSERT INTO academy.tournament_seasons (slug, title, status, rules_summary, starts_at, ends_at)
      VALUES (${slug}, ${title}, 'scheduled', ${rules}, ${input.startsAt}, ${input.endsAt ?? null})
      RETURNING id, slug, title, status, rules_summary, starts_at, ends_at
    `;
    return this.toSeason(rows[0]!);
  }

  async season(seasonId: string): Promise<SeasonRecord> {
    this.assertTournamentEnabled();
    const rows = await this.sql<
      Array<{
        id: string;
        slug: string;
        title: string;
        status: SeasonStatus;
        rules_summary: string;
        starts_at: Date;
        ends_at: Date | null;
      }>
    >`SELECT id, slug, title, status, rules_summary, starts_at, ends_at FROM academy.tournament_seasons WHERE id = ${seasonId}`;
    if (!rows[0]) throw new AcademyError(`Season ${seasonId} not found`, 'academy.season_not_found');
    return this.toSeason(rows[0]);
  }

  async listSeasons(filter: { status?: SeasonStatus; limit?: number } = {}): Promise<SeasonRecord[]> {
    this.assertTournamentEnabled();
    const limit = assertSeasonsSqlListLimit(filter.limit);
    const rows = filter.status
      ? await this.sql<
          Array<{
            id: string;
            slug: string;
            title: string;
            status: SeasonStatus;
            rules_summary: string;
            starts_at: Date;
            ends_at: Date | null;
          }>
        >`
          SELECT id, slug, title, status, rules_summary, starts_at, ends_at
            FROM academy.tournament_seasons WHERE status = ${filter.status}
            ORDER BY starts_at DESC
            LIMIT ${limit}
        `
      : await this.sql<
          Array<{
            id: string;
            slug: string;
            title: string;
            status: SeasonStatus;
            rules_summary: string;
            starts_at: Date;
            ends_at: Date | null;
          }>
        >`
          SELECT id, slug, title, status, rules_summary, starts_at, ends_at
            FROM academy.tournament_seasons ORDER BY starts_at DESC
            LIMIT ${limit}
        `;
    return rows.map((r) => this.toSeason(r));
  }

  async setSeasonStatus(input: { seasonId: string; status: SeasonStatus }): Promise<SeasonRecord> {
    this.assertTournamentEnabled();
    const current = await this.season(input.seasonId);
    // Pure lifecycle owns legal edges — raw SQL used to allow scheduled→frozen etc.
    try {
      assertNoPrizeAttachment(current);
      transitionSeason(current, input.status);
    } catch (e) {
      this.mapTournamentErr(e);
    }

    // live→frozen: snapshot + status flip MUST be one transaction.
    // Split writes left a crash hole: snapshot exists while status stays live
    // and scores still write. This freeze stores the standings computed now,
    // replacing that earlier row, and then marks the season frozen.
    if (current.status === 'live' && input.status === 'frozen') {
      return transaction(
        this.sql,
        async (tx) => {
          const locked = await tx<
            Array<{
              id: string;
              slug: string;
              title: string;
              status: SeasonStatus;
              rules_summary: string;
              starts_at: Date;
              ends_at: Date | null;
            }>
          >`
            SELECT id, slug, title, status, rules_summary, starts_at, ends_at
              FROM academy.tournament_seasons
             WHERE id = ${input.seasonId}
             FOR UPDATE
          `;
          if (!locked[0]) throw new AcademyError(`Season ${input.seasonId} not found`, 'academy.season_not_found');
          const lockedSeason = this.toSeason(locked[0]);
          try {
            assertNoPrizeAttachment(lockedSeason);
            transitionSeason(lockedSeason, 'frozen');
          } catch (e) {
            this.mapTournamentErr(e);
          }
          if (lockedSeason.status !== 'live') {
            throw new AcademyError(
              `Season ${input.seasonId} is ${lockedSeason.status} — cannot freeze (concurrent transition)`,
              'academy.season_invalid',
            );
          }

          const standingRows = await tx<Array<{ season_id: string; user_id: string; score: number; updated_at: Date }>>`
            SELECT season_id, user_id, score, updated_at FROM academy.tournament_standings
             WHERE season_id = ${input.seasonId}
          `;
          let snapshot: FreezeStandingsSnapshot;
          try {
            const frozen = freezeSeasonWithSnapshot(
              lockedSeason,
              standingRows.map((r) => ({
                seasonId: r.season_id,
                userId: r.user_id,
                score: r.score,
                updatedAt: r.updated_at,
              })),
            );
            snapshot = frozen.snapshot;
          } catch (e) {
            this.mapTournamentErr(e);
          }
          const standingsJson = snapshot.standings.map((s) => ({
            rank: s.rank,
            userId: s.userId,
            score: s.score,
            updatedAt: s.updatedAt.toISOString(),
          }));
          await tx`
            INSERT INTO academy.tournament_freeze_snapshots (season_id, frozen_at, standings)
            VALUES (${input.seasonId}, ${snapshot.frozenAt}, ${tx.json(standingsJson as never)})
            ON CONFLICT (season_id) DO UPDATE
              SET frozen_at = EXCLUDED.frozen_at,
                  standings = EXCLUDED.standings
          `;
          const rows = await tx<
            Array<{
              id: string;
              slug: string;
              title: string;
              status: SeasonStatus;
              rules_summary: string;
              starts_at: Date;
              ends_at: Date | null;
            }>
          >`
            UPDATE academy.tournament_seasons
               SET status = 'frozen', updated_at = now()
             WHERE id = ${input.seasonId}
               AND status = 'live'
             RETURNING id, slug, title, status, rules_summary, starts_at, ends_at
          `;
          if (!rows[0]) {
            throw new AcademyError(`Season ${input.seasonId} left live during freeze (concurrent transition)`, 'academy.season_invalid');
          }
          return this.toSeason(rows[0]);
        },
        { isolation: 'read committed' },
      );
    }

    const rows = await this.sql<
      Array<{
        id: string;
        slug: string;
        title: string;
        status: SeasonStatus;
        rules_summary: string;
        starts_at: Date;
        ends_at: Date | null;
      }>
    >`
      UPDATE academy.tournament_seasons
         SET status = ${input.status}, updated_at = now()
       WHERE id = ${input.seasonId}
         AND status = ${current.status}
       RETURNING id, slug, title, status, rules_summary, starts_at, ends_at
    `;
    const row = rows[0];
    if (!row) {
      throw new AcademyError(`Season ${input.seasonId} is no longer ${current.status}`, 'academy.season_invalid');
    }
    return this.toSeason(row);
  }

  /** Read durable freeze audit snapshot (null when season never frozen on this path). */
  async freezeSnapshot(seasonId: string): Promise<{
    seasonId: string;
    frozenAt: Date;
    standings: { rank: number; userId: string; score: number; updatedAt: string }[];
  } | null> {
    this.assertTournamentEnabled();
    await this.season(seasonId);
    const rows = await this.sql<Array<{ season_id: string; frozen_at: Date; standings: unknown }>>`
      SELECT season_id, frozen_at, standings FROM academy.tournament_freeze_snapshots
       WHERE season_id = ${seasonId}
    `;
    const r = rows[0];
    if (!r) return null;
    const standings = r.standings as { rank: number; userId: string; score: number; updatedAt: string }[];
    return {
      seasonId: r.season_id,
      frozenAt: r.frozen_at,
      standings: [...standings],
    };
  }

  async setStanding(input: { seasonId: string; userId: string; score: number; now?: Date }): Promise<StandingRecord> {
    this.assertTournamentEnabled();
    const season = await this.season(input.seasonId);
    const now = input.now ?? new Date();
    try {
      // Live status alone is not enough — calendar window must still be open.
      assertScoreWindowOpen(season, now);
      assertMayWriteScore(season.status);
      assertScore(input.score);
    } catch (e) {
      this.mapTournamentErr(e);
    }
    // The read above is not the write gate. Freeze holds this same row from the
    // snapshot read through the status flip, so the upsert waits, then refuses
    // unless the stored status is still live.
    return transaction(
      this.sql,
      async (tx) => {
        const locked = await tx<
          Array<{
            id: string;
            slug: string;
            title: string;
            status: SeasonStatus;
            rules_summary: string;
            starts_at: Date;
            ends_at: Date | null;
          }>
        >`
          SELECT id, slug, title, status, rules_summary, starts_at, ends_at
            FROM academy.tournament_seasons
           WHERE id = ${input.seasonId}
           FOR UPDATE
        `;
        if (!locked[0]) throw new AcademyError(`Season ${input.seasonId} not found`, 'academy.season_not_found');
        const lockedSeason = this.toSeason(locked[0]);
        try {
          assertScoreWindowOpen(lockedSeason, now);
          assertMayWriteScore(lockedSeason.status);
        } catch (e) {
          this.mapTournamentErr(e);
        }
        const rows = await tx<Array<{ season_id: string; user_id: string; score: number; updated_at: Date }>>`
          INSERT INTO academy.tournament_standings (season_id, user_id, score, updated_at)
          VALUES (${input.seasonId}, ${input.userId}, ${input.score}, now())
          ON CONFLICT (season_id, user_id) DO UPDATE SET score = EXCLUDED.score, updated_at = now()
          RETURNING season_id, user_id, score, updated_at
        `;
        const r = rows[0]!;
        return { seasonId: r.season_id, userId: r.user_id, score: r.score, updatedAt: r.updated_at };
      },
      { isolation: 'read committed' },
    );
  }

  /**
   * Operator bulk score write — Stage-2 L3 residual on the wire.
   * Pure `validateBulkScoreWrite` owns refuse rules (live-only, no empty, no
   * dup user, score bounds). Accepted patches upsert in ONE transaction under
   * a season-row lock so freeze cannot interleave a partial board, and a
   * mid-batch crash cannot leave half the patch set durable.
   * No prize fields, no invent scores.
   */
  async bulkSetStandings(input: {
    seasonId: string;
    patches: readonly ScorePatch[];
  }): Promise<
    { ok: true; accepted: number; standings: StandingRecord[] } | { ok: false; reason: string; message: string; badUserId?: string }
  > {
    this.assertTournamentEnabled();
    const season = await this.season(input.seasonId);
    const gate = validateBulkScoreWrite({
      seasonStatus: season.status,
      seasonId: input.seasonId,
      patches: input.patches,
      // Same calendar gate as setStanding — refuse bulk before any partial upserts.
      startsAt: season.startsAt,
      endsAt: season.endsAt,
    });
    if (gate.status === 'refuse') {
      return {
        ok: false,
        reason: gate.reason,
        message: gate.message,
        ...(gate.badUserId !== undefined ? { badUserId: gate.badUserId } : {}),
      };
    }

    const now = new Date();
    return transaction(
      this.sql,
      async (tx) => {
        // Total order vs freeze: lock season before re-check + multi-row upsert.
        const locked = await tx<
          Array<{
            id: string;
            slug: string;
            title: string;
            status: SeasonStatus;
            rules_summary: string;
            starts_at: Date;
            ends_at: Date | null;
          }>
        >`
          SELECT id, slug, title, status, rules_summary, starts_at, ends_at
            FROM academy.tournament_seasons
           WHERE id = ${input.seasonId}
           FOR UPDATE
        `;
        if (!locked[0]) throw new AcademyError(`Season ${input.seasonId} not found`, 'academy.season_not_found');
        const lockedSeason = this.toSeason(locked[0]);
        const reGate = validateBulkScoreWrite({
          seasonStatus: lockedSeason.status,
          seasonId: input.seasonId,
          patches: input.patches,
          startsAt: lockedSeason.startsAt,
          endsAt: lockedSeason.endsAt,
          now,
        });
        if (reGate.status === 'refuse') {
          return {
            ok: false as const,
            reason: reGate.reason,
            message: reGate.message,
            ...(reGate.badUserId !== undefined ? { badUserId: reGate.badUserId } : {}),
          };
        }

        const standings: StandingRecord[] = [];
        for (const p of reGate.patches) {
          const rows = await tx<Array<{ season_id: string; user_id: string; score: number; updated_at: Date }>>`
            INSERT INTO academy.tournament_standings (season_id, user_id, score, updated_at)
            VALUES (${input.seasonId}, ${p.userId}, ${p.score}, now())
            ON CONFLICT (season_id, user_id) DO UPDATE SET score = EXCLUDED.score, updated_at = now()
            RETURNING season_id, user_id, score, updated_at
          `;
          const r = rows[0]!;
          standings.push({ seasonId: r.season_id, userId: r.user_id, score: r.score, updatedAt: r.updated_at });
        }
        return { ok: true as const, accepted: standings.length, standings };
      },
      { isolation: 'read committed' },
    );
  }

  async standings(seasonId: string, filter: { limit?: number } = {}): Promise<RankedStanding[]> {
    this.assertTournamentEnabled();
    const limit = assertSeasonStandingsSqlLimit(filter.limit);
    await this.season(seasonId);
    const rows = await this.sql<Array<{ season_id: string; user_id: string; score: number; updated_at: Date }>>`
      SELECT season_id, user_id, score, updated_at FROM academy.tournament_standings
       WHERE season_id = ${seasonId}
       ORDER BY score DESC, updated_at ASC
       LIMIT ${limit}
    `;
    return rankStandings(
      rows.map((r) => ({
        seasonId: r.season_id,
        userId: r.user_id,
        score: r.score,
        updatedAt: r.updated_at,
      })),
    );
  }

  // ── Ambassador programme (Stage-1 status only — NO PAY) ───────────────────

  private toAmbassador(row: {
    user_id: string;
    status: AmbassadorStatus;
    appointed_by: string;
    appointed_at: Date;
    frozen_at: Date | null;
    frozen_by: string | null;
    freeze_reason: string | null;
  }): AmbassadorRecord {
    return {
      userId: row.user_id,
      status: row.status,
      appointedBy: row.appointed_by,
      appointedAt: row.appointed_at,
      frozenAt: row.frozen_at,
      frozenBy: row.frozen_by,
      freezeReason: row.freeze_reason,
    };
  }

  private mapAmbassadorErr(err: unknown): never {
    if (err instanceof AmbassadorProgrammeError) {
      throw new AcademyError(err.message, err.code);
    }
    throw err;
  }

  async ambassadorOf(userId: string): Promise<AmbassadorRecord | null> {
    const rows = await this.sql<
      Array<{
        user_id: string;
        status: AmbassadorStatus;
        appointed_by: string;
        appointed_at: Date;
        frozen_at: Date | null;
        frozen_by: string | null;
        freeze_reason: string | null;
      }>
    >`
      SELECT user_id, status, appointed_by, appointed_at, frozen_at, frozen_by, freeze_reason
        FROM academy.ambassadors WHERE user_id = ${userId}
    `;
    return rows[0] ? this.toAmbassador(rows[0]) : null;
  }

  async ambassadorBadge(userId: string): Promise<AmbassadorBadge> {
    return badgeOf(userId, await this.ambassadorOf(userId));
  }

  async listAmbassadors(filter: { status?: AmbassadorStatus; limit?: number } = {}): Promise<AmbassadorRecord[]> {
    const limit = assertAmbassadorsListLimit(filter.limit);
    const rows = filter.status
      ? await this.sql<
          Array<{
            user_id: string;
            status: AmbassadorStatus;
            appointed_by: string;
            appointed_at: Date;
            frozen_at: Date | null;
            frozen_by: string | null;
            freeze_reason: string | null;
          }>
        >`
          SELECT user_id, status, appointed_by, appointed_at, frozen_at, frozen_by, freeze_reason
            FROM academy.ambassadors WHERE status = ${filter.status}
            ORDER BY appointed_at DESC
            LIMIT ${limit}
        `
      : await this.sql<
          Array<{
            user_id: string;
            status: AmbassadorStatus;
            appointed_by: string;
            appointed_at: Date;
            frozen_at: Date | null;
            frozen_by: string | null;
            freeze_reason: string | null;
          }>
        >`
          SELECT user_id, status, appointed_by, appointed_at, frozen_at, frozen_by, freeze_reason
            FROM academy.ambassadors ORDER BY status ASC, appointed_at DESC
            LIMIT ${limit}
        `;
    return rows.map((r) => this.toAmbassador(r));
  }

  /**
   * Operator appoint. New row only, or refuse.
   * Already-active is refused so double-click does not rewrite appointed_by silently.
   * Frozen is refused so freeze audit is not erased — use unfreezeAmbassador.
   */
  async appointAmbassador(input: { userId: string; operatorId: string }): Promise<AmbassadorRecord> {
    const existing = await this.ambassadorOf(input.userId);
    if (existing?.status === 'active') {
      throw new AcademyError(`User ${input.userId} is already an active ambassador`, 'academy.ambassador_already_active');
    }
    if (existing?.status === 'frozen') {
      throw new AcademyError(
        `Ambassador ${input.userId} is frozen — unfreeze to restore the badge (re-appoint would erase freeze audit)`,
        'academy.ambassador_already_frozen',
      );
    }

    const rows = await this.sql<
      Array<{
        user_id: string;
        status: AmbassadorStatus;
        appointed_by: string;
        appointed_at: Date;
        frozen_at: Date | null;
        frozen_by: string | null;
        freeze_reason: string | null;
      }>
    >`
      INSERT INTO academy.ambassadors (user_id, status, appointed_by, appointed_at, frozen_at, frozen_by, freeze_reason, updated_at)
      VALUES (${input.userId}, 'active', ${input.operatorId}, now(), NULL, NULL, NULL, now())
      ON CONFLICT (user_id) DO UPDATE SET
        status = 'active',
        appointed_by = EXCLUDED.appointed_by,
        appointed_at = now(),
        frozen_at = NULL,
        frozen_by = NULL,
        freeze_reason = NULL,
        updated_at = now()
      WHERE academy.ambassadors.status IS DISTINCT FROM 'frozen'
        AND academy.ambassadors.status IS DISTINCT FROM 'active'
      RETURNING user_id, status, appointed_by, appointed_at, frozen_at, frozen_by, freeze_reason
    `;
    if (!rows[0]) {
      // Concurrent freeze/active won the race — re-read and refuse honestly.
      const again = await this.ambassadorOf(input.userId);
      if (again?.status === 'frozen') {
        throw new AcademyError(
          `Ambassador ${input.userId} is frozen — unfreeze to restore the badge (re-appoint would erase freeze audit)`,
          'academy.ambassador_already_frozen',
        );
      }
      if (again?.status === 'active') {
        throw new AcademyError(`User ${input.userId} is already an active ambassador`, 'academy.ambassador_already_active');
      }
      throw new AcademyError(`Could not appoint ambassador ${input.userId}`, 'academy.ambassador_invalid');
    }
    return this.toAmbassador(rows[0]!);
  }

  async freezeAmbassador(input: { userId: string; operatorId: string; reason: string }): Promise<AmbassadorRecord> {
    let reason: string;
    try {
      reason = assertFreezeReason(input.reason);
    } catch (err) {
      this.mapAmbassadorErr(err);
    }

    const existing = await this.ambassadorOf(input.userId);
    if (!existing) {
      throw new AcademyError(`No ambassador programme row for ${input.userId}`, 'academy.ambassador_not_found');
    }
    if (existing.status === 'frozen') {
      throw new AcademyError(`Ambassador ${input.userId} is already frozen`, 'academy.ambassador_already_frozen');
    }

    const rows = await this.sql<
      Array<{
        user_id: string;
        status: AmbassadorStatus;
        appointed_by: string;
        appointed_at: Date;
        frozen_at: Date | null;
        frozen_by: string | null;
        freeze_reason: string | null;
      }>
    >`
      UPDATE academy.ambassadors
         SET status = 'frozen',
             frozen_at = now(),
             frozen_by = ${input.operatorId},
             freeze_reason = ${reason},
             updated_at = now()
       WHERE user_id = ${input.userId}
         AND status = 'active'
       RETURNING user_id, status, appointed_by, appointed_at, frozen_at, frozen_by, freeze_reason
    `;
    if (rows.length === 0) {
      // Concurrent freeze won the race — do not overwrite freeze_reason/by.
      throw new AcademyError(`Ambassador ${input.userId} is already frozen`, 'academy.ambassador_already_frozen');
    }
    return this.toAmbassador(rows[0]!);
  }

  async unfreezeAmbassador(input: { userId: string; operatorId: string }): Promise<AmbassadorRecord> {
    const existing = await this.ambassadorOf(input.userId);
    if (!existing) {
      throw new AcademyError(`Ambassador ${input.userId} not found`, 'academy.ambassador_not_found');
    }
    if (existing.status !== 'frozen') {
      throw new AcademyError(`Ambassador ${input.userId} is not frozen`, 'academy.ambassador_invalid');
    }
    const rows = await this.sql<
      Array<{
        user_id: string;
        status: AmbassadorStatus;
        appointed_by: string;
        appointed_at: Date;
        frozen_at: Date | null;
        frozen_by: string | null;
        freeze_reason: string | null;
      }>
    >`
      UPDATE academy.ambassadors
         SET status = 'active',
             frozen_at = NULL,
             frozen_by = NULL,
             freeze_reason = NULL,
             updated_at = now()
       WHERE user_id = ${input.userId} AND status = 'frozen'
       RETURNING user_id, status, appointed_by, appointed_at, frozen_at, frozen_by, freeze_reason
    `;
    if (!rows[0]) {
      throw new AcademyError(`Ambassador ${input.userId} not found`, 'academy.ambassador_not_found');
    }
    // operatorId is audit context for future event emission — required for admin write symmetry.
    void input.operatorId;
    return this.toAmbassador(rows[0]);
  }

  // ── Residency applications (Stage-1 durable — NO PAY) ─────────────────────
  //
  // Persistence is the whole point: MemoryResidencyDesk is for unit tests only.
  // Routes write here so an apply survives restart.

  private toResidency(row: {
    id: string;
    user_id: string;
    cohort_slug: string;
    statement: string;
    status: ResidencyStatus;
    applied_at: Date;
    decided_at: Date | null;
    decided_by: string | null;
    decision_note: string | null;
  }): ResidencyApplication {
    return {
      id: row.id,
      userId: row.user_id,
      cohortSlug: row.cohort_slug,
      statement: row.statement,
      status: row.status,
      appliedAt: row.applied_at,
      decidedAt: row.decided_at,
      decidedBy: row.decided_by,
      decisionNote: row.decision_note,
    };
  }

  private mapResidencyErr(err: unknown): never {
    if (err instanceof ResidencyError) {
      throw new AcademyError(err.message, err.code);
    }
    throw err;
  }

  async applyResidency(input: { userId: string; cohortSlug: string; statement: string }): Promise<ResidencyApplication> {
    let cohortSlug: string;
    let statement: string;
    try {
      cohortSlug = assertCohortSlug(input.cohortSlug);
      statement = assertStatement(input.statement);
    } catch (err) {
      this.mapResidencyErr(err);
    }

    try {
      const rows = await this.sql<
        Array<{
          id: string;
          user_id: string;
          cohort_slug: string;
          statement: string;
          status: ResidencyStatus;
          applied_at: Date;
          decided_at: Date | null;
          decided_by: string | null;
          decision_note: string | null;
        }>
      >`
        INSERT INTO academy.residency_applications
          (user_id, cohort_slug, statement, status, applied_at, decided_at, decided_by, decision_note, updated_at)
        VALUES
          (${input.userId}, ${cohortSlug}, ${statement}, 'applied', now(), NULL, NULL, NULL, now())
        RETURNING id, user_id, cohort_slug, statement, status, applied_at, decided_at, decided_by, decision_note
      `;
      return this.toResidency(rows[0]!);
    } catch (err) {
      const code = (err as { code?: string } | null)?.code;
      if (code === '23505') {
        throw new AcademyError('Open application already exists for this cohort', 'academy.residency_already_open');
      }
      throw err;
    }
  }

  async withdrawResidency(input: { id: string; userId: string }): Promise<ResidencyApplication> {
    const rows = await this.sql<
      Array<{
        id: string;
        user_id: string;
        cohort_slug: string;
        statement: string;
        status: ResidencyStatus;
        applied_at: Date;
        decided_at: Date | null;
        decided_by: string | null;
        decision_note: string | null;
      }>
    >`
      UPDATE academy.residency_applications
         SET status = 'withdrawn',
             decided_at = now(),
             decided_by = ${input.userId},
             decision_note = 'withdrawn by applicant',
             updated_at = now()
       WHERE id = ${input.id}
         AND user_id = ${input.userId}
         AND status = 'applied'
       RETURNING id, user_id, cohort_slug, statement, status, applied_at, decided_at, decided_by, decision_note
    `;
    if (!rows[0]) {
      const existing = await this.sql<Array<{ status: ResidencyStatus; user_id: string }>>`
        SELECT status, user_id FROM academy.residency_applications WHERE id = ${input.id}
      `;
      if (!existing[0] || existing[0].user_id !== input.userId) {
        throw new AcademyError('Application not found', 'academy.residency_not_found');
      }
      throw new AcademyError(`Application is ${existing[0].status}`, 'academy.residency_not_pending');
    }
    return this.toResidency(rows[0]);
  }

  async decideResidency(input: {
    id: string;
    operatorId: string;
    decision: 'accepted' | 'rejected';
    note?: string;
  }): Promise<ResidencyApplication> {
    const note = (input.note ?? '').trim().slice(0, 500) || null;
    const rows = await this.sql<
      Array<{
        id: string;
        user_id: string;
        cohort_slug: string;
        statement: string;
        status: ResidencyStatus;
        applied_at: Date;
        decided_at: Date | null;
        decided_by: string | null;
        decision_note: string | null;
      }>
    >`
      UPDATE academy.residency_applications
         SET status = ${input.decision},
             decided_at = now(),
             decided_by = ${input.operatorId},
             decision_note = ${note},
             updated_at = now()
       WHERE id = ${input.id}
         AND status = 'applied'
       RETURNING id, user_id, cohort_slug, statement, status, applied_at, decided_at, decided_by, decision_note
    `;
    if (!rows[0]) {
      const existing = await this.sql<Array<{ status: ResidencyStatus }>>`
        SELECT status FROM academy.residency_applications WHERE id = ${input.id}
      `;
      if (!existing[0]) {
        throw new AcademyError('Application not found', 'academy.residency_not_found');
      }
      throw new AcademyError(`Application is ${existing[0].status}`, 'academy.residency_not_pending');
    }
    return this.toResidency(rows[0]);
  }

  async myResidencies(userId: string, requested?: number): Promise<ResidencyApplication[]> {
    const limit = assertMyResidenciesListLimit(requested);
    const rows = await this.sql<
      Array<{
        id: string;
        user_id: string;
        cohort_slug: string;
        statement: string;
        status: ResidencyStatus;
        applied_at: Date;
        decided_at: Date | null;
        decided_by: string | null;
        decision_note: string | null;
      }>
    >`
      SELECT id, user_id, cohort_slug, statement, status, applied_at, decided_at, decided_by, decision_note
        FROM academy.residency_applications
       WHERE user_id = ${userId}
       ORDER BY applied_at DESC
       LIMIT ${limit}
    `;
    return rows.map((r) => this.toResidency(r));
  }

  async listOpenResidencies(filter: { cohortSlug?: string; limit?: number } = {}): Promise<ResidencyApplication[]> {
    const limit = assertOpenResidenciesListLimit(filter.limit);
    const rows = filter.cohortSlug
      ? await this.sql<
          Array<{
            id: string;
            user_id: string;
            cohort_slug: string;
            statement: string;
            status: ResidencyStatus;
            applied_at: Date;
            decided_at: Date | null;
            decided_by: string | null;
            decision_note: string | null;
          }>
        >`
          SELECT id, user_id, cohort_slug, statement, status, applied_at, decided_at, decided_by, decision_note
            FROM academy.residency_applications
           WHERE status = 'applied' AND cohort_slug = ${filter.cohortSlug.trim().toLowerCase()}
           ORDER BY applied_at ASC
           LIMIT ${limit}
        `
      : await this.sql<
          Array<{
            id: string;
            user_id: string;
            cohort_slug: string;
            statement: string;
            status: ResidencyStatus;
            applied_at: Date;
            decided_at: Date | null;
            decided_by: string | null;
            decision_note: string | null;
          }>
        >`
          SELECT id, user_id, cohort_slug, statement, status, applied_at, decided_at, decided_by, decision_note
            FROM academy.residency_applications
           WHERE status = 'applied'
           ORDER BY applied_at ASC
           LIMIT ${limit}
        `;
    return rows.map((r) => this.toResidency(r));
  }

  // ── Certifications Stage-1 (progress + grants — NO XP / NO PAY) ───────────

  private mapCertErr(err: unknown): never {
    if (err instanceof CertError) {
      throw new AcademyError(err.message, err.code);
    }
    throw err;
  }

  listCertDefinitions(): CertDefinition[] {
    return [...this.certs()];
  }

  /** AC-certificates-01: each learning path's published certificate, or the refusal for a path with none. */
  certPaths(): Array<{ path: ProgrammeSlug; certId: string | null; refusal: 'academy.certificate_unpublished' | null }> {
    return PROGRAMME_SLUGS.map((path) => {
      const cert = certificateForPath(path, this.certs());
      return { path, certId: cert?.id ?? null, refusal: cert ? null : 'academy.certificate_unpublished' };
    });
  }

  async enrollCertPath(input: { userId: string; pathSlug: string }): Promise<EnrollmentRecord> {
    this.refuseUnpublishedPath(input.pathSlug);
    const row = await this.customer.enrollCertPath({
      userId: input.userId,
      pathSlug: input.pathSlug,
      ...(this.options.programmeCatalog ? { catalog: this.options.programmeCatalog } : {}),
    });
    return { userId: row.userId, pathSlug: row.pathSlug, enrolledAt: row.enrolledAt };
  }

  /** AC-enrolment-01: the terms of enrolling in a course and the caller's own active enrolment in it. */
  async courseEnrolment(input: { userId: string; slug: string }): Promise<AcademyCourseEnrolment> {
    const path = publishedCourse(input.slug);
    const [enrolments, startsAt] = await Promise.all([this.customer.myEnrollments(input.userId), this.courseStarts.startsAt(path)]);
    const active = enrolments.find((row) => row.pathSlug === path) ?? null;
    return courseEnrolmentView(path, active, startsAt);
  }

  /**
   * Enrol now on the free track. The certificate needs no published definition for this: the free track is the course
   * itself. A repeat while enrolled returns the same enrolment (one active row per learner and course); programme
   * prerequisites still apply.
   */
  async enrolCourse(input: { userId: string; slug: string; track: AcademyEnrolmentTrack }): Promise<AcademyCourseEnrolment> {
    const path = publishedCourse(input.slug);
    assertTrackOpen(input.track);
    const row = await this.customer.enrollCertPath({
      userId: input.userId,
      pathSlug: path,
      ...(this.options.programmeCatalog ? { catalog: this.options.programmeCatalog } : {}),
    });
    return courseEnrolmentView(path, row, await this.courseStarts.startsAt(path));
  }

  /** AC-catalogue-02: My learning, one row per course the caller is enrolled in and that is still published. */
  async myLearning(userId: string, now: Date = new Date()): Promise<AcademyMyCourse[]> {
    const enrolments = await this.publishedEnrolments(userId);
    if (enrolments.length === 0) return [];
    const [completed, state] = await Promise.all([this.completedSlugs(userId), this.customer.learningState(userId)]);
    return Promise.all(
      enrolments.map(async (row) => {
        const path = row.pathSlug as CurriculumPath;
        const startsAt = await this.courseStarts.startsAt(path);
        const releases = await this.courseReleases(userId, path, now, startsAt);
        const open = releases.filter(({ view }) => view.lock === null).map(({ row }) => row.slug);
        return myCourseView(path, row, completed, state.lastItemSlug, open, startsAt, now);
      }),
    );
  }

  /**
   * AC-course-structure-02: the outline of the course an item belongs to, with the caller's own release state per item.
   * Only titles, kinds and lock reasons: no body, and no staff name or reason from an extension.
   */
  async courseOutline(input: { userId: string; itemSlug: string; now?: Date }): Promise<AcademyCourseOutline> {
    const item = getCurriculumItem(input.itemSlug.trim());
    if (!item) throw new AcademyError('Unknown curriculum item', 'academy.curriculum_not_found');
    const path = item.path as CurriculumPath;
    const now = input.now ?? new Date();
    const releases = await this.courseReleases(input.userId, path, now, await this.courseStarts.startsAt(path));
    const slugs = releases.map(({ row }) => row.slug);
    const [completedAt, passed, quizzes, videos] = await Promise.all([
      this.completionTimes(input.userId, slugs),
      this.assessments.passedSlugs(input.userId, now),
      this.assessments.publishedSlugs(),
      this.videoTracks.itemVideos(slugs),
    ]);
    const watched = await this.watchedItems(input.userId, videos);
    const items = releases.map(({ row, view }) => {
      const opensLater = view.lock === 'window' && view.availableFrom !== null && view.availableFrom.getTime() > now.getTime();
      const rule = this.completionRule(row.slug, quizzes, videos);
      return {
        slug: row.slug,
        title: row.title,
        kind: row.kind,
        state: view.state,
        lock: view.lock,
        missing: [...view.missing],
        opensAt: opensLater ? view.availableFrom!.toISOString() : null,
        rule,
        ruleMet: this.completionRuleMet(row.slug, rule, passed, watched),
        completedAt: completedAt.get(row.slug)?.toISOString() ?? null,
      };
    });
    return { slug: path, items };
  }

  /**
   * The caller's release decision for every item of one course, at one `now`, so the outline, Start course and Continue
   * agree. A course is a curriculum path of a handful of items.
   */
  private async courseReleases(userId: string, path: CurriculumPath, now: Date, courseStartsAt: Date | null) {
    const rows = listCurriculum({ path });
    const views = await Promise.all(rows.map((row) => this.release.itemRelease({ userId, itemSlug: row.slug, now, courseStartsAt })));
    return rows.map((row, i) => ({ row, view: views[i]! }));
  }

  /**
   * AC-progress-02: the progress page. Per enrolled course, percent complete over every item the learner can see (every
   * published item: none is hidden from a learner today) with each item's completion; and the grades, best attempt per
   * quiz, pending while staff hide results, with per-type averages over released results only.
   */
  async progressPage(userId: string, now: Date = new Date()): Promise<AcademyProgressPage> {
    const [enrolments, allGrades, courseGrades] = await Promise.all([
      this.publishedEnrolments(userId),
      this.assessments.grades(userId, now),
      this.grading.courseGrades(userId),
    ]);
    // Attempts on quizzes in courses staff made, started before those quizzes had attempts of their own (AC-quizzes-01),
    // left score rows under their item id as slug. Course quiz grades belong to that course's gradebook (AC-assignments-04,
    // from course_quiz_attempts), not to the curriculum paths' grades here.
    const grades = allGrades.filter((row) => getCurriculumItem(row.slug) !== null);
    const paths = enrolments.map((row) => row.pathSlug as CurriculumPath);
    const times = await this.completionTimes(
      userId,
      paths.flatMap((path) => listCurriculum({ path }).map((item) => item.slug)),
    );
    const courses = paths.map((path) => {
      const items = listCurriculum({ path });
      const completed = items.filter((item) => times.has(item.slug)).length;
      return {
        slug: path,
        visible: items.length,
        completed,
        percent: tenths(completed, items.length),
        items: items.map((item) => ({
          slug: item.slug,
          title: item.title,
          kind: item.kind,
          completedAt: times.get(item.slug)?.toISOString() ?? null,
        })),
      };
    });
    const rows = grades.map((row) => {
      const title = getCurriculumItem(row.slug)!.title;
      return row.pending
        ? {
            pending: true as const,
            slug: row.slug,
            title,
            type: 'quiz' as const,
            attempts: row.attempts,
            hiddenUntil: row.hiddenUntil.toISOString(),
          }
        : {
            pending: false as const,
            slug: row.slug,
            title,
            type: 'quiz' as const,
            attempts: row.attempts,
            score: String(row.score),
            possible: String(row.possible),
            percent: tenths(row.score, row.possible),
            passed: row.passed,
          };
    });
    const released = grades.filter((row) => !row.pending);
    const averages =
      released.length === 0
        ? []
        : [
            {
              type: 'quiz' as const,
              count: released.length,
              percent: tenths(
                released.reduce((sum, row) => sum + row.score, 0),
                released.reduce((sum, row) => sum + row.possible, 0),
              ),
            },
          ];
    return { courses, grades: { rows, averages }, courseGrades };
  }

  planner(userId: string) {
    return this.plannerStore.read(userId);
  }

  addTodo(input: { userId: string; clientKey: string; text: string; now?: Date }) {
    return this.plannerStore.addTodo(input);
  }

  setTodoDone(input: { userId: string; todoId: string; done: boolean; now?: Date }) {
    return this.plannerStore.setTodoDone(input);
  }

  removeTodo(input: { userId: string; todoId: string; now?: Date }) {
    return this.plannerStore.removeTodo(input);
  }

  setGoal(input: { userId: string; itemsPerWeek: number; reminder: boolean; now?: Date }) {
    return this.plannerStore.setGoal(input);
  }

  sendGoalReminder(input: { userId: string }) {
    return this.plannerStore.sendGoalReminder(input);
  }

  /** AC-access-grants-01: the caller's access records, one per active enrolment. */
  async myAccessGrants(userId: string): Promise<AcademyAccessGrant[]> {
    return (await this.publishedEnrolments(userId)).map(accessGrantView);
  }

  /** Active enrolments in courses that are still published: My learning and the access records list the same set. */
  private async publishedEnrolments(userId: string) {
    return (await this.customer.myEnrollments(userId)).filter((row) => listCurriculum({ path: row.pathSlug as CurriculumPath }).length > 0);
  }

  myCompletions(input: { userId: string; limit: number | null | undefined; cursor?: string | null }) {
    return this.customer.myCompletions(input);
  }

  myEnrollments(userId: string) {
    return this.customer.myEnrollments(userId);
  }

  leaveCertPath(input: { userId: string; pathSlug: string; clientRequestId: string }) {
    return this.customer.leaveCertPath(input);
  }

  learningState(userId: string) {
    return this.customer.learningState(userId);
  }

  touchLesson(input: { userId: string; slug: string; secondsRead?: number | null; clientRequestId: string; now?: Date }) {
    return this.customer.touchLesson(input);
  }

  residencyCohorts(limit: number | null | undefined) {
    return this.customer.residencyCohorts(limit);
  }

  /**
   * Stores the caller's watch position (AC-videos-01). A save that crosses the owner's threshold (the stored position was
   * below it, or there was none) completes, without a button, every item this video is attached to that completes by
   * the `watch` rule, is open to the caller, is not complete yet, and whose video the caller may watch (`mayWatch`, the
   * playback gate). Only a crossing completes, so an Undo stays undone while the learner keeps watching. `completedItems`
   * names the attached watch items that are complete once the stored position is at or past the threshold, so a save
   * sent again after a lost reply gets the same answer. Storing comes first: if completing fails, or the item was
   * locked, the learner's position still meets the rule and Complete finishes the item.
   */
  async setVideoProgress(input: {
    userId: string;
    videoSlug: string;
    positionSeconds: number;
    clientRequestId: string;
    now?: Date;
    mayWatch?: () => Promise<void>;
  }) {
    const { previousSeconds, replayed, ...stored } = await this.customer.setVideoProgress({
      userId: input.userId,
      videoSlug: input.videoSlug,
      positionSeconds: input.positionSeconds,
      clientRequestId: input.clientRequestId,
      ...(input.now ? { now: input.now } : {}),
      ...(this.options.videoSpine ? { spine: this.options.videoSpine } : {}),
    });
    const threshold = this.options.videoWatchThresholdSeconds;
    if (threshold === undefined || stored.positionSeconds === null || stored.positionSeconds < threshold) {
      return { ...stored, completedItems: [] as string[] };
    }
    const now = input.now ?? new Date();
    const attached = await this.videoTracks.itemsWithVideo(stored.videoSlug);
    const quizzes = attached.length > 0 ? await this.assessments.publishedSlugs() : new Set<string>();
    const items = attached.filter((slug) => !quizzes.has(slug) && hasCurriculumSlug(slug));
    const crossed = !replayed && (previousSeconds === null || previousSeconds < threshold);
    if (crossed && items.length > 0 && (await this.mayWatch(input.mayWatch))) {
      for (const slug of items) {
        if (await this.currentCompletion(this.sql, input.userId, slug)) continue;
        try {
          await this.release.assertMayComplete({ userId: input.userId, itemSlug: slug });
        } catch (err) {
          // Still locked for the caller: the stored position meets the rule, so Complete finishes it once it opens.
          if (err instanceof AcademyError) continue;
          throw err;
        }
        await this.recordCompletion(input.userId, slug, now);
        await this.settleProgrammesHolding(input.userId, slug, now);
      }
    }
    const completedItems: string[] = [];
    for (const slug of items) if (await this.currentCompletion(this.sql, input.userId, slug)) completedItems.push(slug);
    return { ...stored, completedItems };
  }

  /** Whether the playback gate lets the caller watch; a typed refusal means no, anything else is a failure. */
  private async mayWatch(check?: () => Promise<void>): Promise<boolean> {
    try {
      await check?.();
      return true;
    } catch (err) {
      if (err instanceof AcademyError) return false;
      throw err;
    }
  }

  getVideoProgress(input: { userId: string; videoSlug: string }) {
    return this.customer.getVideoProgress({
      ...input,
      ...(this.options.videoSpine ? { spine: this.options.videoSpine } : {}),
    });
  }

  private spineVideo(videoSlug: string): VideoSpineEntry {
    const spine = this.options.videoSpine ?? listVideoSpine();
    const video = this.options.videoSpine ? spine.find((row) => row.slug === videoSlug) : getVideoSpineItem(videoSlug);
    if (!video) throw new AcademyError(`Video "${videoSlug}" is not on the named spine`, 'academy.video_not_found');
    return video;
  }

  /** AC-videos-01: the video attached to one curriculum item, or null. */
  async itemVideo(itemSlug: string): Promise<{ itemSlug: string; videoSlug: string | null }> {
    const slug = itemSlug.trim();
    if (!hasCurriculumSlug(slug)) throw new AcademyError('Unknown curriculum item', 'academy.curriculum_not_found');
    return { itemSlug: slug, videoSlug: await this.videoTracks.itemVideo(slug) };
  }

  /**
   * AC-videos-01: what the player needs besides the signed URL. Only the original file exists (no transcode path), so it
   * is the one rendition; the caption tracks are staff's, read back as cues; both owner intervals are passed as set.
   */
  async videoPlayer(videoSlug: string): Promise<{
    slug: string;
    title: string;
    renditions: Array<{ id: 'original' }>;
    tracks: VideoTrack[];
    saveEverySeconds: number | null;
    watchThresholdSeconds: number | null;
  }> {
    const video = this.spineVideo(videoSlug);
    return {
      slug: video.slug,
      title: video.title,
      renditions: [{ id: 'original' }],
      tracks: await this.videoTracks.tracks(video.slug),
      saveEverySeconds: this.options.videoSaveEverySeconds ?? null,
      watchThresholdSeconds: this.options.videoWatchThresholdSeconds ?? null,
    };
  }

  /** Staff attach a spine video to one curriculum item, or with `videoSlug: null` take it off, with a reason. */
  async setItemVideo(input: { itemSlug: string; videoSlug: string | null; operatorId: string; reason: string; now?: Date }) {
    const itemSlug = input.itemSlug.trim();
    if (!hasCurriculumSlug(itemSlug)) throw new AcademyError('Unknown curriculum item', 'academy.curriculum_not_found');
    const reason = input.reason.trim();
    if (!reason) throw new AcademyError('A reason is required', 'academy.reason_required');
    const videoSlug = input.videoSlug === null ? null : this.spineVideo(input.videoSlug.trim()).slug;
    await this.videoTracks.setItemVideo({ itemSlug, videoSlug, operatorId: input.operatorId, reason, now: input.now ?? new Date() });
    return { itemSlug, videoSlug };
  }

  /** Staff replace every caption track of one spine video, with a reason. */
  async setVideoTracks(input: {
    videoSlug: string;
    tracks: readonly { language: string; label: string; vtt: string }[];
    operatorId: string;
    reason: string;
    now?: Date;
  }) {
    const video = this.spineVideo(input.videoSlug.trim());
    const reason = input.reason.trim();
    if (!reason) throw new AcademyError('A reason is required', 'academy.reason_required');
    const tracks = await this.videoTracks.setTracks({
      videoSlug: video.slug,
      tracks: input.tracks,
      operatorId: input.operatorId,
      reason,
      now: input.now ?? new Date(),
    });
    return { videoSlug: video.slug, tracks };
  }

  callerLiveSeats(userId: string) {
    return this.customer.callerLiveSeats(userId);
  }

  myUpcomingSessions(input: { userId: string; limit: number | null | undefined }) {
    return this.customer.myUpcomingSessions(input);
  }

  sessionCalendar(input: { userId: string; sessionId: string; now?: Date }) {
    return this.customer.sessionCalendar(input);
  }

  grantAudit(input: { limit: number | null | undefined; cursor?: string | null; certificateId?: string | null }) {
    return this.customer.grantAudit(input);
  }

  opsMetrics(input: { from: string; to: string }) {
    return this.customer.opsMetrics(input);
  }

  enrolments(input: { from: string; to: string }) {
    return this.customer.enrolments(input);
  }

  completionsByItem(input: { from: string; to: string; pathSlug?: string | null }) {
    return this.customer.completionsByItem(input);
  }

  setItemPrerequisites(input: { itemSlug: string; prerequisites: readonly string[] }) {
    return this.release.setItemPrerequisites(input);
  }

  setItemWindow(input: { itemSlug: string; availableFrom: Date | null; availableUntil: Date | null; dueAt: Date | null }) {
    return this.release.setItemWindow(input);
  }

  grantItemExtension(input: {
    userId: string;
    itemSlug: string;
    reason: string;
    extendedUntil: Date;
    clientRequestId: string;
    operatorId: string;
    now?: Date;
  }) {
    return this.release.grantItemExtension(input);
  }

  itemRelease(input: { userId: string; itemSlug: string; now?: Date }) {
    return this.release.itemRelease(input);
  }

  /**
   * Lesson body for this learner. The release decision runs first: a lock
   * throws and the catalog body is not read into the result.
   */
  async readCurriculumItem(input: { userId: string; slug: string; now?: Date }) {
    await this.release.assertMayRead({ userId: input.userId, itemSlug: input.slug, now: input.now });
    return curriculumItemView(input.slug);
  }

  /** The public course page (AC-catalogue-03), with the path's published certificate title when there is one. */
  publicCourse(slug: string, now?: Date) {
    return publicCourse(
      slug,
      (path) => this.certs().find((row) => row.path === path)?.title ?? null,
      (itemSlug) => this.opensSignedOut(itemSlug, now),
    );
  }

  /** Whether the signed-out reader would open this item; a prerequisite or a closed window says no. */
  private async opensSignedOut(itemSlug: string, now?: Date): Promise<boolean> {
    try {
      await this.release.assertMayReadSignedOut({ itemSlug, now });
      return true;
    } catch (err) {
      if (err instanceof AcademyError && (err.code === 'academy.sign_in_required' || err.code === 'academy.window_invalid')) return false;
      throw err;
    }
  }

  /**
   * The hub's featured item (AC-articles-01). The hub is public, so the item shows only while a visitor's reader would
   * open it: one behind a prerequisite or outside its window is left out rather than promised and then refused.
   */
  async featuredItem(now?: Date) {
    const item = await this.featured.featured();
    return item && (await this.opensSignedOut(item.slug, now)) ? item : null;
  }

  /** AC-course-structure-01: course records staff create on the desk (see curriculum/courses.ts). */
  courses(input: AcademyCourseListInput) {
    return this.courseRecords.list(input);
  }

  course(courseId: string) {
    return this.courseRecords.get(courseId);
  }

  createCourse(input: AcademyCreateCourseInput & { operatorId: string; now?: Date }) {
    return this.courseRecords.create({ ...input, now: input.now ?? new Date() });
  }

  updateCourse(input: AcademyUpdateCourseInput & { operatorId: string; now?: Date }) {
    return this.courseRecords.update({ ...input, now: input.now ?? new Date() });
  }

  setCourseState(input: AcademySetCourseStateInput & { operatorId: string; now?: Date }) {
    return this.courseRecords.setState({ ...input, now: input.now ?? new Date() });
  }

  saveOutline(input: AcademySaveOutlineInput & { operatorId: string; now?: Date }) {
    return this.courseRecords.saveOutline({ ...input, now: input.now ?? new Date() });
  }

  /** AC-course-structure-03: one outline item's lesson with its revisions, newest first, and which one learners see. */
  lesson(itemId: string) {
    return this.lessonRecords.get(itemId);
  }

  saveLesson(input: AcademySaveLessonInput & { operatorId: string; now?: Date }) {
    return this.lessonRecords.save({ ...input, now: input.now ?? new Date() });
  }

  revertLesson(input: AcademyRevertLessonInput & { operatorId: string; now?: Date }) {
    return this.lessonRecords.revert({ ...input, now: input.now ?? new Date() });
  }

  publishLesson(input: AcademyPublishLessonInput & { operatorId: string; now?: Date }) {
    return this.lessonRecords.publish({ ...input, now: input.now ?? new Date() });
  }

  duplicateItem(input: AcademyDuplicateItemInput & { operatorId: string; now?: Date }) {
    return this.lessonRecords.duplicate({ ...input, now: input.now ?? new Date() });
  }

  importLesson(input: AcademyImportLessonInput & { operatorId: string; now?: Date }) {
    return this.lessonRecords.import({ ...input, now: input.now ?? new Date() });
  }

  /** AC-course-structure-04: the authoring assistant's draft, and a person's accept or discard. */
  assistantDraft(input: AcademyAssistantDraftInput & { operatorId: string; now?: Date }) {
    return this.lessonRecords.assistantDraft({ ...input, now: input.now ?? new Date() });
  }

  decideDraft(input: AcademyDecideDraftInput & { operatorId: string; now?: Date }) {
    return this.lessonRecords.decideDraft({ ...input, now: input.now ?? new Date() });
  }

  /** AC-articles-01: learners stop seeing the lesson; a featured lesson leaves the Learn hub's slot. */
  withdrawLesson(input: AcademyWithdrawLessonInput & { operatorId: string; now?: Date }) {
    return this.lessonRecords.withdraw({ ...input, now: input.now ?? new Date() });
  }

  /** AC-articles-01: the Learn hub's featured slot and topics on the founder console. */
  featuredSlot() {
    return this.learnHub.featuredSlot();
  }

  featureLesson(input: { itemId: string; reason: string; operatorId: string; now?: Date }) {
    return this.learnHub.featureLesson({ ...input, now: input.now ?? new Date() });
  }

  clearFeatured(input: { reason: string; operatorId: string; now?: Date }) {
    return this.learnHub.clearFeatured({ ...input, now: input.now ?? new Date() });
  }

  topics() {
    return this.learnHub.topics();
  }

  createTopic(input: AcademyCreateTopicInput & { operatorId: string; now?: Date }) {
    return this.learnHub.createTopic({ ...input, now: input.now ?? new Date() });
  }

  setCourseTopics(input: AcademySetCourseTopicsInput & { operatorId: string; now?: Date }) {
    return this.courseRecords.setTopics({ ...input, now: input.now ?? new Date() });
  }

  /** AC-catalogue-03: the course as a new learner sees it; staff only, and nothing is written. */
  previewCourse(courseId: string) {
    return this.coursePreview.preview(courseId);
  }

  /** AC-catalogue-03: the unlisted course page through a private link. */
  courseByLink(input: { slug: string; key: string }) {
    return this.coursePreview.byLink(input);
  }

  privateLinks(courseId: string) {
    return this.coursePreview.links(courseId);
  }

  createPrivateLink(input: { courseId: string; reason: string; operatorId: string; now?: Date }) {
    return this.coursePreview.createLink({ ...input, now: input.now ?? new Date() });
  }

  revokePrivateLink(input: { linkId: string; reason: string; operatorId: string; now?: Date }) {
    return this.coursePreview.revokeLink({ ...input, now: input.now ?? new Date() });
  }

  /** AC-catalogue-03: the published courses staff made, newest first. */
  publishedCourses(limit: number) {
    return this.courseLearners.published(limit);
  }

  /** AC-catalogue-03: a published course's page; signed in, the caller's enrolment opens what is released. */
  authoredCoursePage(slug: string, readerId: string | null) {
    return this.courseLearners.page(slug, readerId);
  }

  /** AC-enrolment-01: the terms of enrolling in a course staff made, with the caller's own enrolment. */
  authoredCourseEnrolment(input: { userId: string; slug: string }) {
    return this.courseLearners.terms(input);
  }

  enrolAuthoredCourse(input: { userId: string; slug: string; track: AcademyEnrolmentTrack; now?: Date }) {
    return this.courseLearners.enrol({ ...input, now: input.now ?? new Date() });
  }

  leaveAuthoredCourse(input: { userId: string; slug: string; enrolledAt: string; now?: Date }) {
    return this.courseLearners.leave({ ...input, now: input.now ?? new Date() });
  }

  /** AC-videos-02: an item's uploads, captions and the owner's upload limits. */
  itemMedia(itemId: string, now: Date = new Date()) {
    return this.courseMedia.itemMedia(itemId, now);
  }

  /** AC-videos-02: a declared file checked against the limits, and a signed upload address for its bytes. */
  mediaUploadIntent(input: AcademyMediaIntentInput & { operatorId: string; now?: Date }) {
    return this.courseMedia.intent({ ...input, now: input.now ?? new Date() });
  }

  /** AC-videos-02: the stored file read back and checked against what was declared. */
  confirmMedia(input: { mediaId: string; operatorId: string; now?: Date }) {
    return this.courseMedia.confirm({ ...input, now: input.now ?? new Date() });
  }

  /** AC-videos-02: one language's SRT or WebVTT captions for the item's video. */
  setItemCaptions(input: AcademySetItemCaptionsInput & { operatorId: string; now?: Date }) {
    return this.courseMedia.setCaptions({ ...input, now: input.now ?? new Date() });
  }

  /** AC-assignments-01: an assignment item's brief as staff see it. */
  assignmentForStaff(itemId: string) {
    return this.courseAssignments.adminView(itemId);
  }

  saveAssignment(input: AcademySaveAssignmentInput & { operatorId: string; now?: Date }) {
    return this.courseAssignments.save({ ...input, now: input.now ?? new Date() });
  }

  withdrawAssignment(input: AcademyWithdrawAssignmentInput & { operatorId: string; now?: Date }) {
    return this.courseAssignments.withdraw({ ...input, now: input.now ?? new Date() });
  }

  /** AC-assignments-01: the assignment as the enrolled learner sees it, with their own hand-ins. */
  assignment(input: { itemId: string; userId: string }) {
    return this.courseAssignments.learnerView(input);
  }

  uploadAssignmentFile(input: AcademyUploadAssignmentFileInput & { userId: string; now?: Date }) {
    return this.courseAssignments.uploadFile({ ...input, now: input.now ?? new Date() });
  }

  submitAssignment(input: AcademySubmitAssignmentInput & { userId: string; now?: Date }) {
    return this.courseAssignments.submit({ ...input, now: input.now ?? new Date() });
  }

  /** AC-assignments-03: the review steps and rubric over the revision read; answers with the assignment as staff see it. */
  async saveReviewSteps(input: AcademySaveReviewStepsInput & { operatorId: string; now?: Date }) {
    await this.peerReviews.save({ ...input, now: input.now ?? new Date() });
    return this.courseAssignments.adminView(input.itemId);
  }

  /** AC-assignments-03: the learner's review stage, handing out the next work when one is due and free. */
  peerReview(input: { itemId: string; userId: string; now?: Date }) {
    return this.peerReviews.state({ ...input, now: input.now ?? new Date() });
  }

  /** AC-assignments-02: the grading queue of one assignment, learners under aliases. */
  gradingQueue(input: { itemId: string; operatorId: string; now?: Date }) {
    return this.grading.queue({ ...input, now: input.now ?? new Date() });
  }

  openGrading(input: AcademyOpenGradingInput & { operatorId: string; now?: Date }) {
    return this.grading.open({ ...input, now: input.now ?? new Date() });
  }

  gradeSubmission(input: AcademyGradeSubmissionInput & { operatorId: string; now?: Date }) {
    return this.grading.grade({ ...input, now: input.now ?? new Date() });
  }

  /** AC-assignments-02: a file of grades by alias; good rows apply, bad rows are listed, a repeated file changes nothing. */
  bulkGrade(input: AcademyBulkGradeInput & { operatorId: string; now?: Date }) {
    return this.grading.bulkGrade({ ...input, now: input.now ?? new Date() });
  }

  /** AC-assignments-02: the learner read their feedback; answers with the assignment as they see it. */
  async markFeedbackRead(input: AcademyMarkFeedbackReadInput & { userId: string; now?: Date }) {
    await this.grading.markRead({ ...input, now: input.now ?? new Date() });
    return this.courseAssignments.learnerView({ itemId: input.itemId, userId: input.userId });
  }

  /** AC-assignments-03: the file of work handed to the caller to review, read back through svc-academy. */
  peerReviewFile(input: { itemId: string; taskId: string; userId: string; now?: Date }) {
    return this.peerReviews.file({ ...input, now: input.now ?? new Date() });
  }

  submitPeerReview(input: AcademySubmitPeerReviewInput & { userId: string; now?: Date }) {
    return this.peerReviews.submit({ ...input, now: input.now ?? new Date() });
  }

  setFeatured(input: { itemSlug: string | null; reason: string; operatorId: string; now?: Date }) {
    return this.featured.choose(input);
  }

  /** AC-enrolment-01 step 4: staff set or clear a course's start date with a reason. */
  setCourseStart(input: { slug: string; startsAt: Date | null; reason: string; operatorId: string; now?: Date }) {
    return this.courseStarts.set(input);
  }

  /** The reader for a signed-out visitor (AC-catalogue-01): the same item, nothing about any learner, no touch written. */
  async readPublicCurriculumItem(input: { slug: string; now?: Date }) {
    await this.release.assertMayReadSignedOut({ itemSlug: input.slug, now: input.now });
    return curriculumItemView(input.slug);
  }

  async readCurriculumItemLocalized(input: { userId: string; slug: string; locale?: string; now?: Date }) {
    const item = await this.readCurriculumItem(input);
    const localized = curriculumBodyForLocale(item.body, input.locale);
    return {
      ...item,
      body: localized.body,
      locale: localized.resolution.locale,
      fellBack: localized.resolution.fellBack,
      i18nStrategy: curriculumI18nStrategyLine(),
    };
  }

  /** `mayWatch`: the playback gate, which a `watch` item needs too (refusing with the gate's own error). */
  async markCurriculumComplete(input: {
    userId: string;
    itemSlug: string;
    now?: Date;
    mayWatch?: () => Promise<void>;
  }): Promise<ItemCompletionRecord> {
    const slug = input.itemSlug.trim();
    if (!hasCurriculumSlug(slug)) {
      throw new AcademyError('Unknown curriculum item', 'academy.curriculum_not_found');
    }
    const existing = await this.currentCompletion(this.sql, input.userId, slug);
    let decision: { record: ItemCompletionRecord; alreadyComplete: boolean };
    try {
      decision = decideItemComplete({ userId: input.userId, itemSlug: slug, existing });
    } catch (err) {
      this.mapCertErr(err);
    }
    if (decision.alreadyComplete) return decision.record;
    await this.release.assertMayComplete({ userId: input.userId, itemSlug: slug });
    const now = input.now ?? new Date();
    const quiz = await this.assessments.definition(slug);
    if (quiz && quiz.passMark === null) {
      throw new AcademyError(`academy.pass_mark_unset slug=${slug}`, 'academy.pass_mark_unset');
    }
    const video = quiz ? null : await this.videoTracks.itemVideo(slug);
    const rule: AcademyCompletionRule = quiz ? 'score' : video ? 'watch' : 'view';
    if (rule === 'watch' && this.options.videoWatchThresholdSeconds === undefined) {
      throw new AcademyError('academy.watch_threshold_unset', 'academy.watch_threshold_unset');
    }
    if (rule === 'watch') await input.mayWatch?.();
    const met =
      rule === 'view' ||
      (rule === 'score' && (await this.assessments.passedSlugs(input.userId, now)).has(slug)) ||
      (rule === 'watch' && (await this.watchedItems(input.userId, new Map([[slug, video!]]))).has(slug));
    if (!met) throw new AcademyError(`academy.completion_rule_unmet rule=${rule}`, 'academy.completion_rule_unmet');
    const record = await this.recordCompletion(input.userId, slug, now);
    await this.settleCertificatesNeeding(input.userId, slug, now);
    await this.settleProgrammesHolding(input.userId, slug, now);
    return record;
  }

  /** Records one completion and its history row; a concurrent completion of the same item returns that one. */
  private recordCompletion(userId: string, slug: string, now: Date): Promise<ItemCompletionRecord> {
    return transaction(this.sql, async (tx) => {
      // Complete and Undo on one item take turns, so the history and the current row never disagree.
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`${userId}:${slug}:completion`}, 0))`;
      const rows = await tx<Array<{ user_id: string; item_slug: string; completed_at: Date }>>`
        INSERT INTO academy.cert_item_completions (user_id, item_slug, completed_at)
        VALUES (${userId}, ${slug}, ${now})
        ON CONFLICT (user_id, item_slug) DO NOTHING
        RETURNING user_id, item_slug, completed_at
      `;
      if (!rows[0]) {
        // Completed by a concurrent request: that one wrote the history row.
        return (await this.currentCompletion(tx, userId, slug))!;
      }
      await tx`
        INSERT INTO academy.item_completion_events (user_id, item_slug, event, client_request_id, recorded_at)
        VALUES (${userId}, ${slug}, 'completed', NULL, ${now})
      `;
      return { userId: rows[0].user_id, itemSlug: rows[0].item_slug, completedAt: rows[0].completed_at };
    });
  }

  /**
   * AC-progress-01 Undo of one completion, named by its `completedAt`: the item is no longer complete, so course progress
   * drops and items that need it, and are not complete themselves, lock again (a later item already completed stays so).
   * The history keeps both events; completing again appends a new one with a new `completedAt`, which an old or replayed
   * Undo does not match. A replay of the same request answers as the first did; a request id reused for another item is
   * refused. Nothing matching to undo answers `undoneAt: null`.
   */
  async undoCurriculumComplete(input: {
    userId: string;
    itemSlug: string;
    completedAt: string;
    clientRequestId: string;
    now?: Date;
  }): Promise<AcademyUndoCompletion> {
    const slug = input.itemSlug.trim();
    if (!hasCurriculumSlug(slug)) {
      throw new AcademyError('Unknown curriculum item', 'academy.curriculum_not_found');
    }
    const clientRequestId = input.clientRequestId.trim();
    const completedAt = new Date(input.completedAt);
    const now = input.now ?? new Date();
    const undone = await transaction(this.sql, async (tx) => {
      // completed_at may carry microseconds (rows from before this change used now()); the caller saw it in milliseconds.
      // The request id first, so two Undos sharing one id on different items take turns and the second reads the first.
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`${input.userId}:${clientRequestId}:undo-request`}, 0))`;
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`${input.userId}:${slug}:completion`}, 0))`;
      const replay = await tx<Array<{ item_slug: string; recorded_at: Date }>>`
        SELECT item_slug, recorded_at FROM academy.item_completion_events
         WHERE user_id = ${input.userId} AND client_request_id = ${clientRequestId}
      `;
      if (replay[0]) {
        if (replay[0].item_slug !== slug) {
          throw new AcademyError('academy.request_reused this request id undid another item', 'academy.request_reused');
        }
        return { userId: input.userId, itemSlug: slug, undoneAt: replay[0].recorded_at.toISOString() };
      }
      const removed = await tx<Array<{ item_slug: string }>>`
        DELETE FROM academy.cert_item_completions
         WHERE user_id = ${input.userId} AND item_slug = ${slug}
           AND date_trunc('milliseconds', completed_at) = ${completedAt}
        RETURNING item_slug
      `;
      if (!removed[0]) return { userId: input.userId, itemSlug: slug, undoneAt: null };
      await tx`
        INSERT INTO academy.item_completion_events (user_id, item_slug, event, client_request_id, recorded_at)
        VALUES (${input.userId}, ${slug}, 'undone', ${clientRequestId}, ${now})
      `;
      return { userId: input.userId, itemSlug: slug, undoneAt: now.toISOString() };
    });
    // A delayed certificate waiting on this item stops waiting; completing again starts a new wait.
    if (undone.undoneAt !== null) await this.settleCertificatesNeeding(input.userId, slug, now);
    return undone;
  }

  private async currentCompletion(sql: Sql, userId: string, slug: string): Promise<ItemCompletionRecord | null> {
    const rows = await sql<Array<{ user_id: string; item_slug: string; completed_at: Date }>>`
      SELECT user_id, item_slug, completed_at FROM academy.cert_item_completions
       WHERE user_id = ${userId} AND item_slug = ${slug}
    `;
    return rows[0] ? { userId: rows[0].user_id, itemSlug: rows[0].item_slug, completedAt: rows[0].completed_at } : null;
  }

  /**
   * The course rule an item completes by (AC-progress-01): `score` when a quiz is published for it, otherwise `view`, met
   * by opening it, which the Complete button on the open item already is.
   */
  private completionRule(slug: string, quizzes: ReadonlySet<string>, videos: ReadonlyMap<string, string>): AcademyCompletionRule {
    return quizzes.has(slug) ? 'score' : videos.has(slug) ? 'watch' : 'view';
  }

  /**
   * `passed`: the caller's passed quiz slugs. A quiz with no pass mark is never passed, and completing says why.
   * `watched`: the caller's watch items whose video's stored position reached the owner threshold.
   */
  private completionRuleMet(slug: string, rule: AcademyCompletionRule, passed: ReadonlySet<string>, watched: ReadonlySet<string>): boolean {
    return rule === 'view' || (rule === 'score' ? passed.has(slug) : watched.has(slug));
  }

  /**
   * AC-videos-01: of the given item → video pairs, the items whose video the caller has watched: a stored position at or
   * past the owner's threshold. No threshold: none, since a blank threshold is not zero.
   */
  private async watchedItems(userId: string, videos: ReadonlyMap<string, string>): Promise<Set<string>> {
    const threshold = this.options.videoWatchThresholdSeconds;
    if (threshold === undefined || videos.size === 0) return new Set();
    const rows = await this.sql<Array<{ video_slug: string }>>`
      SELECT video_slug FROM academy.video_progress
       WHERE user_id = ${userId} AND video_slug IN ${this.sql([...new Set(videos.values())])} AND position_seconds >= ${threshold}
    `;
    const seen = new Set(rows.map((row) => row.video_slug));
    return new Set([...videos].filter(([, video]) => seen.has(video)).map(([item]) => item));
  }

  private async completionTimes(userId: string, slugs: readonly string[]): Promise<Map<string, Date>> {
    if (slugs.length === 0) return new Map();
    const rows = await this.sql<Array<{ item_slug: string; completed_at: Date }>>`
      SELECT item_slug, completed_at FROM academy.cert_item_completions
       WHERE user_id = ${userId} AND item_slug = ANY(${slugs as string[]})
    `;
    return new Map(rows.map((r) => [r.item_slug, r.completed_at]));
  }

  private async completedSlugs(userId: string): Promise<Set<string>> {
    const rows = await this.sql<Array<{ item_slug: string }>>`
      SELECT item_slug FROM academy.cert_item_completions WHERE user_id = ${userId}
    `;
    return new Set(rows.map((r) => r.item_slug));
  }

  private async existingGrant(
    userId: string,
    certId: string,
  ): Promise<(CertGrantRecord & { publicId: string; status: 'valid' | 'revoked' }) | null> {
    const key = certIdempotencyKey(userId, certId);
    const rows = await this.sql<
      Array<{ user_id: string; cert_id: string; granted_at: Date; idempotency_key: string; public_id: string; status: string }>
    >`
      SELECT user_id, cert_id, granted_at, idempotency_key, public_id, status FROM academy.cert_grants
       WHERE user_id = ${userId} AND cert_id = ${certId}
    `;
    if (!rows[0]) return null;
    return {
      userId: rows[0].user_id,
      certId: rows[0].cert_id,
      grantedAt: rows[0].granted_at,
      idempotencyKey: rows[0].idempotency_key ?? key,
      publicId: rows[0].public_id,
      status: rows[0].status === 'revoked' ? 'revoked' : 'valid',
    };
  }

  /**
   * AC-programmes-01: staff create a learning programme or replace its details and ordered courses over the revision
   * they read (admin door, reason required). A course is one of the published learning-path courses.
   */
  saveProgramme(input: AcademySaveProgrammeInput & { operatorId: string; now?: Date }): Promise<AcademyProgrammeRecord> {
    const { now = new Date(), ...rest } = input;
    return this.programmeRecords.save({ ...rest, now }, (course) => listCurriculum({ path: course as CurriculumPath }).length > 0);
  }

  /** AC-programmes-01: the programmes staff made, newest first, up to the caller's limit. */
  adminProgrammes(limit: number): Promise<AcademyProgrammeRecord[]> {
    return this.programmeRecords.list(limit);
  }

  /** AC-programmes-01: one programme as the caller stands on it: each course in order, the three counts, the certificate. */
  async programme(input: { userId: string; slug: string; now?: Date }): Promise<AcademyProgramme> {
    const record = await this.programmeRecords.get(input.slug);
    if (!record) throw new AcademyError(`academy.programme_not_found slug=${input.slug}`, 'academy.programme_not_found');
    return this.programmeStanding(input.userId, record, await this.learnerCourses(input.userId), input.now ?? new Date());
  }

  /**
   * AC-programmes-01: the programmes newest first, up to the caller's limit, each as the caller stands on it. `mine` keeps
   * only the programmes the caller has a certificate for or holds a completed or enrolled course of, wherever they sit in
   * the list, so an older programme's certificate is never paged out of the Certificates tab.
   */
  async programmes(input: { userId: string; limit: number; mine?: boolean; now?: Date }): Promise<AcademyProgramme[]> {
    const learner = await this.learnerCourses(input.userId);
    const records = await this.programmeRecords.list(
      input.limit,
      input.mine ? { earned: [...learner.grants.keys()], courses: [...learner.started] } : undefined,
    );
    const now = input.now ?? new Date();
    return Promise.all(records.map((record) => this.programmeStanding(input.userId, record, learner, now)));
  }

  /**
   * What the caller has done, in three reads: the items recorded, the courses with an open enrolment, and the programme
   * certificates they hold. `started` is every course they are enrolled in or have every item of.
   */
  private async learnerCourses(userId: string): Promise<LearnerCourses> {
    const [completed, enrolments, grants] = await Promise.all([
      this.completedSlugs(userId),
      this.publishedEnrolments(userId),
      this.programmeGrants(userId),
    ]);
    const enrolled = new Set(enrolments.map((row) => row.pathSlug));
    const started = new Set([...enrolled, ...PROGRAMME_SLUGS.filter((path) => courseComplete(path, completed))]);
    return { completed, enrolled, started, grants };
  }

  /** The caller's programme certificates by programme slug, in one read. */
  private async programmeGrants(userId: string): Promise<Map<string, ProgrammeGrant>> {
    const rows = await this.sql<Array<{ cert_id: string; granted_at: Date; public_id: string; status: string }>>`
      SELECT cert_id, granted_at, public_id, status FROM academy.cert_grants
       WHERE user_id = ${userId} AND starts_with(cert_id, ${PROGRAMME_CERT_PREFIX})
    `;
    return new Map(
      rows.map((row) => [
        row.cert_id.slice(PROGRAMME_CERT_PREFIX.length),
        { publicId: row.public_id, grantedAt: row.granted_at, status: row.status === 'revoked' ? 'revoked' : 'valid' },
      ]),
    );
  }

  /**
   * How the caller stands on one programme. A course is completed once every one of its items is recorded (whether or not
   * the learner is still enrolled), else enrolled while an enrolment is open, else not enrolled. With every course of a
   * non-empty programme completed, the certificate is issued here if it is not yet: once, keyed `cert:<user>:<cert>`, so a
   * completion whose issue was lost is issued by the learner's next read. A revoked certificate stays revoked.
   */
  private async programmeStanding(
    userId: string,
    record: AcademyProgrammeRecord,
    learner: LearnerCourses,
    now: Date,
  ): Promise<AcademyProgramme> {
    const courses = record.courseSlugs.map((slug) => {
      const items = listCurriculum({ path: slug }).map((row) => row.slug);
      const completed = items.filter((item) => learner.completed.has(item)).length;
      const state: AcademyProgrammeCourseState =
        items.length > 0 && completed === items.length ? 'completed' : learner.enrolled.has(slug) ? 'enrolled' : 'not_enrolled';
      return { slug, state, items: items.length, completed };
    });
    const count = (state: AcademyProgrammeCourseState) => courses.filter((row) => row.state === state).length;
    const certId = academyProgrammeCertId(record.slug);
    const finished = courses.length > 0 && count('completed') === courses.length;
    const grant = learner.grants.get(record.slug) ?? (finished ? await this.issueProgrammeCert(userId, certId, now) : null);
    return {
      slug: record.slug,
      title: record.title,
      summary: record.summary,
      courses,
      counts: { completed: count('completed'), enrolled: count('enrolled'), notEnrolled: count('not_enrolled') },
      certificate: grant
        ? { state: 'earned', certId, publicId: grant.publicId, grantedAt: grant.grantedAt, status: grant.status }
        : { state: 'not_earned', certId },
    };
  }

  /** Writes the programme certificate once; a concurrent issue answers with the row the other one wrote. No XP, no money. */
  private async issueProgrammeCert(userId: string, certId: string, now: Date): Promise<ProgrammeGrant> {
    await this.insertCertGrant({ userId, certId, grantedAt: now, idempotencyKey: certIdempotencyKey(userId, certId) });
    const grant = await this.existingGrant(userId, certId);
    if (!grant) throw new AcademyError(`Programme certificate left no row for ${certId}`, 'academy.cert_invalid');
    return grant;
  }

  /** The one write of a certificate grant: a new serial, and nothing when the learner already holds this certificate. */
  private insertCertGrant(grant: CertGrantRecord) {
    return this.sql<Array<{ user_id: string; cert_id: string; granted_at: Date; idempotency_key: string; public_id: string }>>`
      INSERT INTO academy.cert_grants (user_id, cert_id, granted_at, idempotency_key, public_id)
      VALUES (${grant.userId}, ${grant.certId}, ${grant.grantedAt}, ${grant.idempotencyKey}, ${randomPublicId()})
      ON CONFLICT (user_id, cert_id) DO NOTHING
      RETURNING user_id, cert_id, granted_at, idempotency_key, public_id
    `;
  }

  /** A certificate's title for anyone who checks it: the published definition's, or the programme's. */
  private async certTitle(certId: string): Promise<string | undefined> {
    if (!certId.startsWith(PROGRAMME_CERT_PREFIX)) return this.certDefinition(certId)?.title;
    return (await this.programmeRecords.get(certId.slice(PROGRAMME_CERT_PREFIX.length)))?.title;
  }

  /**
   * After a completion: issues the certificate of every programme holding the item's course that the learner has now
   * finished. The completion is already recorded and stays so; a certificate this step could not issue is issued by the
   * learner's next programme read.
   */
  private async settleProgrammesHolding(userId: string, itemSlug: string, now: Date): Promise<void> {
    const course = getCurriculumItem(itemSlug)?.path as CurriculumPath | undefined;
    if (!course) return;
    try {
      // A programme can only be finished by the completion that finished its course.
      if (!courseComplete(course, await this.completedSlugs(userId))) return;
      const held = await this.programmeRecords.holding(course);
      if (held.length === 0) return;
      const learner = await this.learnerCourses(userId);
      for (const record of held) await this.programmeStanding(userId, record, learner, now);
    } catch (err) {
      console.error({ err, course }, 'programme certificate issue failed; the next programme read retries it');
    }
  }

  /** AC-certificates-02: staff set how one published certificate is issued (admin door, reason required). */
  async setCertIssueRule(input: AcademySetCertIssueRuleInput & { operatorId: string; now?: Date }): Promise<AcademyCertIssueRule> {
    if (!this.certDefinition(input.certId)) {
      this.refuseUnpublishedPath(input.certId);
      throw new AcademyError('Unknown certification', 'academy.cert_not_found');
    }
    return this.issueRules.setRule({
      ...input,
      now: input.now ?? new Date(),
      sweepRunning: this.options.certIssueSweepSeconds !== undefined,
    });
  }

  /**
   * AC-certificates-03: the revocation recorded for one issued certificate, or null while it stands. An unknown code is
   * `academy.cert_not_found`. The router reads this before spending a two-person approval, so a repeat or a typo costs
   * nobody's approval.
   */
  async certRevocation(publicId: string, tx: Sql = this.sql): Promise<AcademyCertRevocation | null> {
    if (!isPublicId(publicId)) throw new AcademyError('Certificate not found', 'academy.cert_not_found');
    const grants = await tx`SELECT 1 FROM academy.cert_grants WHERE public_id = ${publicId}`;
    if (grants.length === 0) throw new AcademyError('Certificate not found', 'academy.cert_not_found');
    const rows = await tx<RevocationRow[]>`
      SELECT ${tx(REVOCATION_COLUMNS)} FROM academy.cert_revocations WHERE public_id = ${publicId}
    `;
    return rows[0] ? revocationRecord(rows[0]) : null;
  }

  /**
   * AC-certificates-03: staff revoke one issued certificate by its public code, once two people approved it (the router
   * consumes identity's approval and passes who proposed and who approved it). The grant turns `revoked` and one record
   * names them, the operator who carried it out, the reason and the time. A repeat answers with the first record and
   * writes nothing; an unknown code is `academy.cert_not_found`.
   */
  async revokeCert(input: {
    publicId: string;
    reason: string;
    proposedBy: string;
    approvedBy: string;
    operatorId: string;
    now?: Date;
  }): Promise<AcademyCertRevocation> {
    const reason = input.reason.trim();
    if (reason.length === 0 || reason.length > 500) throw new AcademyError('A revoke needs a reason', 'academy.cert_invalid');
    return transaction(this.sql, async (tx) => {
      await tx`SELECT 1 FROM academy.cert_grants WHERE public_id = ${input.publicId} FOR UPDATE`;
      const recorded = await this.certRevocation(input.publicId, tx);
      if (recorded) return recorded;
      const [grant] = await tx<Array<{ user_id: string; cert_id: string }>>`
        UPDATE academy.cert_grants SET status = 'revoked' WHERE public_id = ${input.publicId} RETURNING user_id, cert_id
      `;
      const rows = await tx<RevocationRow[]>`
        INSERT INTO academy.cert_revocations (public_id, user_id, cert_id, proposed_by, approved_by, revoked_by, reason, revoked_at)
        VALUES (${input.publicId}, ${grant!.user_id}, ${grant!.cert_id}, ${input.proposedBy}, ${input.approvedBy},
                ${input.operatorId}, ${reason}, ${input.now ?? new Date()})
        RETURNING ${tx(REVOCATION_COLUMNS)}
      `;
      return revocationRecord(rows[0]!);
    });
  }

  /** The stored issue rule of one certificate, or null when staff have set none. */
  certIssueRule(certId: string): Promise<AcademyCertIssueRule | null> {
    return this.issueRules.rule(certId);
  }

  /**
   * AC-certificates-02: how the learner's certificate stands under its issue rule, writing nothing but the wait.
   * `manual` (or no rule) issues nothing by itself: the learner claims it, and any wait left from an earlier delayed rule
   * is dropped. `automatic` is due once every requirement is met. `delayed` records the wait the first time the learner
   * stands complete, due the owner's delay after the later of their last lesson completion and the rule's own revision
   * (a rule set after someone finished starts their wait then); a certificate with an assessment requirement counts from
   * now, since a pass is settled when it happens. A learner no longer complete (an Undo) drops the wait.
   */
  private async issueStanding(
    userId: string,
    cert: CertDefinition,
    progress: ProgressReport,
    now: Date,
  ): Promise<{ issue: AcademyCertIssue; due: boolean }> {
    const rule = await this.issueRules.rule(cert.id);
    if (!rule || rule.mode === 'manual' || progress.granted || !progress.complete) {
      await this.issueRules.dropPending(userId, cert.id);
      return {
        issue: rule && rule.mode !== 'manual' ? { mode: rule.mode, delayMinutes: rule.delayMinutes, issuesAt: null } : MANUAL_ISSUE,
        due: false,
      };
    }
    const view: AcademyCertIssue = { mode: rule.mode, delayMinutes: rule.delayMinutes, issuesAt: null };
    if (rule.mode === 'automatic') return { issue: view, due: true };
    const hasAssessment = cert.requiredItemSlugs.some((slug) => assessmentRequirementSlug(slug) !== null);
    const lessons = [...(await this.completionTimes(userId, cert.requiredItemSlugs)).values()].map((at) => at.getTime());
    const completeAt = new Date(Math.max(rule.updatedAt.getTime(), ...(hasAssessment ? [now.getTime()] : lessons)));
    const dueAt = await this.issueRules.ensurePending(userId, cert.id, issueDueAt(completeAt, rule.delayMinutes!), now);
    return dueAt.getTime() > now.getTime() ? { issue: { ...view, issuesAt: dueAt }, due: false } : { issue: view, due: true };
  }

  /** Issues the learner's certificate when its rule says it is due, and answers how it is issued. Safe to repeat. */
  private async settleCertIssue(userId: string, cert: CertDefinition, now: Date, progress?: ProgressReport): Promise<AcademyCertIssue> {
    const standing = await this.issueStanding(userId, cert, progress ?? (await this.progressOf(userId, cert)), now);
    if (standing.due) {
      await this.grantCert({ userId, certId: cert.id, byRule: true, now });
      await this.issueRules.dropPending(userId, cert.id);
    }
    return standing.issue;
  }

  /**
   * After a completion, an Undo or an assessment result: settles every certificate that needs this requirement (a lesson
   * slug, or `assessment:<slug>`). What happened is already recorded and stays so whatever happens here; a certificate
   * this step could not issue is issued by the learner's next read or the sweep.
   */
  private async settleCertificatesNeeding(userId: string, requirement: string, now: Date): Promise<void> {
    for (const cert of this.certs().filter((row) => row.requiredItemSlugs.includes(requirement))) {
      try {
        await this.settleCertIssue(userId, cert, now);
      } catch (err) {
        console.error({ err, certId: cert.id }, 'certificate issue failed; the next read or sweep retries it');
      }
    }
  }

  /**
   * The issue sweep: issues every delayed certificate due by `now`, in batches until none is left, and answers how many
   * it settled. One learner's failure is logged and left for the next sweep; it never stops the others.
   */
  async issueDueCertificates(now: Date = new Date()): Promise<number> {
    let settled = 0;
    const seen = new Set<string>();
    for (;;) {
      const due = await this.issueRules.due(now, CERT_ISSUE_SWEEP_BATCH);
      // Every settled row leaves the table; a row read twice in one sweep would mean it stayed, so stop rather than spin.
      if (due.some((row) => seen.has(`${row.userId}:${row.certId}`))) return settled;
      let failed = false;
      for (const row of due) {
        seen.add(`${row.userId}:${row.certId}`);
        const cert = this.certDefinition(row.certId);
        try {
          if (cert) await this.settleCertIssue(row.userId, cert, now);
          else await this.issueRules.dropPending(row.userId, row.certId);
          settled += 1;
        } catch (err) {
          failed = true;
          console.error({ err, certId: row.certId }, 'certificate issue sweep: one certificate failed; the next sweep retries it');
        }
      }
      // A full batch may have more behind it. After a failure the rest waits for the next sweep, so a row that keeps
      // failing never spins this loop.
      if (due.length < CERT_ISSUE_SWEEP_BATCH || failed) return settled;
    }
  }

  /**
   * Stage-2 — what the XP plane is doing, for the ops surface and /ready.
   * Reads the publisher; writes nothing, awards nothing.
   */
  certXpPlane(): CertXpPlaneStatus {
    return certXpPlaneStatus(this.certXp);
  }

  /**
   * D26-P1-C1 — perk plane honesty: identity SoT for real perks; invent money refuse-closed.
   */
  certPerkPlane(): CertPerkPlaneStatus {
    return certPerkPlaneStatus();
  }

  /**
   * Grant a certification, publish the XP it is worth, then surface real
   * identity perks (or refuse when the SoT is unreadable / invent is requested).
   *
   * TWO THINGS ABOUT THE ORDER, both deliberate:
   *
   * The grant is written FIRST and the award published after. A certification
   * the user earned is the durable fact; the XP is a consequence of it. If the
   * bus is down we keep the fact and report the missing consequence, rather
   * than refusing a cert somebody completed seven curriculum items for.
   *
   * The award is published on the already-granted path TOO. That is not a
   * double award — `xp-publish.ts` keys it on `academy.cert:cert:<user>:<cert>`,
   * a business key, and identity's `xp_events ON CONFLICT (idempotency_key) DO
   * NOTHING` drops the repeat. It is instead the recovery path: a grant whose
   * emit failed heals the next time anyone asks for that cert, with no outbox
   * table and no sweep.
   *
   * Perks are read AFTER XP publish and never invented: svc-identity is SoT.
   * Unpriced certs (`no_policy`) refuse the perk readout so the grant cannot
   * look like a granted perk or perk money.
   */
  async grantCert(input: {
    userId: string;
    certId: string;
    /** Set when the certificate's issue rule issues it, not the learner's own claim. */
    byRule?: boolean;
    now?: Date;
  }): Promise<{ grant: CertGrantRecord & { publicId: string }; alreadyGranted: boolean; xp: CertXpEmitResult; perks: CertPerkOutcome }> {
    const { byRule = false, now = new Date(), ...claim } = input;
    assertNoCertPerkMoneyAttachment(claim);
    const cert = this.certDefinition(input.certId);
    if (!cert) this.refuseUnpublishedPath(input.certId);
    if (!byRule && cert) {
      // A delayed certificate is issued when its wait ends; claiming it sooner refuses with the time it is due. Once due,
      // the learner's claim is the issue, answered as a first grant.
      const standing = await this.issueStanding(input.userId, cert, await this.progressOf(input.userId, cert), now);
      if (standing.issue.issuesAt !== null) {
        throw new AcademyError(`academy.cert_not_due issuesAt=${standing.issue.issuesAt.toISOString()}`, 'academy.cert_not_due');
      }
    }
    const completed = await this.completedSlugs(input.userId);
    const passed = await this.assessments.passedSlugs(input.userId);
    const existing = await this.existingGrant(input.userId, input.certId);
    // A revoked certificate stays revoked: claiming it again answers the typed refusal and publishes nothing.
    if (existing?.status === 'revoked') throw new AcademyError(`academy.cert_revoked cert=${input.certId}`, 'academy.cert_revoked');
    let decision: { grant: CertGrantRecord; alreadyGranted: boolean };
    try {
      decision = decideGrant({
        userId: input.userId,
        cert,
        completedSlugs: completed,
        existing,
        passedAssessmentSlugs: passed,
      });
    } catch (err) {
      this.mapCertErr(err);
    }
    if (decision.alreadyGranted) {
      if (!existing) throw new AcademyError(`Grant marked already granted with no row for ${input.certId}`, 'academy.cert_invalid');
      const xp = await this.certXp.publishCertXp(decision.grant);
      const perks = await resolveCertPerkOutcome({ userId: input.userId, hostRights: this.hostRights, xp });
      return { grant: { ...decision.grant, publicId: existing.publicId }, alreadyGranted: true, xp, perks };
    }
    // ON CONFLICT DO NOTHING — concurrent second writer must not hardcode
    // alreadyGranted:false (UI would fire "just earned" twice; XP still safe).
    const rows = await this.insertCertGrant(decision.grant);
    if (rows.length === 0) {
      const raced = await this.existingGrant(input.userId, input.certId);
      if (!raced) {
        throw new AcademyError(`Grant race left no cert row for ${input.certId}`, 'academy.cert_invalid');
      }
      const xp = await this.certXp.publishCertXp(raced);
      const perks = await resolveCertPerkOutcome({ userId: input.userId, hostRights: this.hostRights, xp });
      return {
        grant: raced,
        alreadyGranted: alreadyGrantedAfterInsert(false),
        xp,
        perks,
      };
    }
    const grant: CertGrantRecord & { publicId: string } = {
      userId: rows[0]!.user_id,
      certId: rows[0]!.cert_id,
      grantedAt: rows[0]!.granted_at,
      idempotencyKey: rows[0]!.idempotency_key,
      publicId: rows[0]!.public_id,
    };
    const xp = await this.certXp.publishCertXp(grant);
    const perks = await resolveCertPerkOutcome({ userId: input.userId, hostRights: this.hostRights, xp });
    return {
      alreadyGranted: alreadyGrantedAfterInsert(true),
      grant,
      xp,
      perks,
    };
  }

  async myCertGrants(
    userId: string,
    requested?: number,
  ): Promise<Array<CertGrantRecord & { publicId: string; status: 'valid' | 'revoked' }>> {
    const limit = assertMyCertsListLimit(requested);
    const rows = await this.sql<
      Array<{ user_id: string; cert_id: string; granted_at: Date; idempotency_key: string; public_id: string; status: string }>
    >`
      SELECT user_id, cert_id, granted_at, idempotency_key, public_id, status FROM academy.cert_grants
       WHERE user_id = ${userId}
       ORDER BY granted_at DESC
       LIMIT ${limit}
    `;
    return rows.map((r) => ({
      userId: r.user_id,
      certId: r.cert_id,
      grantedAt: r.granted_at,
      idempotencyKey: r.idempotency_key,
      publicId: r.public_id,
      status: r.status === 'revoked' ? ('revoked' as const) : ('valid' as const),
    }));
  }

  /**
   * The caller's progress toward one certificate, with how it is issued. A certificate its rule says is due is issued
   * here first: the recovery path for an issue the completion did not finish (the process stopped between the two).
   */
  async certProgress(input: { userId: string; certId: string; now?: Date }): Promise<ProgressReport & { issue: AcademyCertIssue }> {
    const cert = this.certDefinition(input.certId);
    if (!cert) {
      this.refuseUnpublishedPath(input.certId);
      throw new AcademyError('Unknown certification', 'academy.cert_not_found');
    }
    const now = input.now ?? new Date();
    const progress = await this.progressOf(input.userId, cert);
    const standing = await this.issueStanding(input.userId, cert, progress, now);
    if (!standing.due) return { ...progress, issue: standing.issue };
    try {
      await this.grantCert({ userId: input.userId, certId: cert.id, byRule: true, now });
      await this.issueRules.dropPending(input.userId, cert.id);
    } catch (err) {
      // The read still answers; the certificate stays ready and the sweep or the next read issues it.
      console.error({ err, certId: cert.id }, 'certificate issue on a progress read failed');
      return { ...progress, issue: standing.issue };
    }
    return { ...(await this.progressOf(input.userId, cert)), issue: standing.issue };
  }

  private async progressOf(userId: string, cert: CertDefinition): Promise<ProgressReport> {
    const input = { userId, certId: cert.id };
    const completed = await this.completedSlugs(input.userId);
    const passed = await this.assessments.passedSlugs(input.userId);
    const existing = await this.existingGrant(input.userId, input.certId);
    try {
      return progressReport({
        userId: input.userId,
        cert,
        completedSlugs: completed,
        existingGrant: existing,
        passedAssessmentSlugs: passed,
      });
    } catch (err) {
      this.mapCertErr(err);
    }
  }

  async getAssessment(slug: string): Promise<AcademyQuiz> {
    const def = await this.assessments.definition(slug);
    if (!def) throw new AcademyError(`academy.assessment_unpublished slug=${slug}`, 'academy.assessment_unpublished');
    if (def.passMark === null) throw new AcademyError(`academy.pass_mark_unset slug=${slug}`, 'academy.pass_mark_unset');
    return {
      slug: def.slug,
      kind: def.kind,
      passMark: def.passMark,
      timeLimitSeconds: def.timeLimitSeconds ?? null,
      attemptLimit: def.attemptLimit,
      reviewMode: def.reviewMode ?? 'score_only',
      questions: def.questions.map((question) => ({
        id: question.id,
        prompt: question.prompt,
        kind: question.kind,
        points: question.points,
        choices: question.choices.map((choice) => ({ id: choice.id, text: choice.text })),
      })),
    };
  }

  async submitAssessment(input: {
    userId: string;
    slug: string;
    answers: readonly { questionId: string; choiceId: string }[];
    clientAttemptId: string;
    now?: Date;
  }): Promise<AttemptRow> {
    const row = await this.assessments.submit(input);
    await this.settleCertificatesNeeding(input.userId, `assessment:${input.slug}`, input.now ?? new Date());
    return row;
  }

  assessmentAttempts(userId: string, slug: string): Promise<VisibleAttemptRow[]> {
    return this.assessments.attempts(userId, slug);
  }

  /** AC-quizzes-03: Start (or resume) a timed attempt; see AssessmentRepository.start. */
  startQuizAttempt(input: { userId: string; slug: string; now?: Date }): Promise<AcademyQuizAttempt> {
    return this.assessments.start(input);
  }

  currentQuizAttempt(input: { userId: string; slug: string; now?: Date }): Promise<AcademyQuizAttempt | null> {
    return this.assessments.current(input);
  }

  answerQuizAttempt(input: { userId: string; attemptId: string; questionId: string; choiceId: string; now?: Date }) {
    return this.assessments.answer(input);
  }

  async finishQuizAttempt(input: { userId: string; attemptId: string; now?: Date }): Promise<AcademyQuizAttempt> {
    const attempt = await this.assessments.finish(input);
    await this.settleCertificatesNeeding(input.userId, `assessment:${attempt.slug}`, input.now ?? new Date());
    return attempt;
  }

  reviewQuizAttempt(input: { userId: string; attemptId: string; now?: Date }): Promise<AcademyQuizReview> {
    return this.assessments.review(input);
  }

  /** Staff publish or take down the quiz on one curriculum item (admin door, reason required). */
  setQuiz(input: AcademySetQuizInput & { operatorId: string; now?: Date }) {
    return this.assessments.setQuiz({ ...input, lesson: hasCurriculumSlug });
  }

  /**
   * Public verification. Malformed and unknown ids throw the same error with
   * the same message. The query does not select the account id or the
   * grant reference, and this method does not log either.
   */
  async certVerify(publicId: string): Promise<{
    certId: string;
    title: string;
    grantedAt: Date;
    status: 'valid' | 'revoked';
    holderName?: string;
  }> {
    if (!isPublicId(publicId)) throw new AcademyError('Certificate not found', 'academy.cert_not_found');
    const rows = await this.sql<
      Array<{ cert_id: string; granted_at: Date; status: string; holder_name: string | null; holder_consent_at: Date | null }>
    >`
      SELECT cert_id, granted_at, status, holder_name, holder_consent_at
        FROM academy.cert_grants
       WHERE public_id = ${publicId}
    `;
    const row = rows[0];
    if (!row) throw new AcademyError('Certificate not found', 'academy.cert_not_found');
    const title = await this.certTitle(row.cert_id);
    if (title === undefined) {
      throw new AcademyError(`academy.certificate_unpublished cert=${row.cert_id}`, 'academy.certificate_unpublished');
    }
    const status = row.status === 'valid' ? 'valid' : 'revoked';
    const body: { certId: string; title: string; grantedAt: Date; status: 'valid' | 'revoked'; holderName?: string } = {
      certId: row.cert_id,
      title,
      grantedAt: row.granted_at,
      status,
    };
    if (row.holder_name !== null && row.holder_consent_at !== null) body.holderName = row.holder_name;
    return body;
  }

  async setCertHolderName(input: {
    userId: string;
    grantId?: string | null;
    publicId?: string | null;
    holderName: string | null;
    clientRequestId: string;
    now?: Date;
  }): Promise<{ publicId: string; holderName: string | null; consentAt: Date | null }> {
    const clientRequestId = input.clientRequestId.trim();
    if (!clientRequestId) throw new AcademyError('clientRequestId is required', 'academy.holder_name_invalid');
    const grantId = input.grantId?.trim() || null;
    const publicId = input.publicId?.trim() || null;
    if ((grantId ? 1 : 0) + (publicId ? 1 : 0) !== 1) {
      throw new AcademyError('pass grantId or publicId', 'academy.holder_name_invalid');
    }
    const now = input.now ?? new Date();
    return transaction(this.sql, async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`${input.userId}:holder-name`}, 0))`;
      const replay = await tx<Array<{ public_id: string; holder_name: string | null; consent_at: Date | null }>>`
        SELECT public_id, holder_name, consent_at
          FROM academy.cert_holder_name_requests
         WHERE user_id = ${input.userId} AND client_request_id = ${clientRequestId}
      `;
      if (replay[0]) {
        return { publicId: replay[0].public_id, holderName: replay[0].holder_name, consentAt: replay[0].consent_at };
      }
      const name = normaliseHolderName(input.holderName);
      const grants = await tx<Array<{ public_id: string }>>`
        SELECT public_id FROM academy.cert_grants
         WHERE user_id = ${input.userId}
           AND (
             (${publicId}::text IS NOT NULL AND public_id = ${publicId})
             OR (${grantId}::text IS NOT NULL AND cert_id = ${grantId})
           )
         FOR UPDATE
      `;
      const owned = grants[0];
      if (!owned) throw new AcademyError('Certificate not found', 'academy.cert_not_found');
      const consentAt = name === null ? null : now;
      await tx`
        UPDATE academy.cert_grants
           SET holder_name = ${name}, holder_consent_at = ${consentAt}
         WHERE user_id = ${input.userId} AND public_id = ${owned.public_id}
      `;
      await tx`
        INSERT INTO academy.cert_holder_name_requests (user_id, client_request_id, public_id, holder_name, consent_at)
        VALUES (${input.userId}, ${clientRequestId}, ${owned.public_id}, ${name}, ${consentAt})
      `;
      return { publicId: owned.public_id, holderName: name, consentAt };
    });
  }

  private async liveInvite(roomId: string, userId: string): Promise<{ expiresAt: Date | null } | null> {
    const rows = await this.sql<Array<{ expires_at: Date | null }>>`
      SELECT expires_at FROM academy.room_invites WHERE room_id = ${roomId} AND user_id = ${userId}
    `;
    return rows[0] ? { expiresAt: rows[0].expires_at } : null;
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private assertHost(ownerId: string, callerId: string, what: 'room' | 'session'): void {
    if (ownerId !== callerId) throw new AcademyError(`You do not host this ${what}`, 'academy.not_host');
  }

  /**
   * May this account host at all? (§4.1 `rank_thresholds.perks.lobbyHostRights`.)
   *
   * Asked once, on `createRoom`, and NOT on the operations that follow —
   * `invite`, `scheduleSession`, `startSession`, `endSession` and `updateScene`
   * all check `assertHost` against a room this account already owns.
   *
   * That asymmetry is deliberate. Rank can fall, and a host whose rank slipped
   * mid-residency must still be able to end the session they are running and
   * empty the room. Re-checking the perk on `endSession` would strand live
   * attendees in a session nobody is allowed to close — the perk gates opening
   * a NEW room, not operating one that exists.
   */
  private async assertMayHost(userId: string): Promise<void> {
    const perks = await this.hostRights.perksOf(userId);
    if (!mayHost(perks)) {
      throw new AcademyError(
        'Hosting a lobby is a rank perk — your rank does not carry lobby host rights yet (§4.1)',
        'academy.host_rights_required',
      );
    }
  }
}

/** `part` of `whole` as a percentage with one decimal place, rounded half up, as a decimal string. Integer arithmetic only. */
function tenths(part: number, whole: number): string {
  if (whole <= 0) return '0.0';
  const t = Math.floor((part * 2000 + whole) / (2 * whole));
  return `${Math.floor(t / 10)}.${t % 10}`;
}

function curriculumItemView(slug: string) {
  const item = getCurriculumItem(slug.trim());
  if (!item) {
    throw new AcademyError(`Curriculum item "${slug}" is not in the day-one spine`, 'academy.curriculum_not_found');
  }
  return {
    slug: item.slug,
    title: item.title,
    kind: item.kind,
    path: item.path,
    order: item.order,
    summary: item.summary,
    estimatedMinutes: item.estimatedMinutes,
    body: item.body,
    objectives: [...item.objectives],
    keyTerms: item.keyTerms.map((term) => ({ term: term.term, definition: term.definition })),
    selfCheck: [...item.selfCheck],
  };
}
