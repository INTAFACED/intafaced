// Records, from the TypeScript svc-academy in this checkout, what the Rust crate's door is held to:
//
// - `src/door/calls.rs`: every call's path, query or mutation, who may call it (the scope or public), whether its
//   handler turns a refusal into an answer through `guard()` or lets it out raw, and which slice owns it.
// - `src/door/schemas.json`: every call's input schema, as the tree of zod 4 parts the Rust zod engine runs.
// - `src/door/errors_table.rs`: each academy refusal code with the tRPC code and the message `toTrpcError` sends.
// - `tests/fixtures/input-parity.golden.json`: zod's own verdict on a few thousand inputs, made from each schema.
// - `tests/fixtures/env-parity.golden.json`: what `env.ts` answers for a set of environments.
//
// Run from the repository root, with the workspace packages built (`pnpm --filter "@intafaced/svc-academy^..." build`):
//   TZ=UTC node --import tsx crates/svc-academy/scripts/record-door.mjs          writes the files
//   TZ=UTC node --import tsx crates/svc-academy/scripts/record-door.mjs --check  fails when a written file is stale
//
// It reads the TypeScript service and `services/svc-academy/src/wire-replay.golden.json`; it never writes there. It
// stops being runnable when the TypeScript service is deleted, and from then on what it wrote is the reference.

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const CRATE = fileURLToPath(new URL('../', import.meta.url));
const SVC = `${ROOT}services/svc-academy/src/`;
const NAME = 'record-door';
// The TypeScript service was deleted when svc-academy switched to this crate (weed project-state#3343): what this script
// wrote is now the reference, and a change to it is made in the recorded file itself. Read the TypeScript in git history.
if (!existsSync(SVC)) {
  console.error(
    `${NAME}: services/svc-academy no longer exists (the Rust crate replaced it); nothing to record from. The files it wrote are the reference now.`,
  );
  process.exit(2);
}
const CHECK = process.argv.includes('--check');

if (process.env.TZ !== 'UTC') {
  console.error('record-door: run with TZ=UTC (new Date(text) reads a time with no offset in the local zone)');
  process.exit(2);
}
process.env.INTAFACED_UNSIGNED_SANCTIONS_ROWS = 'off';

const { createAcademyRouter } = await import(`${SVC}router.ts`);
const { ACADEMY_ERROR_CODES } = await import(`${SVC}errors.ts`);
const { userCopy } = await import(`${SVC}user-copy.ts`);

const golden = JSON.parse(readFileSync(`${SVC}wire-replay.golden.json`, 'utf8'));
const refusing = new Proxy(() => undefined, {
  get: () => () => {
    throw new Error('record-door: the router is only read');
  },
});
const procedures = createAcademyRouter(refusing)._def.procedures;
const paths = Object.keys(procedures).sort((a, b) => a.localeCompare(b));

// ── Who owns each call ─────────────────────────────────────────────────────────────────────────────────────────────

/** The slices (one Rust module each), and the calls each owns: exact paths, then `prefix*` patterns. */
const SLICES = {
  door: ['health', 'admin.settingsStatus'],
  curriculum: [
    'curriculum',
    'curriculumDeepLink',
    'curriculumDepth',
    'curriculumImportStatus',
    'curriculumInventory',
    'curriculumItem',
    'curriculumItemLocalized',
    'curriculumPathDeepLinks',
    'curriculumRelated',
    'curriculumStudyGuide',
    'curriculumStudyGuides',
    'publicCurriculum',
    'publicCurriculumItem',
    'publicCurriculumRelated',
    'publicHub',
  ],
  lobbies: [
    'rooms',
    'room',
    'session',
    'join',
    'leave',
    'streamCredential',
    'createRoom',
    'invite',
    'pinLesson',
    'unpinLesson',
    'scheduleSession',
    'startSession',
    'endSession',
    'updateScene',
    'myUpcomingSessions',
    'sessionCalendar',
  ],
  authoring: [
    'admin.course',
    'admin.courses',
    'admin.createCourse',
    'admin.updateCourse',
    'admin.duplicateCourse',
    'admin.duplicateItem',
    'admin.lesson',
    'admin.saveLesson',
    'admin.publishLesson',
    'admin.withdrawLesson',
    'admin.revertLesson',
    'admin.importLesson',
    'admin.assistantDraft',
    'admin.decideDraft',
    'admin.mediaUploadIntent',
    'admin.confirmMedia',
    'admin.itemMedia',
    'admin.setItemCaptions',
    'admin.setItemVideo',
    'admin.setVideoTracks',
    'admin.featuredSlot',
    'admin.featureLesson',
    'admin.setFeatured',
    'admin.clearFeatured',
    'admin.topics',
    'admin.createTopic',
    'admin.setCourseTopics',
    'admin.programmes',
    'admin.saveProgramme',
    'admin.saveOutline',
    'admin.courseRelease',
    'admin.setSectionRelease',
    'admin.courseItemRules',
    'admin.setCourseItemPrerequisites',
    'admin.setItemPrerequisites',
    'admin.setItemWindow',
    'admin.setCourseStart',
    'admin.setCourseState',
    'admin.setCourseVisibility',
    'admin.setCoursePacing',
    'admin.setCourseEnrolmentWindow',
    'admin.setCourseSeatCap',
    'admin.withdrawCoursePrice',
    'videos',
    'video*',
    'publicVideos',
    'itemVideo',
    'itemRelease',
    'courseOutline',
    'programmes',
    'programme',
  ],
  learner: [
    'abandonCoursePurchase',
    'buyCourse',
    'submitCoursePayment',
    'coursePurchase',
    'admin.coursePurchase',
    'admin.refundCoursePurchase',
    'enrolCourse',
    'courseEnrolment',
    'authoredCourse',
    'authoredCourseEnrolment',
    'enrolAuthoredCourse',
    'leaveAuthoredCourse',
    'myLearning',
    'myProgress',
    'learningState',
    'touchLesson',
    'markCurriculumComplete',
    'undoCurriculumComplete',
    'myAccessGrants',
    'planner.*',
    'videoProgress.*',
    'publicCourse',
    'publicCourses',
    'publicCourseByLink',
    'publicAuthoredCourse',
    'publicAuthoredCourses',
    'admin.previewCourse',
    'admin.createPrivateLink',
    'admin.privateLinks',
    'admin.revokePrivateLink',
    'admin.enrolments',
    'admin.grantAccess',
    'admin.reinstateAccess',
    'admin.grantAudit',
    'admin.learnerProgress',
    'admin.markCompleteFor',
  ],
  assessment: [
    'assessment.*',
    'courseQuiz',
    'courseQuizAttempt',
    'startCourseQuiz',
    'answerCourseQuiz',
    'finishCourseQuiz',
    'submitCourseSurvey',
    'assignment',
    'submitAssignment',
    'uploadAssignmentFile',
    'peerReview',
    'peerReviewFile',
    'submitPeerReview',
    'markFeedbackRead',
    'admin.assignment',
    'admin.saveAssignment',
    'admin.withdrawAssignment',
    'admin.courseQuiz*',
    'admin.saveCourseQuiz',
    'admin.setCourseQuizState',
    'admin.curveCourseQuiz',
    'admin.fixCourseQuizKey',
    'admin.rescoreCourseQuiz',
    'admin.overrideCourseQuizScore',
    'admin.scoreCourseQuizEssays',
    'admin.voidQuizAttempt',
    'admin.setQuiz',
    'admin.gradingQueue',
    'admin.openGrading',
    'admin.gradeSubmission',
    'admin.bulkGrade',
    'admin.saveGradingPolicy',
    'admin.saveLatePolicy',
    'admin.saveReviewSteps',
    'admin.courseGradebook',
    'admin.courseGradeReports',
    'admin.makeGradeReport',
    'admin.gradeReportFile',
    'admin.grantCourseExtension',
    'admin.grantItemExtension',
    'admin.grantLearnerExtension',
  ],
  certs: [
    'cert*',
    'grantCert',
    'myCerts',
    'myCompletions',
    'myEnrollments',
    'enrollCertPath',
    'leaveCertPath',
    'setCertHolderName',
    'admin.activateCertDesign',
    'admin.deactivateCertDesign',
    'admin.certDesign',
    'admin.certDesigns',
    'admin.saveCertDesign',
    'admin.certExportFile',
    'admin.certExports',
    'admin.makeCertExport',
    'admin.certIssueRule',
    'admin.setCertIssueRule',
    'admin.grantCertException',
    'admin.issuedCerts',
    'admin.revokeCert',
  ],
  community: [
    'discussion*',
    'createDiscussionPost',
    'followDiscussionPost',
    'likeDiscussionPost',
    'replyDiscussionPost',
    'reportDiscussionPost',
    'acceptDiscussionReply',
    'courseConversations',
    'openCourseConversation',
    'sendCourseMessage',
    'courseEmails',
    'setCourseEmails',
    'admin.academyRoles',
    'admin.saveCustomRole',
    'admin.setCustomRoleActive',
    'admin.courseTeam',
    'admin.proposeTeamChange',
    'admin.confirmTeamChange',
    'admin.learner',
    'admin.learners',
    'admin.learnerSummaries',
    'admin.learnerTags',
    'admin.tagLearners',
    'admin.untagLearner',
    'admin.addLearnerNote',
    'admin.staffEnrol',
    'admin.staffEnrolments',
    'admin.bulkEnrol',
    'admin.bulkEmail',
    'admin.bulkEmails',
    'admin.sendBulkEmail',
    'admin.inviteToCourse',
    'admin.courseInvitations',
    'admin.requestLearnerExport',
    'admin.report*',
    'admin.requestReport',
    'admin.abortReport',
    'admin.deleteReport',
    'admin.opsMetrics',
    'admin.moderationQueue',
    'admin.discussionThread',
    'admin.deleteDiscussionPost',
    'admin.bulkDeleteUserPosts',
    'admin.saveDiscussionTopic',
    'admin.courseInbox',
    'admin.openCourseConversation',
    'admin.replyCourseMessage',
    'admin.completionsByItem',
  ],
  programme: [
    'ambassador*',
    'appointAmbassador',
    'freezeAmbassador',
    'unfreezeAmbassador',
    'applyResidency',
    'decideResidency',
    'withdrawResidency',
    'myResidencies',
    'openResidencies',
    'residency*',
    'season',
    'seasons',
    'seasonCalendar',
    'createSeason',
    'setSeasonStatus',
    'standings',
    'setStanding',
    'bulkSetStandings',
    'freezeSnapshot',
    'tournament*',
    'tournaments.*',
    'paper*',
  ],
};

function sliceOf(path) {
  const exact = Object.entries(SLICES).filter(([, list]) => list.includes(path));
  if (exact.length === 1) return exact[0][0];
  if (exact.length > 1) throw new Error(`${path} is named by two slices`);
  // The longest matching pattern wins: `videoProgress.*` over `video*`.
  const matches = Object.entries(SLICES)
    .flatMap(([slice, list]) => list.filter((p) => p.endsWith('*') && path.startsWith(p.slice(0, -1))).map((p) => [p.length, slice]))
    .sort((a, b) => b[0] - a[0]);
  if (matches.length === 0 || (matches.length > 1 && matches[0][0] === matches[1][0])) {
    throw new Error(`${path} matches ${matches.length} slices`);
  }
  return matches[0][1];
}

// ── The door table ─────────────────────────────────────────────────────────────────────────────────────────────────

/** The calls whose handler does not run `guard()` (router.ts and the spread routers), read by hand. */
const UNGUARDED = new Set([
  'admin.abortReport',
  'admin.bulkEmail',
  'admin.bulkEmails',
  'admin.bulkEnrol',
  'admin.certDesign',
  'admin.certDesigns',
  'admin.certExportFile',
  'admin.certExports',
  'admin.courseGradeReports',
  'admin.courseInvitations',
  'admin.deleteReport',
  'admin.gradeReportFile',
  'admin.inviteToCourse',
  'admin.issuedCerts',
  'admin.learnerSummaries',
  'admin.makeGradeReport',
  'admin.reportCentreFile',
  'admin.reportCentreTasks',
  'admin.reportFile',
  'admin.reportTasks',
  'admin.requestLearnerExport',
  'admin.requestReport',
  'admin.sendBulkEmail',
  'admin.staffEnrol',
  'admin.staffEnrolments',
  'certDefinitions',
  'certPaths',
  'certPerkPlane',
  'certXpPlane',
  'courseEmails',
  'rooms',
  'setCourseEmails',
]);

/** The calls whose handler consumes an identity-issued approval first (`consumeApproval`). */
const APPROVAL_GATED = new Set([
  'appointAmbassador',
  'freezeAmbassador',
  'unfreezeAmbassador',
  'decideResidency',
  'setSeasonStatus',
  'setStanding',
  'bulkSetStandings',
]);

const CALLERS = ['anon', 'read', 'write', 'operator'];
const bodyOf = (group, request, caller) => golden.bodies[golden.answers[group][request][CALLERS.indexOf(caller)]];

/** The scope a call requires, from which of the replay's callers it refused and how it named the scope. */
function scopeOf(path) {
  const named = CALLERS.map((c) => bodyOf(path, 'store-down valid', c)).map((b) => /Scope \\"([a-z:]+)\\" is required/.exec(b)?.[1]);
  const first = named.find(Boolean);
  if (first) return first;
  // The read caller holds only academy:read; a call it was not refused requires exactly that.
  return 'academy:read';
}

function guardedOf(path) {
  const guarded = !UNGUARDED.has(path);
  const reached = bodyOf(path, 'refuses valid', 'operator');
  if (reached.includes('academy.room_not_found')) {
    const raw = reached.includes('"message":"replay: refused"');
    if (raw === guarded) throw new Error(`${path}: the replay shows it ${raw ? 'unguarded' : 'guarded'}`);
  }
  return guarded;
}

const callers = golden.callers;
if (JSON.stringify(callers.map((c) => c.path)) !== JSON.stringify(paths)) throw new Error('the router and the golden disagree');

const table = callers.map((c) => {
  const proc = procedures[c.path];
  return {
    path: c.path,
    kind: c.type,
    access: c.caller === 'public' ? null : scopeOf(c.path),
    guarded: guardedOf(c.path),
    approval: APPROVAL_GATED.has(c.path),
    slice: sliceOf(c.path),
    hasInput: proc._def.inputs.length > 0,
  };
});

// ── The input schemas ──────────────────────────────────────────────────────────────────────────────────────────────

/** Each refine's function source, named: the Rust crate implements each by its name (`src/door/refines.rs`). */
const REFINES = {
  'value=>(value.grantId?1:0)+(value.publicId?1:0)===1': 'grant_or_public_id',
  '(n) => !ACADEMY_BUILTIN_ROLES.includes(n)': 'not_builtin_role',
  "(d) => (d.price === null) === (d.priceAsset === null) && (d.pricing === 'paid' || d.price === null)": 'pricing_holds',
  '(v) => /[1-9]/.test(v)': 'has_nonzero_digit',
  "(i) => (i.kind === 'link') === (i.url !== null)": 'link_has_url',
  '(v) => new Set(v.questions.map((q) => q.id)).size === v.questions.length': 'unique_question_ids',
  "(v) => v.kind === 'survey' || v.questions.every(questionHasKey)": 'graded_has_keys',
  "(v) => v.kind === 'survey' || !v.anonymous": 'only_survey_anonymous',
  "(v) => v.resultsVisibility !== 'after_last_attempt' || v.attemptLimit !== null": 'after_last_needs_limit',
  "(q) => !('choices' in q) || uniqueChoices(q.choices)": 'unique_choice_ids',
  "(q) => q.kind !== 'single' || q.correctChoiceId === null || q.choices.some((c) => c.id === q.correctChoiceId)": 'single_key_is_choice',
  "(q) => q.kind !== 'multi' ||\n    q.correctChoiceIds === null ||\n    (new Set(q.correctChoiceIds).size === q.correctChoiceIds.length &&\n        q.correctChoiceIds.every((id) => q.choices.some((c) => c.id === id)))":
    'multi_keys_are_choices',
  "(q) => q.kind !== 'multi' || !q.partialCredit || q.correctChoiceIds === null || q.points % q.correctChoiceIds.length === 0":
    'partial_credit_splits',
  "(v) => !v.startsWith('-')": 'not_negative',
  "(v) => v.text !== 'off' || v.file !== 'off'": 'text_or_file',
  '(c) => ascending(c.levels)': 'levels_ascend',
  '(t) => new Set(t.topicIds).size === t.topicIds.length': 'unique_topic_ids',
  '(input) => new Set(input.courseSlugs).size === input.courseSlugs.length': 'unique_course_slugs',
  '(s) => s !== ACADEMY_DISCUSSION_GENERAL_TOPIC': 'not_general_topic',
  "(rule) => rule.mode === 'delayed' || rule.delayMinutes === null": 'only_delayed_has_delay',
  'v=>!(v.course&&v.certificate)': 'course_or_certificate',
};

const ids = new Map();
const nodes = [];

function messageOf(def) {
  if (!def.error) return undefined;
  const m = def.error({});
  return typeof m === 'string' ? m : m?.message;
}

const LENGTH_WHEN = 'val.length !== undefined';

function check(c) {
  const d = c._zod.def;
  const out = (k, extra = {}) => {
    const msg = messageOf(d);
    return { k, ...extra, ...(d.abort ? { abort: true } : {}), ...(msg !== undefined ? { msg } : {}) };
  };
  if (d.when && !(['min_length', 'max_length'].includes(d.check) && d.when.toString().includes(LENGTH_WHEN))) {
    throw new Error(`a check with its own when: ${d.check}`);
  }
  switch (d.check) {
    case 'min_length':
      return out('min_length', { n: d.minimum });
    case 'max_length':
      return out('max_length', { n: d.maximum });
    case 'string_format':
      if (d.format === 'regex') return out('regex', { src: d.pattern.toString() });
      if (d.format === 'starts_with') return out('starts_with', { prefix: d.prefix });
      if (d.format === 'url') {
        for (const k of ['normalize', 'hostname', 'protocol']) if (k in d) throw new Error(`url with ${k}`);
        return out('url');
      }
      if (d.format === 'guid' || d.format === 'datetime') return out('format', { format: d.format, src: d.pattern.toString() });
      throw new Error(`string format ${d.format}`);
    case 'overwrite': {
      const src = d.tx.toString();
      if (src === '(input) => input.trim()') return out('trim');
      if (src === '(input) => input.toLowerCase()') return out('lower');
      throw new Error(`overwrite ${src}`);
    }
    case 'greater_than':
      return out('gt', { v: d.value, incl: d.inclusive });
    case 'less_than':
      return out('lt', { v: d.value, incl: d.inclusive });
    case 'number_format':
      if (d.format !== 'safeint') throw new Error(`number format ${d.format}`);
      return out('int');
    case 'custom': {
      const name = REFINES[d.fn.toString()];
      if (!name) throw new Error(`an unnamed refine: ${d.fn.toString()}`);
      return out('refine', { id: name, ...(d.path ? { path: d.path } : {}) });
    }
    default:
      throw new Error(`check ${d.check}`);
  }
}

function node(s) {
  if (ids.has(s)) return ids.get(s);
  const id = nodes.length;
  ids.set(s, id);
  nodes.push(null);
  nodes[id] = build(s);
  return id;
}

function build(s) {
  const d = s._zod.def;
  if (d.error) throw new Error(`a ${d.type} schema with its own error`);
  const self = s._zod.traits.has('$ZodCheck') && d.type === 'string' ? [s] : [];
  const checks = [...self, ...(d.checks ?? [])].map(check);
  const withChecks = (o) => (checks.length ? { ...o, checks } : o);
  switch (d.type) {
    case 'string':
    case 'number':
    case 'boolean':
    case 'date':
      return withChecks({ t: d.type, ...(d.coerce ? { coerce: true } : {}) });
    case 'unknown':
      return withChecks({ t: 'unknown' });
    case 'enum':
      return withChecks({ t: 'enum', values: s.options });
    case 'literal':
      return withChecks({ t: 'literal', values: d.values });
    case 'object': {
      const shape = Object.entries(d.shape).map(([k, v]) => [k, node(v)]);
      let catchall = null;
      if (d.catchall) {
        const t = d.catchall._zod.def.type;
        if (t === 'never') catchall = 'strict';
        else if (t === 'unknown') catchall = 'passthrough';
        else throw new Error(`catchall ${t}`);
      }
      return withChecks({ t: 'object', shape, ...(catchall ? { catchall } : {}) });
    }
    case 'array':
      return withChecks({ t: 'array', el: node(d.element) });
    case 'optional':
    case 'nullable':
      return withChecks({ t: d.type, in: node(d.innerType) });
    case 'default':
      return withChecks({ t: 'default', in: node(d.innerType), value: d.defaultValue });
    case 'union':
      if (d.discriminator !== undefined) {
        if (d.unionFallback) throw new Error('a discriminated union with a fallback');
        return withChecks({ t: 'dunion', disc: d.discriminator, options: d.options.map(node) });
      }
      if (d.inclusive === false) throw new Error('an exclusive union');
      return withChecks({ t: 'union', options: d.options.map(node) });
    case 'record':
      if (d.mode && d.mode !== 'strict') throw new Error(`record mode ${d.mode}`);
      return withChecks({ t: 'record', key: node(d.keyType), value: node(d.valueType) });
    case 'lazy':
      return withChecks({ t: 'lazy', in: node(s._zod.innerType) });
    default:
      throw new Error(`schema type ${d.type}`);
  }
}

const inputs = {};
for (const path of paths) {
  const ins = procedures[path]._def.inputs;
  if (ins.length > 1) throw new Error(`${path} has ${ins.length} inputs`);
  if (ins.length === 1) inputs[path] = node(ins[0]);
}

// ── zod's verdicts ─────────────────────────────────────────────────────────────────────────────────────────────────

const byNode = [...ids.entries()].reduce((m, [s, id]) => m.set(id, s), new Map());

/** `ok <output>`, `issues <zod's issues>`, or `throws <message>` when a refine itself throws (tRPC answers 400 with it). */
function verdict(schema, input, text) {
  let r;
  try {
    r = schema.safeParse(input);
  } catch (err) {
    return `throws ${err.message}`;
  }
  if (!r.success) return `issues ${JSON.stringify(r.error.issues)}`;
  const out = JSON.stringify(r.data) ?? 'undefined';
  // `ok =`: the output is the input as sent.
  return out === text ? 'ok =' : `ok ${out}`;
}

/** Strings tried for each string part: what one accepts is a valid sample of it, the rest probe its checks. */
const POOL = [
  '',
  ' ',
  'a',
  'abc',
  'placeholder',
  'Placeholder Title',
  '  padded  ',
  '﻿bom﻿',
  '\u0085next\u0085',
  'a-b',
  'a_b',
  'A',
  'ABC',
  'ab-CD',
  'en',
  'en-GB',
  'de-AT',
  'zh-Hant',
  '0',
  '1',
  '7',
  '10',
  '0.5',
  '0.25',
  '1.0',
  '1.00',
  '1.5',
  '12.34',
  '1.234',
  '0.0001',
  '-1',
  '-0.5',
  '100',
  '999999',
  '1000000',
  '0x' + 'a'.repeat(40),
  '0x' + 'A1'.repeat(20),
  '0x' + 'b'.repeat(64),
  'f'.repeat(32),
  'e'.repeat(64),
  'custom:33333333-3333-4333-8333-333333333333',
  '33333333-3333-4333-8333-333333333333',
  '33333333-3333-4333-8333-33333333333',
  'not-a-uuid',
  'my-course',
  'my--course',
  '-lead',
  'snake_case',
  'video/mp4',
  'application/pdf',
  'c++',
  '#tag',
  '10.0.0.1',
  '192.168.0.0/24',
  '::1',
  '2001:db8::/32',
  '1.2.3',
  'https://example.com/a',
  ' https://example.com/a ',
  'http://example.com/a',
  'https:example.com',
  'ftp://example.com',
  'https://exa\nmple.com',
  'example.com',
  '2026-01-01T00:00:00.000Z',
  '2026-01-01T00:00:00Z',
  '2026-01-01T00:00:00+08:00',
  '2026-01-01T00:00:00',
  '2026-02-30T00:00:00Z',
  '2026-01-01',
  'Jan 5 2026',
  '2026/01/05',
  '😀',
  '😀😀😀',
  'x'.repeat(41),
];

/** How a long probe is written in the parity file: `["repeat", before, unit, count, after]`, read back the same way. */
const LONG = new Map();
function long(before, unit, count, after = '') {
  const s = before + unit.repeat(count) + after;
  if (s.length > 64) LONG.set(s, ['repeat', before, unit, count, after]);
  return s;
}
/** `["many", element as JSON text, count]`: an array of one element repeated. */
const MANY = new WeakMap();
function many(el, count) {
  const arr = Array.from({ length: count }, () => el);
  if (count > 4) MANY.set(arr, ['many', JSON.stringify(el), count]);
  return arr;
}
function encodeProbe(v) {
  if (v === undefined) return null;
  if (typeof v === 'string' && LONG.has(v)) return LONG.get(v);
  if (Array.isArray(v) && MANY.has(v)) return MANY.get(v);
  return JSON.stringify(v);
}

function poolFor(s) {
  const d = s._zod.def;
  const extra = [];
  for (const c of d.checks ?? []) {
    const cd = c._zod.def;
    if (cd.check === 'max_length')
      extra.push(long('', 'a', cd.maximum), long('', 'a', cd.maximum + 1), long('', '😀', cd.maximum), long(' ', 'a', cd.maximum, ' '));
    if (cd.check === 'min_length' && cd.minimum > 1)
      extra.push(long('', 'a', cd.minimum), long('', 'a', cd.minimum - 1), long('', '😀', cd.minimum - 1));
    if (cd.check === 'string_format' && cd.format === 'starts_with') extra.push(`${cd.prefix}example.com/a`);
  }
  return [...POOL, ...extra];
}

const NUMBERS = [0, 1, 2, 7, -1, 0.5, 1.5, -0.5, 59, 60, 100, 101, 1000, 3600, 86400, 1e6, 2 ** 31, 2 ** 53, -(2 ** 53), 1e21, 1e-7];
const DATES = [
  '2026-01-01T00:00:00.000Z',
  '2026-01-01',
  '2026-01-01T10:00',
  '2026-01-01 10:00:00',
  '2026-13-01',
  'Jan 5 2026 10:00 GMT+0100',
  '5 January 2026',
  'Mon, 05 Jan 2026 10:00:00 GMT',
  '2026/01/05',
  '1/5/2026',
  'tomorrow',
  '',
  '+002026-01-01T00:00:00Z',
  '2026-01-01T00:00:00.123456Z',
  '20260101',
  0,
  7,
  -1,
  8.64e15,
  8.64e15 + 1,
  1.5,
  true,
  null,
  [],
  [2026],
  {},
];

/** A value the part accepts, when one is found; `undefined` otherwise. */
function sample(id, depth = 0) {
  const s = byNode.get(id);
  const n = nodes[id];
  const ok = (v) => s.safeParse(v).success;
  if (depth > 6) return undefined;
  switch (n.t) {
    case 'string':
      return poolFor(s).find(ok);
    case 'number':
      return NUMBERS.find(ok);
    case 'boolean':
      return true;
    case 'date':
      return n.coerce ? '2026-01-01T00:00:00.000Z' : undefined;
    case 'unknown':
      return 'anything';
    case 'enum':
    case 'literal':
      return n.values[0];
    case 'optional':
      return sample(n.in, depth + 1);
    case 'nullable': {
      const v = sample(n.in, depth + 1);
      return v === undefined ? null : v;
    }
    case 'default':
      return sample(n.in, depth + 1);
    case 'lazy':
      return depth > 3 ? undefined : sample(n.in, depth + 1);
    case 'object': {
      const out = {};
      for (const [k, v] of n.shape) {
        const inner = nodes[v];
        if (inner.t === 'optional' && depth > 0) continue;
        const sv = sample(v, depth + 1);
        if (sv !== undefined) out[k] = sv;
      }
      if (ok(out)) return out;
      // Try the refines' usual escape: every nullable field null, every optional left out.
      const lean = {};
      for (const [k, v] of n.shape) {
        const inner = nodes[v];
        if (inner.t === 'optional') continue;
        lean[k] = inner.t === 'nullable' ? null : out[k];
      }
      return ok(lean) ? lean : out;
    }
    case 'array': {
      const min = (n.checks ?? []).find((c) => c.k === 'min_length')?.n ?? 0;
      const el = sample(n.el, depth + 1);
      if (el === undefined) return [];
      const arr = Array.from({ length: Math.max(min, 1) }, () => structuredClone(el));
      if (ok(arr)) return arr;
      // Unique ids: number each element's string fields.
      const numbered = arr.map((e, i) => (typeof e === 'object' && e && !Array.isArray(e) ? { ...e, id: `${e.id ?? 'id'}-${i}` } : e));
      return ok(numbered) ? numbered : arr;
    }
    case 'union':
    case 'dunion':
      for (const o of n.options) {
        const v = sample(o, depth + 1);
        if (v !== undefined && ok(v)) return v;
      }
      return sample(n.options[0], depth + 1);
    case 'record':
      return {};
    default:
      return undefined;
  }
}

/** Values to put at one place in a sample, chosen from the part found there. */
function probes(id) {
  const s = byNode.get(id);
  const n = nodes[id];
  const base = [undefined, null, 7, 'x', true, [], {}];
  switch (n.t) {
    case 'string':
      return [...base, ...poolFor(s).filter((v, i, a) => a.indexOf(v) === i)];
    case 'number':
      return [...base, ...NUMBERS, '5'];
    case 'date':
      return [...base, ...DATES];
    case 'enum':
    case 'literal':
      return [...base, ...n.values, 'nope', String(n.values[0]).toUpperCase()];
    case 'optional':
    case 'nullable':
    case 'default':
    case 'lazy':
      return [...probes(n.in)];
    case 'array': {
      const el = sample(n.el);
      const max = (n.checks ?? []).find((c) => c.k === 'max_length')?.n;
      const out = [...base, [el], [el, el], [7], [null]];
      if (max !== undefined && max < 2000) out.push(many(el, max + 1), many(el, max));
      return out;
    }
    default:
      return base;
  }
}

/** Every place in a value's tree, with the part that checks it: [path, nodeId]. */
function places(id, value, path = [], depth = 0, out = []) {
  if (depth > 4) return out;
  let n = nodes[id];
  while (['optional', 'nullable', 'default', 'lazy'].includes(n.t)) {
    id = n.in;
    n = nodes[id];
  }
  if (n.t === 'object' && value && typeof value === 'object' && !Array.isArray(value)) {
    for (const [k, v] of n.shape) {
      out.push([[...path, k], v]);
      places(v, value[k], [...path, k], depth + 1, out);
    }
  } else if (n.t === 'array' && Array.isArray(value) && value.length > 0) {
    out.push([[...path, 0], n.el]);
    places(n.el, value[0], [...path, 0], depth + 1, out);
  } else if (n.t === 'dunion' || n.t === 'union') {
    for (const o of n.options) if (sample(o) !== undefined && byNode.get(o).safeParse(value).success) places(o, value, path, depth, out);
  }
  return out;
}

function setAt(value, path, v) {
  const copy = structuredClone(value);
  let at = copy;
  for (const k of path.slice(0, -1)) {
    if (at === null || typeof at !== 'object') return undefined;
    at = at[k];
  }
  if (at === null || typeof at !== 'object') return undefined;
  const last = path.at(-1);
  if (v === undefined) delete at[last];
  else at[last] = v;
  return copy;
}

/** A cheap deterministic shuffle, so a schema's many probes are thinned the same way on every run. */
function pick(list, max, seed) {
  if (list.length <= max) return list;
  const scored = list.map((v, i) => [createHash('sha256').update(`${seed}:${i}`).digest().readUInt32BE(0), v]);
  return scored
    .sort((a, b) => a[0] - b[0])
    .slice(0, max)
    .map(([, v]) => v);
}

const recordedCalls = new Map(golden.calls.map((c) => [c.path, c]));
/**
 * Each case is `[path, input, verdict]`; an input is null (none), JSON text, or `[base, at, value]`: base `bases[base]`
 * with the value at path `at` replaced by `value`, or removed when `value` is null. `value` is JSON text, or a long one
 * written short: `["repeat", before, unit, count, after]` (a string) or `["many", element JSON text, count]` (an array).
 */
const cases = [];
const bases = [];
const seenRoots = new Map();
for (const path of paths) {
  const id = inputs[path];
  if (id === undefined) {
    cases.push([path, null, verdict({ safeParse: () => ({ success: true, data: undefined }) }, undefined, null)]);
    continue;
  }
  // Calls sharing one schema share its cases: the first one carries them, the rest one each.
  const schema = byNode.get(id);
  const texts = new Set();
  const add = (v, encoded) => {
    const text = v === undefined ? null : JSON.stringify(v);
    if (texts.has(text)) return;
    texts.add(text);
    cases.push([path, encoded ?? text, verdict(schema, v === undefined ? undefined : JSON.parse(text), text)]);
  };
  const valid = recordedCalls.get(path)?.valid;
  const mine = sample(id);
  if (seenRoots.has(id)) {
    add(mine);
    continue;
  }
  seenRoots.set(id, path);
  for (const v of [undefined, null, 7, 'x', [], {}, valid, mine]) add(v);
  const obj = mine && typeof mine === 'object' && !Array.isArray(mine) ? mine : {};
  add({ ...obj, extra: 1 });
  add({ b: 1, 2: 2, ...obj, a: 3, 1: 4 });
  if (mine === undefined) continue;
  const base = bases.push(JSON.stringify(mine)) - 1;
  const mutations = [];
  for (const [p, at] of places(id, mine)) for (const v of probes(at)) mutations.push([p, v, setAt(mine, p, v)]);
  for (const [p, v, m] of pick(
    mutations.filter((m) => m[2] !== undefined),
    32,
    path,
  ))
    add(m, [base, p, encodeProbe(v)]);
  // Two faults at once, so the order issues come in is held too.
  const ps = places(id, mine);
  if (ps.length >= 2) {
    const [[p1], [p2]] = [ps[0], ps.at(-1)];
    const both = setAt(setAt(mine, p1, 7) ?? mine, p2, null);
    if (both !== undefined) add(both);
  }
}

// ── The error table ────────────────────────────────────────────────────────────────────────────────────────────────

const STATUS_CODE = {
  400: 'BAD_REQUEST',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  409: 'CONFLICT',
  412: 'PRECONDITION_FAILED',
  429: 'TOO_MANY_REQUESTS',
  500: 'INTERNAL_SERVER_ERROR',
};
const errors = ACADEMY_ERROR_CODES.map((code) => {
  const body = bodyOf(`refusal ${code}`, 'via admin.academyRoles', 'operator');
  const status = Number(body.slice(0, 3));
  const message = JSON.parse(body.slice(4)).error.message;
  const copy = userCopy(code);
  let send;
  if (message === `replay: ${code}`) send = 'Message';
  else if (message === copy) send = 'UserCopy';
  else throw new Error(`${code}: the replay sent ${message}`);
  if (!STATUS_CODE[status]) throw new Error(`${code}: status ${status}`);
  return { code, trpc: STATUS_CODE[status], send, copy };
});

// ── The environment ────────────────────────────────────────────────────────────────────────────────────────────────

const ENV_BASE = {
  EDGE_PRINCIPAL_SECRET: 'placeholder-academy-env-parity-edge-secret',
  INTERNAL_SERVICE_SECRET: 'placeholder-academy-env-parity-internal-secret',
  APP_ENV: 'test',
  DATABASE_URL: 'postgres://academy:academy@localhost:5432/academy_test',
  DATABASE_POOL_MAX: '4',
};
const ENV_CASES = [
  {},
  { ACADEMY_MAX_ROOM_CAPACITY: '5000', ACADEMY_PLANNER_TODO_LIMIT: ' 12 ', ACADEMY_OUTLINE_MAX_SECTIONS: '' },
  { ACADEMY_MAX_ROOM_CAPACITY: '0' },
  { ACADEMY_MAX_ROOM_CAPACITY: '100001' },
  { ACADEMY_MAX_ROOM_CAPACITY: '1.5' },
  { ACADEMY_MAX_ROOM_CAPACITY: 'many' },
  { ACADEMY_MAX_ROOM_CAPACITY: '0x10' },
  { ACADEMY_MAX_ROOM_CAPACITY: '   ' },
  { ACADEMY_GRADE_REPORT_ROWS: '', ACADEMY_CERT_ISSUED_ROWS: '50', ACADEMY_GRANT_AUDIT_PAGE_SIZE: '201' },
  { ACADEMY_UPLOAD_VIDEO_TYPES: 'Video/MP4, video/webm ,,', ACADEMY_UPLOAD_HANDOUT_TYPES: 'application/pdf' },
  { ACADEMY_UPLOAD_VIDEO_TYPES: 'mp4' },
  { ACADEMY_UPLOAD_VIDEO_TYPES: ' , ' },
  { ACADEMY_UPLOAD_MAX_BYTES: '5368709120' },
  { ACADEMY_STREAM_PROVIDER: 'livekit', LIVEKIT_URL: 'wss://lk.example', LIVEKIT_TOKEN_TTL_SECONDS: '59' },
  { ACADEMY_STREAM_PROVIDER: 'zoom' },
  { ACADEMY_TOURNAMENT_ENABLED: 'off', ACADEMY_PAPER_TRADING_ENABLED: 'FALSE' },
  { ACADEMY_TOURNAMENT_ENABLED: 'yes please', ACADEMY_PAPER_TRADING_ENABLED: '' },
  { TRADE_URL: '  ', ACADEMY_PAPER_MARKETS_LIMIT: '500' },
  { TRADE_URL: 'not a url' },
  { TRADE_URL: 'http://localhost:4004' },
  {
    ACADEMY_PAYMENT_RPC_URL: 'http://chain.example',
    ACADEMY_PAYMENT_CHAIN_ID: '8453',
    ACADEMY_PAYMENT_TOKEN_ADDRESS: ` 0x${'a'.repeat(40)} `,
    ACADEMY_PAYMENT_TOKEN_DECIMALS: '0',
    ACADEMY_PAYMENT_ASSET: 'USDC',
    ACADEMY_PAYMENT_RECEIVER: `0x${'B'.repeat(40)}`,
    ACADEMY_PAYMENT_CONFIRMATIONS: '12',
    ACADEMY_REFUND_SIGNER_URL: 'http://signer.example',
    LEDGER_URL: 'http://localhost:4001',
    ACADEMY_PURCHASE_RECONCILE_SECONDS: '30',
  },
  { ACADEMY_PAYMENT_TOKEN_ADDRESS: '0x12', ACADEMY_PAYMENT_ASSET: 'usdc', ACADEMY_PAYMENT_RECEIVER: 'nope', ACADEMY_PAYMENT_CHAIN_ID: '0' },
  { ACADEMY_TRUSTED_PROXY_CIDRS: '10.0.0.0/8', ACADEMY_VIDEO_S3_BUCKET: 'b', ACADEMY_VIDEO_URL_TTL_SECONDS: '3601' },
  { ACADEMY_TRUSTED_PROXY_CIDRS: 'x'.repeat(4001) },
  { HTTP_PORT: '0', TOKEN_URL: 'nope', IDENTITY_URL: '' },
  { SERVICE_NAME: 'svc-academy-2', LOG_LEVEL: 'loud' },
  { EDGE_PRINCIPAL_SECRET: 'placeholder' },
  { INTERNAL_SERVICE_SECRET: undefined, EDGE_PRINCIPAL_SECRET: undefined },
  { DATABASE_URL: undefined, DATABASE_POOL_MAX: ' ' },
  { DATABASE_POOL_MAX: '201', DATABASE_SSL: 'YES', OTEL_ENABLED: 'no', NATS_URL: '  ', NATS_STREAM_PREFIX: 'T' },
  { HTTP_PORT: '-5', S2S_AUTH_MODE: 'dual', S2S_SIGNING_KID: 'ab', INTERNAL_SERVICE_BODY_BIND: 'require' },
  { NODE_ENV: 'production', APP_ENV: 'prod' },
];

const envProbe = `${CRATE}scripts/env-probe.mjs`;
const envCases = ENV_CASES.map((overrides) => {
  const vars = { ...ENV_BASE, ...overrides };
  for (const [k, v] of Object.entries(vars)) if (v === undefined) delete vars[k];
  const out = execFileSync(process.execPath, ['--import', 'tsx', envProbe], {
    cwd: ROOT,
    env: { PATH: process.env.PATH, TZ: 'UTC', ACADEMY_ENV_PROBE: JSON.stringify(vars) },
    encoding: 'utf8',
  });
  return { env: vars, answer: JSON.parse(out) };
});

/**
 * The parity file: each distinct verdict once (`verdicts`), and each case as `[path, input as JSON text or null, verdict
 * index]`, one per line, so a changed verdict reads as a one-line difference.
 */
/**
 * The parity fixture, in files the CI review can read: the distinct verdicts and base inputs once
 * (`input-parity/verdicts.golden.json`), and each slice's cases (`input-parity/<slice>.golden.json`), each case naming
 * its verdict by index.
 */
function parityFiles() {
  const verdicts = [];
  const at = new Map();
  const bySlice = Object.fromEntries(Object.keys(SLICES).map((s) => [s, []]));
  for (const [path, input, v] of cases) {
    if (!at.has(v)) at.set(v, verdicts.push(v) - 1);
    bySlice[sliceOf(path)].push(JSON.stringify([path, input, at.get(v)]));
  }
  const dir = `${CRATE}tests/fixtures/input-parity/`;
  return [
    [`${dir}verdicts.golden.json`, JSON.stringify({ verdicts, bases })],
    ...Object.entries(bySlice).map(([slice, rows]) => [`${dir}${slice}.golden.json`, `{"cases":[${rows.join(',')}]}`]),
  ];
}

// ── Writing ────────────────────────────────────────────────────────────────────────────────────────────────────────

const HEADER = '// @generated by crates/svc-academy/scripts/record-door.mjs from the TypeScript svc-academy. Do not edit by hand.\n';
const rustStr = (s) => JSON.stringify(s);
const SLICE_TYPE = {
  door: 'Door',
  curriculum: 'Curriculum',
  lobbies: 'Lobbies',
  authoring: 'Authoring',
  learner: 'Learner',
  assessment: 'Assessment',
  certs: 'Certs',
  community: 'Community',
  programme: 'Programme',
};

const callsRs = `${HEADER}//! Every call the door serves, sorted by path as \`procedureCallers\` sorts it.

use super::{Access, Call, Kind, Slice};

/// The ${table.length} calls.
pub const CALLS: [Call; ${table.length}] = [
${table
  .map(
    (c) => `    Call {
        path: ${rustStr(c.path)},
        kind: Kind::${c.kind === 'query' ? 'Query' : 'Mutation'},
        access: ${c.access === null ? 'Access::Public' : `Access::Scope(${rustStr(c.access)})`},
        guarded: ${c.guarded},
        approval: ${c.approval},
        slice: Slice::${SLICE_TYPE[c.slice]},
        has_input: ${c.hasInput},
    },`,
  )
  .join('\n')}
];
`;

const errorsRs = `${HEADER}//! Each academy refusal code (\`ACADEMY_ERROR_CODES\`, in its order), the tRPC code \`toTrpcError\` gives it, whether
//! the answer carries the refusal's own message or the code's user copy (\`userCopy\`), and that copy.

use super::Send;

/// \`(code, tRPC code, which message, user copy)\`.
pub const ERRORS: [(&str, &str, Send, &str); ${errors.length}] = [
${errors.map((e) => `    (${rustStr(e.code)}, ${rustStr(e.trpc)}, Send::${e.send}, ${rustStr(e.copy)}),`).join('\n')}
];
`;

const outputs = [
  [`${CRATE}src/door/calls.rs`, callsRs],
  [`${CRATE}src/door/errors_table.rs`, errorsRs],
  [`${CRATE}src/door/schemas.json`, `${JSON.stringify({ nodes, inputs })}\n`],
  ...parityFiles(),
  [`${CRATE}tests/fixtures/env-parity.golden.json`, `${JSON.stringify({ cases: envCases }, null, 1)}\n`],
];

/** Each file leaves in the shape the repo's checks hold it to: `cargo fmt --check` for Rust, `format:check` for JSON. */
const PRETTIER = fileURLToPath(new URL('../../../node_modules/.bin/prettier', import.meta.url));
const formatted = (file, text) => {
  if (file.endsWith('.rs')) return execFileSync('rustfmt', ['--edition', '2024', '--emit', 'stdout'], { input: text, encoding: 'utf8' });
  if (file.endsWith('.json'))
    return execFileSync(PRETTIER, ['--stdin-filepath', file], { input: text, encoding: 'utf8', maxBuffer: 1 << 28 });
  return text;
};

let stale = 0;
for (const [file, raw] of outputs) {
  const text = formatted(file, raw);
  if (CHECK) {
    let was = '';
    try {
      was = readFileSync(file, 'utf8');
    } catch {}
    if (was !== text) {
      console.error(`stale: ${file.slice(ROOT.length)}`);
      stale++;
    }
  } else writeFileSync(file, text);
}
const perSlice = Object.keys(SLICES).map((s) => `${s} ${table.filter((c) => c.slice === s).length}`);
console.log(
  `${table.length} calls (${perSlice.join(', ')}), ${nodes.length} schema parts, ${cases.length} input cases, ${errors.length} refusal codes, ${envCases.length} environments`,
);
if (stale) process.exit(1);
