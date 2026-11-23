import { z } from 'zod';
import {
  academyLearnerSummariesInputSchema,
  academyLearnerSummariesSchema,
  academyOpsMetricsSchema,
  academyReportCentreFileSchema,
  academyReportCentreTaskSchema,
  academyReportCentreTasksSchema,
  academyReportDeletedSchema,
  academyReportTaskInputSchema,
  academyRequestReportInputSchema,
} from './academy-analytics.js';
import {
  academyActivateCertDesignInputSchema,
  academyCertDesignSchema,
  academyCertDesignsSchema,
  academyCertExportFileSchema,
  academyCertExportSchema,
  academyCertExportsSchema,
  academyDeactivateCertDesignInputSchema,
  academyIssuedCertsInputSchema,
  academyIssuedCertsSchema,
  academyMakeCertExportInputSchema,
  academySaveCertDesignInputSchema,
  academySaveCertDesignResultSchema,
} from './academy-cert-designs.js';
import { academyCertIdSchema, academyCertIssueRuleSchema, academySetCertIssueRuleInputSchema } from './academy-certificates.js';
import {
  academyAdminCourseQuizSchema,
  academyCourseQuizAnalyticsSchema,
  academyCourseQuizQuestionSchema,
  academyCourseQuizQuestionShape,
  academyCourseQuizAnswersSchema,
  academyCourseQuizAttemptsSchema,
  academyCourseQuizInputSchema,
  academyCurveCourseQuizInputSchema,
  academyCurveCourseQuizResultSchema,
  academyFixCourseQuizKeyInputSchema,
  academyOverrideCourseQuizScoreInputSchema,
  academyRescoreCourseQuizInputSchema,
  academyRescoreCourseQuizResultSchema,
} from './academy-course-quizzes.js';
import {
  academyCourseDetailSchema,
  academyCourseIdInputSchema,
  academyCourseListInputSchema,
  academyCourseListSchema,
  academyCourseSchema,
  academyCreateCourseInputSchema,
  academyDuplicateCourseInputSchema,
  academySaveOutlineInputSchema,
  academySetCourseStateInputSchema,
  academySetCourseTopicsInputSchema,
  academyTopicListSchema,
  academyUpdateCourseInputSchema,
} from './academy-courses.js';
import { academyLearnerTagsSchema, academyTagLearnersInputSchema } from './academy-learner-desk.js';
import {
  academyBulkEmailDetailSchema,
  academyBulkEmailInputSchema,
  academyBulkEmailsInputSchema,
  academyBulkEmailsSchema,
  academyBulkEnrolInputSchema,
  academyBulkEnrolSchema,
  academyCourseInvitationsInputSchema,
  academyCourseInvitationsSchema,
  academyInviteToCourseInputSchema,
  academyInviteToCourseSchema,
  academyReportFileInputSchema,
  academyReportFileSchema,
  academyReportTasksSchema,
  academyRequestLearnerExportInputSchema,
  academyRequestLearnerExportSchema,
  academySendBulkEmailInputSchema,
  academySendBulkEmailSchema,
  academyStaffEnrolInputSchema,
  academyStaffEnrolmentsInputSchema,
  academyStaffEnrolmentsSchema,
  academyStaffEnrolSchema,
} from './academy-staff-enrolment.js';
import { defineProcedure, NO_INPUT, type Refusals } from './procedure.js';

/**
 * svc-academy's operator calls the founder console makes (`apps/admin/src/lib/academy/`), one record per call, as the
 * Rust door serves them (`crates/svc-academy/src/door/calls.rs` for path, kind and scope; `door/schemas.json` for the
 * input; `tests/procedure_records.rs` holds the door to these records).
 *
 * `refusals` are the catalogue codes (`door/errors_table.rs`) the call's domain module can refuse with, on a call whose
 * handler is guarded. An unguarded call (`guarded: false` in `calls.rs`) and a code outside the catalogue (the
 * certificate design codes) reach the caller as INTERNAL_SERVER_ERROR with the code as its cause: a failure, not a
 * named refusal, so none is listed for them.
 */

const READ = { caller: 'scope', scope: 'admin:read', module: 'academy' } as const;
const WRITE = { caller: 'scope', scope: 'admin:write', module: 'academy' } as const;
const COMPLIANCE = { caller: 'scope', scope: 'admin:compliance', module: 'academy' } as const;
const base = { service: 'svc-academy', module: 'academy', transport: 'trpc' } as const;
const NONE: Refusals = Object.freeze({});

const ID = '22222222-2222-4222-8222-222222222222';
const NOT_ID = 'not-an-id';
const REASON = 'a reason';

// ── Courses (authoring/courses.rs) ──────────────────────────────────────────────────────────────────────────────────
const COURSE_NOT_FOUND = { 'academy.course_not_found': 'NOT_FOUND' } as const;
const COURSE_EDIT = {
  ...COURSE_NOT_FOUND,
  'academy.course_not_editable': 'CONFLICT',
  'academy.course_revision_stale': 'CONFLICT',
} as const;
const COURSE_FIELDS = { title: 'A course', summary: null, thumbnailUrl: null, pricing: 'free', price: null, priceAsset: null };
const COURSE_DRAFT = { slug: 'a-course', ...COURSE_FIELDS };
const PRICING_CHECK = {
  pricing_holds: { at: 'input', says: 'a price comes with its asset, and only a paid course has one' },
  has_nonzero_digit: { at: 'input.price', says: 'a price is more than zero' },
} as const;

export const ACADEMY_ADMIN_COURSES = defineProcedure({
  ...base,
  name: 'academy.admin.courses',
  kind: 'query',
  path: 'admin.courses',
  access: READ,
  refusals: { 'academy.courses_list_limit_unset': 'PRECONDITION_FAILED' },
  input: academyCourseListInputSchema,
  output: academyCourseListSchema,
  samples: [
    { verdict: 'accept', input: { limit: 50 } },
    { verdict: 'refuse', input: { limit: 0 } },
  ],
});

export const ACADEMY_ADMIN_COURSE = defineProcedure({
  ...base,
  name: 'academy.admin.course',
  kind: 'query',
  path: 'admin.course',
  access: READ,
  refusals: COURSE_NOT_FOUND,
  input: academyCourseIdInputSchema,
  output: academyCourseDetailSchema,
  samples: [
    { verdict: 'accept', input: { courseId: ID } },
    { verdict: 'refuse', input: { courseId: NOT_ID } },
  ],
});

export const ACADEMY_ADMIN_TOPICS = defineProcedure({
  ...base,
  name: 'academy.admin.topics',
  kind: 'query',
  path: 'admin.topics',
  access: READ,
  refusals: NONE,
  input: NO_INPUT,
  output: academyTopicListSchema,
  samples: [{ verdict: 'accept' }],
});

export const ACADEMY_ADMIN_SET_COURSE_TOPICS = defineProcedure({
  ...base,
  name: 'academy.admin.setCourseTopics',
  kind: 'mutation',
  path: 'admin.setCourseTopics',
  access: WRITE,
  refusals: { ...COURSE_EDIT, 'academy.topic_not_found': 'NOT_FOUND' },
  input: academySetCourseTopicsInputSchema,
  output: academyCourseDetailSchema,
  checks: { topic_once: { at: 'input', says: 'a topic is named once' } },
  samples: [
    { verdict: 'accept', input: { courseId: ID, revision: 1, topicIds: [ID] } },
    { verdict: 'refuse', input: { courseId: ID, revision: 0, topicIds: [] } },
    { verdict: 'refuse', by: 'topic_once', input: { courseId: ID, revision: 1, topicIds: [ID, ID] } },
  ],
});

export const ACADEMY_ADMIN_CREATE_COURSE = defineProcedure({
  ...base,
  name: 'academy.admin.createCourse',
  kind: 'mutation',
  path: 'admin.createCourse',
  access: WRITE,
  refusals: { 'academy.course_slug_taken': 'CONFLICT', 'academy.price_unset': 'PRECONDITION_FAILED' },
  input: academyCreateCourseInputSchema,
  output: academyCourseSchema,
  checks: PRICING_CHECK,
  samples: [
    { verdict: 'accept', input: COURSE_DRAFT },
    { verdict: 'refuse', input: { ...COURSE_DRAFT, slug: 'A' } },
    { verdict: 'refuse', by: 'pricing_holds', input: { ...COURSE_DRAFT, price: '5' } },
    { verdict: 'refuse', by: 'has_nonzero_digit', input: { ...COURSE_DRAFT, pricing: 'paid', price: '0', priceAsset: 'USDT' } },
  ],
});

export const ACADEMY_ADMIN_DUPLICATE_COURSE = defineProcedure({
  ...base,
  name: 'academy.admin.duplicateCourse',
  kind: 'mutation',
  path: 'admin.duplicateCourse',
  access: WRITE,
  refusals: { ...COURSE_NOT_FOUND, 'academy.course_slug_taken': 'CONFLICT' },
  input: academyDuplicateCourseInputSchema,
  output: academyCourseSchema,
  samples: [
    { verdict: 'accept', input: { courseId: ID, slug: 'a-copy', title: 'A copy', reason: REASON } },
    { verdict: 'refuse', input: { courseId: ID, slug: 'a-copy', title: 'A copy', reason: '' } },
  ],
});

export const ACADEMY_ADMIN_UPDATE_COURSE = defineProcedure({
  ...base,
  name: 'academy.admin.updateCourse',
  kind: 'mutation',
  path: 'admin.updateCourse',
  access: WRITE,
  refusals: { ...COURSE_EDIT, 'academy.price_unset': 'PRECONDITION_FAILED' },
  input: academyUpdateCourseInputSchema,
  output: academyCourseSchema,
  checks: PRICING_CHECK,
  samples: [
    { verdict: 'accept', input: { ...COURSE_FIELDS, courseId: ID, revision: 1 } },
    { verdict: 'refuse', input: { ...COURSE_FIELDS, courseId: ID, revision: 0 } },
    { verdict: 'refuse', by: 'pricing_holds', input: { ...COURSE_FIELDS, courseId: ID, revision: 1, price: '5' } },
    {
      verdict: 'refuse',
      by: 'has_nonzero_digit',
      input: { ...COURSE_FIELDS, courseId: ID, revision: 1, pricing: 'paid', price: '0.0', priceAsset: 'USDT' },
    },
  ],
});

export const ACADEMY_ADMIN_SET_COURSE_STATE = defineProcedure({
  ...base,
  name: 'academy.admin.setCourseState',
  kind: 'mutation',
  path: 'admin.setCourseState',
  access: WRITE,
  refusals: {
    ...COURSE_EDIT,
    'academy.course_outline_empty': 'PRECONDITION_FAILED',
    'academy.item_transition_illegal': 'CONFLICT',
    'academy.price_unset': 'PRECONDITION_FAILED',
  },
  input: academySetCourseStateInputSchema,
  output: academyCourseSchema,
  samples: [
    { verdict: 'accept', input: { courseId: ID, to: 'published', revision: 1, reason: REASON } },
    { verdict: 'refuse', input: { courseId: ID, to: 'draft', revision: 1, reason: REASON } },
  ],
});

export const ACADEMY_ADMIN_SAVE_OUTLINE = defineProcedure({
  ...base,
  name: 'academy.admin.saveOutline',
  kind: 'mutation',
  path: 'admin.saveOutline',
  access: WRITE,
  refusals: {
    ...COURSE_EDIT,
    'academy.assignment_has_submissions': 'CONFLICT',
    'academy.item_has_attempts': 'CONFLICT',
    'academy.item_kind_locked': 'CONFLICT',
    'academy.outline_item_unknown': 'CONFLICT',
    'academy.outline_limits_unset': 'PRECONDITION_FAILED',
    'academy.outline_too_large': 'BAD_REQUEST',
  },
  input: academySaveOutlineInputSchema,
  output: academyCourseDetailSchema,
  checks: { link_has_url: { at: 'input.sections[].items[]', says: 'a link item has an https address, and only a link has one' } },
  samples: [
    {
      verdict: 'accept',
      input: { courseId: ID, revision: 1, sections: [{ title: 'One', items: [{ kind: 'lesson', title: 'First', indent: 0, url: null }] }] },
    },
    { verdict: 'refuse', input: { courseId: ID, revision: 1, sections: [{ title: '', items: [] }] } },
    {
      verdict: 'refuse',
      by: 'link_has_url',
      input: { courseId: ID, revision: 1, sections: [{ title: 'One', items: [{ kind: 'link', title: 'A link', indent: 0, url: null }] }] },
    },
  ],
});

// ── Course quiz trail (assessment/quizzes.rs, trail.rs, analytics.rs) ───────────────────────────────────────────────
const QUIZ_NOT_FOUND = { 'academy.quiz_not_found': 'NOT_FOUND' } as const;
const QUIZ_CHANGE = {
  ...QUIZ_NOT_FOUND,
  'academy.assessment_invalid': 'BAD_REQUEST',
  'academy.attempt_not_found': 'NOT_FOUND',
  'academy.attempt_closed': 'CONFLICT',
  'academy.revision_stale': 'CONFLICT',
} as const;
/**
 * A staff read of a quiz: each question's fields are checked by the reply schema, and the rules between them by `accept`,
 * since JSON Schema cannot say them.
 */
const QUIZ_OUT = academyAdminCourseQuizSchema.extend({ questions: z.array(academyCourseQuizQuestionShape) });
const QUESTION_RULES =
  'every question holds the question rules: unique choice ids, keys among the choices, partial credit that splits, a tolerance not negative';
const QUIZ_RULES = {
  question_rules: {
    says: QUESTION_RULES,
    holds: (reply: unknown) => {
      const quiz = QUIZ_OUT.safeParse(reply);
      return quiz.success && quiz.data.questions.every((q) => academyCourseQuizQuestionSchema.safeParse(q).success);
    },
  },
} as const;

const QUIZ_IN = [
  { verdict: 'accept', input: { itemId: ID } },
  { verdict: 'refuse', input: { itemId: NOT_ID } },
] as const;

export const ACADEMY_ADMIN_COURSE_QUIZ = defineProcedure({
  ...base,
  name: 'academy.admin.courseQuiz',
  kind: 'query',
  path: 'admin.courseQuiz',
  access: READ,
  refusals: QUIZ_NOT_FOUND,
  input: academyCourseQuizInputSchema,
  output: QUIZ_OUT,
  accept: QUIZ_RULES,
  samples: QUIZ_IN,
});

export const ACADEMY_ADMIN_COURSE_QUIZ_ATTEMPTS = defineProcedure({
  ...base,
  name: 'academy.admin.courseQuizAttempts',
  kind: 'query',
  path: 'admin.courseQuizAttempts',
  access: READ,
  refusals: QUIZ_NOT_FOUND,
  input: academyCourseQuizInputSchema,
  output: academyCourseQuizAttemptsSchema,
  samples: QUIZ_IN,
});

export const ACADEMY_ADMIN_COURSE_QUIZ_ANALYTICS = defineProcedure({
  ...base,
  name: 'academy.admin.courseQuizAnalytics',
  kind: 'query',
  path: 'admin.courseQuizAnalytics',
  access: READ,
  refusals: { ...QUIZ_NOT_FOUND, 'academy.permission_denied': 'FORBIDDEN' },
  input: academyCourseQuizInputSchema,
  output: academyCourseQuizAnalyticsSchema,
  samples: QUIZ_IN,
});

export const ACADEMY_ADMIN_COURSE_QUIZ_ANSWERS = defineProcedure({
  ...base,
  name: 'academy.admin.courseQuizAnswers',
  kind: 'query',
  path: 'admin.courseQuizAnswers',
  access: READ,
  refusals: { ...QUIZ_NOT_FOUND, 'academy.permission_denied': 'FORBIDDEN' },
  input: academyCourseQuizInputSchema,
  output: academyCourseQuizAnswersSchema,
  samples: QUIZ_IN,
});

export const ACADEMY_ADMIN_CURVE_COURSE_QUIZ = defineProcedure({
  ...base,
  name: 'academy.admin.curveCourseQuiz',
  kind: 'mutation',
  path: 'admin.curveCourseQuiz',
  access: WRITE,
  refusals: {
    ...QUIZ_CHANGE,
    'academy.bulk_file_invalid': 'BAD_REQUEST',
    'academy.bulk_file_too_large': 'BAD_REQUEST',
    'academy.bulk_limit_unset': 'PRECONDITION_FAILED',
  },
  input: academyCurveCourseQuizInputSchema,
  output: academyCurveCourseQuizResultSchema,
  samples: [
    { verdict: 'accept', input: { itemId: ID, fileName: 'curve.csv', csv: 'attempt,points\n', dryRun: true, reason: REASON } },
    { verdict: 'refuse', input: { itemId: ID, fileName: 'curve.csv', csv: '', dryRun: true, reason: REASON } },
  ],
});

export const ACADEMY_ADMIN_FIX_COURSE_QUIZ_KEY = defineProcedure({
  ...base,
  name: 'academy.admin.fixCourseQuizKey',
  kind: 'mutation',
  path: 'admin.fixCourseQuizKey',
  access: WRITE,
  refusals: { ...QUIZ_CHANGE, 'academy.key_fix_invalid': 'BAD_REQUEST' },
  input: academyFixCourseQuizKeyInputSchema,
  output: QUIZ_OUT,
  accept: QUIZ_RULES,
  checks: { question_rules: { at: 'input.questions[]', says: QUESTION_RULES } },
  samples: [
    {
      verdict: 'accept',
      input: { itemId: ID, revision: 1, questions: [{ kind: 'essay', id: 'q1', prompt: 'Why?', points: 1 }], reason: REASON },
    },
    {
      verdict: 'refuse',
      input: { itemId: ID, revision: 1, questions: [{ kind: 'essay', id: 'q1', prompt: 'Why?', points: 0 }], reason: REASON },
    },
    {
      verdict: 'refuse',
      by: 'question_rules',
      input: {
        itemId: ID,
        revision: 1,
        questions: [
          {
            kind: 'single',
            id: 'q1',
            prompt: 'Which?',
            points: 1,
            choices: [
              { id: 'a', text: 'A' },
              { id: 'b', text: 'B' },
            ],
            correctChoiceId: 'c',
          },
        ],
        reason: REASON,
      },
    },
  ],
});

export const ACADEMY_ADMIN_OVERRIDE_COURSE_QUIZ_SCORE = defineProcedure({
  ...base,
  name: 'academy.admin.overrideCourseQuizScore',
  kind: 'mutation',
  path: 'admin.overrideCourseQuizScore',
  access: WRITE,
  refusals: QUIZ_CHANGE,
  input: academyOverrideCourseQuizScoreInputSchema,
  output: academyCourseQuizAttemptsSchema,
  samples: [
    { verdict: 'accept', input: { itemId: ID, attemptId: ID, questionId: 'q1', points: 1, n: 1, comment: null, reason: REASON } },
    { verdict: 'refuse', input: { itemId: ID, attemptId: ID, questionId: 'q1', points: -1, n: 1, comment: null, reason: REASON } },
  ],
});

export const ACADEMY_ADMIN_RESCORE_COURSE_QUIZ = defineProcedure({
  ...base,
  name: 'academy.admin.rescoreCourseQuiz',
  kind: 'mutation',
  path: 'admin.rescoreCourseQuiz',
  access: WRITE,
  refusals: QUIZ_CHANGE,
  input: academyRescoreCourseQuizInputSchema,
  output: academyRescoreCourseQuizResultSchema,
  samples: [
    { verdict: 'accept', input: { itemId: ID, reason: REASON } },
    { verdict: 'refuse', input: { itemId: ID, reason: '' } },
  ],
});

// ── Certificate designs and issue rules (certs/designs.rs, issue_rules.rs) ──────────────────────────────────────────
const CERT_NOT_FOUND = { 'academy.cert_not_found': 'NOT_FOUND' } as const;
const CERT_ID = 'cert-1';
const NOTHING_IN = [
  { verdict: 'accept', input: {} },
  { verdict: 'refuse', input: { extra: 1 } },
] as const;

export const ACADEMY_ADMIN_CERT_DESIGNS = defineProcedure({
  ...base,
  name: 'academy.admin.certDesigns',
  kind: 'query',
  path: 'admin.certDesigns',
  access: READ,
  refusals: NONE,
  input: z.object({}).strict().optional(),
  output: academyCertDesignsSchema,
  samples: NOTHING_IN,
});

export const ACADEMY_ADMIN_CERT_ISSUE_RULE = defineProcedure({
  ...base,
  name: 'academy.admin.certIssueRule',
  kind: 'query',
  path: 'admin.certIssueRule',
  access: READ,
  refusals: { ...CERT_NOT_FOUND, 'academy.cert_invalid': 'BAD_REQUEST' },
  input: z.object({ certId: academyCertIdSchema }),
  output: academyCertIssueRuleSchema.nullable(),
  samples: [
    { verdict: 'accept', input: { certId: CERT_ID } },
    { verdict: 'refuse', input: { certId: '' } },
  ],
});

export const ACADEMY_ADMIN_SET_CERT_ISSUE_RULE = defineProcedure({
  ...base,
  name: 'academy.admin.setCertIssueRule',
  kind: 'mutation',
  path: 'admin.setCertIssueRule',
  access: WRITE,
  refusals: {
    ...CERT_NOT_FOUND,
    'academy.cert_delay_unset': 'PRECONDITION_FAILED',
    'academy.cert_invalid': 'BAD_REQUEST',
    'academy.cert_sweep_unset': 'PRECONDITION_FAILED',
  },
  input: academySetCertIssueRuleInputSchema,
  output: academyCertIssueRuleSchema,
  checks: { only_delayed_has_delay: { at: 'input', says: 'a delayed rule has a delay, and no other rule has one' } },
  samples: [
    { verdict: 'accept', input: { certId: CERT_ID, mode: 'manual', delayMinutes: null, reason: REASON } },
    { verdict: 'refuse', input: { certId: CERT_ID, mode: 'never', delayMinutes: null, reason: REASON } },
    { verdict: 'refuse', by: 'only_delayed_has_delay', input: { certId: CERT_ID, mode: 'manual', delayMinutes: 5, reason: REASON } },
  ],
});

export const ACADEMY_ADMIN_ISSUED_CERTS = defineProcedure({
  ...base,
  name: 'academy.admin.issuedCerts',
  kind: 'query',
  path: 'admin.issuedCerts',
  access: READ,
  refusals: NONE,
  input: academyIssuedCertsInputSchema,
  output: academyIssuedCertsSchema,
  samples: [
    { verdict: 'accept', input: { certificate: null } },
    { verdict: 'refuse', input: { certificate: '' } },
  ],
});

export const ACADEMY_ADMIN_CERT_EXPORTS = defineProcedure({
  ...base,
  name: 'academy.admin.certExports',
  kind: 'query',
  path: 'admin.certExports',
  access: READ,
  refusals: NONE,
  input: z.object({}).strict().optional(),
  output: academyCertExportsSchema,
  samples: NOTHING_IN,
});

export const ACADEMY_ADMIN_CERT_EXPORT_FILE = defineProcedure({
  ...base,
  name: 'academy.admin.certExportFile',
  kind: 'query',
  path: 'admin.certExportFile',
  access: READ,
  refusals: NONE,
  input: academyMakeCertExportInputSchema,
  output: academyCertExportFileSchema,
  samples: [
    { verdict: 'accept', input: { n: 1 } },
    { verdict: 'refuse', input: { n: 0 } },
  ],
});

export const ACADEMY_ADMIN_MAKE_CERT_EXPORT = defineProcedure({
  ...base,
  name: 'academy.admin.makeCertExport',
  kind: 'mutation',
  path: 'admin.makeCertExport',
  access: COMPLIANCE,
  refusals: NONE,
  input: academyMakeCertExportInputSchema,
  output: academyCertExportSchema,
  samples: [
    { verdict: 'accept', input: { n: 1 } },
    { verdict: 'refuse', input: { n: 0 } },
  ],
});

export const ACADEMY_ADMIN_SAVE_CERT_DESIGN = defineProcedure({
  ...base,
  name: 'academy.admin.saveCertDesign',
  kind: 'mutation',
  path: 'admin.saveCertDesign',
  access: COMPLIANCE,
  refusals: CERT_NOT_FOUND,
  input: academySaveCertDesignInputSchema,
  output: academySaveCertDesignResultSchema,
  samples: [
    {
      verdict: 'accept',
      input: {
        certId: CERT_ID,
        revision: 0,
        title: 'A certificate',
        body: 'Awarded for the course.',
        signatories: [{ name: 'A Name', role: 'Director' }],
        disclaimer: null,
        language: 'en',
        size: 'a4',
        effortHours: null,
        reason: REASON,
      },
    },
    {
      verdict: 'refuse',
      input: {
        certId: CERT_ID,
        revision: 0,
        title: 'A certificate',
        body: 'Awarded for the course.',
        signatories: [],
        disclaimer: null,
        language: 'english',
        size: 'a4',
        effortHours: null,
        reason: REASON,
      },
    },
  ],
});

export const ACADEMY_ADMIN_ACTIVATE_CERT_DESIGN = defineProcedure({
  ...base,
  name: 'academy.admin.activateCertDesign',
  kind: 'mutation',
  path: 'admin.activateCertDesign',
  access: COMPLIANCE,
  refusals: CERT_NOT_FOUND,
  input: academyActivateCertDesignInputSchema,
  output: academyCertDesignSchema,
  samples: [
    { verdict: 'accept', input: { certId: CERT_ID, revision: 1, reason: REASON } },
    { verdict: 'refuse', input: { certId: CERT_ID, revision: 0, reason: REASON } },
  ],
});

export const ACADEMY_ADMIN_DEACTIVATE_CERT_DESIGN = defineProcedure({
  ...base,
  name: 'academy.admin.deactivateCertDesign',
  kind: 'mutation',
  path: 'admin.deactivateCertDesign',
  access: COMPLIANCE,
  refusals: CERT_NOT_FOUND,
  input: academyDeactivateCertDesignInputSchema,
  output: academyCertDesignSchema,
  samples: [
    { verdict: 'accept', input: { certId: CERT_ID, reason: REASON } },
    { verdict: 'refuse', input: { certId: CERT_ID, reason: '' } },
  ],
});

// ── Staff enrolment, invitations, course email and learner exports (community/staff_enrolment.rs) ───────────────────
const PATH = 'foundations';
const HISTORY_IN = [
  { verdict: 'accept', input: { path: PATH } },
  { verdict: 'refuse', input: { path: 'nowhere' } },
] as const;

export const ACADEMY_ADMIN_STAFF_ENROLMENTS = defineProcedure({
  ...base,
  name: 'academy.admin.staffEnrolments',
  kind: 'query',
  path: 'admin.staffEnrolments',
  access: READ,
  refusals: NONE,
  input: academyStaffEnrolmentsInputSchema.optional(),
  output: academyStaffEnrolmentsSchema,
  samples: HISTORY_IN,
});

export const ACADEMY_ADMIN_COURSE_INVITATIONS = defineProcedure({
  ...base,
  name: 'academy.admin.courseInvitations',
  kind: 'query',
  path: 'admin.courseInvitations',
  access: READ,
  refusals: NONE,
  input: academyCourseInvitationsInputSchema.optional(),
  output: academyCourseInvitationsSchema,
  samples: HISTORY_IN,
});

export const ACADEMY_ADMIN_BULK_EMAILS = defineProcedure({
  ...base,
  name: 'academy.admin.bulkEmails',
  kind: 'query',
  path: 'admin.bulkEmails',
  access: READ,
  refusals: NONE,
  input: academyBulkEmailsInputSchema.optional(),
  output: academyBulkEmailsSchema,
  samples: HISTORY_IN,
});

export const ACADEMY_ADMIN_BULK_EMAIL = defineProcedure({
  ...base,
  name: 'academy.admin.bulkEmail',
  kind: 'query',
  path: 'admin.bulkEmail',
  access: READ,
  refusals: NONE,
  input: academyBulkEmailInputSchema,
  output: academyBulkEmailDetailSchema,
  samples: [
    { verdict: 'accept', input: { id: ID } },
    { verdict: 'refuse', input: { id: NOT_ID } },
  ],
});

export const ACADEMY_ADMIN_REPORT_TASKS = defineProcedure({
  ...base,
  name: 'academy.admin.reportTasks',
  kind: 'query',
  path: 'admin.reportTasks',
  access: READ,
  refusals: NONE,
  input: NO_INPUT,
  output: academyReportTasksSchema,
  samples: [{ verdict: 'accept' }],
});

export const ACADEMY_ADMIN_REPORT_FILE = defineProcedure({
  ...base,
  name: 'academy.admin.reportFile',
  kind: 'query',
  path: 'admin.reportFile',
  access: READ,
  refusals: NONE,
  input: academyReportFileInputSchema,
  output: academyReportFileSchema,
  samples: [
    { verdict: 'accept', input: { id: ID } },
    { verdict: 'refuse', input: { id: NOT_ID } },
  ],
});

export const ACADEMY_ADMIN_STAFF_ENROL = defineProcedure({
  ...base,
  name: 'academy.admin.staffEnrol',
  kind: 'mutation',
  path: 'admin.staffEnrol',
  access: WRITE,
  refusals: NONE,
  input: academyStaffEnrolInputSchema,
  output: academyStaffEnrolSchema,
  samples: [
    { verdict: 'accept', input: { path: PATH, userId: ID, reason: REASON } },
    { verdict: 'refuse', input: { path: PATH, userId: NOT_ID, reason: REASON } },
  ],
});

export const ACADEMY_ADMIN_BULK_ENROL = defineProcedure({
  ...base,
  name: 'academy.admin.bulkEnrol',
  kind: 'mutation',
  path: 'admin.bulkEnrol',
  access: WRITE,
  refusals: NONE,
  input: academyBulkEnrolInputSchema,
  output: academyBulkEnrolSchema,
  samples: [
    { verdict: 'accept', input: { path: PATH, rows: [{ address: 'a@example.com', userId: null }], reason: REASON } },
    { verdict: 'refuse', input: { path: PATH, rows: [], reason: REASON } },
  ],
});

export const ACADEMY_ADMIN_INVITE_TO_COURSE = defineProcedure({
  ...base,
  name: 'academy.admin.inviteToCourse',
  kind: 'mutation',
  path: 'admin.inviteToCourse',
  access: WRITE,
  refusals: NONE,
  input: academyInviteToCourseInputSchema,
  output: academyInviteToCourseSchema,
  samples: [
    { verdict: 'accept', input: { path: PATH, address: 'a@example.com', reason: REASON } },
    { verdict: 'refuse', input: { path: 'nowhere', address: 'a@example.com', reason: REASON } },
  ],
});

export const ACADEMY_ADMIN_SEND_BULK_EMAIL = defineProcedure({
  ...base,
  name: 'academy.admin.sendBulkEmail',
  kind: 'mutation',
  path: 'admin.sendBulkEmail',
  access: WRITE,
  refusals: NONE,
  input: academySendBulkEmailInputSchema,
  output: academySendBulkEmailSchema,
  samples: [
    { verdict: 'accept', input: { path: PATH, subject: 'Hello', body: 'Welcome.', key: 'sample' } },
    { verdict: 'refuse', input: { path: PATH, subject: 'Hello', body: 'Welcome.', key: '' } },
  ],
});

export const ACADEMY_ADMIN_REQUEST_LEARNER_EXPORT = defineProcedure({
  ...base,
  name: 'academy.admin.requestLearnerExport',
  kind: 'mutation',
  path: 'admin.requestLearnerExport',
  access: WRITE,
  refusals: NONE,
  input: academyRequestLearnerExportInputSchema,
  output: academyRequestLearnerExportSchema,
  samples: [
    { verdict: 'accept', input: { tag: null, key: 'sample' } },
    { verdict: 'refuse', input: { tag: 'Not A Tag', key: 'sample' } },
  ],
});

// ── Learner tags (community/learner_desk.rs) ────────────────────────────────────────────────────────────────────────
export const ACADEMY_ADMIN_LEARNER_TAGS = defineProcedure({
  ...base,
  name: 'academy.admin.learnerTags',
  kind: 'query',
  path: 'admin.learnerTags',
  access: READ,
  refusals: NONE,
  input: NO_INPUT,
  output: academyLearnerTagsSchema,
  samples: [{ verdict: 'accept' }],
});

export const ACADEMY_ADMIN_TAG_LEARNERS = defineProcedure({
  ...base,
  name: 'academy.admin.tagLearners',
  kind: 'mutation',
  path: 'admin.tagLearners',
  // The learner desk's changes take the read scope (`calls.rs`), as the TypeScript router served them.
  access: READ,
  refusals: { 'academy.reason_required': 'BAD_REQUEST' },
  input: academyTagLearnersInputSchema,
  output: z.object({ added: z.number().int().nonnegative() }),
  samples: [
    { verdict: 'accept', input: { userIds: [ID], tag: 'cohort-1', reason: REASON } },
    { verdict: 'refuse', input: { userIds: [], tag: 'cohort-1', reason: REASON } },
  ],
});

// ── Numbers and the reports centre (community/metrics.rs, analytics.rs) ─────────────────────────────────────────────
export const ACADEMY_ADMIN_OPS_METRICS = defineProcedure({
  ...base,
  name: 'academy.admin.opsMetrics',
  kind: 'query',
  path: 'admin.opsMetrics',
  access: READ,
  refusals: { 'academy.metrics_range_invalid': 'BAD_REQUEST', 'academy.path_not_found': 'NOT_FOUND' },
  input: z.object({ from: z.string(), to: z.string() }),
  output: academyOpsMetricsSchema,
  samples: [
    { verdict: 'accept', input: { from: '2026-11-01', to: '2026-11-19' } },
    { verdict: 'refuse', input: { from: '2026-11-01' } },
  ],
});

export const ACADEMY_ADMIN_LEARNER_SUMMARIES = defineProcedure({
  ...base,
  name: 'academy.admin.learnerSummaries',
  kind: 'query',
  path: 'admin.learnerSummaries',
  access: READ,
  refusals: NONE,
  input: academyLearnerSummariesInputSchema,
  output: academyLearnerSummariesSchema,
  samples: [
    { verdict: 'accept', input: {} },
    { verdict: 'refuse', input: { after: NOT_ID } },
  ],
});

const TASK_IN = [
  { verdict: 'accept', input: { taskId: ID } },
  { verdict: 'refuse', input: { taskId: NOT_ID } },
] as const;

export const ACADEMY_ADMIN_REPORT_CENTRE_TASKS = defineProcedure({
  ...base,
  name: 'academy.admin.reportCentreTasks',
  kind: 'query',
  path: 'admin.reportCentreTasks',
  access: READ,
  refusals: NONE,
  input: NO_INPUT,
  output: academyReportCentreTasksSchema,
  samples: [{ verdict: 'accept' }],
});

export const ACADEMY_ADMIN_REPORT_CENTRE_FILE = defineProcedure({
  ...base,
  name: 'academy.admin.reportCentreFile',
  kind: 'query',
  path: 'admin.reportCentreFile',
  access: READ,
  refusals: NONE,
  input: academyReportTaskInputSchema,
  output: academyReportCentreFileSchema,
  samples: TASK_IN,
});

export const ACADEMY_ADMIN_REQUEST_REPORT = defineProcedure({
  ...base,
  name: 'academy.admin.requestReport',
  kind: 'mutation',
  path: 'admin.requestReport',
  access: WRITE,
  refusals: NONE,
  input: academyRequestReportInputSchema,
  output: academyReportCentreTaskSchema,
  samples: [
    { verdict: 'accept', input: { kind: 'learners', tag: null, n: 1 } },
    { verdict: 'refuse', input: { kind: 'learners', tag: null, n: 0 } },
  ],
});

export const ACADEMY_ADMIN_ABORT_REPORT = defineProcedure({
  ...base,
  name: 'academy.admin.abortReport',
  kind: 'mutation',
  path: 'admin.abortReport',
  access: WRITE,
  refusals: NONE,
  input: academyReportTaskInputSchema,
  output: academyReportCentreTaskSchema,
  samples: TASK_IN,
});

export const ACADEMY_ADMIN_DELETE_REPORT = defineProcedure({
  ...base,
  name: 'academy.admin.deleteReport',
  kind: 'mutation',
  path: 'admin.deleteReport',
  access: WRITE,
  refusals: NONE,
  input: academyReportTaskInputSchema,
  output: academyReportDeletedSchema,
  samples: TASK_IN,
});
