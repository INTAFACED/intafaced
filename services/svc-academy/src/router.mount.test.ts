import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, signPrincipalHeader, BASE_PERKS } from '@intafaced/contracts';
import { parseAmount } from '@intafaced/ledger-client';
import { AcademyError } from './errors.js';
import { stubApprovalConsumer } from './action-approval-consume.js';
import { createAcademyRouter } from './router.js';
import { unconfiguredVideoLibrary } from './video/library.js';
import { userCopy } from './user-copy.js';
import { certXpPlaneStatus, NullCertXpPublisher } from './certs/xp-publish.js';
import { certPerkPlaneStatus } from './certs/perk-plane.js';
import type { AcademyService } from './academy-service.js';
import { getCurriculumItem } from './curriculum/catalog.js';
import { curriculumBodyForLocale, curriculumI18nStrategyLine } from './curriculum/i18n-strategy.js';
import type { PaperOpsStatus } from './paper/ops-gate.js';
import { assertCallerCannotLiePaperFlag, memoryPaperFlagPort } from './paper/market-flag-verify.js';

/**
 * THE MOUNT BOUNDARY for svc-academy (docs/decisions/mount-boundary.md).
 *
 * Context comes from `createEdgeContext` over real headers — never a
 * hand-written principal. A seat belongs to the edge-signed caller and to
 * nobody else, and a forgeable principal here is a seat in a staked room that
 * nobody staked for.
 *
 * This file also exists because a service that builds a router and never
 * registers it answers 200 on `/health` and 404 on everything else. That has
 * bitten this repo three times. Calling every procedure through
 * `createCaller` is the cheapest proof that the surface is real.
 */

// The local Vitest config isolates business-door fixtures from the blank
// screening socket. This mounted-request control separately arms strict policy.
afterEach(() => vi.unstubAllEnvs());

const SECRET = 'an-academy-mount-test-edge-secret-long';
const USER = '11111111-1111-4111-8111-111111111111';
const VICTIM = '99999999-9999-4999-8999-999999999999';
const SESSION = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ROOM = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const APPROVED = { approvalId: 'appr-1', operationId: 'op-1' } as const;

function operatorRouter(academy: AcademyService, confirmOperatorId: string) {
  return createAcademyRouter(academy, {}, unconfiguredVideoLibrary(), stubApprovalConsumer(confirmOperatorId));
}

const edgeContext = createEdgeContext({ secret: SECRET, serviceName: 'svc-academy' });

function principal(overrides: Partial<Principal> = {}): Principal {
  return {
    sub: USER,
    userId: USER,
    sid: '22222222-2222-4222-8222-222222222222',
    scopes: ['academy:read', 'academy:write'],
    tier: 'none',
    mfa: false,
    expiresAt: new Date(Date.now() + 60_000),
    ...overrides,
  } as Principal;
}

const anonymous = () => edgeContext({ headers: { 'x-intafaced-region': 'DE' }, id: 'req-anon' });

function signed(p: Principal = principal()) {
  const raw = encodePrincipal(p);
  return edgeContext({
    headers: {
      'x-intafaced-principal': raw,
      'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, 'DE'),
      'x-intafaced-region': 'DE',
    },
    id: 'req-signed',
  });
}

function forged(p: Principal = principal()) {
  return edgeContext({
    headers: { 'x-intafaced-principal': encodePrincipal(p), 'x-intafaced-region': 'DE' },
    id: 'req-forged',
  });
}

/** Trade listing the mount stub consults — caller `paper: true` is not enough. */
const MOUNT_PAPER_FLAG_PORT = memoryPaperFlagPort([
  { marketId: 'mkt-paper-1', symbol: 'BTC-USDT', paper: true },
  { marketId: 'mkt-live-1', symbol: 'BTC/USDT', paper: false },
]);

function presentCatalogItem(slug: string) {
  const item = getCurriculumItem(slug);
  if (!item) {
    throw new AcademyError(`Curriculum item "${slug}" is not in the day-one spine`, 'academy.curriculum_not_found');
  }
  return { ...item, objectives: [...item.objectives], keyTerms: [...item.keyTerms], selfCheck: [...item.selfCheck] };
}

const room = {
  id: ROOM,
  slug: 'meme-war-room',
  name: 'Meme War Room',
  kind: 'meme_war_room' as const,
  access: 'staked' as const,
  minStake: 1_000_000_000_000_000_000n,
  capacity: 50,
  hostId: USER,
};

function stubAcademy(overrides: Partial<AcademyService> = {}): AcademyService {
  return {
    listRooms: vi.fn(async () => [room]),
    room: vi.fn(async () => room),
    listSessions: vi.fn(async () => []),
    session: vi.fn(async () => ({
      id: SESSION,
      roomId: ROOM,
      title: 'Session',
      hostId: USER,
      status: 'live' as const,
      startsAt: new Date(),
      endsAt: null,
      streamProvider: null,
      streamRoom: null,
      scene: {},
      sceneFingerprint: 'stub-session-scene-fp',
    })),
    occupancy: vi.fn(async () => 3),
    callerLiveSeats: vi.fn(async () => []),
    join: vi.fn(async () => ({ role: 'attendee' as const })),
    leave: vi.fn(async () => undefined),
    streamCredential: vi.fn(),
    createRoom: vi.fn(async () => room),
    invite: vi.fn(async () => undefined),
    assertPaperTradingEnabled: vi.fn(() => undefined),
    assertCallerPaperFlagVerified: vi.fn(async (market) => {
      await assertCallerCannotLiePaperFlag(MOUNT_PAPER_FLAG_PORT, market);
    }),
    paperOpsStatus: vi.fn((): PaperOpsStatus => ({
      enabled: true,
      flagId: 'academy.paper-trading',
      envKey: 'ACADEMY_PAPER_TRADING_ENABLED',
      liveTradeUnaffected: true,
      simulated: true,
      venue: 'paper',
      realMoney: false,
    })),
    // The real plane over the real null publisher — a hand-written literal here
    // would pass while the shape drifted underneath it.
    certXpPlane: vi.fn(() => certXpPlaneStatus(new NullCertXpPublisher())),
    certPerkPlane: vi.fn(() => certPerkPlaneStatus()),
    readCurriculumItem: vi.fn(async (input: { slug: string }) => presentCatalogItem(input.slug)),
    readCurriculumItemLocalized: vi.fn(async (input: { slug: string; locale?: string }) => {
      const item = presentCatalogItem(input.slug);
      const localized = curriculumBodyForLocale(item.body, input.locale);
      return {
        ...item,
        body: localized.body,
        locale: localized.resolution.locale,
        fellBack: localized.resolution.fellBack,
        i18nStrategy: curriculumI18nStrategyLine(),
      };
    }),
    ...overrides,
  } as unknown as AcademyService;
}

describe('svc-academy mount — the router is actually mounted', () => {
  it('serves health to an anonymous caller', async () => {
    await expect(createAcademyRouter(stubAcademy()).createCaller(anonymous()).health()).resolves.toEqual({
      ok: true,
      service: 'svc-academy',
    });
  });

  it('refuses blank screening before lobby reads or joins when strict policy is armed', async () => {
    vi.stubEnv('INTAFACED_SCREENING_FAIL_CLOSED', 'true');
    vi.stubEnv('INTAFACED_REGION_FAIL_CLOSED', 'true');
    vi.stubEnv('INTAFACED_SANCTIONS_REGIONS', '');
    vi.stubEnv('INTAFACED_SANCTIONS_LIST_SOURCE', '');
    const academy = stubAcademy();
    const refusal = {
      code: 'FORBIDDEN',
      cause: {
        code: 'denied.screening_unconfigured',
        decision: { screening: { listConfigured: false, moneyGrade: 'unconfigured', readsAsScreenedClean: false } },
      },
    };
    await expect(createAcademyRouter(academy).createCaller(signed()).rooms()).rejects.toMatchObject(refusal);
    await expect(createAcademyRouter(academy).createCaller(signed()).join({ sessionId: SESSION })).rejects.toMatchObject(refusal);
    expect(academy.listRooms).not.toHaveBeenCalled();
    expect(academy.join).not.toHaveBeenCalled();
  });

  it('exposes the lobby surface §8.3 names plus the thin curriculum catalog', () => {
    const procedures = Object.keys(createAcademyRouter(stubAcademy())._def.procedures).sort();

    expect(procedures).toEqual(
      [
        'createRoom',
        'curriculum',
        'curriculumItem',
        'curriculumInventory',
        'curriculumImportStatus',
        'curriculumDeepLink',
        'curriculumPathDeepLinks',
        'curriculumItemLocalized',
        'curriculumStudyGuide',
        'curriculumStudyGuides',
        'curriculumDepth',
        'publicCurriculum',
        'publicCurriculumItem',
        'publicCurriculumRelated',
        'publicVideos',
        'publicCourses',
        'publicCourse',
        'publicCourseByLink',
        'publicAuthoredCourses',
        'publicAuthoredCourse',
        'publicHub',
        'videos',
        'videoCaptions',
        'videoTranscript',
        'videoPlayback',
        'videoPlayer',
        'itemVideo',
        'admin.setItemVideo',
        'admin.setCertIssueRule',
        'admin.saveProgramme',
        'admin.saveDiscussionTopic',
        'admin.discussionThread',
        'admin.courseInbox',
        'admin.openCourseConversation',
        'admin.replyCourseMessage',
        'sendCourseMessage',
        'courseConversations',
        'openCourseConversation',
        'discussionCourses',
        'discussionTopics',
        'discussionPosts',
        'discussionThread',
        'discussionPostImage',
        'createDiscussionPost',
        'replyDiscussionPost',
        'acceptDiscussionReply',
        'followDiscussionPost',
        'likeDiscussionPost',
        'admin.programmes',
        'programmes',
        'programme',
        'admin.revokeCert',
        'certPaths',
        'admin.certIssueRule',
        'admin.setVideoTracks',
        'paperDrill',
        'paperDrillResult',
        'paperOpsStatus',
        'planner.addTodo',
        'planner.get',
        'planner.removeTodo',
        'planner.sendGoalReminder',
        'planner.setGoal',
        'planner.setTodoDone',
        'ambassadorBadge',
        'ambassadors',
        'ambassadorIfcPay',
        'ambassadorPayPlane',
        'ambassadorPayQuote',
        'ambassadorRevenueShare',
        'residencyIfcPayQuote',
        'residencyPayQuote',
        'appointAmbassador',
        'freezeAmbassador',
        'unfreezeAmbassador',
        'applyResidency',
        'withdrawResidency',
        'myResidencies',
        'openResidencies',
        'decideResidency',
        'certDefinitions',
        'enrollCertPath',
        'enrolCourse',
        'courseEnrolment',
        'authoredCourse',
        'authoredCourseEnrolment',
        'enrolAuthoredCourse',
        'leaveAuthoredCourse',
        'assignment',
        'courseQuiz',
        'startCourseQuiz',
        'courseQuizAttempt',
        'answerCourseQuiz',
        'finishCourseQuiz',
        'submitCourseSurvey',
        'uploadAssignmentFile',
        'submitAssignment',
        'peerReview',
        'peerReviewFile',
        'markFeedbackRead',
        'submitPeerReview',
        'myLearning',
        'myProgress',
        'myAccessGrants',
        'courseOutline',
        'markCurriculumComplete',
        'undoCurriculumComplete',
        'itemRelease',
        'admin.setQuiz',
        'admin.setCourseStart',
        'admin.setFeatured',
        'admin.courses',
        'admin.course',
        'admin.createCourse',
        'admin.updateCourse',
        'admin.setCourseState',
        'admin.saveOutline',
        'admin.lesson',
        'admin.saveLesson',
        'admin.revertLesson',
        'admin.publishLesson',
        'admin.duplicateItem',
        'admin.importLesson',
        'admin.courseQuiz',
        'admin.saveCourseQuiz',
        'admin.setCourseQuizState',
        'admin.courseQuizReviews',
        'admin.scoreCourseQuizEssays',
        'admin.courseQuizAttempts',
        'admin.fixCourseQuizKey',
        'admin.rescoreCourseQuiz',
        'admin.overrideCourseQuizScore',
        'admin.courseRelease',
        'admin.setSectionRelease',
        'admin.setCoursePacing',
        'admin.courseItemRules',
        'admin.setCourseItemPrerequisites',
        'admin.grantCourseExtension',
        'admin.courseGradebook',
        'admin.saveGradingPolicy',
        'admin.courseGradeReports',
        'admin.makeGradeReport',
        'admin.gradeReportFile',
        'admin.assignment',
        'admin.saveAssignment',
        'admin.withdrawAssignment',
        'admin.saveReviewSteps',
        'admin.gradingQueue',
        'admin.openGrading',
        'admin.gradeSubmission',
        'admin.bulkGrade',
        'admin.itemMedia',
        'admin.mediaUploadIntent',
        'admin.confirmMedia',
        'admin.setItemCaptions',
        'admin.withdrawLesson',
        'admin.featuredSlot',
        'admin.featureLesson',
        'admin.clearFeatured',
        'admin.topics',
        'admin.createTopic',
        'admin.setCourseTopics',
        'admin.previewCourse',
        'admin.privateLinks',
        'admin.createPrivateLink',
        'admin.revokePrivateLink',
        'admin.assistantDraft',
        'admin.decideDraft',
        'admin.setItemPrerequisites',
        'admin.setItemWindow',
        'admin.grantItemExtension',
        'grantCert',
        'myCerts',
        'certProgress',
        'assessment.get',
        'assessment.start',
        'assessment.current',
        'assessment.answer',
        'assessment.finish',
        'assessment.review',
        'assessment.submit',
        'assessment.attempts',
        'certVerify',
        'setCertHolderName',
        'certXpPlane',
        'certPerkPlane',
        'certPerkIntent',
        'seasons',
        'season',
        'seasonCalendar',
        'tournaments.policy',
        'standings',
        'createSeason',
        'setSeasonStatus',
        'freezeSnapshot',
        'tournamentPrizePlane',
        'tournamentPrizeIntent',
        'tournamentPrizeStart',
        'setStanding',
        'bulkSetStandings',
        'endSession',
        'myCompletions',
        'myEnrollments',
        'leaveCertPath',
        'learningState',
        'touchLesson',
        'residencyCohorts',
        'videoProgress.get',
        'videoProgress.set',
        'videoProgress.watched',
        'myUpcomingSessions',
        'sessionCalendar',
        'admin.completionsByItem',
        'admin.enrolments',
        'admin.grantAudit',
        'admin.opsMetrics',
        'curriculumRelated',
        'admin.settingsStatus',
        'health',
        'invite',
        'join',
        'leave',
        'room',
        'rooms',
        'scheduleSession',
        'session',
        'startSession',
        'streamCredential',
        'updateScene',
      ].sort(),
    );
  });
});

describe('svc-academy mount — curriculum catalog is real, not empty', () => {
  it('refuses curriculum list doors when limit is omitted — never dumps the spine', async () => {
    const caller = createAcademyRouter(stubAcademy()).createCaller(signed());
    await expect(caller.curriculum()).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: userCopy('academy.curriculum_list_limit_unset'),
    });
    await expect(caller.curriculumStudyGuides()).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: userCopy('academy.curriculum_list_limit_unset'),
    });
  });

  it('lists the day-one spine under academy:read', async () => {
    const items = await createAcademyRouter(stubAcademy()).createCaller(signed()).curriculum({ limit: 50 });
    expect(items.length).toBeGreaterThanOrEqual(4);
    expect(items.every((i) => typeof i.slug === 'string' && typeof i.summary === 'string')).toBe(true);
    // List is metadata only — body lives on curriculumItem.
    expect(items[0]).not.toHaveProperty('body');
  });

  it('filters curriculum by Blueprint path', async () => {
    const items = await createAcademyRouter(stubAcademy()).createCaller(signed()).curriculum({ path: 'foundations', limit: 50 });
    expect(items.length).toBeGreaterThan(0);
    expect(items.every((i) => i.path === 'foundations')).toBe(true);
  });

  it('returns body for a known slug and NOT_FOUND for an unknown one', async () => {
    const caller = createAcademyRouter(stubAcademy()).createCaller(signed());
    const item = await caller.curriculumItem({ slug: 'foundations-risk-first' });
    expect(item.body).toContain('# Risk first');

    await expect(caller.curriculumItem({ slug: 'no-such-playbook' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
      message: userCopy('academy.curriculum_not_found'),
    });
  });

  it('refuses curriculum without academy:read', async () => {
    const ctx = signed(principal({ scopes: [] }));
    await expect(createAcademyRouter(stubAcademy()).createCaller(ctx).curriculum()).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('Stage-3 deep-link + import status + locale fallback', async () => {
    const caller = createAcademyRouter(stubAcademy()).createCaller(signed());
    const link = await caller.curriculumDeepLink({ path: 'foundations', slug: 'foundations-risk-first' });
    expect(link).toEqual({
      ok: true,
      path: 'foundations',
      slug: 'foundations-risk-first',
      href: '/academy/curriculum/foundations/foundations-risk-first',
    });
    const paths = await caller.curriculumPathDeepLinks();
    expect(paths.some((p) => p.path === 'foundations' && p.itemCount > 0)).toBe(true);
    const status = await caller.curriculumImportStatus();
    expect(status.stage3Polish.ready).toBe(true);
    expect(status.titlePromiseMet).toBe(true);
    expect(status.substanceBarMet).toBe(true);
    expect(status.theaterSlugs).toEqual([]);
    const localized = await caller.curriculumItemLocalized({ slug: 'foundations-risk-first', locale: 'fr' });
    expect(localized.fellBack).toBe(true);
    expect(localized.locale).toBe('en');
    expect(localized.body).toContain('# Risk first');
  });

  it('serves the teaching scaffolding on the item, not only the markdown', async () => {
    const item = await createAcademyRouter(stubAcademy()).createCaller(signed()).curriculumItem({ slug: 'foundations-risk-first' });
    expect(item.objectives.length).toBeGreaterThan(0);
    expect(item.keyTerms.length).toBeGreaterThan(0);
    expect(item.selfCheck.length).toBeGreaterThan(0);
    expect(item.estimatedMinutes).toBeGreaterThan(0);
  });

  it('serves a study guide for one slug and NOT_FOUND for an unknown one', async () => {
    const caller = createAcademyRouter(stubAcademy()).createCaller(signed());
    const guide = await caller.curriculumStudyGuide({ slug: 'markets-reading-the-book' });
    expect(guide.slug).toBe('markets-reading-the-book');
    expect(guide.path).toBe('markets');
    // The guide is the card payload — scaffolding and size, never the prose.
    expect(guide).not.toHaveProperty('body');
    expect(guide.bodyChars).toBeGreaterThan(900);
    expect(guide.objectives.length).toBeGreaterThan(0);

    await expect(caller.curriculumStudyGuide({ slug: 'no-such-playbook' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('serves study guides for a whole path, in display order', async () => {
    const caller = createAcademyRouter(stubAcademy()).createCaller(signed());
    const guides = await caller.curriculumStudyGuides({ path: 'sovereign', limit: 50 });
    expect(guides.length).toBeGreaterThan(0);
    expect(guides.every((g) => g.path === 'sovereign')).toBe(true);

    const whole = await caller.curriculumStudyGuides({ limit: 50 });
    expect(whole.length).toBeGreaterThan(guides.length);
  });

  it('reports depth honestly — every item clears the editorial floor', async () => {
    const depth = await createAcademyRouter(stubAcademy()).createCaller(signed()).curriculumDepth();
    expect(depth.total).toBeGreaterThan(0);
    expect(depth.thinSlugs).toEqual([]);
    expect(depth.thin).toBe(0);
    expect(depth.allDeep).toBe(true);
    expect(depth.shortestBodyChars).toBeGreaterThanOrEqual(depth.minBodyChars);
  });

  it('refuses the depth surface without academy:read', async () => {
    const ctx = signed(principal({ scopes: [] }));
    await expect(createAcademyRouter(stubAcademy()).createCaller(ctx).curriculumDepth()).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });
});

describe('svc-academy mount — a seat belongs to the signed caller', () => {
  it('refuses an anonymous caller a seat, and takes none', async () => {
    let joined = false;
    const academy = stubAcademy({
      join: (async () => {
        joined = true;
        return { role: 'attendee' as const };
      }) as AcademyService['join'],
    });

    await expect(createAcademyRouter(academy).createCaller(anonymous()).join({ sessionId: SESSION })).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
    expect(joined).toBe(false);
  });

  it('refuses a self-asserted principal — an unsigned header is not a principal', async () => {
    const ctx = forged(principal({ sub: VICTIM, userId: VICTIM }));
    expect(ctx.principal).toBeNull();

    await expect(createAcademyRouter(stubAcademy()).createCaller(ctx).join({ sessionId: SESSION })).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
  });

  it('seats the edge-signed principal and nobody else — there is no userId input to abuse', async () => {
    let seatedFor: string | null = null;
    const academy = stubAcademy({
      join: (async ({ userId }: { userId: string }) => {
        seatedFor = userId;
        return { role: 'attendee' as const };
      }) as AcademyService['join'],
    });

    await expect(createAcademyRouter(academy).createCaller(signed()).join({ sessionId: SESSION })).resolves.toEqual({ role: 'attendee' });
    expect(seatedFor).toBe(USER);
  });

  it('leave is principal-bound too — you cannot eject another attendee', async () => {
    let leftFor: string | null = null;
    const academy = stubAcademy({
      leave: (async ({ userId }: { userId: string }) => {
        leftFor = userId;
      }) as AcademyService['leave'],
    });

    await createAcademyRouter(academy).createCaller(signed()).leave({ sessionId: SESSION });
    expect(leftFor).toBe(USER);
  });

  it('a read scope alone cannot take a seat', async () => {
    const ctx = signed(principal({ scopes: ['academy:read'] }));
    await expect(createAcademyRouter(stubAcademy()).createCaller(ctx).join({ sessionId: SESSION })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });
});

describe('svc-academy mount — hosting is the caller own claim', () => {
  it('createRoom names the signed principal as host, never an input', async () => {
    let hostId: string | null = null;
    const academy = stubAcademy({
      createRoom: (async (input: { hostId: string }) => {
        hostId = input.hostId;
        return room;
      }) as AcademyService['createRoom'],
    });

    await createAcademyRouter(academy)
      .createCaller(signed())
      .createRoom({ slug: 'forex-desk', name: 'Forex Desk', kind: 'forex', access: 'free', capacity: 25 });

    expect(hostId).toBe(USER);
  });

  it('surfaces the §4.1 host-rights refusal as FORBIDDEN, not as a 500', async () => {
    // The distinction is what the UI can do about it: a 403 with this code is
    // "rank up to host", which is an action. A 500 is a dead end.
    const academy = stubAcademy({
      createRoom: (async () => {
        throw new AcademyError('rank does not host', 'academy.host_rights_required');
      }) as AcademyService['createRoom'],
    });

    await expect(
      createAcademyRouter(academy)
        .createCaller(signed())
        .createRoom({ slug: 'forex-desk', name: 'Forex Desk', kind: 'forex', access: 'free', capacity: 25 }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('surfaces an UNREADABLE perk table as a 500 — "try again", not "go and rank up"', async () => {
    const academy = stubAcademy({
      createRoom: (async () => {
        throw new AcademyError('identity unreachable', 'academy.host_rights_unavailable');
      }) as AcademyService['createRoom'],
    });

    await expect(
      createAcademyRouter(academy)
        .createCaller(signed())
        .createRoom({ slug: 'forex-desk', name: 'Forex Desk', kind: 'forex', access: 'free', capacity: 25 }),
    ).rejects.toMatchObject({ code: 'INTERNAL_SERVER_ERROR' });
  });

  it('invite is the one procedure naming another user, and it is host-gated in the service', async () => {
    let invitedBy: string | null = null;
    const academy = stubAcademy({
      invite: (async (input: { hostId: string }) => {
        invitedBy = input.hostId;
      }) as AcademyService['invite'],
    });

    await createAcademyRouter(academy).createCaller(signed()).invite({ roomId: ROOM, userId: VICTIM });
    // The caller cannot claim to be someone else's host: `hostId` comes from
    // the signed principal, and the service compares it to `rooms.host_id`.
    expect(invitedBy).toBe(USER);
  });
});

describe('svc-academy mount — a stake threshold is a decimal string on the wire', () => {
  it('serialises minStake out as a string, never a number', async () => {
    const [out] = await createAcademyRouter(stubAcademy()).createCaller(signed()).rooms();
    expect(typeof out!.minStake).toBe('string');
    expect(out!.minStake).toBe('1');
  });

  it('parses a threshold in without letting the wire string reach the service', async () => {
    let received: unknown;
    const academy = stubAcademy({
      createRoom: (async (input: { minStake?: unknown }) => {
        received = input.minStake;
        return room;
      }) as AcademyService['createRoom'],
    });

    await createAcademyRouter(academy)
      .createCaller(signed())
      .createRoom({ slug: 'staked-room', name: 'Staked', kind: 'general', access: 'staked', minStake: '2.5', capacity: 10 });

    // A scaled bigint, not '2.5'. Doctrine §0.3 — money is never a number, and
    // it is never a raw string past the boundary either.
    expect(typeof received).toBe('bigint');
    expect(received).toBe(2_500_000_000_000_000_000n);
  });

  it('rejects a float-shaped threshold at the edge of the router', async () => {
    await expect(
      createAcademyRouter(stubAcademy())
        .createCaller(signed())
        // @ts-expect-error a number is exactly what must not be accepted here
        .createRoom({ slug: 'r', name: 'R', kind: 'general', access: 'staked', minStake: 2.5, capacity: 10 }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });
});

describe('svc-academy mount — no SFU means an error, never a fake token', () => {
  it('reports stream_unavailable as a 500 rather than returning a credential', async () => {
    const academy = stubAcademy({
      streamCredential: (async () => {
        throw new AcademyError('no provider configured', 'academy.stream_unavailable');
      }) as AcademyService['streamCredential'],
    });

    const call = createAcademyRouter(academy).createCaller(signed()).streamCredential({ sessionId: SESSION });

    // The shape of the failure matters as much as the fact of it: a client that
    // got `{ url, token }` here would try to connect and hang.
    await expect(call).rejects.toMatchObject({ code: 'INTERNAL_SERVER_ERROR' });
    await expect(call).rejects.not.toHaveProperty('token');
  });
});

describe('svc-academy mount — the paper drill gate is reachable, and refuses live', () => {
  const caller = () => createAcademyRouter(stubAcademy()).createCaller(signed());
  const paperMarket = { marketId: 'mkt-paper-1', paper: true, symbol: 'BTC-USDT' };

  it('returns the drill steps for a workbook on a paper market', async () => {
    const result = await caller().paperDrill({ slug: 'foundations-paper-workbook', market: paperMarket });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected a paper drill');
    expect(result.marketId).toBe('mkt-paper-1');
    expect(result.steps.length).toBeGreaterThan(0);
    expect(result.steps.every((step) => step.id && step.instruction)).toBe(true);
  });

  it('REFUSES a market trade did not flag as paper — this is the whole point', async () => {
    const result = await caller().paperDrill({
      slug: 'foundations-paper-workbook',
      market: { ...paperMarket, paper: false },
    });

    expect(result).toMatchObject({ ok: false, reason: 'not_paper' });
  });

  it('REFUSES when the caller labels a live listing as paper', async () => {
    await expect(
      caller().paperDrill({
        slug: 'foundations-paper-workbook',
        market: { marketId: 'mkt-live-1', paper: true, symbol: 'BTC/USDT' },
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('REFUSES paper: true when TRADE_URL / verification port is unset', async () => {
    const academy = stubAcademy({
      assertCallerPaperFlagVerified: vi.fn(async (market) => {
        await assertCallerCannotLiePaperFlag(undefined, market);
      }),
    });
    await expect(
      createAcademyRouter(academy).createCaller(signed()).paperDrill({ slug: 'foundations-paper-workbook', market: paperMarket }),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
  });

  it('refuses with no market rather than defaulting to one', async () => {
    const result = await caller().paperDrill({ slug: 'foundations-paper-workbook', market: null });

    expect(result).toMatchObject({ ok: false, reason: 'no_market' });
  });

  it('refuses a catalog item that is not a workbook', async () => {
    const notAWorkbook = await caller().curriculum({ kind: 'playbook', limit: 50 });
    const slug = notAWorkbook[0]?.slug;
    expect(slug).toBeTruthy();

    const result = await caller().paperDrill({ slug: slug as string, market: paperMarket });

    expect(result).toMatchObject({ ok: false });
  });

  it('rejects a slug that is not in the spine at all', async () => {
    await expect(caller().paperDrill({ slug: 'no-such-workbook', market: paperMarket })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('Stage-3 ops kill refuses paperDrill — live trade path not involved', async () => {
    const academy = stubAcademy({
      assertPaperTradingEnabled: vi.fn(() => {
        throw new AcademyError('Paper trading drills are disabled by ops — live trade unchanged.', 'academy.paper_trading_disabled');
      }),
    });
    await expect(
      createAcademyRouter(academy).createCaller(signed()).paperDrill({ slug: 'foundations-paper-workbook', market: paperMarket }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('Stage-3 paperOpsStatus reports enable + liveTradeUnaffected + realMoney false', async () => {
    const status = await caller().paperOpsStatus();
    expect(status).toEqual({
      enabled: true,
      flagId: 'academy.paper-trading',
      envKey: 'ACADEMY_PAPER_TRADING_ENABLED',
      liveTradeUnaffected: true,
      simulated: true,
      venue: 'paper',
      realMoney: false,
    });
    expect(JSON.stringify(status)).not.toContain('"realMoney":true');
    expect(JSON.stringify(status)).not.toContain('"live":true');
  });

  it('REFUSES paperDrill when the body claims realMoney or live', async () => {
    await expect(
      caller().paperDrill({ slug: 'foundations-paper-workbook', market: paperMarket, realMoney: true } as never),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(
      caller().paperDrill({ slug: 'foundations-paper-workbook', market: { ...paperMarket, live: true } } as never),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('REFUSES paperOpsStatus when the service presents paper as live money', async () => {
    const academy = stubAcademy({
      paperOpsStatus: vi.fn(() => ({
        enabled: true,
        flagId: 'academy.paper-trading' as const,
        envKey: 'ACADEMY_PAPER_TRADING_ENABLED' as const,
        liveTradeUnaffected: true as const,
        simulated: true as const,
        venue: 'paper' as const,
        realMoney: true,
      })) as unknown as AcademyService['paperOpsStatus'],
    });
    await expect(createAcademyRouter(academy).createCaller(signed()).paperOpsStatus()).rejects.toMatchObject({
      code: 'INTERNAL_SERVER_ERROR',
    });
  });

  it('a started drill arrives sealed — the client has something to badge', async () => {
    const result = await caller().paperDrill({ slug: 'foundations-paper-workbook', market: paperMarket });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected a paper drill');
    expect(result.simulated).toBe(true);
    expect(result.venue).toBe('paper');
    expect(result.realLedger).toBe(false);
    expect(result.withdrawable).toBe(false);
    expect(result.realMoney).toBe(false);
    expect(result.disclaimer).toMatch(/no value moved/i);
  });
});

/**
 * THE DRILL, FINISHED. `paperDrill` says "you may"; this says "here is what it
 * came to", and every figure in it is a figure trade published.
 *
 * The tests that matter here are the negative ones. A drill result that could
 * be read as real money, or a fill valued at a price nobody quoted, is the
 * incident TRK-academy.paper-trading exists to prevent — so each is asserted as
 * a refusal, not as an absence.
 */
describe('svc-academy mount — a paper drill produces a labelled simulated result', () => {
  const caller = () => createAcademyRouter(stubAcademy()).createCaller(signed());
  const paperMarket = { marketId: 'mkt-paper-1', paper: true, symbol: 'BTC-USDT' };
  const drill = (over: Record<string, unknown> = {}) => ({
    slug: 'foundations-paper-workbook',
    market: paperMarket,
    completedStepIds: [] as string[],
    fills: [] as unknown[],
    markPrice: null as string | null,
    ...over,
  });

  it('completes the workbook and values the round trip from published prices', async () => {
    const result = await caller().paperDrillResult(
      drill({
        completedStepIds: ['size-from-invalidation', 'limit-cancel', 'prewritten-stop'],
        fills: [
          { fillId: 'f-1', marketId: 'mkt-paper-1', side: 'buy', price: '100', size: '2' },
          { fillId: 'f-2', marketId: 'mkt-paper-1', side: 'sell', price: '110', size: '2' },
        ],
      }) as never,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected a drill result');
    expect(result.result.status).toBe('complete');
    expect(result.result.complete).toBe(true);
    expect(result.result.completedCount).toBe(3);
    expect(result.result.remainingStepIds).toEqual([]);
    expect(result.result.valuation.realisedPnl).toBe('20');
    expect(result.result.valuation.totalPnl).toBe('20');
  });

  it('LABELS the result — nothing here could be read as a real position', async () => {
    const result = await caller().paperDrillResult(
      drill({
        fills: [{ fillId: 'f-1', marketId: 'mkt-paper-1', side: 'buy', price: '100', size: '2' }],
        markPrice: '115',
      }) as never,
    );

    if (!result.ok) throw new Error('expected a drill result');
    expect(result.simulated).toBe(true);
    expect(result.venue).toBe('paper');
    expect(result.realLedger).toBe(false);
    expect(result.withdrawable).toBe(false);
    expect(result.realMoney).toBe(false);
    expect(result.disclaimer).toMatch(/withdrawable/i);

    // Belt and braces: no key anywhere in the payload claims a real book.
    const flat = JSON.stringify(result);
    expect(flat).toContain('"simulated":true');
    expect(flat).toContain('"withdrawable":false');
    expect(flat).toContain('"realMoney":false');
    expect(flat).not.toContain('ledgerTxId');
    expect(flat).not.toContain('idempotencyKey');
    expect(flat).not.toContain('availableBalance');
    expect(flat).not.toContain('holdAmount');
  });

  it('REFUSES a result body that claims live money on the wire', async () => {
    await expect(caller().paperDrillResult(drill({ realMoney: true }) as never)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(
      caller().paperDrillResult(
        drill({ fills: [{ fillId: 'f-1', marketId: 'mkt-paper-1', side: 'buy', price: '1', size: '1', live: true }] }) as never,
      ),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('REFUSES a live market — a result is never produced off a real book', async () => {
    const result = await caller().paperDrillResult(drill({ market: { ...paperMarket, paper: false } }) as never);
    expect(result).toMatchObject({ ok: false, reason: 'not_paper' });
  });

  it('REFUSES a result when the caller labels a live listing as paper', async () => {
    await expect(
      caller().paperDrillResult(drill({ market: { marketId: 'mkt-live-1', paper: true, symbol: 'BTC/USDT' } }) as never),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('refuses with no market rather than picking one', async () => {
    const result = await caller().paperDrillResult(drill({ market: null }) as never);
    expect(result).toMatchObject({ ok: false, reason: 'no_market' });
  });

  it('refuses a step the workbook does not have — no invented progress', async () => {
    const result = await caller().paperDrillResult(drill({ completedStepIds: ['step-i-made-up'] }) as never);
    expect(result).toMatchObject({ ok: false, reason: 'unknown_step' });
  });

  it('refuses a fill from another market', async () => {
    const result = await caller().paperDrillResult(
      drill({ fills: [{ fillId: 'f-1', marketId: 'mkt-somewhere-else', side: 'buy', price: '1', size: '1' }] }) as never,
    );
    expect(result).toMatchObject({ ok: false, reason: 'bad_fill' });
  });

  it('REJECTS a price sent as a JSON number — a float never enters, simulated or not', async () => {
    await expect(
      caller().paperDrillResult(
        drill({ fills: [{ fillId: 'f-1', marketId: 'mkt-paper-1', side: 'buy', price: 100, size: '1' }] }) as never,
      ),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('REJECTS a fill with no price at all rather than valuing it at zero', async () => {
    await expect(
      caller().paperDrillResult(drill({ fills: [{ fillId: 'f-1', marketId: 'mkt-paper-1', side: 'buy', size: '1' }] }) as never),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('reports an unmarked open position as unmarked instead of inventing the mark', async () => {
    const result = await caller().paperDrillResult(
      drill({ fills: [{ fillId: 'f-1', marketId: 'mkt-paper-1', side: 'buy', price: '100', size: '2' }] }) as never,
    );

    if (!result.ok) throw new Error('expected a drill result');
    expect(result.result.valuation.openSize).toBe('2');
    expect(result.result.valuation.unrealisedPnl).toBeNull();
    expect(result.result.valuation.totalPnl).toBeNull();
    expect(result.result.valuation.markUnavailable).toBe(true);
  });

  it('rejects a slug that is not in the spine', async () => {
    await expect(caller().paperDrillResult(drill({ slug: 'no-such-workbook' }) as never)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('the Stage-3 ops kill refuses the result surface too — live trade untouched', async () => {
    const academy = stubAcademy({
      assertPaperTradingEnabled: vi.fn(() => {
        throw new AcademyError('Paper trading drills are disabled by ops — live trade unchanged.', 'academy.paper_trading_disabled');
      }),
    });

    await expect(
      createAcademyRouter(academy)
        .createCaller(signed())
        .paperDrillResult(drill() as never),
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('is refused outright without the academy:read scope', async () => {
    const noScope = principal({ scopes: [] });
    await expect(
      createAcademyRouter(stubAcademy())
        .createCaller(signed(noScope))
        .paperDrillResult(drill() as never),
    ).rejects.toBeTruthy();
  });
});

// ── Ambassador IFC pay / revenue share — under rate authority on the mount ──
//
// Pure ifc-pay tests prove refuse + quote. Without a mount test an operator path
// could start returning 200 with invented amounts and only unit files would stay green.
describe('svc-academy mount — ambassador pay under rate authority', () => {
  const admin = () =>
    principal({
      scopes: ['admin:read', 'admin:write', 'academy:read', 'academy:write'],
    });
  const BENEFICIARY = '11111111-1111-4111-8111-111111111111';

  it('ambassadorPayPlane is dark for settlement (no invent enabled=true)', async () => {
    const plane = await createAcademyRouter(stubAcademy()).createCaller(signed(admin())).ambassadorPayPlane();
    expect(plane.ifcPayEnabled).toBe(false);
    expect(plane.revenueShareEnabled).toBe(false);
    expect(plane.ifcRateAuthorityPublished).toBe(false);
    expect(plane.ifcPayQuoteEnabled).toBe(false);
    expect(plane.classM).toBe(true);
    expect(plane).not.toHaveProperty('rate');
    expect(plane).not.toHaveProperty('amount');
    expect(plane).not.toHaveProperty('bps');
    expect(plane.residualIfcPay).toMatch(/refuse-closed|owner-only/);
  });

  it('ambassadorIfcPay refuses closed without rate authority — PRECONDITION_FAILED', async () => {
    await expect(
      createAcademyRouter(stubAcademy()).createCaller(signed(admin())).ambassadorIfcPay({ beneficiaryId: BENEFICIARY }),
    ).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
    });
  });

  it('ambassadorRevenueShare refuses closed — including dryRun without authority', async () => {
    await expect(
      createAcademyRouter(stubAcademy()).createCaller(signed(admin())).ambassadorRevenueShare({ beneficiaryId: BENEFICIARY, dryRun: true }),
    ).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
    });
  });

  it('published rate authority + dryRun returns quote from owner rates only', async () => {
    const ifcPayLaw = {
      published: true as const,
      sessionCredit: '7.25000000',
      asset: 'IFC',
      period: 'session',
    };
    const caller = createAcademyRouter(stubAcademy(), { ifcPayLaw }).createCaller(signed(admin()));
    const plane = await caller.ambassadorPayPlane();
    expect(plane.ifcRateAuthorityPublished).toBe(true);
    expect(plane.ifcPayQuoteEnabled).toBe(true);
    expect(plane.ifcPayEnabled).toBe(false);

    const quote = await caller.ambassadorIfcPay({
      beneficiaryId: BENEFICIARY,
      dryRun: true,
      residencyStatus: 'accepted',
    });
    expect(quote).toMatchObject({
      ok: true,
      kind: 'ifc_pay',
      sessionCredit: '7.25000000',
      asset: 'IFC',
      authority: 'owner_published',
      settlement: 'refuse_recipe_unset',
    });
  });

  it('residencyIfcPayQuote refuses non-accepted residency even with authority', async () => {
    const ifcPayLaw = {
      published: true as const,
      sessionCredit: '1.00000000',
      asset: 'IFC',
      period: 'session',
    };
    await expect(
      createAcademyRouter(stubAcademy(), { ifcPayLaw })
        .createCaller(signed(admin()))
        .residencyIfcPayQuote({ beneficiaryId: BENEFICIARY, residencyStatus: 'applied' }),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
  });

  it('pay plane is not readable without admin:read', async () => {
    await expect(createAcademyRouter(stubAcademy()).createCaller(signed()).ambassadorPayPlane()).rejects.toBeTruthy();
  });

  it('public ambassadorPayQuote returns typed refuse when rates unset — not a fake quote', async () => {
    const quote = await createAcademyRouter(stubAcademy()).createCaller(signed()).ambassadorPayQuote();
    expect(quote.status).toBe('refuse');
    expect(quote.ok).toBe(false);
    expect(quote.payable).toBe(false);
    expect(quote.inventedIfc).toBe(false);
    expect(quote.reason).toBe('unset');
    expect(quote.code).toBe('academy.ambassador_pay.rates_unset');
    expect(quote.rateAuthorityPublished).toBe(false);
    expect(quote).not.toHaveProperty('sessionCredit');
    expect(quote).not.toHaveProperty('amount');
    expect(quote).not.toHaveProperty('shareOfFeeBps');
  });

  it('public residencyPayQuote refuses unset rates even for accepted residency', async () => {
    const quote = await createAcademyRouter(stubAcademy()).createCaller(signed()).residencyPayQuote({ residencyStatus: 'accepted' });
    expect(quote.status).toBe('refuse');
    expect(quote.kind).toBe('residency');
    expect(quote.code).toBe('academy.ambassador_pay.rates_unset');
    expect(quote.payable).toBe(false);
    expect(quote).not.toHaveProperty('sessionCredit');
  });

  it('unset public doors never look payable', async () => {
    const caller = createAcademyRouter(stubAcademy()).createCaller(signed());
    const ifc = await caller.ambassadorPayQuote({ kind: 'ifc_pay' });
    const share = await caller.ambassadorPayQuote({ kind: 'revenue_share' });
    const residency = await caller.residencyPayQuote();
    expect(ifc.ok).toBe(false);
    expect(share.ok).toBe(false);
    expect(residency.ok).toBe(false);
    expect(ifc.payable || share.payable || residency.payable).toBe(false);
  });
});

// ── Certifications Stage-2: the XP outcome crosses the mount ────────────────
//
// The router is where a client learns whether its certification's award went
// out. A grant that reported nothing would leave "did my rank move?" to be
// answered by refreshing a page, so the shape is asserted here and not only
// in certs/xp-publish.test.ts.
describe('svc-academy mount — a cert grant reports its XP award', () => {
  const caller = () => createAcademyRouter(stubAcademy()).createCaller(signed());

  it('grantCert reports the XP award alongside the grant', async () => {
    const academy = stubAcademy({
      grantCert: vi.fn(async () => ({
        alreadyGranted: false,
        grant: {
          userId: USER,
          certId: 'foundations-v1',
          grantedAt: new Date(),
          idempotencyKey: `cert:${USER}:foundations-v1`,
          publicId: 'a'.repeat(32),
        },
        xp: { emitted: true as const, idempotencyKey: `academy.cert:cert:${USER}:foundations-v1`, xpDelta: 100 },
        perks: {
          status: 'real' as const,
          path: 'identity_rank' as const,
          sot: 'svc-identity' as const,
          academyHoldsPerkMoney: false as const,
          academyMapsCertToPerk: false as const,
          perks: BASE_PERKS,
        },
      })),
    });

    const result = await createAcademyRouter(academy).createCaller(signed()).grantCert({ certId: 'foundations-v1' });

    expect(result.xp).toEqual({ emitted: true, idempotencyKey: `academy.cert:cert:${USER}:foundations-v1`, xpDelta: 100 });
    expect(result.perks.status).toBe('real');
  });

  it('grantCert still returns the grant when the award could not be published', async () => {
    const academy = stubAcademy({
      grantCert: vi.fn(async () => ({
        alreadyGranted: true,
        grant: {
          userId: USER,
          certId: 'foundations-v1',
          grantedAt: new Date(),
          idempotencyKey: `cert:${USER}:foundations-v1`,
          publicId: 'a'.repeat(32),
        },
        xp: { emitted: false as const, reason: 'publisher_unavailable' as const },
        perks: {
          status: 'refuse' as const,
          code: 'academy.cert_perk_refuse_closed' as const,
          reason: 'identity_unreadable' as const,
          message: 'Identity perk table unreadable',
          academyHoldsPerkMoney: false as const,
          academyMapsCertToPerk: false as const,
          residual: 'TRK-academy.certs D26-P1-C1 — perks via svc-identity rank only; cert→perk money refuse-closed (no invent)' as const,
        },
      })),
    });

    const result = await createAcademyRouter(academy).createCaller(signed()).grantCert({ certId: 'foundations-v1' });

    expect(result.grant.certId).toBe('foundations-v1');
    expect(result.xp).toEqual({ emitted: false, reason: 'publisher_unavailable' });
    expect(result.perks.status).toBe('refuse');
  });

  it('grantCert unpriced cert publishes nothing — perk outcome is refuse, not granted money', async () => {
    const academy = stubAcademy({
      grantCert: vi.fn(async () => ({
        alreadyGranted: false,
        grant: {
          userId: USER,
          certId: 'not-in-policy-v1',
          grantedAt: new Date(),
          idempotencyKey: `cert:${USER}:not-in-policy-v1`,
          publicId: 'b'.repeat(32),
        },
        xp: { emitted: false as const, reason: 'no_policy' as const },
        perks: {
          status: 'refuse' as const,
          code: 'academy.cert_perk_refuse_closed' as const,
          reason: 'unpriced' as const,
          message: 'Unpriced cert publishes nothing — no XP, no identity perk grant, no invent perk money',
          academyHoldsPerkMoney: false as const,
          academyMapsCertToPerk: false as const,
          residual: 'TRK-academy.certs D26-P1-C1 — perks via svc-identity rank only; cert→perk money refuse-closed (no invent)' as const,
        },
      })),
    });

    const result = await createAcademyRouter(academy).createCaller(signed()).grantCert({ certId: 'not-in-policy-v1' });

    expect(result.xp).toEqual({ emitted: false, reason: 'no_policy' });
    expect(result.xp).not.toHaveProperty('xpDelta');
    expect(result.perks.status).toBe('refuse');
    if (result.perks.status !== 'refuse') throw new Error('expected refuse');
    expect(result.perks.reason).toBe('unpriced');
    expect(result.perks).not.toHaveProperty('perks');
    expect(result.perks.academyHoldsPerkMoney).toBe(false);
  });

  it('certXpPlane names svc-identity as the rank writer, never academy', async () => {
    const plane = await caller().certXpPlane();

    expect(plane.rankWriter).toBe('svc-identity');
    expect(plane).toMatchObject({ publisherId: 'none', emitEnabled: false, sourceModule: 'academy', action: 'cert.granted' });
  });

  it('certXpPlane is not readable without academy:read', async () => {
    await expect(createAcademyRouter(stubAcademy()).createCaller(anonymous()).certXpPlane()).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
  });

  it('certPerkPlane refuses academy perk money and names identity SoT', async () => {
    const plane = await caller().certPerkPlane();
    expect(plane.rankWriter).toBe('svc-identity');
    expect(plane.academyHoldsPerkMoney).toBe(false);
    expect(plane.academyMapsCertToPerk).toBe(false);
    expect(plane.perksEnabledViaIdentity).toBe(true);
  });

  it('certPerkIntent always refuse-closes invent kinds', async () => {
    const result = await createAcademyRouter(stubAcademy())
      .createCaller(signed(principal({ scopes: ['admin:read', 'admin:write', 'academy:read', 'academy:write'] })))
      .certPerkIntent({ kind: 'invent_perk_money' });
    expect(result).toMatchObject({
      ok: false,
      status: 'refuse',
      code: 'academy.cert_perk_refuse_closed',
      kind: 'invent_perk_money',
      academyHoldsPerkMoney: false,
      academyMapsCertToPerk: false,
    });
  });
});

describe('svc-academy mount — stored video (not LiveKit)', () => {
  it('videos refuses academy.video_storage_unconfigured when storage is off', async () => {
    await expect(createAcademyRouter(stubAcademy()).createCaller(signed()).videos()).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: userCopy('academy.video_storage_unconfigured'),
    });
  });

  it('unsigned object URL is not a grant', async () => {
    const video = {
      storage: {
        endpoint: 'http://academy-minio:9000',
        bucket: 'academy-video',
        accessKey: 'academyvideo',
        secretKey: 'academyvideo-secret-key',
        region: 'us-east-1',
        ttlSeconds: 300,
      },
      gate: { minTier: 'none' as const, minStake: '0' },
      stakeOf: async () => parseAmount('1'),
    };
    await expect(
      createAcademyRouter(stubAcademy(), {}, video).createCaller(signed()).videoPlayback({
        slug: 'foundations-risk-first',
        url: 'http://academy-minio:9000/academy-video/foundations/risk-first.mp4',
      }),
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: userCopy('academy.video_grant_required'),
    });
  });
});

describe('svc-academy mount — ambassador appoint/freeze dual-control', () => {
  const CONFIRM = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  const TARGET = '33333333-3333-4333-8333-333333333333';
  const APPOINTED_AT = new Date('2026-01-01T00:00:00.000Z');

  const activeRecord = {
    userId: TARGET,
    status: 'active' as const,
    appointedBy: USER,
    appointedAt: APPOINTED_AT,
    frozenAt: null,
    frozenBy: null,
    freezeReason: null,
  };

  function programmeStub() {
    const calls: unknown[] = [];
    return {
      calls,
      academy: stubAcademy({
        appointAmbassador: vi.fn(async (input) => {
          calls.push(['appoint', input]);
          return activeRecord;
        }),
        freezeAmbassador: vi.fn(async (input) => {
          calls.push(['freeze', input]);
          return {
            ...activeRecord,
            status: 'frozen' as const,
            frozenAt: new Date('2026-01-02T00:00:00.000Z'),
            frozenBy: USER,
            freezeReason: input.reason,
          };
        }),
        unfreezeAmbassador: vi.fn(async (input) => {
          calls.push(['unfreeze', input]);
          return activeRecord;
        }),
      }),
    };
  }

  function admin(mfa: boolean) {
    return signed(principal({ scopes: ['admin:write', 'academy:read', 'academy:write'], mfa }));
  }

  it('refuses without MFA even with admin:write — no invented second factor', async () => {
    const { calls, academy } = programmeStub();
    const caller = operatorRouter(academy, CONFIRM).createCaller(admin(false));
    await expect(caller.appointAmbassador({ userId: TARGET, confirmOperatorId: CONFIRM, ...APPROVED })).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
    await expect(
      caller.freezeAmbassador({ userId: TARGET, reason: 'operator freeze', confirmOperatorId: CONFIRM, ...APPROVED }),
    ).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
    await expect(caller.unfreezeAmbassador({ userId: TARGET, confirmOperatorId: CONFIRM, ...APPROVED })).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
    expect(calls).toEqual([]);
  });

  it('refuses missing approval ids — a typed-in second name is not enough', async () => {
    const { calls, academy } = programmeStub();
    const caller = operatorRouter(academy, CONFIRM).createCaller(admin(true));
    await expect(caller.appointAmbassador({ userId: TARGET })).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: expect.stringMatching(/typed-in second name|approvalId/),
    });
    await expect(caller.appointAmbassador({ userId: TARGET, confirmOperatorId: USER })).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: expect.stringMatching(/typed-in second name|approvalId/),
    });
    await expect(caller.appointAmbassador({ userId: TARGET, confirmOperatorId: '   ' })).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: expect.stringMatching(/typed-in second name|approvalId/),
    });
    await expect(caller.freezeAmbassador({ userId: TARGET, reason: 'operator freeze' })).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: expect.stringMatching(/typed-in second name|approvalId/),
    });
    await expect(caller.freezeAmbassador({ userId: TARGET, reason: 'operator freeze', confirmOperatorId: USER })).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: expect.stringMatching(/typed-in second name|approvalId/),
    });
    await expect(caller.unfreezeAmbassador({ userId: TARGET, confirmOperatorId: USER })).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: expect.stringMatching(/typed-in second name|approvalId/),
    });
    expect(calls).toEqual([]);
  });

  it('appoints/freezes/unfreezes with MFA and consumed approval; same-person typed confirm is not a refuse', async () => {
    const { calls, academy } = programmeStub();
    const caller = operatorRouter(academy, CONFIRM).createCaller(admin(true));
    await expect(caller.appointAmbassador({ userId: TARGET, confirmOperatorId: USER, ...APPROVED })).resolves.toMatchObject({
      userId: TARGET,
      status: 'active',
      confirmOperatorId: CONFIRM,
    });
    await expect(
      caller.freezeAmbassador({ userId: TARGET, reason: 'operator freeze', confirmOperatorId: CONFIRM, ...APPROVED }),
    ).resolves.toMatchObject({
      userId: TARGET,
      status: 'frozen',
      confirmOperatorId: CONFIRM,
    });
    await expect(caller.unfreezeAmbassador({ userId: TARGET, confirmOperatorId: CONFIRM, ...APPROVED })).resolves.toMatchObject({
      userId: TARGET,
      status: 'active',
      confirmOperatorId: CONFIRM,
    });
    expect(calls).toEqual([
      ['appoint', { userId: TARGET, operatorId: USER }],
      ['freeze', { userId: TARGET, operatorId: USER, reason: 'operator freeze' }],
      ['unfreeze', { userId: TARGET, operatorId: USER }],
    ]);
  });
});

describe('svc-academy mount — decideResidency dual-control', () => {
  const CONFIRM = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  const TARGET = '33333333-3333-4333-8333-333333333333';
  const APP_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
  const APPLIED_AT = new Date('2026-01-01T00:00:00.000Z');
  const DECIDED_AT = new Date('2026-01-02T00:00:00.000Z');

  const decided = {
    id: APP_ID,
    userId: TARGET,
    cohortSlug: 'foundations',
    statement: 'I want to sit the residency because I have been paper-trading with a risk-first book.',
    status: 'accepted' as const,
    appliedAt: APPLIED_AT,
    decidedAt: DECIDED_AT,
    decidedBy: USER,
    decisionNote: null as string | null,
  };

  function residencyStub() {
    const calls: unknown[] = [];
    return {
      calls,
      academy: stubAcademy({
        decideResidency: vi.fn(async (input) => {
          calls.push(['decide', input]);
          return {
            ...decided,
            status: input.decision,
            decisionNote: input.note ?? null,
          };
        }),
      }),
    };
  }

  function admin(mfa: boolean) {
    return signed(principal({ scopes: ['admin:write', 'academy:read', 'academy:write'], mfa }));
  }

  it('refuses without MFA even with admin:write — no invented second factor', async () => {
    const { calls, academy } = residencyStub();
    const caller = operatorRouter(academy, CONFIRM).createCaller(admin(false));
    await expect(
      caller.decideResidency({ id: APP_ID, decision: 'accepted', confirmOperatorId: CONFIRM, ...APPROVED }),
    ).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
    expect(calls).toEqual([]);
  });

  it('refuses missing approval ids — a typed-in second name is not enough', async () => {
    const { calls, academy } = residencyStub();
    const caller = operatorRouter(academy, CONFIRM).createCaller(admin(true));
    await expect(caller.decideResidency({ id: APP_ID, decision: 'accepted' })).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: expect.stringMatching(/typed-in second name|approvalId/),
    });
    await expect(caller.decideResidency({ id: APP_ID, decision: 'accepted', confirmOperatorId: USER })).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: expect.stringMatching(/typed-in second name|approvalId/),
    });
    await expect(caller.decideResidency({ id: APP_ID, decision: 'rejected', confirmOperatorId: '   ' })).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: expect.stringMatching(/typed-in second name|approvalId/),
    });
    expect(calls).toEqual([]);
  });

  it('accepts/rejects with MFA and consumed approval; same-person typed confirm is not a refuse', async () => {
    const { calls, academy } = residencyStub();
    const caller = operatorRouter(academy, CONFIRM).createCaller(admin(true));
    await expect(caller.decideResidency({ id: APP_ID, decision: 'accepted', confirmOperatorId: USER, ...APPROVED })).resolves.toMatchObject(
      {
        id: APP_ID,
        status: 'accepted',
        confirmOperatorId: CONFIRM,
      },
    );
    await expect(
      caller.decideResidency({ id: APP_ID, decision: 'rejected', note: 'not ready', confirmOperatorId: CONFIRM, ...APPROVED }),
    ).resolves.toMatchObject({
      id: APP_ID,
      status: 'rejected',
      confirmOperatorId: CONFIRM,
    });
    expect(calls).toEqual([
      ['decide', { id: APP_ID, operatorId: USER, decision: 'accepted' }],
      ['decide', { id: APP_ID, operatorId: USER, decision: 'rejected', note: 'not ready' }],
    ]);
  });
});

describe('svc-academy mount — createSeason dual-control', () => {
  const CONFIRM = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  const SEASON_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const STARTS_AT = new Date('2026-08-01T00:00:00.000Z');

  const createdSeason = {
    id: SEASON_ID,
    slug: 'spring-open',
    title: 'Spring Open',
    status: 'scheduled' as const,
    rulesSummary: 'Paper ladder only — no prize money on this stage.',
    startsAt: STARTS_AT,
    endsAt: null as Date | null,
  };

  const payload = {
    slug: 'spring-open',
    title: 'Spring Open',
    rulesSummary: 'Paper ladder only — no prize money on this stage.',
    startsAt: STARTS_AT,
  };

  function seasonStub() {
    const calls: unknown[] = [];
    return {
      calls,
      academy: stubAcademy({
        createSeason: vi.fn(async (input) => {
          calls.push(['createSeason', input]);
          return createdSeason;
        }),
      }),
    };
  }

  function admin(mfa: boolean) {
    return signed(principal({ scopes: ['admin:write', 'academy:read', 'academy:write'], mfa }));
  }

  it('refuses without MFA even with admin:write — no invented second factor', async () => {
    const { calls, academy } = seasonStub();
    const caller = operatorRouter(academy, CONFIRM).createCaller(admin(false));
    await expect(caller.createSeason({ ...payload, confirmOperatorId: CONFIRM, ...APPROVED })).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
    expect(calls).toEqual([]);
  });

  it('refuses missing approval ids — a typed-in second name is not enough', async () => {
    const { calls, academy } = seasonStub();
    const caller = operatorRouter(academy, CONFIRM).createCaller(admin(true));
    await expect(caller.createSeason(payload)).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: expect.stringMatching(/typed-in second name|approvalId/),
    });
    await expect(caller.createSeason({ ...payload, confirmOperatorId: USER })).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: expect.stringMatching(/typed-in second name|approvalId/),
    });
    await expect(caller.createSeason({ ...payload, confirmOperatorId: '   ' })).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: expect.stringMatching(/typed-in second name|approvalId/),
    });
    expect(calls).toEqual([]);
  });

  it('creates with MFA and consumed approval; same-person typed confirm is not a refuse', async () => {
    const { calls, academy } = seasonStub();
    const caller = operatorRouter(academy, CONFIRM).createCaller(admin(true));
    await expect(caller.createSeason({ ...payload, confirmOperatorId: USER, ...APPROVED })).resolves.toMatchObject({
      id: SEASON_ID,
      status: 'scheduled',
      confirmOperatorId: CONFIRM,
    });
    expect(calls).toEqual([
      [
        'createSeason',
        {
          slug: payload.slug,
          title: payload.title,
          rulesSummary: payload.rulesSummary,
          startsAt: STARTS_AT,
          endsAt: null,
        },
      ],
    ]);
  });
});

describe('svc-academy mount — setSeasonStatus dual-control', () => {
  const CONFIRM = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  const SEASON_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const STARTS_AT = new Date('2026-08-01T00:00:00.000Z');

  const frozenSeason = {
    id: SEASON_ID,
    slug: 'spring-open',
    title: 'Spring Open',
    status: 'frozen' as const,
    rulesSummary: 'Paper ladder only — no prize money on this stage.',
    startsAt: STARTS_AT,
    endsAt: null as Date | null,
  };

  function seasonStub() {
    const calls: unknown[] = [];
    return {
      calls,
      academy: stubAcademy({
        setSeasonStatus: vi.fn(async (input) => {
          calls.push(['setSeasonStatus', input]);
          return { ...frozenSeason, status: input.status };
        }),
      }),
    };
  }

  function admin(mfa: boolean) {
    return signed(principal({ scopes: ['admin:write', 'academy:read', 'academy:write'], mfa }));
  }

  it('refuses without MFA even with admin:write — no invented second factor', async () => {
    const { calls, academy } = seasonStub();
    const caller = operatorRouter(academy, CONFIRM).createCaller(admin(false));
    await expect(
      caller.setSeasonStatus({ seasonId: SEASON_ID, status: 'frozen', confirmOperatorId: CONFIRM, ...APPROVED }),
    ).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
    expect(calls).toEqual([]);
  });

  it('refuses missing approval ids — a typed-in second name is not enough', async () => {
    const { calls, academy } = seasonStub();
    const caller = operatorRouter(academy, CONFIRM).createCaller(admin(true));
    await expect(caller.setSeasonStatus({ seasonId: SEASON_ID, status: 'frozen' })).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: expect.stringMatching(/typed-in second name|approvalId/),
    });
    await expect(caller.setSeasonStatus({ seasonId: SEASON_ID, status: 'frozen', confirmOperatorId: USER })).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: expect.stringMatching(/typed-in second name|approvalId/),
    });
    await expect(caller.setSeasonStatus({ seasonId: SEASON_ID, status: 'ended', confirmOperatorId: '   ' })).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: expect.stringMatching(/typed-in second name|approvalId/),
    });
    expect(calls).toEqual([]);
  });

  it('freezes with MFA and consumed approval; same-person typed confirm is not a refuse', async () => {
    const { calls, academy } = seasonStub();
    const caller = operatorRouter(academy, CONFIRM).createCaller(admin(true));
    await expect(
      caller.setSeasonStatus({ seasonId: SEASON_ID, status: 'frozen', confirmOperatorId: USER, ...APPROVED }),
    ).resolves.toMatchObject({
      id: SEASON_ID,
      status: 'frozen',
      confirmOperatorId: CONFIRM,
    });
    expect(calls).toEqual([['setSeasonStatus', { seasonId: SEASON_ID, status: 'frozen' }]]);
  });
});

describe('svc-academy mount — standing writes dual-control', () => {
  const CONFIRM = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  const SEASON_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const TARGET = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
  const UPDATED_AT = new Date('2026-09-06T00:00:00.000Z');

  const standing = {
    seasonId: SEASON_ID,
    userId: TARGET,
    score: 12,
    updatedAt: UPDATED_AT,
  };

  function standingStub() {
    const calls: unknown[] = [];
    return {
      calls,
      academy: stubAcademy({
        setStanding: vi.fn(async (input) => {
          calls.push(['setStanding', input]);
          return { ...standing, score: input.score };
        }),
        bulkSetStandings: vi.fn(async (input) => {
          calls.push(['bulkSetStandings', input]);
          return { ok: true as const, accepted: input.patches.length, standings: [{ ...standing, score: input.patches[0]!.score }] };
        }),
      }),
    };
  }

  function admin(mfa: boolean) {
    return signed(principal({ scopes: ['admin:write', 'academy:read', 'academy:write'], mfa }));
  }

  it('refuses without MFA even with admin:write — no invented second factor', async () => {
    const { calls, academy } = standingStub();
    const caller = operatorRouter(academy, CONFIRM).createCaller(admin(false));
    await expect(
      caller.setStanding({ seasonId: SEASON_ID, userId: TARGET, score: 12, confirmOperatorId: CONFIRM, ...APPROVED }),
    ).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
    await expect(
      caller.bulkSetStandings({
        seasonId: SEASON_ID,
        patches: [{ userId: TARGET, score: 12 }],
        confirmOperatorId: CONFIRM,
        ...APPROVED,
      }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(calls).toEqual([]);
  });

  it('refuses missing approval ids — a typed-in second name is not enough', async () => {
    const { calls, academy } = standingStub();
    const caller = operatorRouter(academy, CONFIRM).createCaller(admin(true));
    await expect(caller.setStanding({ seasonId: SEASON_ID, userId: TARGET, score: 12 })).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: expect.stringMatching(/typed-in second name|approvalId/),
    });
    await expect(caller.setStanding({ seasonId: SEASON_ID, userId: TARGET, score: 12, confirmOperatorId: USER })).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: expect.stringMatching(/typed-in second name|approvalId/),
    });
    await expect(caller.setStanding({ seasonId: SEASON_ID, userId: TARGET, score: 12, confirmOperatorId: '   ' })).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: expect.stringMatching(/typed-in second name|approvalId/),
    });
    await expect(caller.bulkSetStandings({ seasonId: SEASON_ID, patches: [{ userId: TARGET, score: 12 }] })).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: expect.stringMatching(/typed-in second name|approvalId/),
    });
    await expect(
      caller.bulkSetStandings({
        seasonId: SEASON_ID,
        patches: [{ userId: TARGET, score: 12 }],
        confirmOperatorId: USER,
      }),
    ).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: expect.stringMatching(/typed-in second name|approvalId/),
    });
    expect(calls).toEqual([]);
  });

  it('writes scores with MFA and consumed approval; same-person typed confirm is not a refuse', async () => {
    const { calls, academy } = standingStub();
    const caller = operatorRouter(academy, CONFIRM).createCaller(admin(true));
    await expect(
      caller.setStanding({ seasonId: SEASON_ID, userId: TARGET, score: 12, confirmOperatorId: USER, ...APPROVED }),
    ).resolves.toMatchObject({
      seasonId: SEASON_ID,
      userId: TARGET,
      score: 12,
      confirmOperatorId: CONFIRM,
    });
    await expect(
      caller.bulkSetStandings({
        seasonId: SEASON_ID,
        patches: [{ userId: TARGET, score: 19 }],
        confirmOperatorId: CONFIRM,
        ...APPROVED,
      }),
    ).resolves.toMatchObject({
      ok: true,
      accepted: 1,
      confirmOperatorId: CONFIRM,
    });
    expect(calls).toEqual([
      ['setStanding', { seasonId: SEASON_ID, userId: TARGET, score: 12 }],
      ['bulkSetStandings', { seasonId: SEASON_ID, patches: [{ userId: TARGET, score: 19 }] }],
    ]);
  });
});
