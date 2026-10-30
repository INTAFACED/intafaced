import { z } from 'zod';
import { AuthError, requireMfa, type Principal } from '@intafaced/auth';
import {
  router,
  publicProcedure,
  scopedProcedure,
  TRPCError,
  rankPerksSchema,
  academyRelatedInputSchema,
  academyPublicCatalogueInputSchema,
  academyPublicVideoSchema,
  academyPublicCourseCardSchema,
  academyPublicCourseSchema,
  academyCourseEnrolmentSchema,
  academyEnrolCourseInputSchema,
  academyMyCourseSchema,
  academyAccessGrantSchema,
  academyCourseOutlineSchema,
  academyQuizAttemptSchema,
  academyQuizReviewSchema,
  academyQuizSchema,
  academySetQuizInputSchema,
  academySetCertIssueRuleInputSchema,
  academySaveProgrammeInputSchema,
  academySaveDiscussionTopicInputSchema,
  academyDiscussionTopicSchema,
  academyDiscussionCourseSchema,
  academyDiscussionCoursesInputSchema,
  academyDiscussionTopicsSchema,
  academyDiscussionTopicsInputSchema,
  academyDiscussionPostSchema,
  academyDiscussionPostsInputSchema,
  academyDiscussionReplySchema,
  academyDiscussionThreadSchema,
  academyDiscussionThreadInputSchema,
  academyDiscussionPostImageInputSchema,
  academyDiscussionImageSchema,
  academyDiscussionFollowResultSchema,
  academyDiscussionLikeResultSchema,
  academyDiscussionAcceptResultSchema,
  academyCreateDiscussionPostInputSchema,
  academyReplyDiscussionPostInputSchema,
  academyAcceptDiscussionReplyInputSchema,
  academyDiscussionToggleInputSchema,
  academyStaffDiscussionThreadSchema,
  academySendCourseMessageInputSchema,
  academySendCourseMessageResultSchema,
  academyCourseConversationsInputSchema,
  academyCourseConversationInputSchema,
  academyCourseConversationSummarySchema,
  academyCourseConversationSchema,
  academyStaffConversationSummarySchema,
  academyStaffConversationSchema,
  academyReplyCourseMessageInputSchema,
  academyProgrammeRecordSchema,
  academyProgrammeSchema,
  academyProgrammeInputSchema,
  academyProgrammesInputSchema,
  academyCertIssueRuleSchema,
  academyCertIssueSchema,
  academyCertIdSchema,
  academyCertRevocationSchema,
  academyRevokeCertInputSchema,
  academyItemVideoSchema,
  academySetItemVideoInputSchema,
  academySetVideoTracksInputSchema,
  academyVideoPlayerSchema,
  academyVideoPositionSavedSchema,
  academyVideoPositionSchema,
  academyVideoTrackSchema,
  academyProgressPageSchema,
  academyPlannerSchema,
  academyPlannerTodoSchema,
  academyGoalSchema,
  academyGoalReminderSchema,
  academyAddTodoInputSchema,
  academySetTodoDoneInputSchema,
  academyRemoveTodoInputSchema,
  academySetGoalInputSchema,
  academyUndoCompletionInputSchema,
  academyUndoCompletionSchema,
  academyPublicHubSchema,
  academyCourseSchema,
  academyCourseDetailSchema,
  academyCourseListSchema,
  academyCourseListInputSchema,
  academyCreateCourseInputSchema,
  academyUpdateCourseInputSchema,
  academySetCourseStateInputSchema,
  academySaveOutlineInputSchema,
  academyLessonSchema,
  academySaveLessonInputSchema,
  academyRevertLessonInputSchema,
  academyPublishLessonInputSchema,
  academyDuplicateItemInputSchema,
  academyImportLessonInputSchema,
  academyAssistantDraftInputSchema,
  academyDecideDraftInputSchema,
  academyImportLessonResultSchema,
  academyItemMediaSchema,
  academyWithdrawLessonInputSchema,
  academyFeaturedSlotSchema,
  academyFeatureLessonInputSchema,
  academyClearFeaturedInputSchema,
  academyTopicListSchema,
  academyAuthoredCourseEnrolmentSchema,
  academyAuthoredCourseInputSchema,
  academyCourseByLinkInputSchema,
  academyLeaveAuthoredCourseInputSchema,
  academyAdminAssignmentSchema,
  academyAdminCourseQuizSchema,
  academyCourseQuizInputSchema,
  academyLearnerCourseQuizSchema,
  academySaveCourseQuizInputSchema,
  academySetCourseQuizStateInputSchema,
  academyStartCourseQuizInputSchema,
  academyCourseReleaseInputSchema,
  academyCourseReleaseSchema,
  academySetSectionReleaseInputSchema,
  academySetCoursePacingInputSchema,
  academyCourseItemRulesSchema,
  academyCourseItemRulesInputSchema,
  academySetCourseItemPrerequisitesInputSchema,
  academyGrantCourseExtensionInputSchema,
  academyCourseGradebookSchema,
  academyCourseGradebookInputSchema,
  academySaveGradingPolicyInputSchema,
  academyCourseQuizAttemptSchema,
  academyAnswerCourseQuizInputSchema,
  academyFinishCourseQuizInputSchema,
  academySubmitCourseSurveyInputSchema,
  academySurveySubmittedSchema,
  academyCourseQuizReviewsSchema,
  academyScoreCourseQuizEssaysInputSchema,
  academyCourseQuizAttemptsSchema,
  academyFixCourseQuizKeyInputSchema,
  academyRescoreCourseQuizInputSchema,
  academyRescoreCourseQuizResultSchema,
  academyOverrideCourseQuizScoreInputSchema,
  academyAssignmentInputSchema,
  academyAssignmentViewSchema,
  academySaveAssignmentInputSchema,
  academySaveReviewStepsInputSchema,
  academyPeerReviewInputSchema,
  academyGradingQueueInputSchema,
  academyGradingQueueSchema,
  academyOpenGradingInputSchema,
  academyGradeSubmissionInputSchema,
  academyBulkGradeInputSchema,
  academyBulkGradeResultSchema,
  academyMarkFeedbackReadInputSchema,
  academyPeerReviewFileInputSchema,
  academyPeerReviewFileSchema,
  academyReviewStateSchema,
  academySubmitPeerReviewInputSchema,
  academySubmissionFileSchema,
  academySubmitAssignmentInputSchema,
  academyUploadAssignmentFileInputSchema,
  academyWithdrawAssignmentInputSchema,
  academyPublishedCourseListSchema,
  academyPublishedCoursesInputSchema,
  academyCourseIdInputSchema,
  academyCourseLearnerViewSchema,
  academyCreatedPrivateLinkSchema,
  academyCreatePrivateLinkInputSchema,
  academyPrivateLinkListSchema,
  academyPrivateLinkSchema,
  academyRevokePrivateLinkInputSchema,
  academyCreateTopicInputSchema,
  academyTopicSchema,
  academySetCourseTopicsInputSchema,
  academyMediaIntentInputSchema,
  academyMediaIntentSchema,
  academyConfirmMediaInputSchema,
  academyMediaSchema,
  academySetItemCaptionsInputSchema,
  academySetItemCaptionsResultSchema,
} from '@intafaced/contracts';
import { formatAmount, parseAmount } from '@intafaced/ledger-client';
import { DualControlError } from './dual-control.js';
import {
  ActionApprovalConsumeError,
  academyActionPayloadHash,
  readApprovalIds,
  unwiredApprovalConsumer,
  type ActionApprovalConsumer,
} from './action-approval-consume.js';
import { AcademyError } from './errors.js';
import { gradeReportProcedures } from './curriculum/grade-reports-router.js';
import { relatedItems } from './curriculum/related.js';
import { listPublicCourses, searchPublicCurriculum } from './curriculum/public-catalogue.js';
import { OwnerDecisionError } from './curriculum/lessons.js';
import { settingsRegister, type SettingsEnv } from './settings/register.js';
import { userCopy } from './user-copy.js';
import type { AcademyService, AttendeeRole, RoomRecord, SessionRecord } from './academy-service.js';
import type { CallerSeat } from './learning/customer-store.js';
import { VerifyRateLimiter, type VerifyRate } from './certs/verify-rate.js';
import {
  AmbassadorPayRefuseError,
  ambassadorPayPlaneStatus,
  attemptAmbassadorPay,
  attemptResidencyIfcPay,
  decidePublicAmbassadorPayQuote,
  decidePublicResidencyPayQuote,
} from './ambassadors/ifc-pay.js';
import {
  PrizePoolRefuseError,
  assertMayStartPrizeSeason,
  decidePrizeIntent,
  decidePrizePoolStart,
  isPrizeRefuseClosed,
  prizeRefuseStatusLine,
  type PrizeIntentKind,
} from './tournaments/prize-refuse.js';
import {
  AmbassadorRateAuthorityRefuseError,
  UNPUBLISHED_AMBASSADOR_IFC_PAY_LAW,
  UNPUBLISHED_AMBASSADOR_REVENUE_SHARE_LAW,
  type AmbassadorIfcPayLaw,
  type AmbassadorRevenueShareLaw,
} from './ambassadors/ifc-pay-rate-law.js';
import {
  assertCurriculumPageLimit,
  curriculumDepthReport,
  curriculumStudyGuide,
  getCurriculumItem,
  listCurriculum,
  listCurriculumStudyGuides,
} from './curriculum/catalog.js';
import { curriculumInventory, curriculumImportStageStatus } from './curriculum/import-pipeline.js';
import { resolveCurriculumDeepLink, listCurriculumPathDeepLinks } from './curriculum/deep-links.js';
import {
  drillProgress,
  isDrillComplete,
  listPaperFillRefs,
  remainingStepIds,
  replayPaperDrill,
  startPaperDrillForCatalogItem,
} from './paper/workbook-loop.js';
import { PAPER_OPS_ENV_KEY, PAPER_OPS_FLAG_ID } from './paper/ops-gate.js';
import {
  assertSealedSimulated,
  sealSimulated,
  SIMULATED_VENUE,
  valueSimulatedDrill,
  type PublishedFill,
} from './paper/simulated-result.js';
import { assertPaperInputNeverClaimsLive, assertPaperNeverReadableAsRealMoney } from './paper/real-money-ban.js';
import { CERT_XP_ACTION, CERT_XP_SOURCE_MODULE } from './certs/xp-publish.js';
import {
  CERT_PERK_REFUSE_CODE,
  CERT_PERK_RESIDUAL,
  decideCertPerkInvent,
  isCertPerkInventRefuseClosed,
  type CertPerkInventKind,
} from './certs/perk-plane.js';
import { bulkScoreStatusLine, validateBulkScoreWrite } from './tournaments/bulk-score.js';
import { seasonWindowAt } from './tournaments/season-calendar.js';
import { describeTournamentPolicy } from './tournaments/tournament-policy.js';
import {
  assertAcademyVideoEntitled,
  assertAcademyVideoUrlGranted,
  grantAcademyVideoCaptions,
  grantAcademyVideoPlayback,
  grantAcademyVideoTranscript,
  listAcademyVideos,
  unconfiguredVideoLibrary,
  type VideoLibraryDeps,
} from './video/library.js';
import { decideWatched, requireSpineItem } from './video/player.js';

/**
 * svc-academy's API — lobbies + thin curriculum catalog (§8.3, §XIII).
 *
 * ── Authorisation, stated once ──────────────────────────────────────────────
 *
 * A SEAT is the only thing this service grants on the lobby surface, and it
 * grants it to `ctx.principal.userId` and nobody else. No procedure takes a
 * userId from the input except `invite`, where naming someone else IS the
 * operation — and that one is host-only, so the caller must already own the
 * room they are inviting into.
 *
 * Host-side procedures take the same principal and let the service compare it
 * against the room's or session's `host_id`. Whether an account may open a room
 * in the FIRST place is not a scope question at all: it is §4.1's
 * `lobbyHostRights` perk, read from svc-identity at `createRoom`. See
 * host-rights.ts for why the scope could not carry that.
 *
 * Curriculum procedures are read-only catalog lookups. They take no userId and
 * write no progress. Progress, certification and the XP a certification is
 * worth are the `cert*` procedures at the bottom of this file, and they are
 * scoped the same way: the caller's own progress, never a userId from input.
 *
 * `academy` is `minTier: 'none'` in the jurisdiction matrix (nothing custodial
 * happens here), so `{ module: 'academy' }` is doing region work, not
 * verification work. That is the correct gate: a blocked region is a legal
 * constraint on serving it at all.
 */

/** A stake threshold on the wire is a decimal string, like every other amount. */
const amountString = z.string().regex(/^\d+(\.\d{1,18})?$/, 'amounts are unsigned decimal strings (max 18dp)');

const roomKind = z.enum(['general', 'futures', 'options', 'meme_war_room', 'forex', 'defi_lab', 'merchant_clinic']);
const roomAccess = z.enum(['free', 'staked', 'invite']);
const sessionStatus = z.enum(['scheduled', 'live', 'ended', 'cancelled']);
/** Matches Blueprint `curriculumPath` — the only paths the catalog knows. */
const curriculumPath = z.enum(['foundations', 'markets', 'builder', 'sovereign']);
const curriculumKind = z.enum(['playbook', 'workbook', 'lesson']);

const roomOut = z.object({
  id: z.string().guid(),
  slug: z.string(),
  name: z.string(),
  kind: roomKind,
  access: roomAccess,
  minStake: amountString,
  capacity: z.number().int(),
  hostId: z.string().guid(),
  seated: z.boolean(),
  role: z.enum(['host', 'speaker', 'attendee']).nullable(),
});

const sessionOut = z.object({
  id: z.string().guid(),
  roomId: z.string().guid(),
  title: z.string(),
  hostId: z.string().guid(),
  status: sessionStatus,
  startsAt: z.date(),
  endsAt: z.date().nullable(),
  /** Null when no SFU is configured — the lobby still runs as text and presence. */
  streamProvider: z.string().nullable(),
  scene: z.record(z.string(), z.unknown()),
  /** Always on read — client supplies this as expectedFingerprint on updateScene. */
  sceneFingerprint: z.string().min(1),
  seated: z.boolean(),
  role: z.enum(['host', 'speaker', 'attendee']).nullable(),
});

const curriculumSummaryOut = z.object({
  slug: z.string(),
  title: z.string(),
  kind: curriculumKind,
  path: curriculumPath,
  order: z.number().int(),
  summary: z.string(),
  /** Derived from the body, never hand-typed — see `readingMinutes` in curriculum/content.ts. */
  estimatedMinutes: z.number().int().positive(),
});

const curriculumKeyTermOut = z.object({ term: z.string(), definition: z.string() });

/**
 * The teaching scaffolding that turns a markdown blob into a screen: what a
 * reader should be able to do, the vocabulary the body assumes, and the
 * questions that reveal whether they got it. Nothing here is graded — grading
 * and XP belong to the `cert*` procedures.
 */
const curriculumTeachingOut = {
  objectives: z.array(z.string()).min(1),
  keyTerms: z.array(curriculumKeyTermOut).min(1),
  selfCheck: z.array(z.string()).min(1),
};

const curriculumItemOut = curriculumSummaryOut.extend({
  body: z.string(),
  ...curriculumTeachingOut,
});

const curriculumStudyGuideOut = curriculumSummaryOut
  .omit({ order: true, summary: true })
  .extend({ ...curriculumTeachingOut, bodyChars: z.number().int().nonnegative() });

const curriculumDepthOut = z.object({
  total: z.number().int(),
  deep: z.number().int(),
  thin: z.number().int(),
  thinSlugs: z.array(z.string()),
  minBodyChars: z.number().int(),
  shortestBodyChars: z.number().int(),
  totalBodyChars: z.number().int(),
  allDeep: z.boolean(),
});

const curriculumInventoryOut = z.object({
  contentSource: z.enum(['platform-native-expansion', 'licensed-import-pending']),
  spine: z.object({
    total: z.number().int(),
    playbooks: z.number().int(),
    workbooks: z.number().int(),
    lessons: z.number().int(),
  }),
  titleTarget: z.object({ playbooks: z.number().int(), workbooks: z.number().int() }),
  titlePromiseMet: z.boolean(),
  residualPlaybooks: z.number().int(),
  residualWorkbooks: z.number().int(),
});

const curriculumDeepLinkOut = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    path: curriculumPath,
    slug: z.string().nullable(),
    href: z.string(),
  }),
  z.object({
    ok: z.literal(false),
    reason: z.enum(['unknown_path', 'unknown_slug', 'path_mismatch']),
    message: z.string(),
  }),
]);

const curriculumImportStatusOut = z.object({
  contentSource: z.enum(['platform-native-expansion', 'licensed-import-pending']),
  titlePromiseMet: z.boolean(),
  residualPlaybooks: z.number().int(),
  residualWorkbooks: z.number().int(),
  stage1Pipeline: z.literal(true),
  stage2CatalogExpanded: z.boolean(),
  stage3Polish: z.object({
    deepLinksVerified: z.boolean(),
    i18nStrategyHonest: z.boolean(),
    ready: z.boolean(),
  }),
  /** D26-P1-C5 — real lesson substance, not char-count theater. */
  substanceBarMet: z.boolean(),
  theaterSlugs: z.array(z.string()),
});

const curriculumItemLocalizedOut = curriculumItemOut.extend({
  locale: z.string(),
  fellBack: z.boolean(),
  i18nStrategy: z.string(),
});

/**
 * The seal, as a SCHEMA — every field a literal.
 *
 * This is the labelling rule enforced by the type system rather than by
 * remembering. A handler that returns a paper payload without `simulated: true`
 * does not compile, and one that somehow gets past that is rejected by the
 * output parser at runtime. The alternative — a `simulated?: boolean` a caller
 * is trusted to set — is the version that ships unlabelled on the day someone
 * adds a field in a hurry.
 *
 * `realMoney: false` is the D26-P1-C4 harden — paper flag never readable as
 * real money even if a client only checks one bit.
 */
const simulatedSealOut = {
  simulated: z.literal(true),
  venue: z.literal(SIMULATED_VENUE),
  realLedger: z.literal(false),
  withdrawable: z.literal(false),
  realMoney: z.literal(false),
  disclaimer: z.string().min(1),
};

const paperDrillOut = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    ...simulatedSealOut,
    marketId: z.string(),
    symbol: z.string(),
    steps: z.array(z.object({ id: z.string(), instruction: z.string() })),
  }),
  z.object({
    ok: z.literal(false),
    reason: z.enum(['not_paper', 'no_market', 'unknown_step', 'bad_fill']),
    message: z.string(),
  }),
]);

/**
 * A trade-published fill, as it may arrive.
 *
 * `price` and `size` are `z.string()` and there is no `z.coerce` anywhere near
 * them. A body carrying `"price": 68412.5` is a 400 rather than a float in a
 * book — doctrine §0.6's "never a number" does not have a practice exemption,
 * because a wrong practice figure is still a figure this platform published.
 */
const publishedFillIn = z
  .object({
    fillId: z.string().min(1).max(128),
    marketId: z.string().min(1),
    side: z.enum(['buy', 'sell']),
    price: z.string().min(1),
    size: z.string().min(1),
    recordedAt: z.date().optional(),
  })
  .strict();

/** Trade's paper flag only. Extra live/realMoney keys must refuse, not strip. */
const paperMarketFlagIn = z
  .object({
    marketId: z.string().min(1),
    paper: z.boolean(),
    symbol: z.string().min(1),
  })
  .strict();

const simulatedValuationOut = z.object({
  // Nested seal — valuation alone cannot be read as live money if parent seal stripped
  simulated: z.literal(true),
  venue: z.literal(SIMULATED_VENUE),
  realLedger: z.literal(false),
  withdrawable: z.literal(false),
  realMoney: z.literal(false),
  disclaimer: z.string().min(1),
  fillCount: z.number().int(),
  boughtSize: z.string(),
  soldSize: z.string(),
  openSize: z.string(),
  averageBuyPrice: z.string().nullable(),
  averageSellPrice: z.string().nullable(),
  realisedPnl: z.string(),
  /** Null, never a guess, when trade published no mark for the open size. */
  unrealisedPnl: z.string().nullable(),
  totalPnl: z.string().nullable(),
  markUnavailable: z.boolean(),
});

const paperDrillResultOut = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    ...simulatedSealOut,
    result: z.object({
      workbookSlug: z.string(),
      marketId: z.string(),
      symbol: z.string(),
      status: z.enum(['active', 'complete', 'refused']),
      stepCount: z.number().int(),
      completedCount: z.number().int(),
      remainingStepIds: z.array(z.string()),
      ratio: z.string(),
      complete: z.boolean(),
      valuation: simulatedValuationOut,
    }),
  }),
  z.object({
    ok: z.literal(false),
    reason: z.enum(['not_paper', 'no_market', 'unknown_step', 'bad_fill']),
    message: z.string(),
  }),
]);

const ambassadorStatus = z.enum(['active', 'frozen']);
const ambassadorOut = z.object({
  userId: z.string().guid(),
  status: ambassadorStatus,
  appointedBy: z.string().guid(),
  appointedAt: z.date(),
  frozenAt: z.date().nullable(),
  frozenBy: z.string().guid().nullable(),
  freezeReason: z.string().nullable(),
});
const ambassadorBadgeOut = z.object({
  userId: z.string().guid(),
  isAmbassador: z.boolean(),
  status: ambassadorStatus.nullable(),
});

const seasonStatus = z.enum(['scheduled', 'live', 'frozen', 'ended']);
const seasonOut = z.object({
  id: z.string().guid(),
  slug: z.string(),
  title: z.string(),
  status: seasonStatus,
  rulesSummary: z.string(),
  startsAt: z.date(),
  endsAt: z.date().nullable(),
});
const standingOut = z.object({
  seasonId: z.string().guid(),
  userId: z.string().guid(),
  score: z.number().int(),
  updatedAt: z.date(),
  rank: z.number().int(),
});

const seasonCalendarOut = z.object({
  seasonId: z.string().guid(),
  status: seasonStatus,
  startsAt: z.date(),
  endsAt: z.date().nullable(),
  openAt: z.date(),
  inWindow: z.boolean(),
  scoreWindowOpen: z.boolean(),
});

const residencyStatus = z.enum(['applied', 'accepted', 'rejected', 'withdrawn']);
const residencyOut = z.object({
  id: z.string().guid(),
  userId: z.string().guid(),
  cohortSlug: z.string(),
  statement: z.string(),
  status: residencyStatus,
  appliedAt: z.date(),
  decidedAt: z.date().nullable(),
  decidedBy: z.string().guid().nullable(),
  decisionNote: z.string().nullable(),
});
/** Public IFC / residency pay door — typed refuse only (no quote amounts). */
const publicAmbassadorPayQuoteOut = z.object({
  status: z.literal('refuse'),
  ok: z.literal(false),
  payable: z.literal(false),
  inventedIfc: z.literal(false),
  kind: z.enum(['ifc_pay', 'revenue_share', 'residency']),
  code: z.enum([
    'academy.ambassador_pay.rates_unset',
    'academy.ambassador_pay.class_m',
    'academy.ambassador_pay.recipe_unset',
    'academy.ambassador_pay.invent_refused',
    'academy.ambassador_pay.residency_not_accepted',
    'academy.ambassador_revenue_share.rates_unset',
    'academy.ambassador_revenue_share.class_m',
    'academy.ambassador_revenue_share.recipe_unset',
    'academy.ambassador_revenue_share.invent_refused',
    'academy.ambassador_revenue_share.residency_not_accepted',
  ]),
  reason: z.enum(['unset', 'invent', 'class_m']),
  rateAuthorityPublished: z.boolean(),
  residual: z.string(),
  message: z.string(),
});

const certDefinitionOut = z.object({
  id: z.string(),
  title: z.string(),
  requiredItemSlugs: z.array(z.string()),
});
const enrollmentOut = z.object({
  userId: z.string().guid(),
  pathSlug: z.string(),
  enrolledAt: z.date(),
});
const leaveOut = enrollmentOut.extend({ leftAt: z.date() });
const completionPageOut = z.object({
  items: z.array(z.object({ itemSlug: z.string(), completedAt: z.date() })),
  nextCursor: z.string().nullable(),
});
const learningStateOut = z.object({
  lastItemSlug: z.string().nullable(),
  lastOpenedAt: z.date().nullable(),
  secondsRead: z.number().int(),
  activeDays: z.number().int(),
});
const cohortOut = z.object({
  slug: z.string(),
  startsAt: z.date().nullable(),
  endsAt: z.date().nullable(),
  capacity: z.number().int().nullable(),
  entryRules: z.string().nullable(),
  seatsLeft: z.number().int().nullable(),
});
const videoProgressOut = academyVideoPositionSchema;
const metricCellOut = z.object({
  value: z.number().int().nullable(),
  reason: z.enum(['metric_not_recorded']).nullable(),
});
const attendeeRole = z.enum(['host', 'speaker', 'attendee']);
const upcomingSessionOut = sessionOut.extend({ seated: z.literal(true), role: attendeeRole });
const itemCompletionOut = z.object({
  userId: z.string().guid(),
  itemSlug: z.string(),
  completedAt: z.date(),
});
const certGrantOut = z.object({
  userId: z.string().guid(),
  certId: z.string(),
  grantedAt: z.date(),
  idempotencyKey: z.string(),
  publicId: z.string().regex(/^[0-9a-f]{32}$/),
  /** `revoked` once staff revoked it (AC-certificates-03); the public check then says revoked too. */
  status: z.enum(['valid', 'revoked']).optional(),
});
/**
 * Stage-2 XP outcome on a grant.
 *
 * Reported rather than thrown: a certification that was earned is granted even
 * when its award could not be published, and a client that cannot tell those
 * apart cannot tell the user whether to expect their rank to move. `reason` is
 * a machine id — the shell owns the sentence and its i18n key (§9).
 */
const certXpOut = z.discriminatedUnion('emitted', [
  z.object({ emitted: z.literal(true), idempotencyKey: z.string(), xpDelta: z.number().int() }),
  z.object({
    emitted: z.literal(false),
    reason: z.enum(['no_policy', 'not_publishable', 'delta_unrepresentable', 'publisher_unavailable', 'publish_failed']),
  }),
]);
const certXpPlaneOut = z.object({
  publisherId: z.string(),
  emitEnabled: z.boolean(),
  sourceModule: z.literal(CERT_XP_SOURCE_MODULE),
  action: z.literal(CERT_XP_ACTION),
  rankWriter: z.literal('svc-identity'),
  policies: z.array(z.object({ certId: z.string(), xpDelta: z.number().int() })),
});
const certPerkInventKind = z.enum(['cert_to_perk_map', 'invent_perk_money', 'invent_fee_discount', 'invent_ifc_grant', 'invent_balance']);
const certPerkOutcomeOut = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('real'),
    path: z.literal('identity_rank'),
    sot: z.literal('svc-identity'),
    academyHoldsPerkMoney: z.literal(false),
    academyMapsCertToPerk: z.literal(false),
    perks: rankPerksSchema,
  }),
  z.object({
    status: z.literal('refuse'),
    code: z.literal(CERT_PERK_REFUSE_CODE),
    reason: z.enum(['identity_unreadable', 'unpriced']),
    message: z.string(),
    academyHoldsPerkMoney: z.literal(false),
    academyMapsCertToPerk: z.literal(false),
    residual: z.literal(CERT_PERK_RESIDUAL),
  }),
]);
const certPerkPlaneOut = z.object({
  perksEnabledViaIdentity: z.literal(true),
  academyMapsCertToPerk: z.literal(false),
  academyHoldsPerkMoney: z.literal(false),
  rankWriter: z.literal('svc-identity'),
  residual: z.literal(CERT_PERK_RESIDUAL),
  inventKindsRefuseClosed: z.array(certPerkInventKind),
  statusLine: z.string(),
});
const certProgressOut = z.object({
  userId: z.string().guid(),
  certId: z.string(),
  title: z.string(),
  requiredCount: z.number().int(),
  completedCount: z.number().int(),
  ratio: z.string(),
  missingItemSlugs: z.array(z.string()),
  complete: z.boolean(),
  granted: z.boolean(),
  grantIdempotencyKey: z.string().nullable(),
  issue: academyCertIssueSchema,
});

const seatFor = (seats: readonly CallerSeat[], id: string, kind: 'room' | 'session'): { role: AttendeeRole } | null => {
  const hit = seats.find((s) => (kind === 'room' ? s.roomId === id : s.sessionId === id));
  return hit ? { role: hit.role } : null;
};

const serialiseRoom = (room: RoomRecord, seat: { role: AttendeeRole } | null = null): z.infer<typeof roomOut> => ({
  ...room,
  minStake: formatAmount(room.minStake),
  seated: seat !== null,
  role: seat?.role ?? null,
});

const serialiseSession = (session: SessionRecord, seat: { role: AttendeeRole } | null = null): z.infer<typeof sessionOut> => ({
  ...session,
  seated: seat !== null,
  role: seat?.role ?? null,
});

/**
 * Error codes are preserved, not flattened.
 *
 * `academy.room_full` (wait) and `academy.stake_required` (stake) are both "you
 * cannot sit down", and a client that cannot tell them apart cannot tell the
 * user what to do next. `academy.stream_unavailable` is a deployment fact, not
 * a bad request, and it is reported as one.
 */
function toTrpcError(err: unknown): TRPCError {
  if (err instanceof TRPCError) return err;
  // The allowlisted owner-decision refusal (no academy code): a path that waits for the owner's choice.
  if (err instanceof OwnerDecisionError) return new TRPCError({ code: 'PRECONDITION_FAILED', message: err.message, cause: err });
  if (err instanceof DualControlError) {
    return new TRPCError({ code: 'PRECONDITION_FAILED', message: err.message, cause: err });
  }
  if (err instanceof ActionApprovalConsumeError) {
    return new TRPCError({ code: 'PRECONDITION_FAILED', message: `${err.message} [${err.code}]`, cause: err });
  }
  if (err instanceof AmbassadorPayRefuseError) {
    // PRECONDITION_FAILED: operator asked for pay before owner rates + ledger recipe exist.
    return new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: err.message,
      cause: err,
    });
  }
  if (err instanceof AmbassadorRateAuthorityRefuseError) {
    return new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: err.message,
      cause: err,
    });
  }
  if (err instanceof PrizePoolRefuseError) {
    // PRECONDITION_FAILED: blank pool cannot start; amount present still Class M refuse (no invent IFC).
    return new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: err.message,
      cause: err,
    });
  }
  if (!(err instanceof AcademyError)) {
    return new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Request failed', cause: err });
  }

  const message = userCopy(err.code);

  switch (err.code) {
    case 'academy.room_not_found':
    case 'academy.session_not_found':
    case 'academy.curriculum_not_found':
    case 'academy.course_not_found':
      return new TRPCError({ code: 'NOT_FOUND', message, cause: err });

    case 'academy.not_host':
    case 'academy.stake_required':
    case 'academy.invite_required':
    case 'academy.host_rights_required':
      return new TRPCError({ code: 'FORBIDDEN', message, cause: err });

    case 'academy.room_full':
    case 'academy.session_not_live':
      return new TRPCError({ code: 'CONFLICT', message, cause: err });

    case 'academy.scene_invalid':
    case 'academy.scene_conflict':
    case 'academy.scene_presence_collision':
    case 'academy.ambassador_invalid':
    case 'academy.residency_invalid':
      // Client sent a scene that fails Stage-1 schema or size gate /
      // freeze reason that fails Stage-1 programme rules /
      // residency statement/cohort that fails Stage-1 rules.
      return new TRPCError({ code: 'BAD_REQUEST', message, cause: err });

    case 'academy.ambassador_not_found':
    case 'academy.residency_not_found':
      return new TRPCError({ code: 'NOT_FOUND', message, cause: err });

    case 'academy.ambassador_already_active':
    case 'academy.ambassador_already_frozen':
    case 'academy.residency_already_open':
    case 'academy.residency_not_pending':
    case 'academy.cert_already_granted':
    case 'academy.cert_incomplete':
    case 'academy.cert_not_due':
    case 'academy.cert_revoked':
      return new TRPCError({ code: 'CONFLICT', message, cause: err });

    case 'academy.cert_not_found':
      return new TRPCError({ code: 'NOT_FOUND', message, cause: err });

    case 'academy.cert_invalid':
      return new TRPCError({ code: 'BAD_REQUEST', message, cause: err });

    case 'academy.season_not_found':
      return new TRPCError({ code: 'NOT_FOUND', message, cause: err });

    case 'academy.tournament_disabled':
    case 'academy.paper_trading_disabled':
      return new TRPCError({ code: 'FORBIDDEN', message, cause: err });

    case 'academy.paper_flag_unverified':
      return new TRPCError({ code: 'PRECONDITION_FAILED', message: err.message, cause: err });

    case 'academy.paper_flag_mismatch':
    case 'academy.paper_market_unlisted':
      return new TRPCError({ code: 'FORBIDDEN', message: err.message, cause: err });

    case 'academy.season_not_live':
      return new TRPCError({ code: 'CONFLICT', message, cause: err });

    case 'academy.season_invalid':
    case 'academy.standing_invalid':
      return new TRPCError({ code: 'BAD_REQUEST', message, cause: err });

    case 'academy.paper_price_unavailable':
    case 'academy.paper_result_unlabelled':
    case 'academy.paper_looks_like_real_money':
      // Neither is the caller's fault and neither may be softened into a
      // partial answer. "No price was published", "this figure lost its
      // simulated label", and "this payload claimed real custody" are all
      // states where the only safe payload is no payload — a 200 carrying a
      // best guess is the incident this row exists to prevent.
      return new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message, cause: err });

    case 'academy.stake_unavailable':
    case 'academy.stream_unavailable':
    case 'academy.host_rights_unavailable':
    case 'academy.paper_flag_unavailable':
      // All three are OUR infrastructure, not the caller's request, and the
      // distinction matters to a client: a 403 tells someone to go and stake or
      // rank up, and telling them that because svc-token was unreachable sends
      // them to do something they have already done. A 500 says "try again".
      return new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message, cause: err });

    case 'academy.video_storage_unconfigured':
    case 'academy.video_url_ttl_unset':
    case 'academy.video_s3_region_unset':
    case 'academy.room_capacity_unset':
    case 'academy.standings_limit_unset':
    case 'academy.programme_list_limit_unset':
    case 'academy.residency_list_limit_unset':
    case 'academy.curriculum_list_limit_unset':
    case 'academy.paper_list_limit_unset':
    case 'academy.paper_markets_limit_unset':
    case 'academy.season_list_limit_unset':
    case 'academy.ambassadors_list_limit_unset':
    case 'academy.rooms_list_limit_unset':
    case 'academy.sessions_list_limit_unset':
    case 'academy.seasons_list_limit_unset':
    case 'academy.open_residencies_list_limit_unset':
    case 'academy.my_residencies_list_limit_unset':
    case 'academy.my_certs_list_limit_unset':
    case 'academy.my_completions_list_limit_unset':
    case 'academy.residency_cohorts_list_limit_unset':
    case 'academy.my_upcoming_sessions_list_limit_unset':
    case 'academy.grant_audit_list_limit_unset':
    case 'academy.prerequisite_unmet':
      return new TRPCError({
        code: 'PRECONDITION_FAILED',
        message: err.code === 'academy.prerequisite_unmet' ? err.message : message,
        cause: err,
      });

    case 'academy.goal_invalid':
    case 'academy.captions_invalid':
    case 'academy.seconds_out_of_range':
    case 'academy.video_position_out_of_range':
    case 'academy.metrics_range_invalid':
      return new TRPCError({ code: 'BAD_REQUEST', message: err.message, cause: err });

    case 'academy.video_not_found':
    case 'academy.enrollment_not_found':
    case 'academy.path_not_found':
      return new TRPCError({ code: 'NOT_FOUND', message, cause: err });

    case 'academy.assessment_unpublished':
    case 'academy.pass_mark_unset':
    case 'academy.quiz_no_questions':
    case 'academy.scoring_policy_unset':
    case 'academy.ip_unreadable':
    case 'academy.not_released_yet':
    case 'academy.certificate_unpublished':
    case 'academy.enrolment_closed':
    case 'academy.verify_rate_unset':
    case 'academy.verify_address_unset':
    case 'academy.cert_delay_unset':
    case 'academy.cert_sweep_unset':
    case 'academy.video_captions_unpublished':
    case 'academy.video_transcript_unpublished':
    case 'academy.watch_threshold_unset':
    case 'academy.completion_rule_unmet':
    case 'academy.grades_hidden':
    case 'academy.planner_limit_unset':
      return new TRPCError({ code: 'PRECONDITION_FAILED', message: err.message, cause: err });

    case 'academy.request_reused':
    case 'academy.attempt_closed':
    case 'academy.attempt_open':
    case 'academy.attempt_required':
    case 'academy.planner_full':
    case 'academy.item_has_attempts':
    case 'academy.survey_duplicate':
    case 'academy.pacing_locked':
      return new TRPCError({ code: 'CONFLICT', message: err.message, cause: err });

    case 'academy.attempt_not_found':
    case 'academy.todo_not_found':
    case 'academy.quiz_not_found':
      return new TRPCError({ code: 'NOT_FOUND', message: err.message, cause: err });

    case 'academy.attempt_limit':
    case 'academy.attempt_cooldown':
    case 'academy.verify_rate_limited':
      return new TRPCError({ code: 'TOO_MANY_REQUESTS', message: err.message, cause: err });

    case 'academy.sign_in_required':
    case 'academy.access_code_invalid':
    case 'academy.ip_not_allowed':
      return new TRPCError({ code: 'FORBIDDEN', message: err.message, cause: err });

    case 'academy.assessment_invalid':
    case 'academy.holder_name_invalid':
      return new TRPCError({ code: 'BAD_REQUEST', message: err.message, cause: err });

    case 'academy.video_grant_required':
      return new TRPCError({ code: 'FORBIDDEN', message, cause: err });

    case 'academy.slug_reserved':
      return new TRPCError({ code: 'BAD_REQUEST', message: err.message, cause: err });

    case 'academy.course_slug_taken':
    case 'academy.course_revision_stale':
    case 'academy.course_not_editable':
    case 'academy.private_link_course_closed':
    case 'academy.item_transition_illegal':
    case 'academy.outline_item_unknown':
    case 'academy.revision_stale':
    case 'academy.item_kind_locked':
    case 'academy.topic_slug_taken':
    case 'academy.programme_slug_taken':
    case 'academy.assignment_closed':
    case 'academy.submission_version_stale':
    case 'academy.assignment_has_submissions':
    case 'academy.review_already_sent':
    case 'academy.grader_locked':
      return new TRPCError({ code: 'CONFLICT', message: err.message, cause: err });

    case 'academy.enrolment_required':
    case 'academy.permission_denied':
      return new TRPCError({ code: 'FORBIDDEN', message: err.message, cause: err });

    case 'academy.price_unset':
    case 'academy.course_outline_empty':
    case 'academy.courses_list_limit_unset':
    case 'academy.outline_limits_unset':
    case 'academy.import_limit_unset':
    case 'academy.upload_limits_unset':
    case 'academy.topics_list_limit_unset':
    case 'academy.featured_not_live':
    case 'academy.lesson_not_live':
    case 'academy.item_video_missing':
    case 'academy.upload_incomplete':
    case 'academy.file_unavailable':
    case 'academy.grader_lease_unset':
    case 'academy.programme_limit_unset':
    case 'academy.post_limit_unset':
    case 'academy.attachment_limit_unset':
    case 'academy.message_limit_unset':
      return new TRPCError({ code: 'PRECONDITION_FAILED', message: err.message, cause: err });

    case 'academy.programme_not_found':
    case 'academy.post_not_found':
    case 'academy.conversation_not_found':
      return new TRPCError({ code: 'NOT_FOUND', message: err.message, cause: err });

    case 'academy.outline_too_large':
    case 'academy.programme_too_large':
    case 'academy.post_too_long':
    case 'academy.message_too_long':
    case 'academy.attachment_too_large':
    case 'academy.attachment_type_refused':
    case 'academy.item_has_no_lesson':
    case 'academy.import_too_large':
    case 'academy.lesson_blocks_invalid':
    case 'academy.submission_incomplete':
    case 'academy.peer_count_unset':
    case 'academy.rubric_invalid':
    case 'academy.review_marks_invalid':
    case 'academy.upload_too_large':
    case 'academy.upload_type_refused':
    case 'academy.file_type_mismatch':
      return new TRPCError({ code: 'BAD_REQUEST', message: err.message, cause: err });

    case 'academy.lesson_revision_unknown':
    case 'academy.draft_not_found':
    case 'academy.media_not_found':
    case 'academy.topic_not_found':
    case 'academy.private_link_not_found':
    case 'academy.assignment_not_found':
    case 'academy.review_task_not_found':
    case 'academy.submission_not_found':
      return new TRPCError({ code: 'NOT_FOUND', message: err.message, cause: err });

    case 'academy.prerequisite_cycle':
    case 'academy.prerequisite_unmeasured':
    case 'academy.weights_invalid':
    case 'academy.grading_policy_invalid':
    case 'academy.window_invalid':
    case 'academy.ip_rule_invalid':
    case 'academy.reason_required':
    case 'academy.grade_invalid':
    case 'academy.key_fix_invalid':
    case 'academy.bulk_file_invalid':
      return new TRPCError({ code: 'BAD_REQUEST', message: err.message, cause: err });
  }
}

const operatorApprovalIds = {
  confirmOperatorId: z.string().max(128).nullish(),
  approvalId: z.string().max(128).nullish(),
  operationId: z.string().max(128).nullish(),
};

/**
 * MFA first, then identity-issued action-bound approval.
 * `confirmOperatorId` is display-only — a typed-in second name is not the second person.
 */
async function consumeOperatorApproval(
  principal: Principal | null | undefined,
  approvals: ActionApprovalConsumer,
  input: { readonly approvalId?: string | null; readonly operationId?: string | null },
  targetId: string,
  fields: Record<string, string>,
): Promise<string> {
  const consumed = await consumeApproval(principal, approvals, input, targetId, fields);
  return consumed.approverId ?? consumed.requesterId;
}

/** The same consume, answering both people: who proposed the action and who approved it (refused when nobody approved it). */
async function consumeApprovalPair(
  principal: Principal | null | undefined,
  approvals: ActionApprovalConsumer,
  input: { readonly approvalId?: string | null; readonly operationId?: string | null },
  targetId: string,
  fields: Record<string, string>,
): Promise<{ proposedBy: string; approvedBy: string }> {
  const consumed = await consumeApproval(principal, approvals, input, targetId, fields);
  if (!consumed.approverId) throw new DualControlError('the approval names no approver; a second person must approve it');
  return { proposedBy: consumed.requesterId, approvedBy: consumed.approverId };
}

async function consumeApproval(
  principal: Principal | null | undefined,
  approvals: ActionApprovalConsumer,
  input: { readonly approvalId?: string | null; readonly operationId?: string | null },
  targetId: string,
  fields: Record<string, string>,
) {
  if (!principal) {
    throw new DualControlError('operator identity is required; the academy ambassador door does not invent a caller');
  }
  try {
    requireMfa(principal);
  } catch (err) {
    if (err instanceof AuthError && err.code === 'mfa.required') {
      throw new TRPCError({ code: 'UNAUTHORIZED', message: err.message, cause: err });
    }
    throw err;
  }
  const ids = readApprovalIds(input);
  return approvals.consume({
    approvalId: ids.approvalId,
    operationId: ids.operationId,
    payloadHash: academyActionPayloadHash(targetId, fields),
    targetService: 'svc-academy',
    targetId,
    expectedVersion: '1',
  });
}

/** The caller address an IP filter checks, as the trusted edge named it; null when it cannot be read (AC-quizzes-01). */
function quizClientAddressOf(ctx: object): string | null {
  const value = (ctx as { quizClientAddress?: unknown }).quizClientAddress;
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

/** TCP peer the HTTP adapter attached. Blank is not an address. */
function clientAddressOf(ctx: object): string | null {
  const value = (ctx as { clientAddress?: unknown }).clientAddress;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export type AcademyRouterPayLaws = {
  readonly ifcPayLaw?: AmbassadorIfcPayLaw;
  readonly revenueShareLaw?: AmbassadorRevenueShareLaw;
};

export type AcademyRouterVideo = VideoLibraryDeps;

/**
 * Optional payLaws: owner-published rate authority (D26-P1-C2).
 * Default unpublished — refuse invent rates; product dry-run when published.
 * Video defaults unconfigured — academy.video_storage_unconfigured.
 */
export function createAcademyRouter(
  academy: AcademyService,
  payLaws: AcademyRouterPayLaws = {},
  video: AcademyRouterVideo = unconfiguredVideoLibrary(),
  approvals: ActionApprovalConsumer = unwiredApprovalConsumer(),
  verifyRate: VerifyRate | null = null,
  settings: SettingsEnv = {},
) {
  const ifcPayLaw = payLaws.ifcPayLaw ?? UNPUBLISHED_AMBASSADOR_IFC_PAY_LAW;
  const revenueShareLaw = payLaws.revenueShareLaw ?? UNPUBLISHED_AMBASSADOR_REVENUE_SHARE_LAW;
  const verifyLimiter = new VerifyRateLimiter();
  const guard = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (err) {
      throw toTrpcError(err);
    }
  };

  return router({
    health: publicProcedure
      .output(z.object({ ok: z.boolean(), service: z.literal('svc-academy') }))
      .query(() => ({ ok: true, service: 'svc-academy' as const })),

    // ── Curriculum (thin catalog — A-P5-2) ───────────────────────────────────
    //
    // Pure in-process spine. No progress write, no XP, no money. Full
    // proprietary library import is residual (see curriculum/catalog.ts).

    curriculum: scopedProcedure('academy:read', { module: 'academy' })
      .input(z.object({ path: curriculumPath.optional(), kind: curriculumKind.optional(), limit: z.number().optional() }).optional())
      .output(z.array(curriculumSummaryOut))
      .query(({ input }) =>
        guard(async () => {
          const all = listCurriculum({
            ...(input?.path ? { path: input.path } : {}),
            ...(input?.kind ? { kind: input.kind } : {}),
          });
          const limit = assertCurriculumPageLimit(input?.limit);
          return all.slice(0, limit);
        }),
      ),

    /** AC-articles-02 — related items by shared path. None → []. */
    curriculumRelated: scopedProcedure('academy:read', { module: 'academy' })
      .input(academyRelatedInputSchema)
      .output(z.array(curriculumSummaryOut))
      .query(({ input }) => guard(async () => relatedItems(input.slug, assertCurriculumPageLimit(input.limit)))),

    /**
     * One curriculum item including markdown body.
     *
     * Unknown slug → `academy.curriculum_not_found` (NOT_FOUND). We do not
     * invent titles for the residual DERIV//DESK library that is not in-repo.
     */
    curriculumItem: scopedProcedure('academy:read', { module: 'academy' })
      .input(z.object({ slug: z.string().min(1).max(120) }))
      .output(curriculumItemOut)
      .query(({ input, ctx }) => guard(() => academy.readCurriculumItem({ userId: ctx.principal!.userId, slug: input.slug }))),

    // ── Signed-out Academy (AC-catalogue-01) ─────────────────────────────────
    //
    // The published spine for a visitor with no account: no progress, no
    // learner rows, no touch written. Per-address limits on these reads are
    // svc-edge's (EDGE_RATE_LIMIT_MAX, an owner value that refuses while
    // blank): only the edge sees the caller's address.

    publicCurriculum: publicProcedure
      .input(academyPublicCatalogueInputSchema)
      .output(z.array(curriculumSummaryOut))
      .query(({ input }) =>
        guard(async () => {
          const limit = assertCurriculumPageLimit(input.limit);
          return searchPublicCurriculum({
            limit,
            ...(input.q !== undefined ? { q: input.q } : {}),
            ...(input.path ? { path: input.path } : {}),
            ...(input.kind ? { kind: input.kind } : {}),
            ...(input.sort ? { sort: input.sort } : {}),
          });
        }),
      ),

    publicCurriculumItem: publicProcedure
      .input(z.object({ slug: z.string().min(1).max(120) }).strict())
      .output(curriculumItemOut)
      .query(({ input }) => guard(() => academy.readPublicCurriculumItem({ slug: input.slug }))),

    publicCurriculumRelated: publicProcedure
      .input(academyRelatedInputSchema)
      .output(z.array(curriculumSummaryOut))
      .query(({ input }) => guard(async () => relatedItems(input.slug.trim(), assertCurriculumPageLimit(input.limit)))),

    /** The video list a visitor sees: the same refusal as signed in when storage is not configured. */
    publicVideos: publicProcedure
      .output(z.array(academyPublicVideoSchema))
      .query(() => guard(async () => listAcademyVideos(video).map(({ slug, title, path }) => ({ slug, title, path })))),

    /** AC-catalogue-03: one card per course with published items. A course is one curriculum path until courses are rows. */
    publicCourses: publicProcedure.output(z.array(academyPublicCourseCardSchema)).query(() => listPublicCourses()),

    /** The public course page. Unknown and unpublished courses give the same `academy.course_not_found`. */
    publicCourse: publicProcedure
      .input(z.object({ slug: z.string().min(1).max(120) }).strict())
      .output(academyPublicCourseSchema)
      .query(({ input }) => guard(() => academy.publicCourse(input.slug))),

    /**
     * AC-catalogue-03: a course's unlisted page through a private link; anything else is `academy.course_not_found`. A
     * POST so the key travels in the body, never in a URL the edge logs. It writes nothing.
     */
    publicCourseByLink: publicProcedure
      .input(academyCourseByLinkInputSchema)
      .output(academyCourseLearnerViewSchema)
      .mutation(({ input }) => guard(() => academy.courseByLink(input))),

    /** AC-catalogue-03: the published courses staff made, newest first, up to the page asked for. */
    publicAuthoredCourses: publicProcedure
      .input(academyPublishedCoursesInputSchema)
      .output(academyPublishedCourseListSchema)
      .query(({ input }) => guard(() => academy.publishedCourses(input.limit))),

    /** AC-catalogue-03: a published course's public page; anything else is `academy.course_not_found`. Writes nothing. */
    publicAuthoredCourse: publicProcedure
      .input(academyAuthoredCourseInputSchema)
      .output(academyCourseLearnerViewSchema)
      .query(({ input }) => guard(() => academy.authoredCoursePage(input.slug, null))),

    /** AC-articles-01: the hub's featured slot, only what staff chose (a curriculum item or a course lesson); null when nobody chose one. */
    publicHub: publicProcedure
      .output(academyPublicHubSchema)
      .query(() => guard(async () => ({ featured: await academy.featuredItem(), lesson: await academy.featuredLesson() }))),

    /**
     * Stage-1 import pipeline inventory: content source decision + count gate.
     * titlePromiseMet is true when 20 playbooks + 3 workbooks exist (platform-native
     * expansion may close this without a licensed library dump).
     */
    curriculumInventory: scopedProcedure('academy:read', { module: 'academy' })
      .output(curriculumInventoryOut)
      .query(() => curriculumInventory()),

    /**
     * Stage-3 import/status: pipeline + catalog expansion + polish readiness.
     * Does not invent licensed library content; workbook live-quote invent stays refused.
     */
    curriculumImportStatus: scopedProcedure('academy:read', { module: 'academy' })
      .output(curriculumImportStatusOut)
      .query(() => curriculumImportStageStatus()),

    /**
     * Stage-3 Blueprint curriculumPath deep-link resolver.
     * Unknown path/slug or path mismatch → ok:false (no invent).
     */
    curriculumDeepLink: scopedProcedure('academy:read', { module: 'academy' })
      .input(z.object({ path: curriculumPath, slug: z.string().min(1).max(120).optional() }))
      .output(curriculumDeepLinkOut)
      .query(({ input }) => resolveCurriculumDeepLink(input)),

    /**
     * Stage-3 path-index deep-links for Blueprint paths that have catalog content.
     */
    curriculumPathDeepLinks: scopedProcedure('academy:read', { module: 'academy' })
      .output(
        z.array(
          z.object({
            path: curriculumPath,
            href: z.string(),
            itemCount: z.number().int(),
          }),
        ),
      )
      .query(() => [...listCurriculumPathDeepLinks()]),

    /**
     * Stage-3 localized curriculum body. Missing locales fall back to default `en`
     * — we never invent a translation.
     */
    curriculumItemLocalized: scopedProcedure('academy:read', { module: 'academy' })
      .input(z.object({ slug: z.string().min(1).max(120), locale: z.string().min(2).max(12).optional() }))
      .output(curriculumItemLocalizedOut)
      .query(({ input, ctx }) =>
        guard(() =>
          academy.readCurriculumItemLocalized({
            userId: ctx.principal!.userId,
            slug: input.slug,
            ...(input.locale !== undefined ? { locale: input.locale } : {}),
          }),
        ),
      ),

    /**
     * The study guide for one item: objectives, key terms, self-check and the
     * reading estimate, without the markdown body.
     *
     * This is what an index screen needs. `curriculumItem` hands back several
     * thousand characters of prose, which is the wrong payload for a card, and
     * a client that had to fetch the whole body to show "3 objectives, 4 min"
     * would either over-fetch every row or invent the numbers locally.
     *
     * Unknown slug → `academy.curriculum_not_found`. We never synthesise a guide.
     */
    curriculumStudyGuide: scopedProcedure('academy:read', { module: 'academy' })
      .input(z.object({ slug: z.string().min(1).max(120) }))
      .output(curriculumStudyGuideOut)
      .query(({ input }) =>
        guard(async () => {
          const guide = curriculumStudyGuide(input.slug);
          if (!guide) {
            throw new AcademyError(`Curriculum item "${input.slug}" is not in the day-one spine`, 'academy.curriculum_not_found');
          }
          return { ...guide, objectives: [...guide.objectives], keyTerms: [...guide.keyTerms], selfCheck: [...guide.selfCheck] };
        }),
      ),

    /**
     * Study guides for a whole path, in the path's display order — one call for
     * a path index. Owner-published `limit` required; omit does not dump the spine.
     */
    curriculumStudyGuides: scopedProcedure('academy:read', { module: 'academy' })
      .input(z.object({ path: curriculumPath.optional(), limit: z.number().optional() }).optional())
      .output(z.array(curriculumStudyGuideOut))
      .query(({ input }) =>
        guard(async () => {
          const all = listCurriculumStudyGuides(input?.path).map((guide) => ({
            ...guide,
            objectives: [...guide.objectives],
            keyTerms: [...guide.keyTerms],
            selfCheck: [...guide.selfCheck],
          }));
          const limit = assertCurriculumPageLimit(input?.limit);
          return all.slice(0, limit);
        }),
      ),

    /**
     * Depth inventory over the library. `curriculumInventory` answers "are there
     * 20 playbooks and 3 workbooks"; its validation floor is 40 characters, which
     * a three-bullet stub clears. This answers the second question — is any of it
     * long enough to be worth reading — and it answers by NAMING what falls short
     * in `thinSlugs` rather than asserting that nothing does.
     */
    curriculumDepth: scopedProcedure('academy:read', { module: 'academy' })
      .output(curriculumDepthOut)
      .query(() => {
        const report = curriculumDepthReport();
        return { ...report, thinSlugs: [...report.thinSlugs] };
      }),

    /**
     * Stored VOD catalog (TRK-academy.video). Not LiveKit.
     *
     * Unconfigured storage → academy.video_storage_unconfigured.
     * Does not list the bucket (Class X residual).
     */
    videos: scopedProcedure('academy:read', { module: 'academy' })
      .output(
        z.array(
          z.object({
            slug: z.string(),
            title: z.string(),
            path: curriculumPath,
            durationSeconds: z.number().int().nullable(),
            thumbnailUrl: z.string().nullable(),
            language: z.string().nullable(),
            captionsUrl: z.string().nullable(),
            captionsPublished: z.boolean(),
            transcriptPublished: z.boolean(),
          }),
        ),
      )
      .query(() => guard(async () => [...listAcademyVideos(video)])),

    /**
     * AC-videos-01 captions track. Unpublished URL refuses
     * academy.video_captions_unpublished. Does not invent a file.
     */
    videoCaptions: scopedProcedure('academy:read', { module: 'academy' })
      .input(z.object({ slug: z.string().min(1).max(120) }).strict())
      .output(
        z.object({
          slug: z.string(),
          captionsUrl: z.string(),
          language: z.string().nullable(),
          expiresAt: z.date(),
          grant: z.string(),
        }),
      )
      .query(({ ctx, input }) =>
        guard(async () =>
          grantAcademyVideoCaptions({
            deps: video,
            slug: input.slug,
            caller: { userId: ctx.principal.userId, tier: ctx.principal.tier },
          }),
        ),
      ),

    /**
     * AC-videos-01 transcript. Unpublished text refuses
     * academy.video_transcript_unpublished. Does not invent words.
     */
    videoTranscript: scopedProcedure('academy:read', { module: 'academy' })
      .input(z.object({ slug: z.string().min(1).max(120) }).strict())
      .output(
        z.object({
          slug: z.string(),
          language: z.string(),
          text: z.string(),
          transcriptUrl: z.string(),
          expiresAt: z.date(),
          grant: z.string(),
        }),
      )
      .query(({ ctx, input }) =>
        guard(async () =>
          grantAcademyVideoTranscript({
            deps: video,
            slug: input.slug,
            caller: { userId: ctx.principal.userId, tier: ctx.principal.tier },
          }),
        ),
      ),

    /**
     * Signed expiring GET after tier/stake gate. URL without grant is refused.
     */
    videoPlayback: scopedProcedure('academy:read', { module: 'academy' })
      .input(
        z
          .object({
            slug: z.string().min(1).max(120),
            /** Raw object URL — refused unless it already carries a grant signature. */
            url: z.string().min(1).max(2000).optional(),
          })
          .strict(),
      )
      .output(
        z.object({
          slug: z.string(),
          playbackUrl: z.string(),
          expiresAt: z.date(),
          grant: z.string(),
        }),
      )
      .query(({ ctx, input }) =>
        guard(async () => {
          if (input.url) {
            assertAcademyVideoUrlGranted(video, input.url);
          }
          return grantAcademyVideoPlayback({
            deps: video,
            slug: input.slug,
            caller: { userId: ctx.principal.userId, tier: ctx.principal.tier },
          });
        }),
      ),

    /**
     * AC-videos-01: the player's caption tracks (as cues; the transcript is the same cues), the renditions that exist and
     * the owner's save interval and watch threshold. Behind the same storage, tier and stake gate as playback.
     */
    videoPlayer: scopedProcedure('academy:read', { module: 'academy' })
      .input(z.object({ slug: z.string().min(1).max(120) }).strict())
      .output(academyVideoPlayerSchema)
      .query(({ ctx, input }) =>
        guard(async () => {
          await assertAcademyVideoEntitled(video, { userId: ctx.principal.userId, tier: ctx.principal.tier });
          return academy.videoPlayer(input.slug);
        }),
      ),

    /** AC-videos-01: the video attached to one curriculum item (null: none), so the reader shows its player. */
    itemVideo: scopedProcedure('academy:read', { module: 'academy' })
      .input(z.object({ itemSlug: z.string().min(1).max(120) }).strict())
      .output(academyItemVideoSchema)
      .query(({ input }) => guard(() => academy.itemVideo(input.itemSlug))),

    /**
     * Paper drill gate for a workbook (TRK-academy.paper-trading Stage 2+3).
     *
     * Read-only on purpose: the drill loop is a pure state machine and academy
     * holds no run state, so this answers one question — may this catalog item
     * be drilled against this market, and with which steps. A market that is
     * not flagged `paper: true` by trade refuses here rather than anywhere a
     * user could mistake it for live. Stage-3 ops kill-switch
     * (`ACADEMY_PAPER_TRADING_ENABLED=false`) refuses before the market check —
     * live trade is unaffected. No fills, prices or balances cross this
     * boundary; money truth stays on trade.
     */
    paperDrill: scopedProcedure('academy:read', { module: 'academy' })
      .input(
        z
          .object({
            slug: z.string().min(1),
            market: paperMarketFlagIn.nullable().default(null),
          })
          .strict(),
      )
      .output(paperDrillOut)
      .query(({ input }) =>
        guard(async () => {
          assertPaperInputNeverClaimsLive(input);
          academy.assertPaperTradingEnabled();
          await academy.assertCallerPaperFlagVerified(input.market);
          const item = getCurriculumItem(input.slug);
          if (!item) {
            throw new AcademyError(`Curriculum item "${input.slug}" is not in the day-one spine`, 'academy.curriculum_not_found');
          }
          const result = startPaperDrillForCatalogItem({ slug: input.slug, kind: item.kind, market: input.market });
          if (!result.ok) {
            return { ok: false as const, reason: result.reason, message: result.message };
          }
          const sealed = assertSealedSimulated(
            sealSimulated({
              marketId: result.run.marketId,
              symbol: result.run.symbol,
              steps: result.run.steps.map((step) => ({ id: step.id, instruction: step.instruction })),
            }),
          );
          const wire = {
            ok: true as const,
            simulated: sealed.simulated,
            venue: sealed.venue,
            realLedger: sealed.realLedger,
            withdrawable: sealed.withdrawable,
            realMoney: sealed.realMoney,
            disclaimer: sealed.disclaimer,
            ...sealed.result,
          };
          // D26-P1-C4 — second door: no custody-looking key may ride along.
          assertPaperNeverReadableAsRealMoney(wire);
          return wire;
        }),
      ),

    /**
     * The drill, finished — steps ticked off and trade's fills valued.
     * (TRK-academy.paper-trading Stage-2 "completable with simulated results".)
     *
     * `paperDrill` above answers "may I start this". This answers "what did it
     * come to", which is the half a workbook could not previously reach: the
     * loop's later functions had no caller, so a drill could be opened over the
     * wire and never closed with anything to show.
     *
     * STATELESS, and that is the design rather than a shortcut. Academy stores
     * no run and no position, so the caller replays what happened — the steps
     * they completed and the fills TRADE gave them — and this returns the
     * authoritative reading of it. Every refusal the step-by-step path would
     * have raised is raised here in the same order: a live market, a non-
     * workbook slug, an unknown step, a malformed fill.
     *
     * WHAT IT WILL NOT DO. It has no price source. Prices and sizes are the
     * ones trade published, handed in as decimal strings; a fill missing one is
     * `academy.paper_price_unavailable`, and an open position with no published
     * mark comes back `unrealisedPnl: null, markUnavailable: true`. Neither
     * case is filled in with a plausible number, because a fabricated price in
     * a practice drill is still this platform stating a price that never
     * existed.
     *
     * AND IT MOVES NOTHING. No hold, no fill, no ledger post — doctrine §0.6,
     * and `paper/ledger-isolation.test.ts` fails the build if that changes.
     */
    paperDrillResult: scopedProcedure('academy:read', { module: 'academy' })
      .input(
        z
          .object({
            slug: z.string().min(1),
            market: paperMarketFlagIn.nullable().default(null),
            completedStepIds: z.array(z.string().min(1)).max(64).default([]),
            fills: z.array(publishedFillIn).max(256).default([]),
            /** Trade's published mark for open size. Absent → reported unmarked. */
            markPrice: z.string().min(1).nullable().default(null),
          })
          .strict(),
      )
      .output(paperDrillResultOut)
      .query(({ input }) =>
        guard(async () => {
          assertPaperInputNeverClaimsLive(input);
          academy.assertPaperTradingEnabled();
          await academy.assertCallerPaperFlagVerified(input.market);
          const item = getCurriculumItem(input.slug);
          if (!item) {
            throw new AcademyError(`Curriculum item "${input.slug}" is not in the day-one spine`, 'academy.curriculum_not_found');
          }

          const replayed = replayPaperDrill({
            slug: input.slug,
            kind: item.kind,
            market: input.market,
            completedStepIds: input.completedStepIds,
            fills: input.fills,
          });
          if (!replayed.ok) {
            return { ok: false as const, reason: replayed.reason, message: replayed.message };
          }

          const run = replayed.run;
          const progress = drillProgress(run);
          // Value the post-attach run, not the raw input array. attachPaperFillRef
          // already de-dupes fillId and refuses conflicting re-sends; valuing
          // input.fills would re-inflate PnL when a client double-posts the same id.
          // Incomplete refs (id-only) never reach valuation — publishedFillIn on
          // the wire requires side/price/size, and uniquePublishedFills refuses
          // conflicts that slip past attach.
          const fillsForValue: PublishedFill[] = listPaperFillRefs(run).flatMap((ref) => {
            if (ref.side !== 'buy' && ref.side !== 'sell') return [];
            if (typeof ref.price !== 'string' || typeof ref.size !== 'string') return [];
            return [
              {
                fillId: ref.fillId,
                marketId: ref.marketId,
                side: ref.side,
                price: ref.price,
                size: ref.size,
              },
            ];
          });
          // Throws `academy.paper_price_unavailable` rather than valuing a fill
          // whose price nobody published (or a conflicting fillId pair).
          const valuation = valueSimulatedDrill(fillsForValue, input.markPrice);

          const sealed = assertSealedSimulated(
            sealSimulated({
              workbookSlug: run.workbookSlug,
              marketId: run.marketId,
              symbol: run.symbol,
              status: run.status,
              stepCount: progress.stepCount,
              completedCount: progress.completedCount,
              remainingStepIds: [...remainingStepIds(run)],
              ratio: progress.ratio,
              complete: isDrillComplete(run),
              valuation,
            }),
          );
          const wire = {
            ok: true as const,
            simulated: sealed.simulated,
            venue: sealed.venue,
            realLedger: sealed.realLedger,
            withdrawable: sealed.withdrawable,
            realMoney: sealed.realMoney,
            disclaimer: sealed.disclaimer,
            result: sealed.result,
          };
          // D26-P1-C4 — second door: valuation may not smuggle custody keys.
          assertPaperNeverReadableAsRealMoney(wire);
          return wire;
        }),
      ),

    /**
     * Stage-3 ops status for paper drills (TRK-academy.paper-trading).
     * Reports enable/kill only — never invents prices; live trade unaffected.
     */
    paperOpsStatus: scopedProcedure('academy:read', { module: 'academy' })
      .output(
        z.object({
          enabled: z.boolean(),
          flagId: z.literal(PAPER_OPS_FLAG_ID),
          envKey: z.literal(PAPER_OPS_ENV_KEY),
          liveTradeUnaffected: z.literal(true),
          simulated: z.literal(true),
          venue: z.literal(SIMULATED_VENUE),
          realMoney: z.literal(false),
        }),
      )
      .query(() =>
        guard(async () => {
          const status = academy.paperOpsStatus();
          // Refuse a live/realMoney claim from the service — do not rewrite it quiet.
          assertPaperNeverReadableAsRealMoney(status);
          const wire = {
            enabled: status.enabled,
            flagId: PAPER_OPS_FLAG_ID,
            envKey: PAPER_OPS_ENV_KEY,
            liveTradeUnaffected: true as const,
            simulated: true as const,
            venue: SIMULATED_VENUE,
            realMoney: false as const,
          };
          assertPaperNeverReadableAsRealMoney(wire);
          return wire;
        }),
      ),

    // ── Lobbies ──────────────────────────────────────────────────────────────

    rooms: scopedProcedure('academy:read', { module: 'academy' })
      .input(z.object({ kind: roomKind.optional(), limit: z.number().optional() }).optional())
      .output(z.array(roomOut))
      .query(async ({ ctx, input }) => {
        const rooms = await academy.listRooms({
          ...(input?.kind ? { kind: input.kind } : {}),
          limit: input?.limit,
        });
        const seats = await academy.callerLiveSeats(ctx.principal.userId);
        return rooms.map((room) => serialiseRoom(room, seatFor(seats, room.id, 'room')));
      }),

    /** A room, its terms, and what is on in it. `seated` and `role` are the caller's. */
    room: scopedProcedure('academy:read', { module: 'academy' })
      .input(z.object({ roomId: z.string().guid(), limit: z.number().optional() }))
      .output(z.object({ room: roomOut, sessions: z.array(sessionOut) }))
      .query(({ ctx, input }) =>
        guard(async () => {
          const seats = await academy.callerLiveSeats(ctx.principal.userId);
          return {
            room: serialiseRoom(await academy.room(input.roomId), seatFor(seats, input.roomId, 'room')),
            sessions: (await academy.listSessions({ roomId: input.roomId, limit: input.limit })).map((session) =>
              serialiseSession(session, seatFor(seats, session.id, 'session')),
            ),
          };
        }),
      ),

    session: scopedProcedure('academy:read', { module: 'academy' })
      .input(z.object({ sessionId: z.string().guid() }))
      .output(z.object({ session: sessionOut, occupancy: z.number().int() }))
      .query(({ ctx, input }) =>
        guard(async () => {
          const seats = await academy.callerLiveSeats(ctx.principal.userId);
          return {
            session: serialiseSession(await academy.session(input.sessionId), seatFor(seats, input.sessionId, 'session')),
            occupancy: await academy.occupancy(input.sessionId),
          };
        }),
      ),

    /**
     * Take a seat.
     *
     * The gate and the capacity check both live in the service; this is the
     * only place a seat is granted, and it grants it to the caller and nobody
     * else.
     */
    join: scopedProcedure('academy:write', { module: 'academy' })
      .input(z.object({ sessionId: z.string().guid() }))
      .output(z.object({ role: z.enum(['host', 'speaker', 'attendee']) }))
      .mutation(({ ctx, input }) => guard(() => academy.join({ sessionId: input.sessionId, userId: ctx.principal.userId }))),

    leave: scopedProcedure('academy:write', { module: 'academy' })
      .input(z.object({ sessionId: z.string().guid() }))
      .output(z.object({ ok: z.literal(true) }))
      .mutation(({ ctx, input }) =>
        guard(async () => {
          await academy.leave({ sessionId: input.sessionId, userId: ctx.principal.userId });
          return { ok: true as const };
        }),
      ),

    /**
     * A credential for the audio/video stream, for a caller already seated.
     *
     * Fails with `academy.stream_unavailable` when no SFU is configured, rather
     * than returning a token that cannot connect (SOCKET §13
     * `socket.stream-provider`). A lobby with no stream still runs.
     */
    streamCredential: scopedProcedure('academy:write', { module: 'academy' })
      .input(z.object({ sessionId: z.string().guid() }))
      .output(z.object({ url: z.string(), token: z.string(), expiresAt: z.date() }))
      .mutation(({ ctx, input }) => guard(() => academy.streamCredential({ sessionId: input.sessionId, userId: ctx.principal.userId }))),

    // ── Hosting ──────────────────────────────────────────────────────────────

    createRoom: scopedProcedure('academy:write', { module: 'academy' })
      .input(
        z.object({
          slug: z
            .string()
            .min(3)
            .max(64)
            .regex(/^[a-z0-9-]+$/, 'a slug is lowercase letters, digits and hyphens'),
          name: z.string().min(1).max(120),
          kind: roomKind,
          access: roomAccess,
          minStake: amountString.optional(),
          capacity: z.number().int().min(1),
        }),
      )
      .output(roomOut)
      .mutation(({ ctx, input }) => {
        // `minStake` is pulled OUT of the spread rather than corrected after it.
        // Spreading `input` whole put the wire's decimal STRING onto a field the
        // service types as a scaled `bigint`, and the conditional override only
        // replaced it when the value was truthy — so the money type held for
        // rooms that set a threshold and quietly broke for those that did not.
        // Destructuring means the string cannot reach the service at all: the
        // field is a parsed `Amount` or it is absent.
        const { minStake, ...rest } = input;
        return guard(async () =>
          serialiseRoom(
            await academy.createRoom({
              ...rest,
              hostId: ctx.principal.userId,
              ...(minStake ? { minStake: parseAmount(minStake) } : {}),
            }),
          ),
        );
      }),

    invite: scopedProcedure('academy:write', { module: 'academy' })
      .input(z.object({ roomId: z.string().guid(), userId: z.string().guid(), expiresAt: z.coerce.date().nullable().optional() }))
      .output(z.object({ ok: z.literal(true) }))
      .mutation(({ ctx, input }) =>
        guard(async () => {
          await academy.invite({
            roomId: input.roomId,
            hostId: ctx.principal.userId,
            userId: input.userId,
            expiresAt: input.expiresAt ?? null,
          });
          return { ok: true as const };
        }),
      ),

    scheduleSession: scopedProcedure('academy:write', { module: 'academy' })
      .input(z.object({ roomId: z.string().guid(), title: z.string().min(1).max(160), startsAt: z.coerce.date() }))
      .output(sessionOut)
      .mutation(({ ctx, input }) =>
        guard(async () => {
          const session = await academy.scheduleSession({ ...input, hostId: ctx.principal.userId });
          const seats = await academy.callerLiveSeats(ctx.principal.userId);
          return serialiseSession(session, seatFor(seats, session.id, 'session'));
        }),
      ),

    startSession: scopedProcedure('academy:write', { module: 'academy' })
      .input(z.object({ sessionId: z.string().guid() }))
      .output(sessionOut)
      .mutation(({ ctx, input }) =>
        guard(async () => {
          const session = await academy.startSession({ sessionId: input.sessionId, hostId: ctx.principal.userId });
          const seats = await academy.callerLiveSeats(ctx.principal.userId);
          return serialiseSession(session, seatFor(seats, session.id, 'session'));
        }),
      ),

    endSession: scopedProcedure('academy:write', { module: 'academy' })
      .input(z.object({ sessionId: z.string().guid() }))
      .output(sessionOut)
      .mutation(({ ctx, input }) =>
        guard(async () => {
          const session = await academy.endSession({ sessionId: input.sessionId, hostId: ctx.principal.userId });
          const seats = await academy.callerLiveSeats(ctx.principal.userId);
          return serialiseSession(session, seatFor(seats, session.id, 'session'));
        }),
      ),

    /**
     * The 2D scene (§8.3). Host writes whole scene; optional expectedFingerprint
     * enforces concurrent-edit policy (stale host tab → conflict, not last-write-wins).
     */
    updateScene: scopedProcedure('academy:write', { module: 'academy' })
      .input(
        z.object({
          sessionId: z.string().guid(),
          scene: z.record(z.string(), z.unknown()),
          expectedFingerprint: z.string().min(1).max(128).optional(),
        }),
      )
      .output(sessionOut.extend({ sceneFingerprint: z.string() }))
      .mutation(({ ctx, input }) =>
        guard(async () => {
          const session = await academy.updateScene({
            sessionId: input.sessionId,
            hostId: ctx.principal.userId,
            scene: input.scene,
            ...(input.expectedFingerprint !== undefined ? { expectedFingerprint: input.expectedFingerprint } : {}),
          });
          const seats = await academy.callerLiveSeats(ctx.principal.userId);
          return serialiseSession(session, seatFor(seats, session.id, 'session'));
        }),
      ),

    // ── Ambassador programme Stage-1 (status only — NO PAY / Class M residual) ─
    //
    // Public badge is academy:read. Appoint/freeze are operator admin:write —
    // programme control is not a user self-serve action.
    // Dual-control: MFA + identity-issued action-bound approval.
    // A typed-in `confirmOperatorId` is display-only, not the second person.

    ambassadorBadge: scopedProcedure('academy:read', { module: 'academy' })
      .input(z.object({ userId: z.string().guid() }))
      .output(ambassadorBadgeOut)
      .query(({ input }) => guard(() => academy.ambassadorBadge(input.userId))),

    ambassadors: scopedProcedure('admin:read', { module: 'academy' })
      .input(z.object({ status: ambassadorStatus.optional(), limit: z.number().optional() }).optional())
      .output(z.array(ambassadorOut))
      .query(({ input }) =>
        guard(async () =>
          academy.listAmbassadors({
            ...(input?.status ? { status: input.status } : {}),
            limit: input?.limit,
          }),
        ),
      ),

    appointAmbassador: scopedProcedure('admin:write', { module: 'academy' })
      .input(z.object({ userId: z.string().guid(), ...operatorApprovalIds }))
      .output(ambassadorOut.extend({ confirmOperatorId: z.string() }))
      .mutation(({ input, ctx }) =>
        guard(async () => {
          const confirmOperatorId = await consumeOperatorApproval(ctx.principal, approvals, input, 'academy.ambassador.appoint', {
            userId: input.userId,
          });
          const record = await academy.appointAmbassador({ userId: input.userId, operatorId: ctx.principal!.userId });
          return { ...record, confirmOperatorId };
        }),
      ),

    freezeAmbassador: scopedProcedure('admin:write', { module: 'academy' })
      .input(z.object({ userId: z.string().guid(), reason: z.string().min(1).max(500), ...operatorApprovalIds }))
      .output(ambassadorOut.extend({ confirmOperatorId: z.string() }))
      .mutation(({ input, ctx }) =>
        guard(async () => {
          const confirmOperatorId = await consumeOperatorApproval(ctx.principal, approvals, input, 'academy.ambassador.freeze', {
            userId: input.userId,
            reason: input.reason,
          });
          const record = await academy.freezeAmbassador({
            userId: input.userId,
            operatorId: ctx.principal!.userId,
            reason: input.reason,
          });
          return { ...record, confirmOperatorId };
        }),
      ),

    /** Reactivate a frozen ambassador without re-appoint (clear freeze reason). */
    unfreezeAmbassador: scopedProcedure('admin:write', { module: 'academy' })
      .input(z.object({ userId: z.string().guid(), ...operatorApprovalIds }))
      .output(ambassadorOut.extend({ confirmOperatorId: z.string() }))
      .mutation(({ input, ctx }) =>
        guard(async () => {
          const confirmOperatorId = await consumeOperatorApproval(ctx.principal, approvals, input, 'academy.ambassador.unfreeze', {
            userId: input.userId,
          });
          const record = await academy.unfreezeAmbassador({
            userId: input.userId,
            operatorId: ctx.principal!.userId,
          });
          return { ...record, confirmOperatorId };
        }),
      ),

    /**
     * IFC pay / revenue share under rate authority (D26-P1-C2).
     * Settlement stays dark (no ledger recipe). Quote path opens when owner rates published.
     */
    ambassadorPayPlane: scopedProcedure('admin:read', { module: 'academy' })
      .output(
        z.object({
          ifcPayEnabled: z.literal(false),
          revenueShareEnabled: z.literal(false),
          ifcRateAuthorityPublished: z.boolean(),
          revenueShareRateAuthorityPublished: z.boolean(),
          ifcPayQuoteEnabled: z.boolean(),
          revenueShareQuoteEnabled: z.boolean(),
          classM: z.literal(true),
          residualIfcPay: z.string(),
          residualRevenueShare: z.string(),
        }),
      )
      .query(() => ambassadorPayPlaneStatus({ ifc: ifcPayLaw, revenueShare: revenueShareLaw })),

    /**
     * Public door (academy:read) — typed refuse, never a fake IFC quote.
     * Unset rate authority → rates_unset; never payable.
     */
    ambassadorPayQuote: scopedProcedure('academy:read', { module: 'academy' })
      .input(z.object({ kind: z.enum(['ifc_pay', 'revenue_share']).optional() }).optional())
      .output(publicAmbassadorPayQuoteOut)
      .query(({ input }) =>
        decidePublicAmbassadorPayQuote({
          kind: input?.kind ?? 'ifc_pay',
          law: (input?.kind ?? 'ifc_pay') === 'revenue_share' ? revenueShareLaw : ifcPayLaw,
        }),
      ),

    ambassadorIfcPay: scopedProcedure('admin:write', { module: 'academy' })
      .input(
        z.object({
          beneficiaryId: z.string().guid(),
          dryRun: z.boolean().optional(),
          residencyStatus: z.enum(['applied', 'accepted', 'rejected', 'withdrawn']).optional(),
        }),
      )
      .mutation(async ({ input }) => {
        try {
          return attemptAmbassadorPay({
            kind: 'ifc_pay',
            law: ifcPayLaw,
            beneficiaryId: input.beneficiaryId,
            dryRun: input.dryRun,
            residencyStatus: input.residencyStatus,
          });
        } catch (err) {
          throw toTrpcError(err);
        }
      }),

    ambassadorRevenueShare: scopedProcedure('admin:write', { module: 'academy' })
      .input(
        z.object({
          beneficiaryId: z.string().guid(),
          dryRun: z.boolean().optional(),
          residencyStatus: z.enum(['applied', 'accepted', 'rejected', 'withdrawn']).optional(),
        }),
      )
      .mutation(async ({ input }) => {
        try {
          return attemptAmbassadorPay({
            kind: 'revenue_share',
            law: revenueShareLaw,
            beneficiaryId: input.beneficiaryId,
            dryRun: input.dryRun,
            residencyStatus: input.residencyStatus,
          });
        } catch (err) {
          throw toTrpcError(err);
        }
      }),

    /**
     * Public residency IFC door — refuse when rates unset (accepted residency is not payable).
     */
    residencyPayQuote: scopedProcedure('academy:read', { module: 'academy' })
      .input(z.object({ residencyStatus: residencyStatus.optional() }).optional())
      .output(publicAmbassadorPayQuoteOut)
      .query(({ input }) =>
        decidePublicResidencyPayQuote({
          law: ifcPayLaw,
          residencyStatus: input?.residencyStatus,
        }),
      ),

    /** Operator residency IFC quote under rate authority — accepted residency + published rates. */
    residencyIfcPayQuote: scopedProcedure('admin:write', { module: 'academy' })
      .input(
        z.object({
          beneficiaryId: z.string().guid(),
          residencyStatus: z.enum(['applied', 'accepted', 'rejected', 'withdrawn']),
          dryRun: z.boolean().optional().default(true),
        }),
      )
      .mutation(async ({ input }) => {
        try {
          return attemptResidencyIfcPay({
            law: ifcPayLaw,
            beneficiaryId: input.beneficiaryId,
            residencyStatus: input.residencyStatus,
            dryRun: input.dryRun,
          });
        } catch (err) {
          throw toTrpcError(err);
        }
      }),

    // ── Residency applications Stage-1 (durable, NO PAY) ──────────────────────
    //
    // User applies/withdraws own rows. Operator decides open queue. Pay is Class M.
    // Dual-control on decide: MFA + identity-issued action-bound approval.
    // A typed-in `confirmOperatorId` is not the second person.

    applyResidency: scopedProcedure('academy:write', { module: 'academy' })
      .input(z.object({ cohortSlug: z.string().min(3).max(48), statement: z.string().min(20).max(2000) }))
      .output(residencyOut)
      .mutation(({ input, ctx }) =>
        guard(() =>
          academy.applyResidency({
            userId: ctx.principal!.userId,
            cohortSlug: input.cohortSlug,
            statement: input.statement,
          }),
        ),
      ),

    withdrawResidency: scopedProcedure('academy:write', { module: 'academy' })
      .input(z.object({ id: z.string().guid() }))
      .output(residencyOut)
      .mutation(({ input, ctx }) => guard(() => academy.withdrawResidency({ id: input.id, userId: ctx.principal!.userId }))),

    myResidencies: scopedProcedure('academy:read', { module: 'academy' })
      .input(z.object({ limit: z.number().optional() }).optional())
      .output(z.array(residencyOut))
      .query(({ input, ctx }) => guard(() => academy.myResidencies(ctx.principal!.userId, input?.limit))),

    openResidencies: scopedProcedure('admin:read', { module: 'academy' })
      .input(z.object({ cohortSlug: z.string().min(3).max(48).optional(), limit: z.number().optional() }).optional())
      .output(z.array(residencyOut))
      .query(({ input }) =>
        guard(() =>
          academy.listOpenResidencies({
            ...(input?.cohortSlug ? { cohortSlug: input.cohortSlug } : {}),
            limit: input?.limit,
          }),
        ),
      ),

    decideResidency: scopedProcedure('admin:write', { module: 'academy' })
      .input(
        z.object({
          id: z.string().guid(),
          decision: z.enum(['accepted', 'rejected']),
          note: z.string().max(500).optional(),
          ...operatorApprovalIds,
        }),
      )
      .output(residencyOut.extend({ confirmOperatorId: z.string() }))
      .mutation(({ input, ctx }) =>
        guard(async () => {
          const confirmOperatorId = await consumeOperatorApproval(ctx.principal, approvals, input, 'academy.residency.decide', {
            id: input.id,
            decision: input.decision,
          });
          const record = await academy.decideResidency({
            id: input.id,
            operatorId: ctx.principal!.userId,
            decision: input.decision,
            ...(input.note === undefined ? {} : { note: input.note }),
          });
          return { ...record, confirmOperatorId };
        }),
      ),

    // ── Tournament ladders Stage-1 (NO PRIZE MONEY) ───────────────────────────
    //
    // Gated by ACADEMY_TOURNAMENT_ENABLED. Operator creates/starts seasons;
    // standings are readable by academy:read. Score writes are admin:write until
    // a paper/live source is product-lawed (Stage-2+).
    // Dual-control on createSeason, setSeasonStatus, setStanding, bulkSetStandings:
    // MFA + identity-issued action-bound approval. Typed-in confirm is display-only.

    seasons: scopedProcedure('academy:read', { module: 'academy' })
      .input(z.object({ status: seasonStatus.optional(), limit: z.number().optional() }).optional())
      .output(z.array(seasonOut))
      .query(({ input }) =>
        guard(async () =>
          academy.listSeasons({
            ...(input?.status ? { status: input.status } : {}),
            limit: input?.limit,
          }),
        ),
      ),

    season: scopedProcedure('academy:read', { module: 'academy' })
      .input(z.object({ seasonId: z.string().guid() }))
      .output(seasonOut)
      .query(({ input }) => guard(() => academy.season(input.seasonId))),

    seasonCalendar: scopedProcedure('academy:read', { module: 'academy' })
      .input(z.object({ seasonId: z.string().guid(), at: z.coerce.date().optional() }))
      .output(seasonCalendarOut)
      .query(async ({ input }) =>
        guard(async () => {
          const season = await academy.season(input.seasonId);
          return seasonWindowAt(season, input.at ?? new Date());
        }),
      ),

    tournaments: router({
      policy: publicProcedure.query(() => describeTournamentPolicy()),
    }),

    standings: scopedProcedure('academy:read', { module: 'academy' })
      .input(z.object({ seasonId: z.string().guid(), limit: z.number().optional() }))
      .output(z.array(standingOut))
      .query(({ input }) => guard(() => academy.standings(input.seasonId, { limit: input.limit }))),

    createSeason: scopedProcedure('admin:write', { module: 'academy' })
      .input(
        z.object({
          slug: z.string().min(3).max(64),
          title: z.string().min(3).max(160),
          rulesSummary: z.string().min(8).max(4000),
          startsAt: z.coerce.date(),
          endsAt: z.coerce.date().nullable().optional(),
          ...operatorApprovalIds,
        }),
      )
      .output(seasonOut.extend({ confirmOperatorId: z.string() }))
      .mutation(({ input, ctx }) =>
        guard(async () => {
          const confirmOperatorId = await consumeOperatorApproval(ctx.principal, approvals, input, 'academy.season.create', {
            slug: input.slug,
            title: input.title,
          });
          const record = await academy.createSeason({
            slug: input.slug,
            title: input.title,
            rulesSummary: input.rulesSummary,
            startsAt: input.startsAt,
            endsAt: input.endsAt ?? null,
          });
          return { ...record, confirmOperatorId };
        }),
      ),

    setSeasonStatus: scopedProcedure('admin:write', { module: 'academy' })
      .input(
        z.object({
          seasonId: z.string().guid(),
          status: seasonStatus,
          ...operatorApprovalIds,
        }),
      )
      .output(seasonOut.extend({ confirmOperatorId: z.string() }))
      .mutation(({ input, ctx }) =>
        guard(async () => {
          const confirmOperatorId = await consumeOperatorApproval(ctx.principal, approvals, input, 'academy.season.setStatus', {
            seasonId: input.seasonId,
            status: input.status,
          });
          const record = await academy.setSeasonStatus({
            seasonId: input.seasonId,
            status: input.status,
          });
          return { ...record, confirmOperatorId };
        }),
      ),

    /**
     * Durable freeze audit — ranked standings at live→frozen (no prize fields).
     * Null when the season was never frozen through setSeasonStatus.
     */
    freezeSnapshot: scopedProcedure('admin:read', { module: 'academy' })
      .input(z.object({ seasonId: z.string().guid() }))
      .output(
        z
          .object({
            seasonId: z.string().guid(),
            frozenAt: z.date(),
            standings: z.array(
              z.object({
                rank: z.number().int().positive(),
                userId: z.string(),
                score: z.number().int(),
                updatedAt: z.string(),
              }),
            ),
          })
          .nullable(),
      )
      .query(({ input }) => guard(() => academy.freezeSnapshot(input.seasonId))),

    /**
     * Class N/M honesty — IFC prize pools refuse-closed on the wire.
     * Pure helpers already refuse; this mounts them so operators never see a
     * success path that invents pool amounts. No amount fields on the output.
     * D26-P1-C3: unset start refuse is greppable on statusLine / blankStart.
     */
    tournamentPrizePlane: scopedProcedure('admin:read', { module: 'academy' })
      .output(
        z.object({
          prizesEnabled: z.literal(false),
          ledgerRecipeReady: z.literal(false),
          academyHoldsPrizeBalance: z.literal(false),
          inventIfc: z.literal(false),
          statusLine: z.string(),
          blankStart: z.object({
            status: z.literal('refuse'),
            code: z.literal('academy.prize_pool_unset'),
            reason: z.literal('unset'),
          }),
          intents: z.array(
            z.object({
              kind: z.enum(['fund_pool', 'payout', 'escrow', 'clawback', 'invent_balance']),
              status: z.literal('refuse'),
              code: z.literal('academy.prize_refuse_closed'),
            }),
          ),
        }),
      )
      .query(() => {
        const kinds: PrizeIntentKind[] = ['fund_pool', 'payout', 'escrow', 'clawback', 'invent_balance'];
        const intents = kinds.map((kind) => {
          const d = decidePrizeIntent(kind);
          if (!isPrizeRefuseClosed(d)) {
            // Unreachable while Stage-3 refuse is absolute — fail closed if that ever softens.
            throw new AcademyError('Prize plane must stay refuse-closed', 'academy.season_invalid');
          }
          return { kind: d.kind, status: 'refuse' as const, code: d.code };
        });
        const blankStart = decidePrizePoolStart(null);
        if (blankStart.code !== 'academy.prize_pool_unset' || blankStart.reason !== 'unset') {
          throw new AcademyError('Blank prize start must stay prize_pool_unset', 'academy.season_invalid');
        }
        return {
          prizesEnabled: false as const,
          ledgerRecipeReady: false as const,
          academyHoldsPrizeBalance: false as const,
          inventIfc: false as const,
          statusLine: prizeRefuseStatusLine(),
          blankStart: {
            status: 'refuse' as const,
            code: 'academy.prize_pool_unset' as const,
            reason: 'unset' as const,
          },
          intents,
        };
      }),

    /** Operator attempt to fund/pay/escrow — always refuse, never invents amounts. */
    tournamentPrizeIntent: scopedProcedure('admin:write', { module: 'academy' })
      .input(z.object({ kind: z.enum(['fund_pool', 'payout', 'escrow', 'clawback', 'invent_balance']) }))
      .output(
        z.object({
          ok: z.literal(false),
          status: z.literal('refuse'),
          code: z.literal('academy.prize_refuse_closed'),
          kind: z.enum(['fund_pool', 'payout', 'escrow', 'clawback', 'invent_balance']),
          message: z.string(),
          academyHoldsPrizeBalance: z.literal(false),
          ledgerRecipeReady: z.literal(false),
        }),
      )
      .mutation(({ input }) => {
        const d = decidePrizeIntent(input.kind);
        return {
          ok: false as const,
          status: 'refuse' as const,
          code: d.code,
          kind: d.kind,
          message: d.message,
          academyHoldsPrizeBalance: false as const,
          ledgerRecipeReady: false as const,
        };
      }),

    /**
     * D26-P1-C3 — start a prize-bearing season.
     * Blank / unset pool → PRECONDITION_FAILED `academy.prize_pool_unset`.
     * Amount present without Class M recipes → still refuse (no invent IFC).
     * Never returns ok / never invents pool amounts on the wire.
     */
    tournamentPrizeStart: scopedProcedure('admin:write', { module: 'academy' })
      .input(
        z.object({
          seasonId: z.string().guid().optional(),
          /** Owner pool amount (decimal string). Blank / omitted → unset refuse. */
          prizePool: z
            .union([z.string(), z.object({ amount: z.string().optional().nullable() }).passthrough()])
            .optional()
            .nullable(),
        }),
      )
      .mutation(({ input }) => {
        try {
          assertMayStartPrizeSeason(input.prizePool);
        } catch (err) {
          throw toTrpcError(err);
        }
      }),

    setStanding: scopedProcedure('admin:write', { module: 'academy' })
      .input(
        z.object({
          seasonId: z.string().guid(),
          userId: z.string().guid(),
          score: z.number().int(),
          ...operatorApprovalIds,
        }),
      )
      .output(standingOut.omit({ rank: true }).extend({ confirmOperatorId: z.string() }))
      .mutation(({ input, ctx }) =>
        guard(async () => {
          const confirmOperatorId = await consumeOperatorApproval(ctx.principal, approvals, input, 'academy.standing.set', {
            seasonId: input.seasonId,
            userId: input.userId,
            score: String(input.score),
          });
          const record = await academy.setStanding({
            seasonId: input.seasonId,
            userId: input.userId,
            score: input.score,
          });
          return { ...record, confirmOperatorId };
        }),
      ),

    /**
     * Bulk score staging on the wire (was pure-only residual).
     * Live season only; empty/dup/bad score refuse closed. No prize invent.
     */
    bulkSetStandings: scopedProcedure('admin:write', { module: 'academy' })
      .input(
        z.object({
          seasonId: z.string().guid(),
          patches: z.array(z.object({ userId: z.string().guid(), score: z.number().int() })).max(500),
          ...operatorApprovalIds,
        }),
      )
      .output(
        z.discriminatedUnion('ok', [
          z.object({
            ok: z.literal(true),
            accepted: z.number().int().nonnegative(),
            statusLine: z.string(),
            standings: z.array(standingOut.omit({ rank: true })),
            confirmOperatorId: z.string(),
          }),
          z.object({
            ok: z.literal(false),
            reason: z.string(),
            message: z.string(),
            statusLine: z.string(),
            badUserId: z.string().optional(),
            confirmOperatorId: z.string(),
          }),
        ]),
      )
      .mutation(({ input, ctx }) =>
        guard(async () => {
          const confirmOperatorId = await consumeOperatorApproval(ctx.principal, approvals, input, 'academy.standing.bulk', {
            seasonId: input.seasonId,
            patches: JSON.stringify(input.patches),
          });
          const result = await academy.bulkSetStandings({
            seasonId: input.seasonId,
            patches: input.patches,
          });
          if (!result.ok) {
            return {
              ok: false as const,
              reason: result.reason,
              message: result.message,
              statusLine: `ok=0 accepted=0 refused=1 reason=${result.reason}`,
              ...(result.badUserId !== undefined ? { badUserId: result.badUserId } : {}),
              confirmOperatorId,
            };
          }
          return {
            ok: true as const,
            accepted: result.accepted,
            confirmOperatorId,
            statusLine: bulkScoreStatusLine(
              validateBulkScoreWrite({
                seasonStatus: 'live',
                seasonId: input.seasonId,
                patches: input.patches,
              }),
            ),
            standings: result.standings,
          };
        }),
      ),

    // ── Certifications (progress + grants + XP emit + perk real/refuse — NO PAY) ─
    //
    // Definitions are code-seeded. Completions and grants are durable. Stage-2
    // publishes `intafaced.identity.xp.earned` on grant. D26-P1-C1 then surfaces
    // real svc-identity perks or refuses invent perk money — never a cert→perk
    // map or academy perk book (§4.1). Nothing here posts to the ledger.

    certDefinitions: scopedProcedure('academy:read', { module: 'academy' })
      .output(z.array(certDefinitionOut))
      .query(() =>
        academy.listCertDefinitions().map((c) => ({
          id: c.id,
          title: c.title,
          requiredItemSlugs: [...c.requiredItemSlugs],
        })),
      ),

    /**
     * AC-certificates-01: every learning path with its published certificate, or the refusal a path with no published
     * certificate design gets (`academy.certificate_unpublished`), so the Certificates tab shows each path in full layout.
     */
    certPaths: scopedProcedure('academy:read', { module: 'academy' })
      .output(
        z.array(
          z.object({
            path: curriculumPath,
            certId: z.string().nullable(),
            refusal: z.literal('academy.certificate_unpublished').nullable(),
          }),
        ),
      )
      .query(() => academy.certPaths()),

    enrollCertPath: scopedProcedure('academy:write', { module: 'academy' })
      .input(z.object({ pathSlug: z.string().min(1).max(64) }))
      .output(enrollmentOut)
      .mutation(({ input, ctx }) => guard(() => academy.enrollCertPath({ userId: ctx.principal!.userId, pathSlug: input.pathSlug }))),

    /** AC-enrolment-01: Enrol now from a course page. A repeat while enrolled answers with the same enrolment. */
    enrolCourse: scopedProcedure('academy:write', { module: 'academy' })
      .input(academyEnrolCourseInputSchema)
      .output(academyCourseEnrolmentSchema)
      .mutation(({ input, ctx }) =>
        guard(() => academy.enrolCourse({ userId: ctx.principal!.userId, slug: input.slug, track: input.track })),
      ),

    /** AC-enrolment-01: the terms of enrolling in a course (tracks, start date, seats, closed reason) and the caller's own enrolment. */
    courseEnrolment: scopedProcedure('academy:read', { module: 'academy' })
      .input(z.object({ slug: z.string().min(1).max(64) }).strict())
      .output(academyCourseEnrolmentSchema)
      .query(({ input, ctx }) => guard(() => academy.courseEnrolment({ userId: ctx.principal.userId, slug: input.slug }))),

    /** AC-catalogue-03: a published course staff made, as the caller sees it: their enrolment opens what is released. */
    authoredCourse: scopedProcedure('academy:read', { module: 'academy' })
      .input(academyAuthoredCourseInputSchema)
      .output(academyCourseLearnerViewSchema)
      .query(({ input, ctx }) => guard(() => academy.authoredCoursePage(input.slug, ctx.principal.userId))),

    /** AC-enrolment-01: the terms of enrolling in a course staff made, and the caller's own enrolment. */
    authoredCourseEnrolment: scopedProcedure('academy:read', { module: 'academy' })
      .input(academyAuthoredCourseInputSchema)
      .output(academyAuthoredCourseEnrolmentSchema)
      .query(({ input, ctx }) => guard(() => academy.authoredCourseEnrolment({ userId: ctx.principal.userId, slug: input.slug }))),

    /** AC-enrolment-01: enrol on the free track, keyed `enrol:<user>:<course>`; a closed track refuses `academy.enrolment_closed`. */
    enrolAuthoredCourse: scopedProcedure('academy:write', { module: 'academy' })
      .input(academyEnrolCourseInputSchema)
      .output(academyAuthoredCourseEnrolmentSchema)
      .mutation(({ input, ctx }) =>
        guard(() => academy.enrolAuthoredCourse({ userId: ctx.principal!.userId, slug: input.slug, track: input.track })),
      ),

    /** AC-enrolment-01: leave the enrolment that began at `enrolledAt`; a repeat is the same leave. */
    leaveAuthoredCourse: scopedProcedure('academy:write', { module: 'academy' })
      .input(academyLeaveAuthoredCourseInputSchema)
      .output(academyAuthoredCourseEnrolmentSchema)
      .mutation(({ input, ctx }) => guard(() => academy.leaveAuthoredCourse({ ...input, userId: ctx.principal!.userId }))),

    /** AC-assignments-01: an assignment as the enrolled learner sees it, with their own hand-ins, newest first. */
    assignment: scopedProcedure('academy:read', { module: 'academy' })
      .input(academyAssignmentInputSchema)
      .output(academyAssignmentViewSchema)
      .query(({ input, ctx }) => guard(() => academy.assignment({ itemId: input.itemId, userId: ctx.principal.userId }))),

    /** AC-quizzes-01: a published quiz in a course staff made, as the enrolled learner reads it: no key, code or filter. */
    courseQuiz: scopedProcedure('academy:read', { module: 'academy' })
      .input(academyCourseQuizInputSchema)
      .output(academyLearnerCourseQuizSchema)
      .query(({ input, ctx }) => guard(() => academy.courseQuizzes.learnerView({ itemId: input.itemId, userId: ctx.principal.userId }))),

    /** AC-quizzes-01: start (or get back) the caller's attempt; enrolment, the access code and the IP filter are checked first. */
    startCourseQuiz: scopedProcedure('academy:write', { module: 'academy' })
      .input(academyStartCourseQuizInputSchema)
      .output(academyCourseQuizAttemptSchema)
      .mutation(({ input, ctx }) =>
        guard(() =>
          academy.courseQuizzes.start({
            itemId: input.itemId,
            userId: ctx.principal.userId,
            accessCode: input.accessCode,
            clientAddress: quizClientAddressOf(ctx),
            now: new Date(),
          }),
        ),
      ),

    /** AC-quizzes-02: the caller's newest attempt on a course quiz, with its score as the results visibility allows; null before any. */
    courseQuizAttempt: scopedProcedure('academy:read', { module: 'academy' })
      .input(academyCourseQuizInputSchema)
      .output(academyCourseQuizAttemptSchema.nullable())
      .query(({ input, ctx }) =>
        guard(() => academy.courseQuizzes.current({ itemId: input.itemId, userId: ctx.principal.userId, now: new Date() })),
      ),

    /** AC-quizzes-02: save one answer on the caller's open attempt: a choice, choices, a decimal or text. */
    answerCourseQuiz: scopedProcedure('academy:write', { module: 'academy' })
      .input(academyAnswerCourseQuizInputSchema)
      .output(academyCourseQuizAttemptSchema)
      .mutation(({ input, ctx }) => guard(() => academy.courseQuizzes.answer({ ...input, userId: ctx.principal.userId, now: new Date() }))),

    /** AC-quizzes-02: finish and score once; an essay leaves the attempt pending review. */
    finishCourseQuiz: scopedProcedure('academy:write', { module: 'academy' })
      .input(academyFinishCourseQuizInputSchema)
      .output(academyCourseQuizAttemptSchema)
      .mutation(({ input, ctx }) =>
        guard(() => academy.courseQuizzes.finish({ attemptId: input.attemptId, userId: ctx.principal.userId, now: new Date() })),
      ),

    /** AC-quizzes-02: one survey response; an anonymous survey keeps no account with it. */
    submitCourseSurvey: scopedProcedure('academy:write', { module: 'academy' })
      .input(academySubmitCourseSurveyInputSchema)
      .output(academySurveySubmittedSchema)
      .mutation(({ input, ctx }) =>
        guard(() => academy.courseQuizzes.submitSurvey({ ...input, userId: ctx.principal.userId, now: new Date() })),
      ),

    /** AC-assignments-01: a file for the next hand-in, checked against the owner's limits; the same file is the same row. */
    uploadAssignmentFile: scopedProcedure('academy:write', { module: 'academy' })
      .input(academyUploadAssignmentFileInputSchema)
      .output(academySubmissionFileSchema)
      .mutation(({ input, ctx }) => guard(() => academy.uploadAssignmentFile({ ...input, userId: ctx.principal!.userId }))),

    /** AC-assignments-01: hand in version n, keyed `submit:<item>:<account>:<n>`; a retry returns the stored hand-in. */
    submitAssignment: scopedProcedure('academy:write', { module: 'academy' })
      .input(academySubmitAssignmentInputSchema)
      .output(academyAssignmentViewSchema)
      .mutation(({ input, ctx }) => guard(() => academy.submitAssignment({ ...input, userId: ctx.principal!.userId }))),

    /** AC-assignments-03: the caller's review stage; hands them the next classmate's work when one is due and free. */
    peerReview: scopedProcedure('academy:write', { module: 'academy' })
      .input(academyPeerReviewInputSchema)
      .output(academyReviewStateSchema)
      .mutation(({ input, ctx }) => guard(() => academy.peerReview({ itemId: input.itemId, userId: ctx.principal!.userId }))),

    /** AC-assignments-02: the caller read the feedback on one of their graded hand-ins; changes no grade. */
    markFeedbackRead: scopedProcedure('academy:write', { module: 'academy' })
      .input(academyMarkFeedbackReadInputSchema)
      .output(academyAssignmentViewSchema)
      .mutation(({ input, ctx }) => guard(() => academy.markFeedbackRead({ ...input, userId: ctx.principal!.userId }))),

    /** AC-assignments-03: the file of work handed to the caller to review, read back so its store address stays hidden. */
    peerReviewFile: scopedProcedure('academy:read', { module: 'academy' })
      .input(academyPeerReviewFileInputSchema)
      .output(academyPeerReviewFileSchema)
      .query(({ input, ctx }) => guard(() => academy.peerReviewFile({ ...input, userId: ctx.principal!.userId }))),

    /** AC-assignments-03: one review's marks, keyed `peer:<assignment>:<reviewer>:<author>`; the same marks answer as stored. */
    submitPeerReview: scopedProcedure('academy:write', { module: 'academy' })
      .input(academySubmitPeerReviewInputSchema)
      .output(academyReviewStateSchema)
      .mutation(({ input, ctx }) => guard(() => academy.submitPeerReview({ ...input, userId: ctx.principal!.userId }))),

    /** AC-catalogue-02: My learning, the caller's enrolled courses with real progress and where Continue goes. */
    myLearning: scopedProcedure('academy:read', { module: 'academy' })
      .output(z.array(academyMyCourseSchema))
      .query(({ ctx }) => guard(() => academy.myLearning(ctx.principal.userId))),

    /** AC-course-structure-02: the outline of an item's course, with the caller's own release state per item. */
    courseOutline: scopedProcedure('academy:read', { module: 'academy' })
      .input(z.object({ itemSlug: z.string().min(1).max(120) }).strict())
      .output(academyCourseOutlineSchema)
      .query(({ input, ctx }) => guard(() => academy.courseOutline({ userId: ctx.principal.userId, itemSlug: input.itemSlug }))),

    /** AC-access-grants-01: the caller's access records, with source and expiry. */
    myAccessGrants: scopedProcedure('academy:read', { module: 'academy' })
      .output(z.array(academyAccessGrantSchema))
      .query(({ ctx }) => guard(() => academy.myAccessGrants(ctx.principal.userId))),

    /** AC-progress-02: the caller's progress page: percent complete per enrolled course, check marks, and grades. */
    myProgress: scopedProcedure('academy:read', { module: 'academy' })
      .output(academyProgressPageSchema)
      .query(({ ctx }) => guard(() => academy.progressPage(ctx.principal.userId))),

    /** AC-progress-02: the caller's own planner: to-do items and a weekly goal. Nothing here is visible to anyone else. */
    planner: router({
      get: scopedProcedure('academy:read', { module: 'academy' })
        .output(academyPlannerSchema)
        .query(({ ctx }) => guard(() => academy.planner(ctx.principal.userId))),
      addTodo: scopedProcedure('academy:write', { module: 'academy' })
        .input(academyAddTodoInputSchema)
        .output(academyPlannerTodoSchema)
        .mutation(({ input, ctx }) => guard(() => academy.addTodo({ ...input, userId: ctx.principal.userId }))),
      setTodoDone: scopedProcedure('academy:write', { module: 'academy' })
        .input(academySetTodoDoneInputSchema)
        .output(academyPlannerTodoSchema)
        .mutation(({ input, ctx }) => guard(() => academy.setTodoDone({ ...input, userId: ctx.principal.userId }))),
      removeTodo: scopedProcedure('academy:write', { module: 'academy' })
        .input(academyRemoveTodoInputSchema)
        .output(z.object({ id: z.string().guid(), removed: z.literal(true) }))
        .mutation(({ input, ctx }) => guard(() => academy.removeTodo({ ...input, userId: ctx.principal.userId }))),
      setGoal: scopedProcedure('academy:write', { module: 'academy' })
        .input(academySetGoalInputSchema)
        .output(academyGoalSchema.nullable())
        .mutation(({ input, ctx }) => guard(() => academy.setGoal({ ...input, userId: ctx.principal.userId }))),
      sendGoalReminder: scopedProcedure('academy:write', { module: 'academy' })
        .output(academyGoalReminderSchema)
        .mutation(({ ctx }) => guard(() => academy.sendGoalReminder({ userId: ctx.principal.userId }))),
    }),

    markCurriculumComplete: scopedProcedure('academy:write', { module: 'academy' })
      .input(z.object({ itemSlug: z.string().min(1).max(120) }))
      .output(itemCompletionOut)
      .mutation(({ input, ctx }) =>
        guard(() =>
          academy.markCurriculumComplete({
            userId: ctx.principal!.userId,
            itemSlug: input.itemSlug,
            mayWatch: () => assertAcademyVideoEntitled(video, { userId: ctx.principal!.userId, tier: ctx.principal!.tier }),
          }),
        ),
      ),

    /** AC-progress-01: Undo a completion. Progress drops and the history keeps both events; completing again adds one. */
    undoCurriculumComplete: scopedProcedure('academy:write', { module: 'academy' })
      .input(academyUndoCompletionInputSchema)
      .output(academyUndoCompletionSchema)
      .mutation(({ input, ctx }) =>
        guard(() =>
          academy.undoCurriculumComplete({
            userId: ctx.principal.userId,
            itemSlug: input.itemSlug,
            completedAt: input.completedAt,
            clientRequestId: input.clientRequestId,
          }),
        ),
      ),

    /**
     * Whether this learner may work the item: locked, unlocked, started or
     * completed. No stored rule means unlocked (or started, once they opened it).
     */
    itemRelease: scopedProcedure('academy:read', { module: 'academy' })
      .input(z.object({ itemSlug: z.string().min(1).max(120) }))
      .output(
        z.object({
          itemSlug: z.string(),
          state: z.enum(['locked', 'unlocked', 'started', 'completed']),
          missing: z.array(z.string()),
          lock: z.enum(['prerequisite', 'window']).nullable(),
          availableFrom: z.date().nullable(),
          availableUntil: z.date().nullable(),
          dueAt: z.date().nullable(),
          extendedUntil: z.date().nullable(),
          reason: z.string().nullable(),
          grantedAt: z.date().nullable(),
          grantedBy: z.string().guid().nullable(),
        }),
      )
      .query(({ input, ctx }) => guard(() => academy.itemRelease({ userId: ctx.principal!.userId, itemSlug: input.itemSlug }))),

    /**
     * Grant the caller's own certification, publish the XP it is worth, and
     * report real identity perks (or refuse when invent/unreadable).
     *
     * Safe to call twice: the grant is idempotent on (user, cert) and the award
     * carries that same business key, which identity drops on conflict. Calling
     * it again after a bus outage is the documented way to recover a missing
     * award — see academy-service.grantCert.
     */
    grantCert: scopedProcedure('academy:write', { module: 'academy' })
      .input(z.object({ certId: z.string().min(1).max(64) }))
      .output(
        z.object({
          grant: certGrantOut,
          alreadyGranted: z.boolean(),
          xp: certXpOut,
          perks: certPerkOutcomeOut,
        }),
      )
      .mutation(({ input, ctx }) =>
        guard(async () => {
          const result = await academy.grantCert({ userId: ctx.principal!.userId, certId: input.certId });
          return {
            alreadyGranted: result.alreadyGranted,
            grant: {
              userId: result.grant.userId,
              certId: result.grant.certId,
              grantedAt: result.grant.grantedAt,
              idempotencyKey: result.grant.idempotencyKey,
              publicId: result.grant.publicId,
            },
            xp: result.xp,
            perks: result.perks,
          };
        }),
      ),

    /**
     * Stage-2 XP plane status: is this process publishing awards at all, under
     * which module/action, and what each cert is worth. Answers "my cert did not
     * move my rank" without guessing — `emitEnabled: false` is a deployment
     * fact, not a ladder disagreement.
     */
    certXpPlane: scopedProcedure('academy:read', { module: 'academy' })
      .output(certXpPlaneOut)
      .query(() => {
        const plane = academy.certXpPlane();
        return { ...plane, policies: [...plane.policies] };
      }),

    /**
     * D26-P1-C1 perk plane: real perks via identity rank only; invent money refuse-closed.
     */
    certPerkPlane: scopedProcedure('academy:read', { module: 'academy' })
      .output(certPerkPlaneOut)
      .query(() => {
        const plane = academy.certPerkPlane();
        return { ...plane, inventKindsRefuseClosed: [...plane.inventKindsRefuseClosed] };
      }),

    /**
     * Operator attempt to invent cert→perk money / map — always refuse, never amounts.
     */
    certPerkIntent: scopedProcedure('admin:write', { module: 'academy' })
      .input(z.object({ kind: certPerkInventKind }))
      .output(
        z.object({
          ok: z.literal(false),
          status: z.literal('refuse'),
          code: z.literal(CERT_PERK_REFUSE_CODE),
          kind: certPerkInventKind,
          message: z.string(),
          academyHoldsPerkMoney: z.literal(false),
          academyMapsCertToPerk: z.literal(false),
          residual: z.literal(CERT_PERK_RESIDUAL),
        }),
      )
      .mutation(({ input }) => {
        const d = decideCertPerkInvent(input.kind as CertPerkInventKind);
        if (!isCertPerkInventRefuseClosed(d)) {
          throw new AcademyError('Cert perk invent plane must stay refuse-closed', 'academy.cert_invalid');
        }
        return {
          ok: false as const,
          status: 'refuse' as const,
          code: d.code,
          kind: d.kind,
          message: d.message,
          academyHoldsPerkMoney: false as const,
          academyMapsCertToPerk: false as const,
          residual: d.residual,
        };
      }),

    /** AC-programmes-01: the learning programmes newest first, each with the caller's course counts and certificate. */
    programmes: scopedProcedure('academy:read', { module: 'academy' })
      .input(academyProgrammesInputSchema)
      .output(z.array(academyProgrammeSchema))
      .query(({ input, ctx }) =>
        guard(() => academy.programmes({ userId: ctx.principal!.userId, limit: input.limit, mine: input.mine ?? false })),
      ),

    /** AC-programmes-01: one programme: its courses in order with the caller's state on each, the counts and the certificate. */
    programme: scopedProcedure('academy:read', { module: 'academy' })
      .input(academyProgrammeInputSchema)
      .output(academyProgrammeSchema)
      .query(({ input, ctx }) => guard(() => academy.programme({ userId: ctx.principal!.userId, slug: input.slug }))),

    /** AC-rooms-01: the published courses the caller is enrolled in, each a way into its discussion. */
    discussionCourses: scopedProcedure('academy:read', { module: 'academy' })
      .input(academyDiscussionCoursesInputSchema)
      .output(z.array(academyDiscussionCourseSchema))
      .query(({ input, ctx }) => guard(() => academy.discussion.courses(ctx.principal!.userId, input.limit))),

    /** AC-rooms-01: a course's discussion topics, pinned first, with the default General topic. Enrolled learners only. */
    discussionTopics: scopedProcedure('academy:read', { module: 'academy' })
      .input(academyDiscussionTopicsInputSchema)
      .output(academyDiscussionTopicsSchema)
      .query(({ input, ctx }) => guard(() => academy.discussion.topics({ userId: ctx.principal!.userId, courseSlug: input.courseSlug }))),

    /** AC-rooms-01: one topic's posts, newest first. */
    discussionPosts: scopedProcedure('academy:read', { module: 'academy' })
      .input(academyDiscussionPostsInputSchema)
      .output(z.array(academyDiscussionPostSchema))
      .query(({ input, ctx }) => guard(() => academy.discussion.posts({ ...input, userId: ctx.principal!.userId }))),

    /** AC-rooms-01: one post and up to `limit` of its replies, the accepted answer first. */
    discussionThread: scopedProcedure('academy:read', { module: 'academy' })
      .input(academyDiscussionThreadInputSchema)
      .output(academyDiscussionThreadSchema)
      .query(({ input, ctx }) => guard(() => academy.discussion.thread({ ...input, userId: ctx.principal!.userId }))),

    /** AC-rooms-01: a post's image, or null when it has none. */
    discussionPostImage: scopedProcedure('academy:read', { module: 'academy' })
      .input(academyDiscussionPostImageInputSchema)
      .output(academyDiscussionImageSchema.nullable())
      .query(({ input, ctx }) => guard(() => academy.discussion.image({ userId: ctx.principal!.userId, postId: input.postId }))),

    /** AC-rooms-01: post a question or a discussion; a retry with the same client request id is the same post. */
    createDiscussionPost: scopedProcedure('academy:write', { module: 'academy' })
      .input(academyCreateDiscussionPostInputSchema)
      .output(academyDiscussionPostSchema)
      .mutation(({ input, ctx }) =>
        guard(() => academy.discussion.createPost({ ...input, userId: ctx.principal!.userId, now: new Date() })),
      ),

    /** AC-rooms-01: reply to a post (one level). */
    replyDiscussionPost: scopedProcedure('academy:write', { module: 'academy' })
      .input(academyReplyDiscussionPostInputSchema)
      .output(academyDiscussionReplySchema)
      .mutation(({ input, ctx }) => guard(() => academy.discussion.reply({ ...input, userId: ctx.principal!.userId, now: new Date() }))),

    /** AC-rooms-01: the asker marks one reply as the accepted answer; marking another moves the mark. */
    acceptDiscussionReply: scopedProcedure('academy:write', { module: 'academy' })
      .input(academyAcceptDiscussionReplyInputSchema)
      .output(academyDiscussionAcceptResultSchema)
      .mutation(({ input, ctx }) => guard(() => academy.discussion.accept({ ...input, userId: ctx.principal!.userId }))),

    /** AC-rooms-01: follow a post or stop; a repeat changes nothing. */
    followDiscussionPost: scopedProcedure('academy:write', { module: 'academy' })
      .input(academyDiscussionToggleInputSchema)
      .output(academyDiscussionFollowResultSchema)
      .mutation(({ input, ctx }) => guard(() => academy.discussion.follow({ ...input, userId: ctx.principal!.userId, now: new Date() }))),

    /** AC-rooms-01: like a post or a reply, or take it back; a repeat changes nothing. */
    likeDiscussionPost: scopedProcedure('academy:write', { module: 'academy' })
      .input(academyDiscussionToggleInputSchema)
      .output(academyDiscussionLikeResultSchema)
      .mutation(({ input, ctx }) => guard(() => academy.discussion.like({ ...input, userId: ctx.principal!.userId, now: new Date() }))),

    /** AC-rooms-04: write to the course team of a course the caller is enrolled in; the mail copy names vendor.email. */
    sendCourseMessage: scopedProcedure('academy:write', { module: 'academy' })
      .input(academySendCourseMessageInputSchema)
      .output(academySendCourseMessageResultSchema)
      .mutation(({ input, ctx }) => guard(() => academy.courseMessages.send({ ...input, userId: ctx.principal!.userId, now: new Date() }))),

    /** AC-rooms-04: the caller's own conversations with course teams, newest first, each with its unread marker. */
    courseConversations: scopedProcedure('academy:read', { module: 'academy' })
      .input(academyCourseConversationsInputSchema)
      .output(z.array(academyCourseConversationSummarySchema))
      .query(({ input, ctx }) => guard(() => academy.courseMessages.inbox(ctx.principal!.userId, input.limit))),

    /** AC-rooms-04: open one of the caller's conversations, which marks it read on their side. */
    openCourseConversation: scopedProcedure('academy:write', { module: 'academy' })
      .input(academyCourseConversationInputSchema)
      .output(academyCourseConversationSchema)
      .mutation(({ input, ctx }) => guard(() => academy.courseMessages.open({ ...input, userId: ctx.principal!.userId, now: new Date() }))),

    myCerts: scopedProcedure('academy:read', { module: 'academy' })
      .input(z.object({ limit: z.number().optional() }).optional())
      .output(z.array(certGrantOut))
      .query(({ input, ctx }) => guard(() => academy.myCertGrants(ctx.principal!.userId, input?.limit))),

    certProgress: scopedProcedure('academy:read', { module: 'academy' })
      .input(z.object({ certId: z.string().min(1).max(64) }))
      .output(certProgressOut)
      .query(({ input, ctx }) =>
        guard(async () => {
          const p = await academy.certProgress({ userId: ctx.principal!.userId, certId: input.certId });
          return {
            userId: p.userId,
            certId: p.certId,
            title: p.title,
            requiredCount: p.requiredCount,
            completedCount: p.completedCount,
            ratio: p.ratio,
            missingItemSlugs: [...p.missingItemSlugs],
            complete: p.complete,
            granted: p.granted,
            grantIdempotencyKey: p.grantIdempotencyKey,
            issue: p.issue,
          };
        }),
      ),

    assessment: router({
      get: scopedProcedure('academy:read', { module: 'academy' })
        .input(z.object({ slug: z.string().min(1).max(120) }))
        .output(academyQuizSchema)
        .query(({ input }) => guard(() => academy.getAssessment(input.slug))),

      /** AC-quizzes-03: Start a timed attempt, or get back the one already open with its server-held time left. */
      start: scopedProcedure('academy:write', { module: 'academy' })
        .input(z.object({ slug: z.string().min(1).max(120) }).strict())
        .output(academyQuizAttemptSchema)
        .mutation(({ input, ctx }) => guard(() => academy.startQuizAttempt({ userId: ctx.principal.userId, slug: input.slug }))),

      /** The caller's open attempt on this quiz, or null (one past its deadline is finished on this read). */
      current: scopedProcedure('academy:read', { module: 'academy' })
        .input(z.object({ slug: z.string().min(1).max(120) }).strict())
        .output(academyQuizAttemptSchema.nullable())
        .query(({ input, ctx }) => guard(() => academy.currentQuizAttempt({ userId: ctx.principal.userId, slug: input.slug }))),

      /** Autosave one answer on the caller's open attempt. */
      answer: scopedProcedure('academy:write', { module: 'academy' })
        .input(
          z
            .object({
              attemptId: z.string().guid(),
              questionId: z.string().min(1).max(80),
              choiceId: z.string().min(1).max(80),
            })
            .strict(),
        )
        .output(academyQuizAttemptSchema)
        .mutation(({ input, ctx }) => guard(() => academy.answerQuizAttempt({ userId: ctx.principal.userId, ...input }))),

      /** Score the saved answers once; finishing again answers with the same result. */
      finish: scopedProcedure('academy:write', { module: 'academy' })
        .input(z.object({ attemptId: z.string().guid() }).strict())
        .output(academyQuizAttemptSchema)
        .mutation(({ input, ctx }) => guard(() => academy.finishQuizAttempt({ userId: ctx.principal.userId, attemptId: input.attemptId }))),

      /** A finished attempt of the caller's own, with answers against the key or the score only. */
      review: scopedProcedure('academy:read', { module: 'academy' })
        .input(z.object({ attemptId: z.string().guid() }).strict())
        .output(academyQuizReviewSchema)
        .query(({ input, ctx }) => guard(() => academy.reviewQuizAttempt({ userId: ctx.principal.userId, attemptId: input.attemptId }))),

      submit: scopedProcedure('academy:write', { module: 'academy' })
        .input(
          z.object({
            slug: z.string().min(1).max(120),
            clientAttemptId: z.string().min(1).max(200),
            answers: z.array(z.object({ questionId: z.string().min(1).max(80), choiceId: z.string().min(1).max(80) })).max(100),
          }),
        )
        .output(
          z.object({
            slug: z.string(),
            score: z.number().int(),
            maxScore: z.number().int(),
            pass: z.boolean(),
            submittedAt: z.date(),
          }),
        )
        .mutation(({ input, ctx }) =>
          guard(() =>
            academy.submitAssessment({
              userId: ctx.principal.userId,
              slug: input.slug,
              clientAttemptId: input.clientAttemptId,
              answers: input.answers,
            }),
          ),
        ),

      attempts: scopedProcedure('academy:read', { module: 'academy' })
        .input(z.object({ slug: z.string().min(1).max(120) }))
        .output(
          z.array(
            // While the quiz's results are hidden (AC-progress-02) an attempt carries `hiddenUntil` and no score.
            z.object({
              slug: z.string(),
              score: z.number().int().nullable(),
              maxScore: z.number().int().nullable(),
              pass: z.boolean().nullable(),
              submittedAt: z.date(),
              hiddenUntil: z.date().nullable(),
            }),
          ),
        )
        .query(({ input, ctx }) => guard(() => academy.assessmentAttempts(ctx.principal.userId, input.slug))),
    }),

    /**
     * Signed-out verification. The body is exactly the credential fields.
     * A blank rate refuses before any lookup. Malformed and unknown ids
     * share one not-found error.
     */
    certVerify: publicProcedure
      .input(z.object({ publicId: z.string().max(200) }))
      .output(
        z.object({
          certId: z.string(),
          title: z.string(),
          grantedAt: z.date(),
          status: z.enum(['valid', 'revoked']),
          holderName: z.string().optional(),
        }),
      )
      .query(({ input, ctx }) =>
        guard(async () => {
          if (!verifyRate) throw new AcademyError('academy.verify_rate_unset', 'academy.verify_rate_unset');
          const address = clientAddressOf(ctx);
          if (!address) throw new AcademyError('academy.verify_address_unset', 'academy.verify_address_unset');
          if (verifyLimiter.take(address, verifyRate) === 'limited') {
            throw new AcademyError('academy.verify_rate_limited', 'academy.verify_rate_limited');
          }
          return academy.certVerify(input.publicId);
        }),
      ),

    setCertHolderName: scopedProcedure('academy:write', { module: 'academy' })
      .input(
        z
          .object({
            grantId: z.string().min(1).max(64).optional(),
            publicId: z.string().min(1).max(64).optional(),
            holderName: z.string().max(400).nullable(),
            consent: z.literal(true),
            clientRequestId: z.string().min(1).max(200),
          })
          .refine((value) => (value.grantId ? 1 : 0) + (value.publicId ? 1 : 0) === 1),
      )
      .output(
        z.object({
          publicId: z.string(),
          holderName: z.string().nullable(),
          consentAt: z.date().nullable(),
        }),
      )
      .mutation(({ input, ctx }) =>
        guard(() =>
          academy.setCertHolderName({
            userId: ctx.principal.userId,
            holderName: input.holderName,
            clientRequestId: input.clientRequestId,
            ...(input.grantId ? { grantId: input.grantId } : {}),
            ...(input.publicId ? { publicId: input.publicId } : {}),
          }),
        ),
      ),

    myCompletions: scopedProcedure('academy:read', { module: 'academy' })
      .input(z.object({ limit: z.number().optional(), cursor: z.string().min(1).max(512).optional() }))
      .output(completionPageOut)
      .query(({ ctx, input }) =>
        guard(() => academy.myCompletions({ userId: ctx.principal.userId, limit: input.limit, cursor: input.cursor ?? null })),
      ),

    myEnrollments: scopedProcedure('academy:read', { module: 'academy' })
      .output(z.array(enrollmentOut))
      .query(({ ctx }) =>
        guard(async () =>
          (await academy.myEnrollments(ctx.principal.userId)).map((row) => ({
            userId: row.userId,
            pathSlug: row.pathSlug,
            enrolledAt: row.enrolledAt,
          })),
        ),
      ),

    leaveCertPath: scopedProcedure('academy:write', { module: 'academy' })
      .input(z.object({ pathSlug: z.string().min(1).max(64), clientRequestId: z.string().min(1).max(200) }))
      .output(leaveOut)
      .mutation(({ ctx, input }) =>
        guard(async () => {
          const row = await academy.leaveCertPath({
            userId: ctx.principal.userId,
            pathSlug: input.pathSlug,
            clientRequestId: input.clientRequestId,
          });
          if (!row.leftAt) throw new AcademyError('Leave did not record leftAt', 'academy.cert_invalid');
          return { userId: row.userId, pathSlug: row.pathSlug, enrolledAt: row.enrolledAt, leftAt: row.leftAt };
        }),
      ),

    learningState: scopedProcedure('academy:read', { module: 'academy' })
      .output(learningStateOut)
      .query(({ ctx }) => guard(() => academy.learningState(ctx.principal.userId))),

    touchLesson: scopedProcedure('academy:write', { module: 'academy' })
      .input(
        z.object({
          slug: z.string().min(1).max(120),
          secondsRead: z.number().optional(),
          clientRequestId: z.string().min(1).max(200),
        }),
      )
      .output(learningStateOut)
      .mutation(({ ctx, input }) =>
        guard(() =>
          academy.touchLesson({
            userId: ctx.principal.userId,
            slug: input.slug,
            clientRequestId: input.clientRequestId,
            ...(input.secondsRead !== undefined ? { secondsRead: input.secondsRead } : {}),
          }),
        ),
      ),

    residencyCohorts: scopedProcedure('academy:read', { module: 'academy' })
      .input(z.object({ limit: z.number().optional() }))
      .output(z.array(cohortOut))
      .query(({ input }) => guard(() => academy.residencyCohorts(input.limit))),

    videoProgress: router({
      set: scopedProcedure('academy:write', { module: 'academy' })
        .input(
          z.object({
            videoSlug: z.string().min(1).max(120),
            positionSeconds: z.number(),
            clientRequestId: z.string().min(1).max(200),
          }),
        )
        .output(academyVideoPositionSavedSchema)
        .mutation(({ ctx, input }) =>
          guard(() =>
            academy.setVideoProgress({
              userId: ctx.principal.userId,
              videoSlug: input.videoSlug,
              positionSeconds: input.positionSeconds,
              clientRequestId: input.clientRequestId,
              mayWatch: () => assertAcademyVideoEntitled(video, { userId: ctx.principal.userId, tier: ctx.principal.tier }),
            }),
          ),
        ),
      get: scopedProcedure('academy:read', { module: 'academy' })
        .input(z.object({ videoSlug: z.string().min(1).max(120) }))
        .output(videoProgressOut)
        .query(({ ctx, input }) => guard(() => academy.getVideoProgress({ userId: ctx.principal.userId, videoSlug: input.videoSlug }))),
      /**
       * Stored position against the owner watch threshold. Blank threshold
       * refuses academy.watch_threshold_unset. A missing row is not watched.
       * Caller-only: the user id comes from the session, never the input.
       */
      watched: scopedProcedure('academy:read', { module: 'academy' })
        .input(z.object({ videoSlug: z.string().min(1).max(120) }).strict())
        .output(
          z.object({
            videoSlug: z.string(),
            positionSeconds: z.number().int().nullable(),
            thresholdSeconds: z.number().int(),
            watched: z.boolean(),
          }),
        )
        .query(({ ctx, input }) =>
          guard(async () => {
            requireSpineItem(input.videoSlug);
            const progress = await academy.getVideoProgress({
              userId: ctx.principal.userId,
              videoSlug: input.videoSlug,
            });
            return decideWatched({
              videoSlug: input.videoSlug,
              positionSeconds: progress.positionSeconds,
              thresholdSeconds: settings.ACADEMY_VIDEO_WATCH_THRESHOLD_SECONDS,
            });
          }),
        ),
    }),

    myUpcomingSessions: scopedProcedure('academy:read', { module: 'academy' })
      .input(z.object({ limit: z.number().optional() }))
      .output(z.array(upcomingSessionOut))
      .query(({ ctx, input }) => guard(() => academy.myUpcomingSessions({ userId: ctx.principal.userId, limit: input.limit }))),

    sessionCalendar: scopedProcedure('academy:read', { module: 'academy' })
      .input(z.object({ sessionId: z.string().guid() }))
      .output(z.object({ calendar: z.string() }))
      .query(({ ctx, input }) =>
        guard(async () => ({ calendar: await academy.sessionCalendar({ userId: ctx.principal.userId, sessionId: input.sessionId }) })),
      ),

    admin: router({
      ...gradeReportProcedures(academy.gradeReports),
      /** AC-course-structure-01: the courses staff created, newest first, and how many are in each state. */
      courses: scopedProcedure('admin:read', { module: 'academy' })
        .input(academyCourseListInputSchema)
        .output(academyCourseListSchema)
        .query(({ input }) => guard(() => academy.courses(input))),

      /** AC-course-structure-01: one course with its history (who did what, and why), newest first. */
      course: scopedProcedure('admin:read', { module: 'academy' })
        .input(academyCourseIdInputSchema)
        .output(academyCourseDetailSchema)
        .query(({ input }) => guard(() => academy.course(input.courseId))),

      /** AC-course-structure-01: create a course as a draft. Keyed by its slug; a repeat answers with the stored course. */
      createCourse: scopedProcedure('admin:write', { module: 'academy' })
        .input(academyCreateCourseInputSchema)
        .output(academyCourseSchema)
        .mutation(({ input, ctx }) => guard(() => academy.createCourse({ ...input, operatorId: ctx.principal!.userId }))),

      /** AC-course-structure-01: edit a draft's details over the revision the editor read. The slug never changes. */
      updateCourse: scopedProcedure('admin:write', { module: 'academy' })
        .input(academyUpdateCourseInputSchema)
        .output(academyCourseSchema)
        .mutation(({ input, ctx }) => guard(() => academy.updateCourse({ ...input, operatorId: ctx.principal!.userId }))),

      /** AC-course-structure-01: one lifecycle move with a reason. Publishing refuses a paid course with no price, and an empty outline. */
      setCourseState: scopedProcedure('admin:write', { module: 'academy' })
        .input(academySetCourseStateInputSchema)
        .output(academyCourseSchema)
        .mutation(({ input, ctx }) => guard(() => academy.setCourseState({ ...input, operatorId: ctx.principal!.userId }))),

      /** AC-course-structure-02: replace a draft's outline (sections of typed items) over the revision read, inside the owner's limits. */
      saveOutline: scopedProcedure('admin:write', { module: 'academy' })
        .input(academySaveOutlineInputSchema)
        .output(academyCourseDetailSchema)
        .mutation(({ input, ctx }) => guard(() => academy.saveOutline({ ...input, operatorId: ctx.principal!.userId }))),

      /** AC-course-structure-03: one item's lesson revisions, newest first, and the revision learners see. */
      lesson: scopedProcedure('admin:read', { module: 'academy' })
        .input(z.object({ itemId: z.string().guid() }).strict())
        .output(academyLessonSchema)
        .query(({ input }) => guard(() => academy.lesson(input.itemId))),

      /** AC-course-structure-03: a new lesson revision of ordered blocks, over the revision read. Learners keep the live one. */
      saveLesson: scopedProcedure('admin:write', { module: 'academy' })
        .input(academySaveLessonInputSchema)
        .output(academyLessonSchema)
        .mutation(({ input, ctx }) => guard(() => academy.saveLesson({ ...input, operatorId: ctx.principal!.userId }))),

      /** AC-course-structure-03: a new revision with an older revision's blocks. History is never rewritten. */
      revertLesson: scopedProcedure('admin:write', { module: 'academy' })
        .input(academyRevertLessonInputSchema)
        .output(academyLessonSchema)
        .mutation(({ input, ctx }) => guard(() => academy.revertLesson({ ...input, operatorId: ctx.principal!.userId }))),

      /** AC-course-structure-03: learners see this lesson revision from now on; a course event names who and why. */
      publishLesson: scopedProcedure('admin:write', { module: 'academy' })
        .input(academyPublishLessonInputSchema)
        .output(academyLessonSchema)
        .mutation(({ input, ctx }) => guard(() => academy.publishLesson({ ...input, operatorId: ctx.principal!.userId }))),

      /** AC-course-structure-03: copy a draft course's item and its newest lesson after it. No learner record is copied. */
      duplicateItem: scopedProcedure('admin:write', { module: 'academy' })
        .input(academyDuplicateItemInputSchema)
        .output(academyLessonSchema)
        .mutation(({ input, ctx }) => guard(() => academy.duplicateItem({ ...input, operatorId: ctx.principal!.userId }))),

      /** AC-course-structure-03: a lesson file as a new revision; over the size limit refuses before parsing, a bad block is reported. */
      importLesson: scopedProcedure('admin:write', { module: 'academy' })
        .input(academyImportLessonInputSchema)
        .output(academyImportLessonResultSchema)
        .mutation(({ input, ctx }) => guard(() => academy.importLesson({ ...input, operatorId: ctx.principal!.userId }))),

      /** AC-quizzes-01: a quiz item's questions, rules, state, attempts and what stops Publish. */
      courseQuiz: scopedProcedure('admin:read', { module: 'academy' })
        .input(academyCourseQuizInputSchema)
        .output(academyAdminCourseQuizSchema)
        .query(({ input }) => guard(() => academy.courseQuizzes.adminView(input.itemId))),

      /** AC-quizzes-01: the draft over the revision read; questions are fixed once a learner has an attempt. */
      saveCourseQuiz: scopedProcedure('admin:write', { module: 'academy' })
        .input(academySaveCourseQuizInputSchema)
        .output(academyAdminCourseQuizSchema)
        .mutation(({ input, ctx }) =>
          guard(() => academy.courseQuizzes.save({ ...input, operatorId: ctx.principal!.userId, now: new Date() })),
        ),

      /** AC-quizzes-01: publish when nothing blocks it, or take back to draft while no learner has an attempt, with a reason. */
      setCourseQuizState: scopedProcedure('admin:write', { module: 'academy' })
        .input(academySetCourseQuizStateInputSchema)
        .output(academyAdminCourseQuizSchema)
        .mutation(({ input, ctx }) =>
          guard(() => academy.courseQuizzes.setState({ ...input, operatorId: ctx.principal!.userId, now: new Date() })),
        ),

      /** AC-quizzes-02: finished attempts waiting for an essay score, under per-quiz aliases. */
      courseQuizReviews: scopedProcedure('admin:read', { module: 'academy' })
        .input(academyCourseQuizInputSchema)
        .output(academyCourseQuizReviewsSchema)
        .query(({ input }) => guard(() => academy.courseQuizzes.reviews(input.itemId))),

      /** AC-quizzes-02: score an attempt's essays and grade it; answers the quiz's remaining queue. */
      scoreCourseQuizEssays: scopedProcedure('admin:write', { module: 'academy' })
        .input(academyScoreCourseQuizEssaysInputSchema)
        .output(academyCourseQuizReviewsSchema)
        .mutation(({ input, ctx }) =>
          guard(() => academy.courseQuizzes.scoreEssays({ ...input, operatorId: ctx.principal!.userId, now: new Date() })),
        ),

      /** AC-quizzes-04: every finished attempt under its alias, with points per question and its score trail. */
      courseQuizAttempts: scopedProcedure('admin:read', { module: 'academy' })
        .input(academyCourseQuizInputSchema)
        .output(academyCourseQuizAttemptsSchema)
        .query(({ input }) => guard(() => academy.courseQuizTrail.attempts(input.itemId))),

      /** AC-quizzes-04: a new revision of a published quiz that changes only keys; attempts keep their score until a rescore. */
      fixCourseQuizKey: scopedProcedure('admin:write', { module: 'academy' })
        .input(academyFixCourseQuizKeyInputSchema)
        .output(academyAdminCourseQuizSchema)
        .mutation(({ input, ctx }) =>
          guard(async () => {
            await academy.courseQuizTrail.fixKey({ ...input, operatorId: ctx.principal!.userId, now: new Date() });
            return academy.courseQuizzes.adminView(input.itemId);
          }),
        ),

      /** AC-quizzes-04: apply the current keys to each graded attempt they change, `rescore:<attempt>:<revision>`. */
      rescoreCourseQuiz: scopedProcedure('admin:write', { module: 'academy' })
        .input(academyRescoreCourseQuizInputSchema)
        .output(academyRescoreCourseQuizResultSchema)
        .mutation(({ input, ctx }) =>
          guard(() => academy.courseQuizTrail.rescore({ ...input, operatorId: ctx.principal!.userId, now: new Date() })),
        ),

      /** AC-quizzes-04: one question's points on a graded attempt, `override:<attempt>:<question>:<n>`, with a reason. */
      overrideCourseQuizScore: scopedProcedure('admin:write', { module: 'academy' })
        .input(academyOverrideCourseQuizScoreInputSchema)
        .output(academyCourseQuizAttemptsSchema)
        .mutation(({ input, ctx }) =>
          guard(() => academy.courseQuizTrail.override({ ...input, operatorId: ctx.principal!.userId, now: new Date() })),
        ),

      /** AC-release-access-01: a course's pacing and each section's release rule. */
      courseRelease: scopedProcedure('admin:read', { module: 'academy' })
        .input(academyCourseReleaseInputSchema)
        .output(academyCourseReleaseSchema)
        .query(({ input }) => guard(() => academy.courseRelease.adminView(input.courseId))),

      /** AC-release-access-01: a section opens at an instant or days after enrolment, or with the course; with a reason. */
      setSectionRelease: scopedProcedure('admin:write', { module: 'academy' })
        .input(academySetSectionReleaseInputSchema)
        .output(academyCourseReleaseSchema)
        .mutation(({ input, ctx }) =>
          guard(() => academy.courseRelease.setSectionRelease({ ...input, operatorId: ctx.principal!.userId, now: new Date() })),
        ),

      /** AC-release-access-01: self-paced or instructor-paced, refused once a learner has enrolled. */
      setCoursePacing: scopedProcedure('admin:write', { module: 'academy' })
        .input(academySetCoursePacingInputSchema)
        .output(academyCourseReleaseSchema)
        .mutation(({ input, ctx }) =>
          guard(() => academy.courseRelease.setPacing({ ...input, operatorId: ctx.principal!.userId, now: new Date() })),
        ),

      /** AC-release-access-02: each assignment and quiz with what it requires, and every learner's moved due date. */
      courseItemRules: scopedProcedure('admin:read', { module: 'academy' })
        .input(academyCourseItemRulesInputSchema)
        .output(academyCourseItemRulesSchema)
        .query(({ input }) => guard(() => academy.courseItemRules.adminView(input.courseId))),

      /** AC-release-access-02: the whole set an item requires, refused when it makes a cycle; with a reason. */
      setCourseItemPrerequisites: scopedProcedure('admin:write', { module: 'academy' })
        .input(academySetCourseItemPrerequisitesInputSchema)
        .output(academyCourseItemRulesSchema)
        .mutation(({ input, ctx }) =>
          guard(() => academy.courseItemRules.setPrerequisites({ ...input, operatorId: ctx.principal!.userId, now: new Date() })),
        ),

      /** AC-release-access-02: one enrolled learner's later due date on an assignment, with who and why. */
      grantCourseExtension: scopedProcedure('admin:write', { module: 'academy' })
        .input(academyGrantCourseExtensionInputSchema)
        .output(academyCourseItemRulesSchema)
        .mutation(({ input, ctx }) =>
          guard(() => academy.courseItemRules.grantExtension({ ...input, operatorId: ctx.principal!.userId, now: new Date() })),
        ),

      /** AC-assignments-04: the grading policy, the course's graded items and each enrolled learner's scores. */
      courseGradebook: scopedProcedure('admin:read', { module: 'academy' })
        .input(academyCourseGradebookInputSchema)
        .output(academyCourseGradebookSchema)
        .query(({ input }) => guard(() => academy.courseGradebook.view(input.courseId))),

      /** AC-assignments-04: types with weights adding up to exactly 1 and dropped lowest, over the revision read. */
      saveGradingPolicy: scopedProcedure('admin:write', { module: 'academy' })
        .input(academySaveGradingPolicyInputSchema)
        .output(academyCourseGradebookSchema)
        .mutation(({ input, ctx }) =>
          guard(() => academy.courseGradebook.savePolicy({ ...input, operatorId: ctx.principal!.userId, now: new Date() })),
        ),

      /** AC-assignments-01: an assignment item's brief, who saved it, and how many learners handed in. */
      assignment: scopedProcedure('admin:read', { module: 'academy' })
        .input(z.object({ itemId: z.string().guid() }).strict())
        .output(academyAdminAssignmentSchema)
        .query(({ input }) => guard(() => academy.assignmentForStaff(input.itemId))),

      /** AC-assignments-01: the brief over the revision read; a saved brief releases the item to enrolled learners. */
      saveAssignment: scopedProcedure('admin:write', { module: 'academy' })
        .input(academySaveAssignmentInputSchema)
        .output(academyAdminAssignmentSchema)
        .mutation(({ input, ctx }) => guard(() => academy.saveAssignment({ ...input, operatorId: ctx.principal!.userId }))),

      /** AC-assignments-01: learners can no longer hand in; the brief and every hand-in stay. */
      withdrawAssignment: scopedProcedure('admin:write', { module: 'academy' })
        .input(academyWithdrawAssignmentInputSchema)
        .output(academyAdminAssignmentSchema)
        .mutation(({ input, ctx }) => guard(() => academy.withdrawAssignment({ ...input, operatorId: ctx.principal!.userId }))),

      /** AC-assignments-02: each learner's newest hand-in under an alias, with its peer reviews, grade and lease. */
      gradingQueue: scopedProcedure('admin:read', { module: 'academy' })
        .input(academyGradingQueueInputSchema)
        .output(academyGradingQueueSchema)
        .query(({ input, ctx }) => guard(() => academy.gradingQueue({ itemId: input.itemId, operatorId: ctx.principal!.userId }))),

      /** AC-assignments-02: take or renew the caller's grader lease on one hand-in. */
      openGrading: scopedProcedure('admin:write', { module: 'academy' })
        .input(academyOpenGradingInputSchema)
        .output(academyGradingQueueSchema)
        .mutation(({ input, ctx }) => guard(() => academy.openGrading({ ...input, operatorId: ctx.principal!.userId }))),

      /** AC-assignments-02: grade event n, keyed `grade:<submission>:<n>`; an override needs a reason. */
      gradeSubmission: scopedProcedure('admin:write', { module: 'academy' })
        .input(academyGradeSubmissionInputSchema)
        .output(academyGradingQueueSchema)
        .mutation(({ input, ctx }) => guard(() => academy.gradeSubmission({ ...input, operatorId: ctx.principal!.userId }))),

      /** AC-assignments-02: a CSV of grades by alias; good rows apply, bad rows are listed, the same file changes nothing. */
      bulkGrade: scopedProcedure('admin:write', { module: 'academy' })
        .input(academyBulkGradeInputSchema)
        .output(academyBulkGradeResultSchema)
        .mutation(({ input, ctx }) => guard(() => academy.bulkGrade({ ...input, operatorId: ctx.principal!.userId }))),

      /** AC-assignments-03: peer and self review steps and the rubric, over the revision read. */
      saveReviewSteps: scopedProcedure('admin:write', { module: 'academy' })
        .input(academySaveReviewStepsInputSchema)
        .output(academyAdminAssignmentSchema)
        .mutation(({ input, ctx }) => guard(() => academy.saveReviewSteps({ ...input, operatorId: ctx.principal!.userId }))),

      /** AC-videos-02: one item's uploads, caption languages and the owner's upload limits. */
      itemMedia: scopedProcedure('admin:read', { module: 'academy' })
        .input(z.object({ itemId: z.string().guid() }).strict())
        .output(academyItemMediaSchema)
        .query(({ input }) => guard(() => academy.itemMedia(input.itemId))),

      /** AC-videos-02: a declared file checked against the owner's limits, and a signed upload address for its bytes. */
      mediaUploadIntent: scopedProcedure('admin:write', { module: 'academy' })
        .input(academyMediaIntentInputSchema)
        .output(academyMediaIntentSchema)
        .mutation(({ input, ctx }) => guard(() => academy.mediaUploadIntent({ ...input, operatorId: ctx.principal!.userId }))),

      /** AC-videos-02: the stored file read back; a size or type other than declared refuses. */
      confirmMedia: scopedProcedure('admin:write', { module: 'academy' })
        .input(academyConfirmMediaInputSchema)
        .output(academyMediaSchema)
        .mutation(({ input, ctx }) => guard(() => academy.confirmMedia({ ...input, operatorId: ctx.principal!.userId }))),

      /** AC-videos-02: one language's SRT or WebVTT file; the first malformed line comes back and nothing is stored. */
      setItemCaptions: scopedProcedure('admin:write', { module: 'academy' })
        .input(academySetItemCaptionsInputSchema)
        .output(academySetItemCaptionsResultSchema)
        .mutation(({ input, ctx }) => guard(() => academy.setItemCaptions({ ...input, operatorId: ctx.principal!.userId }))),

      /** AC-articles-01: learners stop seeing the lesson; a featured lesson leaves the Learn hub's slot. */
      withdrawLesson: scopedProcedure('admin:write', { module: 'academy' })
        .input(academyWithdrawLessonInputSchema)
        .output(academyLessonSchema)
        .mutation(({ input, ctx }) => guard(() => academy.withdrawLesson({ ...input, operatorId: ctx.principal!.userId }))),

      /** AC-articles-01: the Learn hub's featured slot as staff left it. */
      featuredSlot: scopedProcedure('admin:read', { module: 'academy' })
        .output(academyFeaturedSlotSchema)
        .query(() => guard(() => academy.featuredSlot())),

      /** AC-articles-01: a lesson learners can read fills the featured slot, with a reason. */
      featureLesson: scopedProcedure('admin:write', { module: 'academy' })
        .input(academyFeatureLessonInputSchema)
        .output(academyFeaturedSlotSchema)
        .mutation(({ input, ctx }) => guard(() => academy.featureLesson({ ...input, operatorId: ctx.principal!.userId }))),

      /** AC-articles-01: nothing is featured, with a reason. */
      clearFeatured: scopedProcedure('admin:write', { module: 'academy' })
        .input(academyClearFeaturedInputSchema)
        .output(academyFeaturedSlotSchema)
        .mutation(({ input, ctx }) => guard(() => academy.clearFeatured({ ...input, operatorId: ctx.principal!.userId }))),

      /** AC-articles-01: the topics, up to the owner's list limit. */
      topics: scopedProcedure('admin:read', { module: 'academy' })
        .output(academyTopicListSchema)
        .query(() => guard(() => academy.topics())),

      /** AC-articles-01: a topic keyed by its address; an Academy tab's address refuses `academy.slug_reserved`. */
      createTopic: scopedProcedure('admin:write', { module: 'academy' })
        .input(academyCreateTopicInputSchema)
        .output(academyTopicSchema)
        .mutation(({ input, ctx }) => guard(() => academy.createTopic({ ...input, operatorId: ctx.principal!.userId }))),

      /** AC-articles-01: the topics a course is filed under, over the revision read. */
      setCourseTopics: scopedProcedure('admin:write', { module: 'academy' })
        .input(academySetCourseTopicsInputSchema)
        .output(academyCourseDetailSchema)
        .mutation(({ input, ctx }) => guard(() => academy.setCourseTopics({ ...input, operatorId: ctx.principal!.userId }))),

      /** AC-catalogue-03: Preview as new learner, the real syllabus with its locks; nothing is written. */
      previewCourse: scopedProcedure('admin:read', { module: 'academy' })
        .input(academyCourseIdInputSchema)
        .output(academyCourseLearnerViewSchema)
        .query(({ input }) => guard(() => academy.previewCourse(input.courseId))),

      /** AC-catalogue-03: the course's private links, newest first, without their keys. */
      privateLinks: scopedProcedure('admin:read', { module: 'academy' })
        .input(academyCourseIdInputSchema)
        .output(academyPrivateLinkListSchema)
        .query(({ input }) => guard(() => academy.privateLinks(input.courseId))),

      /** AC-catalogue-03: a new link to the unlisted page; its key is shown once. */
      createPrivateLink: scopedProcedure('admin:write', { module: 'academy' })
        .input(academyCreatePrivateLinkInputSchema)
        .output(academyCreatedPrivateLinkSchema)
        .mutation(({ input, ctx }) => guard(() => academy.createPrivateLink({ ...input, operatorId: ctx.principal!.userId }))),

      /** AC-catalogue-03: the link stops opening the page. */
      revokePrivateLink: scopedProcedure('admin:write', { module: 'academy' })
        .input(academyRevokePrivateLinkInputSchema)
        .output(academyPrivateLinkSchema)
        .mutation(({ input, ctx }) => guard(() => academy.revokePrivateLink({ ...input, operatorId: ctx.principal!.userId }))),

      /** AC-course-structure-04: a template draft from the course's structure; the model path refuses `owner.decision`. */
      assistantDraft: scopedProcedure('admin:write', { module: 'academy' })
        .input(academyAssistantDraftInputSchema)
        .output(academyLessonSchema)
        .mutation(({ input, ctx }) => guard(() => academy.assistantDraft({ ...input, operatorId: ctx.principal!.userId }))),

      /** AC-course-structure-04: a person accepts (a new lesson revision) or discards the open draft. */
      decideDraft: scopedProcedure('admin:write', { module: 'academy' })
        .input(academyDecideDraftInputSchema)
        .output(academyLessonSchema)
        .mutation(({ input, ctx }) => guard(() => academy.decideDraft({ ...input, operatorId: ctx.principal!.userId }))),

      /** AC-articles-01: staff choose the hub's featured item with a reason; `itemSlug: null` clears the slot. */
      setFeatured: scopedProcedure('admin:write', { module: 'academy' })
        .input(z.object({ itemSlug: z.string().min(1).max(120).nullable(), reason: z.string().max(500) }).strict())
        .output(z.object({ itemSlug: z.string().nullable(), reason: z.string().nullable(), chosenAt: z.date().nullable() }))
        .mutation(({ input, ctx }) => guard(() => academy.setFeatured({ ...input, operatorId: ctx.principal!.userId }))),

      /** AC-quizzes-03: publish or take down the quiz on one curriculum item. The answer key never leaves the service. */
      setQuiz: scopedProcedure('admin:write', { module: 'academy' })
        .input(academySetQuizInputSchema)
        .output(z.object({ slug: z.string(), published: z.boolean() }))
        .mutation(({ input, ctx }) => guard(() => academy.setQuiz({ ...input, operatorId: ctx.principal!.userId }))),

      /** AC-programmes-01: create a learning programme, or replace its details and ordered courses over the revision read. */
      saveProgramme: scopedProcedure('admin:write', { module: 'academy' })
        .input(academySaveProgrammeInputSchema)
        .output(academyProgrammeRecordSchema)
        .mutation(({ input, ctx }) => guard(() => academy.saveProgramme({ ...input, operatorId: ctx.principal!.userId }))),

      /** AC-rooms-01: create a course discussion topic, or change its title, pin and position, with a reason. */
      saveDiscussionTopic: scopedProcedure('admin:write', { module: 'academy' })
        .input(academySaveDiscussionTopicInputSchema)
        .output(academyDiscussionTopicSchema)
        .mutation(({ input, ctx }) =>
          guard(() => academy.discussion.saveTopic({ ...input, operatorId: ctx.principal!.userId, now: new Date() })),
        ),

      /** AC-rooms-01: a post and its replies with the account behind each, anonymous or not. */
      discussionThread: scopedProcedure('admin:read', { module: 'academy' })
        .input(academyDiscussionThreadInputSchema)
        .output(academyStaffDiscussionThreadSchema)
        .query(({ input }) => guard(() => academy.discussion.staffThread(input.postId, input.limit))),

      /** AC-rooms-04: every conversation with a course team, newest first, with the staff-side unread marker. */
      courseInbox: scopedProcedure('admin:read', { module: 'academy' })
        .input(academyCourseConversationsInputSchema)
        .output(z.array(academyStaffConversationSummarySchema))
        .query(({ input }) => guard(() => academy.courseMessages.staffInbox(input.limit))),

      /** AC-rooms-04: open one conversation, which marks it read on the staff side. */
      openCourseConversation: scopedProcedure('admin:write', { module: 'academy' })
        .input(academyCourseConversationInputSchema)
        .output(academyStaffConversationSchema)
        .mutation(({ input }) => guard(() => academy.courseMessages.staffOpen({ ...input, now: new Date() }))),

      /** AC-rooms-04: answer a learner's conversation as the course team. */
      replyCourseMessage: scopedProcedure('admin:write', { module: 'academy' })
        .input(academyReplyCourseMessageInputSchema)
        .output(academySendCourseMessageResultSchema)
        .mutation(({ input, ctx }) =>
          guard(() => academy.courseMessages.staffReply({ ...input, operatorId: ctx.principal!.userId, now: new Date() })),
        ),

      /** AC-programmes-01: the programmes staff made, newest first. */
      programmes: scopedProcedure('admin:read', { module: 'academy' })
        .input(academyProgrammesInputSchema.omit({ mine: true }))
        .output(z.array(academyProgrammeRecordSchema))
        .query(({ input }) => guard(() => academy.adminProgrammes(input.limit))),

      /** AC-certificates-02: how one published certificate is issued (manual, automatic, or after the owner's delay), with a reason. */
      setCertIssueRule: scopedProcedure('admin:write', { module: 'academy' })
        .input(academySetCertIssueRuleInputSchema)
        .output(academyCertIssueRuleSchema)
        .mutation(({ input, ctx }) => guard(() => academy.setCertIssueRule({ ...input, operatorId: ctx.principal!.userId }))),

      /**
       * AC-certificates-03: revoke one issued certificate by its public code, under two-person approval
       * (`academy.cert.revoke`, payload `{publicId, reason}`). The public check then says revoked.
       */
      revokeCert: scopedProcedure('admin:write', { module: 'academy' })
        .input(academyRevokeCertInputSchema)
        .output(academyCertRevocationSchema)
        .mutation(({ input, ctx }) =>
          guard(async () => {
            // A repeat answers with the first record, and an unknown code refuses, before the two people's approval is spent.
            const recorded = await academy.certRevocation(input.publicId);
            if (recorded) return recorded;
            const pair = await consumeApprovalPair(ctx.principal, approvals, input, 'academy.cert.revoke', {
              publicId: input.publicId,
              reason: input.reason,
            });
            return academy.revokeCert({ publicId: input.publicId, reason: input.reason, ...pair, operatorId: ctx.principal!.userId });
          }),
        ),

      /** AC-certificates-02: one certificate's stored issue rule, or null when staff have set none (the learner claims it). */
      certIssueRule: scopedProcedure('admin:read', { module: 'academy' })
        .input(z.object({ certId: academyCertIdSchema }))
        .output(academyCertIssueRuleSchema.nullable())
        .query(({ input }) => guard(() => academy.certIssueRule(input.certId))),

      /** AC-videos-01: attach a spine video to one curriculum item (it then completes by `watch`), or take it off with null. */
      setItemVideo: scopedProcedure('admin:write', { module: 'academy' })
        .input(academySetItemVideoInputSchema)
        .output(academyItemVideoSchema)
        .mutation(({ input, ctx }) => guard(() => academy.setItemVideo({ ...input, operatorId: ctx.principal!.userId }))),

      /** AC-videos-01: replace every caption track of one video (WebVTT per language); `tracks: []` removes them. */
      setVideoTracks: scopedProcedure('admin:write', { module: 'academy' })
        .input(academySetVideoTracksInputSchema)
        .output(z.object({ videoSlug: z.string(), tracks: z.array(academyVideoTrackSchema) }))
        .mutation(({ input, ctx }) => guard(() => academy.setVideoTracks({ ...input, operatorId: ctx.principal!.userId }))),

      /** AC-enrolment-01 step 4: staff set a course's start date with a reason; `startsAt: null` clears it, keeping who and why. */
      setCourseStart: scopedProcedure('admin:write', { module: 'academy' })
        .input(
          z
            .object({
              slug: z.string().min(1).max(120),
              startsAt: z.string().datetime({ offset: true }).nullable(),
              reason: z.string().max(500),
            })
            .strict(),
        )
        .output(z.object({ slug: z.string(), startsAt: z.date().nullable(), reason: z.string(), setAt: z.date() }))
        .mutation(({ input, ctx }) =>
          guard(() =>
            academy.setCourseStart({
              slug: input.slug,
              startsAt: input.startsAt === null ? null : new Date(input.startsAt),
              reason: input.reason,
              operatorId: ctx.principal!.userId,
            }),
          ),
        ),

      setItemPrerequisites: scopedProcedure('admin:write', { module: 'academy' })
        .input(z.object({ itemSlug: z.string().min(1).max(120), prerequisites: z.array(z.string().min(1).max(120)).max(40) }))
        .output(z.object({ itemSlug: z.string(), prerequisites: z.array(z.string()) }))
        .mutation(({ input }) => guard(() => academy.setItemPrerequisites(input))),

      setItemWindow: scopedProcedure('admin:write', { module: 'academy' })
        .input(
          z.object({
            itemSlug: z.string().min(1).max(120),
            availableFrom: z.string().datetime({ offset: true }).nullable(),
            availableUntil: z.string().datetime({ offset: true }).nullable(),
            dueAt: z.string().datetime({ offset: true }).nullable(),
          }),
        )
        .output(
          z.object({
            itemSlug: z.string(),
            availableFrom: z.date().nullable(),
            availableUntil: z.date().nullable(),
            dueAt: z.date().nullable(),
          }),
        )
        .mutation(({ input }) =>
          guard(() =>
            academy.setItemWindow({
              itemSlug: input.itemSlug,
              availableFrom: input.availableFrom === null ? null : new Date(input.availableFrom),
              availableUntil: input.availableUntil === null ? null : new Date(input.availableUntil),
              dueAt: input.dueAt === null ? null : new Date(input.dueAt),
            }),
          ),
        ),

      grantItemExtension: scopedProcedure('admin:write', { module: 'academy' })
        .input(
          z.object({
            userId: z.string().guid(),
            itemSlug: z.string().min(1).max(120),
            reason: z.string().max(500),
            extendedUntil: z.string().datetime({ offset: true }),
            clientRequestId: z.string().min(1).max(200),
          }),
        )
        .output(
          z.object({
            userId: z.string().guid(),
            itemSlug: z.string(),
            revision: z.number().int().positive(),
            reason: z.string(),
            extendedUntil: z.date(),
            clientRequestId: z.string(),
          }),
        )
        .mutation(({ input, ctx }) =>
          guard(() =>
            academy.grantItemExtension({
              userId: input.userId,
              itemSlug: input.itemSlug,
              reason: input.reason,
              extendedUntil: new Date(input.extendedUntil),
              clientRequestId: input.clientRequestId,
              operatorId: ctx.principal!.userId,
            }),
          ),
        ),

      /**
       * AC-order-02 — owner settings register: every class-a owner value with
       * its state (set / not set) and the refusal shown while blank. State only:
       * no value and no default ever leaves this read.
       */
      settingsStatus: scopedProcedure('admin:read', { module: 'academy' })
        .output(
          z.object({
            rows: z.array(
              z.object({
                key: z.string(),
                state: z.enum(['set', 'not_set']),
                store: z.enum(['env', 'pending', 'refuse_closed']),
                readOnly: z.boolean(),
                refusalCode: z.string().nullable(),
              }),
            ),
          }),
        )
        .query(() => ({ rows: [...settingsRegister(settings)] })),

      grantAudit: scopedProcedure('admin:read', { module: 'academy' })
        .input(
          z.object({
            limit: z.number().optional(),
            cursor: z.string().min(1).max(512).optional(),
            certificateId: z.string().min(1).max(64).optional(),
          }),
        )
        .output(
          z.object({
            items: z.array(
              z.object({
                accountId: z.string().guid(),
                certificateId: z.string(),
                grantedAt: z.date(),
                status: z.literal('granted'),
                reference: z.string(),
              }),
            ),
            nextCursor: z.string().nullable(),
          }),
        )
        .query(({ input }) =>
          guard(() =>
            academy.grantAudit({
              limit: input.limit,
              cursor: input.cursor ?? null,
              certificateId: input.certificateId ?? null,
            }),
          ),
        ),
      opsMetrics: scopedProcedure('admin:read', { module: 'academy' })
        .input(z.object({ from: z.string(), to: z.string() }))
        .output(
          z.object({
            from: z.string(),
            to: z.string(),
            days: z.array(
              z.object({
                date: z.string(),
                lessonsRead: metricCellOut,
                completions: metricCellOut,
                grants: metricCellOut,
              }),
            ),
          }),
        )
        .query(({ input }) => guard(() => academy.opsMetrics({ from: input.from, to: input.to }))),
      enrolments: scopedProcedure('admin:read', { module: 'academy' })
        .input(z.object({ from: z.string(), to: z.string() }))
        .output(
          z.object({
            from: z.string(),
            to: z.string(),
            total: z.number().int().nonnegative(),
            paths: z.array(z.object({ pathSlug: z.string(), count: z.number().int().nonnegative() })),
          }),
        )
        .query(({ input }) => guard(() => academy.enrolments({ from: input.from, to: input.to }))),
      completionsByItem: scopedProcedure('admin:read', { module: 'academy' })
        .input(z.object({ from: z.string(), to: z.string(), pathSlug: z.string().min(1).max(64).optional() }))
        .output(
          z.object({
            from: z.string(),
            to: z.string(),
            pathSlug: z.string().nullable(),
            items: z.array(
              z.object({
                itemSlug: z.string(),
                pathSlug: z.string().nullable(),
                count: z.number().int().nonnegative(),
              }),
            ),
          }),
        )
        .query(({ input }) =>
          guard(() =>
            academy.completionsByItem({
              from: input.from,
              to: input.to,
              pathSlug: input.pathSlug ?? null,
            }),
          ),
        ),
    }),
  });
}

export type AcademyRouter = ReturnType<typeof createAcademyRouter>;
