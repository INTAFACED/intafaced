import { z } from 'zod';
import { defineProcedure, NO_INPUT } from './procedure.js';
import {
  academyAdminAssignmentSchema,
  academyAssistantDraftInputSchema,
  academyBulkGradeInputSchema,
  academyBulkGradeResultSchema,
  academyClearFeaturedInputSchema,
  academyConfirmMediaInputSchema,
  academyCourseIdInputSchema,
  academyCourseLearnerViewSchema,
  academyCreatedPrivateLinkSchema,
  academyCreatePrivateLinkInputSchema,
  academyCreateTopicInputSchema,
  academyDecideDraftInputSchema,
  academyDuplicateItemInputSchema,
  academyFeaturedSlotSchema,
  academyFeatureLessonInputSchema,
  academyGradingQueueInputSchema,
  academyGradingQueueSchema,
  academyImportLessonInputSchema,
  academyImportLessonResultSchema,
  academyItemMediaSchema,
  academyLessonSchema,
  academyMediaSchema,
  academyOpenGradingInputSchema,
  academyPrivateLinkListSchema,
  academyPrivateLinkSchema,
  academyPublishLessonInputSchema,
  academyRevertLessonInputSchema,
  academyRevokePrivateLinkInputSchema,
  academySaveLessonInputSchema,
  academyTopicSchema,
  academyWithdrawAssignmentInputSchema,
  academyWithdrawLessonInputSchema,
} from './academy-courses.js';
import { academyCourseGradebookInputSchema, academyCourseGradebookSchema } from './academy-course-gradebook.js';
import {
  academyGradeReportFileInputSchema,
  academyGradeReportFileSchema,
  academyGradeReportSchema,
  academyGradeReportsSchema,
  academyMakeGradeReportInputSchema,
} from './academy-grade-reports.js';
import {
  academyCourseItemRulesInputSchema,
  academyCourseItemRulesSchema,
  academyGrantCourseExtensionInputSchema,
  academySetCourseItemPrerequisitesInputSchema,
} from './academy-course-item-rules.js';
import {
  academyAddLearnerNoteInputSchema,
  academyGrantAccessInputSchema,
  academyGrantLearnerExtensionInputSchema,
  academyLearnerChangeSchema,
  academyLearnerInputSchema,
  academyLearnerPageSchema,
  academyLearnerProgressSchema,
  academyLearnersInputSchema,
  academyLearnersSchema,
  academyMarkCompleteForInputSchema,
  academyReinstateAccessInputSchema,
  academyUntagLearnerInputSchema,
  academyVoidQuizAttemptInputSchema,
} from './academy-learner-desk.js';
import {
  academyAdminCourseQuizSchema,
  academyCourseQuizInputSchema,
  academyCourseQuizReviewsSchema,
  academyScoreCourseQuizEssaysInputSchema,
  academySetCourseQuizStateInputSchema,
} from './academy-course-quizzes.js';
import {
  academyCourseReleaseInputSchema,
  academyCourseReleaseSchema,
  academySetCoursePacingInputSchema,
  academySetSectionReleaseInputSchema,
} from './academy-course-release.js';
import {
  academyRoleSchema,
  academyRolesSchema,
  academySetCustomRoleActiveInputSchema,
  academyModerationQueueInputSchema,
  academyModerationQueueSchema,
  academyCourseTeamInputSchema,
  academyCourseTeamSchema,
  academyDeleteDiscussionPostInputSchema,
  academyModerationResultSchema,
  academyBulkDeleteUserPostsInputSchema,
  academyProposeTeamChangeInputSchema,
  academyTeamChangeSchema,
  academyConfirmTeamChangeInputSchema,
} from './academy-team.js';
import { academyGrantCertExceptionInputSchema, academyCertExceptionSchema } from './academy-certificates.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-academy `admin.*`, one record per call: svc-academy mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-academy', module: 'academy', transport: 'trpc' } as const;

/** AC-assignments-01: an assignment item's brief, who saved it, and how many learners handed in. */
export const ACADEMY_ADMIN_ASSIGNMENT = defineProcedure({
  ...base,
  name: 'academy.admin.assignment',
  kind: 'query',
  path: 'admin.assignment',
  access: { caller: 'scope', scope: 'admin:read', module: 'academy' },
  refusals: { 'academy.assignment_not_found': 'NOT_FOUND', 'academy.outline_item_unknown': 'CONFLICT' },
  input: z.object({ itemId: z.string().guid() }).strict(),
  output: academyAdminAssignmentSchema,
  outputChecks: {
    academy_points_holds: { at: 'output.brief.points', says: 'points are more than zero' },
    academy_rubric_criterion_holds: { at: 'output.review.rubric.criteria[]', says: 'levels go up, with no two alike' },
  },
  samples: [
    { verdict: 'accept', input: { itemId: '33333333-3333-4333-8333-333333333333' } },
    { verdict: 'refuse', input: 42 },
  ],
});

/** AC-assignments-01: learners can no longer hand in; the brief and every hand-in stay. */
export const ACADEMY_ADMIN_WITHDRAW_ASSIGNMENT = defineProcedure({
  ...base,
  name: 'academy.admin.withdrawAssignment',
  kind: 'mutation',
  path: 'admin.withdrawAssignment',
  access: { caller: 'scope', scope: 'admin:write', module: 'academy' },
  refusals: { 'academy.assignment_not_found': 'NOT_FOUND', 'academy.outline_item_unknown': 'CONFLICT' },
  input: academyWithdrawAssignmentInputSchema,
  output: academyAdminAssignmentSchema,
  outputChecks: {
    academy_points_holds: { at: 'output.brief.points', says: 'points are more than zero' },
    academy_rubric_criterion_holds: { at: 'output.review.rubric.criteria[]', says: 'levels go up, with no two alike' },
  },
  samples: [
    { verdict: 'accept', input: { itemId: '33333333-3333-4333-8333-333333333333', reason: 'placeholder' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const ACADEMY_ADMIN_COURSE_GRADE_REPORTS = defineProcedure({
  ...base,
  name: 'academy.admin.courseGradeReports',
  kind: 'query',
  path: 'admin.courseGradeReports',
  access: { caller: 'scope', scope: 'admin:read', module: 'academy' },
  refusals: {},
  input: academyCourseGradebookInputSchema,
  output: academyGradeReportsSchema,
  samples: [
    { verdict: 'accept', input: { courseId: '33333333-3333-4333-8333-333333333333' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const ACADEMY_ADMIN_GRADE_REPORT_FILE = defineProcedure({
  ...base,
  name: 'academy.admin.gradeReportFile',
  kind: 'query',
  path: 'admin.gradeReportFile',
  access: { caller: 'scope', scope: 'admin:read', module: 'academy' },
  refusals: {},
  input: academyGradeReportFileInputSchema,
  output: academyGradeReportFileSchema,
  samples: [
    { verdict: 'accept', input: { courseId: '33333333-3333-4333-8333-333333333333', n: 1 } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const ACADEMY_ADMIN_MAKE_GRADE_REPORT = defineProcedure({
  ...base,
  name: 'academy.admin.makeGradeReport',
  kind: 'mutation',
  path: 'admin.makeGradeReport',
  access: { caller: 'scope', scope: 'admin:write', module: 'academy' },
  refusals: {},
  input: academyMakeGradeReportInputSchema,
  output: academyGradeReportSchema,
  samples: [
    { verdict: 'accept', input: { courseId: '33333333-3333-4333-8333-333333333333', n: 1 } },
    { verdict: 'refuse', input: 42 },
  ],
});

/** AC-assignments-02: each learner's newest hand-in under an alias, with its peer reviews, grade and lease. */
export const ACADEMY_ADMIN_GRADING_QUEUE = defineProcedure({
  ...base,
  name: 'academy.admin.gradingQueue',
  kind: 'query',
  path: 'admin.gradingQueue',
  access: { caller: 'scope', scope: 'admin:read', module: 'academy' },
  refusals: { 'academy.assignment_not_found': 'NOT_FOUND', 'academy.outline_item_unknown': 'CONFLICT' },
  input: academyGradingQueueInputSchema,
  output: academyGradingQueueSchema,
  samples: [
    { verdict: 'accept', input: { itemId: '33333333-3333-4333-8333-333333333333' } },
    { verdict: 'refuse', input: 42 },
  ],
});

/** AC-assignments-02: take or renew the caller's grader lease on one hand-in. */
export const ACADEMY_ADMIN_OPEN_GRADING = defineProcedure({
  ...base,
  name: 'academy.admin.openGrading',
  kind: 'mutation',
  path: 'admin.openGrading',
  access: { caller: 'scope', scope: 'admin:write', module: 'academy' },
  refusals: {
    'academy.assignment_closed': 'CONFLICT',
    'academy.assignment_not_found': 'NOT_FOUND',
    'academy.grader_lease_unset': 'PRECONDITION_FAILED',
    'academy.grader_locked': 'CONFLICT',
    'academy.outline_item_unknown': 'CONFLICT',
    'academy.submission_not_found': 'NOT_FOUND',
  },
  input: academyOpenGradingInputSchema,
  output: academyGradingQueueSchema,
  samples: [
    { verdict: 'accept', input: { itemId: '33333333-3333-4333-8333-333333333333', submissionId: '33333333-3333-4333-8333-333333333333' } },
    { verdict: 'refuse', input: 42 },
  ],
});

/** AC-assignments-02: a CSV of grades by alias; good rows apply, bad rows are listed, the same file changes nothing. */
export const ACADEMY_ADMIN_BULK_GRADE = defineProcedure({
  ...base,
  name: 'academy.admin.bulkGrade',
  kind: 'mutation',
  path: 'admin.bulkGrade',
  access: { caller: 'scope', scope: 'admin:write', module: 'academy' },
  refusals: {
    'academy.assignment_closed': 'CONFLICT',
    'academy.assignment_not_found': 'NOT_FOUND',
    'academy.bulk_file_invalid': 'BAD_REQUEST',
    'academy.grade_invalid': 'BAD_REQUEST',
    'academy.grader_lease_unset': 'PRECONDITION_FAILED',
    'academy.grader_locked': 'CONFLICT',
    'academy.outline_item_unknown': 'CONFLICT',
    'academy.reason_required': 'BAD_REQUEST',
    'academy.submission_not_found': 'NOT_FOUND',
  },
  input: academyBulkGradeInputSchema,
  output: academyBulkGradeResultSchema,
  samples: [
    { verdict: 'accept', input: { itemId: '33333333-3333-4333-8333-333333333333', fileName: 'placeholder', csv: 'placeholder' } },
    { verdict: 'refuse', input: 42 },
  ],
});

/** AC-articles-01: the Learn hub's featured slot as staff left it. */
export const ACADEMY_ADMIN_FEATURED_SLOT = defineProcedure({
  ...base,
  name: 'academy.admin.featuredSlot',
  kind: 'query',
  path: 'admin.featuredSlot',
  access: { caller: 'scope', scope: 'admin:read', module: 'academy' },
  refusals: { 'academy.slug_reserved': 'BAD_REQUEST' },
  input: NO_INPUT,
  output: academyFeaturedSlotSchema,
  samples: [{ verdict: 'accept' }],
});

/** AC-articles-01: nothing is featured, with a reason. */
export const ACADEMY_ADMIN_CLEAR_FEATURED = defineProcedure({
  ...base,
  name: 'academy.admin.clearFeatured',
  kind: 'mutation',
  path: 'admin.clearFeatured',
  access: { caller: 'scope', scope: 'admin:write', module: 'academy' },
  refusals: { 'academy.slug_reserved': 'BAD_REQUEST' },
  input: academyClearFeaturedInputSchema,
  output: academyFeaturedSlotSchema,
  samples: [
    { verdict: 'accept', input: { reason: 'placeholder' } },
    { verdict: 'refuse', input: 42 },
  ],
});

/** AC-articles-01: a topic keyed by its address; an Academy tab's address refuses `academy.slug_reserved`. */
export const ACADEMY_ADMIN_CREATE_TOPIC = defineProcedure({
  ...base,
  name: 'academy.admin.createTopic',
  kind: 'mutation',
  path: 'admin.createTopic',
  access: { caller: 'scope', scope: 'admin:write', module: 'academy' },
  refusals: { 'academy.slug_reserved': 'BAD_REQUEST', 'academy.topic_slug_taken': 'CONFLICT' },
  input: academyCreateTopicInputSchema,
  output: academyTopicSchema,
  samples: [
    { verdict: 'accept', input: { slug: 'placeholder', name: 'placeholder' } },
    { verdict: 'refuse', input: 42 },
  ],
});

/** AC-release-access-02: each assignment and quiz with what it requires, and every learner's moved due date. */
export const ACADEMY_ADMIN_COURSE_ITEM_RULES = defineProcedure({
  ...base,
  name: 'academy.admin.courseItemRules',
  kind: 'query',
  path: 'admin.courseItemRules',
  access: { caller: 'scope', scope: 'admin:read', module: 'academy' },
  refusals: { 'academy.course_not_found': 'NOT_FOUND' },
  input: academyCourseItemRulesInputSchema,
  output: academyCourseItemRulesSchema,
  samples: [
    { verdict: 'accept', input: { courseId: '33333333-3333-4333-8333-333333333333' } },
    { verdict: 'refuse', input: 42 },
  ],
});

/** AC-release-access-02: the whole set an item requires, refused when it makes a cycle; with a reason. */
export const ACADEMY_ADMIN_SET_COURSE_ITEM_PREREQUISITES = defineProcedure({
  ...base,
  name: 'academy.admin.setCourseItemPrerequisites',
  kind: 'mutation',
  path: 'admin.setCourseItemPrerequisites',
  access: { caller: 'scope', scope: 'admin:write', module: 'academy' },
  refusals: {
    'academy.course_not_found': 'NOT_FOUND',
    'academy.outline_item_unknown': 'CONFLICT',
    'academy.prerequisite_cycle': 'BAD_REQUEST',
    'academy.prerequisite_unmeasured': 'BAD_REQUEST',
  },
  input: academySetCourseItemPrerequisitesInputSchema,
  output: academyCourseItemRulesSchema,
  samples: [
    {
      verdict: 'accept',
      input: {
        courseId: '33333333-3333-4333-8333-333333333333',
        itemId: '33333333-3333-4333-8333-333333333333',
        prerequisiteIds: [],
        reason: 'placeholder',
      },
    },
    { verdict: 'refuse', input: 42 },
  ],
});

/** AC-release-access-02: one enrolled learner's later due date on an assignment, with who and why. */
export const ACADEMY_ADMIN_GRANT_COURSE_EXTENSION = defineProcedure({
  ...base,
  name: 'academy.admin.grantCourseExtension',
  kind: 'mutation',
  path: 'admin.grantCourseExtension',
  access: { caller: 'scope', scope: 'admin:write', module: 'academy' },
  refusals: {
    'academy.assignment_closed': 'CONFLICT',
    'academy.assignment_not_found': 'NOT_FOUND',
    'academy.course_not_found': 'NOT_FOUND',
    'academy.enrolment_required': 'FORBIDDEN',
    'academy.window_invalid': 'BAD_REQUEST',
  },
  input: academyGrantCourseExtensionInputSchema,
  output: academyCourseItemRulesSchema,
  samples: [
    {
      verdict: 'accept',
      input: {
        courseId: '33333333-3333-4333-8333-333333333333',
        itemId: '33333333-3333-4333-8333-333333333333',
        userId: '33333333-3333-4333-8333-333333333333',
        dueAt: '2026-01-01T00:00:00.000Z',
        reason: 'placeholder',
      },
    },
    { verdict: 'refuse', input: 42 },
  ],
});

export const ACADEMY_ADMIN_LEARNER = defineProcedure({
  ...base,
  name: 'academy.admin.learner',
  kind: 'query',
  path: 'admin.learner',
  access: { caller: 'scope', scope: 'admin:read', module: 'academy' },
  refusals: { 'academy.slug_reserved': 'BAD_REQUEST' },
  input: academyLearnerInputSchema,
  output: academyLearnerPageSchema,
  samples: [
    { verdict: 'accept', input: { userId: '33333333-3333-4333-8333-333333333333' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const ACADEMY_ADMIN_LEARNER_PROGRESS = defineProcedure({
  ...base,
  name: 'academy.admin.learnerProgress',
  kind: 'query',
  path: 'admin.learnerProgress',
  access: { caller: 'scope', scope: 'admin:read', module: 'academy' },
  refusals: { 'academy.slug_reserved': 'BAD_REQUEST' },
  input: academyLearnerInputSchema,
  output: academyLearnerProgressSchema,
  samples: [
    { verdict: 'accept', input: { userId: '33333333-3333-4333-8333-333333333333' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const ACADEMY_ADMIN_LEARNERS = defineProcedure({
  ...base,
  name: 'academy.admin.learners',
  kind: 'query',
  path: 'admin.learners',
  access: { caller: 'scope', scope: 'admin:read', module: 'academy' },
  refusals: {},
  input: academyLearnersInputSchema,
  output: academyLearnersSchema,
  samples: [
    { verdict: 'accept', input: {} },
    { verdict: 'refuse', input: 42 },
  ],
});

/** AC-course-structure-03: one item's lesson revisions, newest first, and the revision learners see. */
export const ACADEMY_ADMIN_LESSON = defineProcedure({
  ...base,
  name: 'academy.admin.lesson',
  kind: 'query',
  path: 'admin.lesson',
  access: { caller: 'scope', scope: 'admin:read', module: 'academy' },
  refusals: { 'academy.outline_item_unknown': 'CONFLICT' },
  input: z.object({ itemId: z.string().guid() }).strict(),
  output: academyLessonSchema,
  samples: [
    { verdict: 'accept', input: { itemId: '33333333-3333-4333-8333-333333333333' } },
    { verdict: 'refuse', input: 42 },
  ],
});

/** AC-course-structure-03: a new lesson revision of ordered blocks, over the revision read. Learners keep the live one. */
export const ACADEMY_ADMIN_SAVE_LESSON = defineProcedure({
  ...base,
  name: 'academy.admin.saveLesson',
  kind: 'mutation',
  path: 'admin.saveLesson',
  access: { caller: 'scope', scope: 'admin:write', module: 'academy' },
  refusals: {
    'academy.item_has_no_lesson': 'BAD_REQUEST',
    'academy.lesson_blocks_invalid': 'BAD_REQUEST',
    'academy.outline_item_unknown': 'CONFLICT',
    'academy.permission_denied': 'FORBIDDEN',
    'academy.revision_stale': 'CONFLICT',
    'academy.role_not_found': 'NOT_FOUND',
  },
  input: academySaveLessonInputSchema,
  output: academyLessonSchema,
  samples: [
    {
      verdict: 'accept',
      input: { itemId: '33333333-3333-4333-8333-333333333333', revision: 0, blocks: [{ type: 'text', markdown: 'placeholder' }] },
    },
    { verdict: 'refuse', input: 42 },
  ],
});

/** AC-course-structure-03: a new revision with an older revision's blocks. History is never rewritten. */
export const ACADEMY_ADMIN_REVERT_LESSON = defineProcedure({
  ...base,
  name: 'academy.admin.revertLesson',
  kind: 'mutation',
  path: 'admin.revertLesson',
  access: { caller: 'scope', scope: 'admin:write', module: 'academy' },
  refusals: {
    'academy.item_has_no_lesson': 'BAD_REQUEST',
    'academy.lesson_blocks_invalid': 'BAD_REQUEST',
    'academy.lesson_revision_unknown': 'NOT_FOUND',
    'academy.outline_item_unknown': 'CONFLICT',
    'academy.permission_denied': 'FORBIDDEN',
    'academy.revision_stale': 'CONFLICT',
    'academy.role_not_found': 'NOT_FOUND',
  },
  input: academyRevertLessonInputSchema,
  output: academyLessonSchema,
  samples: [
    { verdict: 'accept', input: { itemId: '33333333-3333-4333-8333-333333333333', revision: 1, toRevision: 1 } },
    { verdict: 'refuse', input: 42 },
  ],
});

/** AC-course-structure-03: learners see this lesson revision from now on; a course event names who and why. */
export const ACADEMY_ADMIN_PUBLISH_LESSON = defineProcedure({
  ...base,
  name: 'academy.admin.publishLesson',
  kind: 'mutation',
  path: 'admin.publishLesson',
  access: { caller: 'scope', scope: 'admin:write', module: 'academy' },
  refusals: {
    'academy.course_not_editable': 'CONFLICT',
    'academy.course_revision_stale': 'CONFLICT',
    'academy.item_has_no_lesson': 'BAD_REQUEST',
    'academy.lesson_revision_unknown': 'NOT_FOUND',
    'academy.outline_item_unknown': 'CONFLICT',
    'academy.permission_denied': 'FORBIDDEN',
    'academy.role_not_found': 'NOT_FOUND',
  },
  input: academyPublishLessonInputSchema,
  output: academyLessonSchema,
  samples: [
    {
      verdict: 'accept',
      input: { itemId: '33333333-3333-4333-8333-333333333333', lessonRevision: 1, courseRevision: 1, reason: 'placeholder' },
    },
    { verdict: 'refuse', input: 42 },
  ],
});

/** AC-course-structure-04: a template draft from the course's structure; the model path refuses `owner.decision`. */
export const ACADEMY_ADMIN_ASSISTANT_DRAFT = defineProcedure({
  ...base,
  name: 'academy.admin.assistantDraft',
  kind: 'mutation',
  path: 'admin.assistantDraft',
  access: { caller: 'scope', scope: 'admin:write', module: 'academy' },
  refusals: {
    'academy.item_has_no_lesson': 'BAD_REQUEST',
    'academy.lesson_blocks_invalid': 'BAD_REQUEST',
    'academy.outline_item_unknown': 'CONFLICT',
    'academy.revision_stale': 'CONFLICT',
  },
  input: academyAssistantDraftInputSchema,
  output: academyLessonSchema,
  samples: [
    { verdict: 'accept', input: { itemId: '33333333-3333-4333-8333-333333333333', revision: 0, path: 'template' } },
    { verdict: 'refuse', input: 42 },
  ],
});

/** AC-course-structure-04: a person accepts (a new lesson revision) or discards the open draft. */
export const ACADEMY_ADMIN_DECIDE_DRAFT = defineProcedure({
  ...base,
  name: 'academy.admin.decideDraft',
  kind: 'mutation',
  path: 'admin.decideDraft',
  access: { caller: 'scope', scope: 'admin:write', module: 'academy' },
  refusals: {
    'academy.draft_not_found': 'NOT_FOUND',
    'academy.item_has_no_lesson': 'BAD_REQUEST',
    'academy.lesson_blocks_invalid': 'BAD_REQUEST',
    'academy.outline_item_unknown': 'CONFLICT',
    'academy.revision_stale': 'CONFLICT',
  },
  input: academyDecideDraftInputSchema,
  output: academyLessonSchema,
  samples: [
    {
      verdict: 'accept',
      input: { itemId: '33333333-3333-4333-8333-333333333333', basedOnRevision: 0, kind: 'template', decision: 'accept' },
    },
    { verdict: 'refuse', input: 42 },
  ],
});

/** AC-articles-01: learners stop seeing the lesson; a featured lesson leaves the Learn hub's slot. */
export const ACADEMY_ADMIN_WITHDRAW_LESSON = defineProcedure({
  ...base,
  name: 'academy.admin.withdrawLesson',
  kind: 'mutation',
  path: 'admin.withdrawLesson',
  access: { caller: 'scope', scope: 'admin:write', module: 'academy' },
  refusals: {
    'academy.course_not_editable': 'CONFLICT',
    'academy.course_revision_stale': 'CONFLICT',
    'academy.item_has_no_lesson': 'BAD_REQUEST',
    'academy.lesson_not_live': 'PRECONDITION_FAILED',
    'academy.outline_item_unknown': 'CONFLICT',
  },
  input: academyWithdrawLessonInputSchema,
  output: academyLessonSchema,
  samples: [
    { verdict: 'accept', input: { itemId: '33333333-3333-4333-8333-333333333333', courseRevision: 1, reason: 'placeholder' } },
    { verdict: 'refuse', input: 42 },
  ],
});

/** AC-course-structure-03: copy a draft course's item and its newest lesson after it. No learner record is copied. */
export const ACADEMY_ADMIN_DUPLICATE_ITEM = defineProcedure({
  ...base,
  name: 'academy.admin.duplicateItem',
  kind: 'mutation',
  path: 'admin.duplicateItem',
  access: { caller: 'scope', scope: 'admin:write', module: 'academy' },
  refusals: {
    'academy.course_not_editable': 'CONFLICT',
    'academy.course_revision_stale': 'CONFLICT',
    'academy.item_has_no_lesson': 'BAD_REQUEST',
    'academy.lesson_blocks_invalid': 'BAD_REQUEST',
    'academy.outline_item_unknown': 'CONFLICT',
    'academy.outline_limits_unset': 'PRECONDITION_FAILED',
    'academy.outline_too_large': 'BAD_REQUEST',
    'academy.permission_denied': 'FORBIDDEN',
    'academy.role_not_found': 'NOT_FOUND',
  },
  input: academyDuplicateItemInputSchema,
  output: academyLessonSchema,
  samples: [
    { verdict: 'accept', input: { itemId: '33333333-3333-4333-8333-333333333333', courseRevision: 1 } },
    { verdict: 'refuse', input: 42 },
  ],
});

/** AC-articles-01: a lesson learners can read fills the featured slot, with a reason. */
export const ACADEMY_ADMIN_FEATURE_LESSON = defineProcedure({
  ...base,
  name: 'academy.admin.featureLesson',
  kind: 'mutation',
  path: 'admin.featureLesson',
  access: { caller: 'scope', scope: 'admin:write', module: 'academy' },
  refusals: {
    'academy.course_not_editable': 'CONFLICT',
    'academy.featured_not_live': 'PRECONDITION_FAILED',
    'academy.item_has_no_lesson': 'BAD_REQUEST',
    'academy.outline_item_unknown': 'CONFLICT',
    'academy.slug_reserved': 'BAD_REQUEST',
  },
  input: academyFeatureLessonInputSchema,
  output: academyFeaturedSlotSchema,
  samples: [
    { verdict: 'accept', input: { itemId: '33333333-3333-4333-8333-333333333333', reason: 'placeholder' } },
    { verdict: 'refuse', input: 42 },
  ],
});

/** AC-course-structure-03: a lesson file as a new revision; over the size limit refuses before parsing, a bad block is reported. */
export const ACADEMY_ADMIN_IMPORT_LESSON = defineProcedure({
  ...base,
  name: 'academy.admin.importLesson',
  kind: 'mutation',
  path: 'admin.importLesson',
  access: { caller: 'scope', scope: 'admin:write', module: 'academy' },
  refusals: {
    'academy.import_limit_unset': 'PRECONDITION_FAILED',
    'academy.import_too_large': 'BAD_REQUEST',
    'academy.item_has_no_lesson': 'BAD_REQUEST',
    'academy.lesson_blocks_invalid': 'BAD_REQUEST',
    'academy.outline_item_unknown': 'CONFLICT',
    'academy.permission_denied': 'FORBIDDEN',
    'academy.revision_stale': 'CONFLICT',
    'academy.role_not_found': 'NOT_FOUND',
  },
  input: academyImportLessonInputSchema,
  output: academyImportLessonResultSchema,
  samples: [
    { verdict: 'accept', input: { itemId: '33333333-3333-4333-8333-333333333333', revision: 0, document: 'placeholder' } },
    { verdict: 'refuse', input: 42 },
  ],
});

/** AC-catalogue-03: Preview as new learner, the real syllabus with its locks; nothing is written. */
export const ACADEMY_ADMIN_PREVIEW_COURSE = defineProcedure({
  ...base,
  name: 'academy.admin.previewCourse',
  kind: 'query',
  path: 'admin.previewCourse',
  access: { caller: 'scope', scope: 'admin:read', module: 'academy' },
  refusals: { 'academy.course_not_found': 'NOT_FOUND' },
  input: academyCourseIdInputSchema,
  output: academyCourseLearnerViewSchema,
  samples: [
    { verdict: 'accept', input: { courseId: '33333333-3333-4333-8333-333333333333' } },
    { verdict: 'refuse', input: 42 },
  ],
});

/** AC-catalogue-03: the course's private links, newest first, without their keys. */
export const ACADEMY_ADMIN_PRIVATE_LINKS = defineProcedure({
  ...base,
  name: 'academy.admin.privateLinks',
  kind: 'query',
  path: 'admin.privateLinks',
  access: { caller: 'scope', scope: 'admin:read', module: 'academy' },
  refusals: { 'academy.course_not_found': 'NOT_FOUND' },
  input: academyCourseIdInputSchema,
  output: academyPrivateLinkListSchema,
  samples: [
    { verdict: 'accept', input: { courseId: '33333333-3333-4333-8333-333333333333' } },
    { verdict: 'refuse', input: 42 },
  ],
});

/** AC-catalogue-03: a new link to the unlisted page; its key is shown once. */
export const ACADEMY_ADMIN_CREATE_PRIVATE_LINK = defineProcedure({
  ...base,
  name: 'academy.admin.createPrivateLink',
  kind: 'mutation',
  path: 'admin.createPrivateLink',
  access: { caller: 'scope', scope: 'admin:write', module: 'academy' },
  refusals: { 'academy.course_not_found': 'NOT_FOUND', 'academy.private_link_course_closed': 'CONFLICT' },
  input: academyCreatePrivateLinkInputSchema,
  output: academyCreatedPrivateLinkSchema,
  samples: [
    { verdict: 'accept', input: { courseId: '33333333-3333-4333-8333-333333333333', reason: 'placeholder' } },
    { verdict: 'refuse', input: 42 },
  ],
});

/** AC-catalogue-03: the link stops opening the page. */
export const ACADEMY_ADMIN_REVOKE_PRIVATE_LINK = defineProcedure({
  ...base,
  name: 'academy.admin.revokePrivateLink',
  kind: 'mutation',
  path: 'admin.revokePrivateLink',
  access: { caller: 'scope', scope: 'admin:write', module: 'academy' },
  refusals: { 'academy.private_link_not_found': 'NOT_FOUND' },
  input: academyRevokePrivateLinkInputSchema,
  output: academyPrivateLinkSchema,
  samples: [
    { verdict: 'accept', input: { linkId: '33333333-3333-4333-8333-333333333333', reason: 'placeholder' } },
    { verdict: 'refuse', input: 42 },
  ],
});

/** AC-videos-02: one item's uploads, caption languages and the owner's upload limits. */
export const ACADEMY_ADMIN_ITEM_MEDIA = defineProcedure({
  ...base,
  name: 'academy.admin.itemMedia',
  kind: 'query',
  path: 'admin.itemMedia',
  access: { caller: 'scope', scope: 'admin:read', module: 'academy' },
  refusals: {
    'academy.item_has_no_lesson': 'BAD_REQUEST',
    'academy.outline_item_unknown': 'CONFLICT',
    'academy.video_grant_required': 'FORBIDDEN',
    'academy.video_s3_region_unset': 'PRECONDITION_FAILED',
    'academy.video_storage_unconfigured': 'PRECONDITION_FAILED',
    'academy.video_url_ttl_unset': 'PRECONDITION_FAILED',
  },
  input: z.object({ itemId: z.string().guid() }).strict(),
  output: academyItemMediaSchema,
  samples: [
    { verdict: 'accept', input: { itemId: '33333333-3333-4333-8333-333333333333' } },
    { verdict: 'refuse', input: 42 },
  ],
});

/** AC-videos-02: the stored file read back; a size or type other than declared refuses. */
export const ACADEMY_ADMIN_CONFIRM_MEDIA = defineProcedure({
  ...base,
  name: 'academy.admin.confirmMedia',
  kind: 'mutation',
  path: 'admin.confirmMedia',
  access: { caller: 'scope', scope: 'admin:write', module: 'academy' },
  refusals: {
    'academy.file_type_mismatch': 'BAD_REQUEST',
    'academy.media_not_found': 'NOT_FOUND',
    'academy.upload_incomplete': 'PRECONDITION_FAILED',
    'academy.video_grant_required': 'FORBIDDEN',
    'academy.video_s3_region_unset': 'PRECONDITION_FAILED',
    'academy.video_storage_unconfigured': 'PRECONDITION_FAILED',
    'academy.video_url_ttl_unset': 'PRECONDITION_FAILED',
  },
  input: academyConfirmMediaInputSchema,
  output: academyMediaSchema,
  samples: [
    { verdict: 'accept', input: { mediaId: '33333333-3333-4333-8333-333333333333' } },
    { verdict: 'refuse', input: 42 },
  ],
});

/** AC-quizzes-02: finished attempts waiting for an essay score, under per-quiz aliases. */
export const ACADEMY_ADMIN_COURSE_QUIZ_REVIEWS = defineProcedure({
  ...base,
  name: 'academy.admin.courseQuizReviews',
  kind: 'query',
  path: 'admin.courseQuizReviews',
  access: { caller: 'scope', scope: 'admin:read', module: 'academy' },
  refusals: { 'academy.outline_item_unknown': 'CONFLICT', 'academy.quiz_not_found': 'NOT_FOUND' },
  input: academyCourseQuizInputSchema,
  output: academyCourseQuizReviewsSchema,
  samples: [
    { verdict: 'accept', input: { itemId: '33333333-3333-4333-8333-333333333333' } },
    { verdict: 'refuse', input: 42 },
  ],
});

/** AC-quizzes-01: publish when nothing blocks it, or take back to draft while no learner has an attempt, with a reason. */
export const ACADEMY_ADMIN_SET_COURSE_QUIZ_STATE = defineProcedure({
  ...base,
  name: 'academy.admin.setCourseQuizState',
  kind: 'mutation',
  path: 'admin.setCourseQuizState',
  access: { caller: 'scope', scope: 'admin:write', module: 'academy' },
  refusals: {
    'academy.item_has_attempts': 'CONFLICT',
    'academy.outline_item_unknown': 'CONFLICT',
    'academy.pass_mark_unset': 'PRECONDITION_FAILED',
    'academy.quiz_no_questions': 'PRECONDITION_FAILED',
    'academy.quiz_not_found': 'NOT_FOUND',
    'academy.scoring_policy_unset': 'PRECONDITION_FAILED',
  },
  input: academySetCourseQuizStateInputSchema,
  output: academyAdminCourseQuizSchema,
  outputChecks: {
    academy_course_quiz_question_holds: {
      at: ['output.questions[]', 'output.questions[]', 'output.questions[]', 'output.questions[]', 'output.questions[]'],
      says: 'with partial credit the points split into a whole share per correct choice; every key is one of the choices, once; the key is one of the choices; choice ids are unique; a tolerance is not negative',
    },
  },
  samples: [
    { verdict: 'accept', input: { itemId: '33333333-3333-4333-8333-333333333333', state: 'draft', reason: 'placeholder' } },
    { verdict: 'refuse', input: 42 },
  ],
});

/** AC-quizzes-02: score an attempt's essays and grade it; answers the quiz's remaining queue. */
export const ACADEMY_ADMIN_SCORE_COURSE_QUIZ_ESSAYS = defineProcedure({
  ...base,
  name: 'academy.admin.scoreCourseQuizEssays',
  kind: 'mutation',
  path: 'admin.scoreCourseQuizEssays',
  access: { caller: 'scope', scope: 'admin:write', module: 'academy' },
  refusals: {
    'academy.assessment_invalid': 'BAD_REQUEST',
    'academy.attempt_closed': 'CONFLICT',
    'academy.attempt_not_found': 'NOT_FOUND',
    'academy.outline_item_unknown': 'CONFLICT',
    'academy.quiz_not_found': 'NOT_FOUND',
  },
  input: academyScoreCourseQuizEssaysInputSchema,
  output: academyCourseQuizReviewsSchema,
  samples: [
    {
      verdict: 'accept',
      input: { itemId: '33333333-3333-4333-8333-333333333333', attemptId: '33333333-3333-4333-8333-333333333333', points: {} },
    },
    { verdict: 'refuse', input: 42 },
  ],
});

/** AC-release-access-01: a course's pacing and each section's release rule. */
export const ACADEMY_ADMIN_COURSE_RELEASE = defineProcedure({
  ...base,
  name: 'academy.admin.courseRelease',
  kind: 'query',
  path: 'admin.courseRelease',
  access: { caller: 'scope', scope: 'admin:read', module: 'academy' },
  refusals: { 'academy.course_not_found': 'NOT_FOUND' },
  input: academyCourseReleaseInputSchema,
  output: academyCourseReleaseSchema,
  samples: [
    { verdict: 'accept', input: { courseId: '33333333-3333-4333-8333-333333333333' } },
    { verdict: 'refuse', input: 42 },
  ],
});

/** AC-release-access-01: a section opens at an instant or days after enrolment, or with the course; with a reason. */
export const ACADEMY_ADMIN_SET_SECTION_RELEASE = defineProcedure({
  ...base,
  name: 'academy.admin.setSectionRelease',
  kind: 'mutation',
  path: 'admin.setSectionRelease',
  access: { caller: 'scope', scope: 'admin:write', module: 'academy' },
  refusals: { 'academy.course_not_found': 'NOT_FOUND', 'academy.outline_item_unknown': 'CONFLICT' },
  input: academySetSectionReleaseInputSchema,
  output: academyCourseReleaseSchema,
  samples: [
    {
      verdict: 'accept',
      input: {
        courseId: '33333333-3333-4333-8333-333333333333',
        sectionId: '33333333-3333-4333-8333-333333333333',
        rule: { kind: 'at', at: '2026-01-01T00:00:00.000Z' },
        reason: 'placeholder',
      },
    },
    { verdict: 'refuse', input: 42 },
  ],
});

/** AC-release-access-01: self-paced or instructor-paced, refused once a learner has enrolled. */
export const ACADEMY_ADMIN_SET_COURSE_PACING = defineProcedure({
  ...base,
  name: 'academy.admin.setCoursePacing',
  kind: 'mutation',
  path: 'admin.setCoursePacing',
  access: { caller: 'scope', scope: 'admin:write', module: 'academy' },
  refusals: { 'academy.course_not_found': 'NOT_FOUND', 'academy.pacing_locked': 'CONFLICT' },
  input: academySetCoursePacingInputSchema,
  output: academyCourseReleaseSchema,
  samples: [
    { verdict: 'accept', input: { courseId: '33333333-3333-4333-8333-333333333333', pacing: 'self_paced', reason: 'placeholder' } },
    { verdict: 'refuse', input: 42 },
  ],
});

/** AC-roles-01: every role with its permissions and holders, the permission list and the owner's custom role limit. */
export const ACADEMY_ADMIN_ACADEMY_ROLES = defineProcedure({
  ...base,
  name: 'academy.admin.academyRoles',
  kind: 'query',
  path: 'admin.academyRoles',
  access: { caller: 'scope', scope: 'admin:read', module: 'academy' },
  refusals: {},
  input: NO_INPUT,
  output: academyRolesSchema,
  samples: [{ verdict: 'accept' }],
});

/** AC-roles-01: switch a custom role off (holders keep the row, the permissions stop) or on, with a reason. */
export const ACADEMY_ADMIN_SET_CUSTOM_ROLE_ACTIVE = defineProcedure({
  ...base,
  name: 'academy.admin.setCustomRoleActive',
  kind: 'mutation',
  path: 'admin.setCustomRoleActive',
  access: { caller: 'scope', scope: 'admin:write', module: 'academy' },
  refusals: {
    'academy.permission_denied': 'FORBIDDEN',
    'academy.reason_required': 'BAD_REQUEST',
    'academy.role_escalation': 'FORBIDDEN',
    'academy.role_not_found': 'NOT_FOUND',
  },
  input: academySetCustomRoleActiveInputSchema,
  output: academyRoleSchema,
  samples: [
    { verdict: 'accept', input: { roleId: '33333333-3333-4333-8333-333333333333', active: true, reason: 'placeholder' } },
    { verdict: 'refuse', input: 42 },
  ],
});

/** AC-rooms-02: reported entries still showing and the moderation events; readable by a read-only session. */
export const ACADEMY_ADMIN_MODERATION_QUEUE = defineProcedure({
  ...base,
  name: 'academy.admin.moderationQueue',
  kind: 'query',
  path: 'admin.moderationQueue',
  access: { caller: 'scope', scope: 'admin:read', module: 'academy' },
  refusals: { 'academy.role_not_found': 'NOT_FOUND' },
  input: academyModerationQueueInputSchema,
  output: academyModerationQueueSchema,
  samples: [
    { verdict: 'accept', input: { courseId: '33333333-3333-4333-8333-333333333333', limit: 1 } },
    { verdict: 'refuse', input: 42 },
  ],
});

/** AC-roles-01: a course's team (or the academy-wide team, `courseId: null`) and what the caller may do there. */
export const ACADEMY_ADMIN_COURSE_TEAM = defineProcedure({
  ...base,
  name: 'academy.admin.courseTeam',
  kind: 'query',
  path: 'admin.courseTeam',
  access: { caller: 'scope', scope: 'admin:read', module: 'academy' },
  refusals: { 'academy.course_not_found': 'NOT_FOUND', 'academy.role_not_found': 'NOT_FOUND' },
  input: academyCourseTeamInputSchema,
  output: academyCourseTeamSchema,
  samples: [
    { verdict: 'accept', input: { courseId: '33333333-3333-4333-8333-333333333333' } },
    { verdict: 'refuse', input: 42 },
  ],
});

/** AC-rooms-02: delete a post or reply with a reason; the author is told in their tray. */
export const ACADEMY_ADMIN_DELETE_DISCUSSION_POST = defineProcedure({
  ...base,
  name: 'academy.admin.deleteDiscussionPost',
  kind: 'mutation',
  path: 'admin.deleteDiscussionPost',
  access: { caller: 'scope', scope: 'admin:write', module: 'academy' },
  refusals: {
    'academy.course_not_found': 'NOT_FOUND',
    'academy.permission_denied': 'FORBIDDEN',
    'academy.post_not_found': 'NOT_FOUND',
    'academy.reason_required': 'BAD_REQUEST',
    'academy.role_not_found': 'NOT_FOUND',
  },
  input: academyDeleteDiscussionPostInputSchema,
  output: academyModerationResultSchema,
  samples: [
    { verdict: 'accept', input: { postId: '33333333-3333-4333-8333-333333333333', reason: 'placeholder' } },
    { verdict: 'refuse', input: 42 },
  ],
});

/** AC-rooms-02: delete every post and reply of one author in one course, with a reason; their posts elsewhere stay. */
export const ACADEMY_ADMIN_BULK_DELETE_USER_POSTS = defineProcedure({
  ...base,
  name: 'academy.admin.bulkDeleteUserPosts',
  kind: 'mutation',
  path: 'admin.bulkDeleteUserPosts',
  access: { caller: 'scope', scope: 'admin:write', module: 'academy' },
  refusals: {
    'academy.course_not_found': 'NOT_FOUND',
    'academy.permission_denied': 'FORBIDDEN',
    'academy.post_not_found': 'NOT_FOUND',
    'academy.reason_required': 'BAD_REQUEST',
    'academy.role_not_found': 'NOT_FOUND',
  },
  input: academyBulkDeleteUserPostsInputSchema,
  output: academyModerationResultSchema,
  samples: [
    {
      verdict: 'accept',
      input: { courseId: '33333333-3333-4333-8333-333333333333', authorId: '33333333-3333-4333-8333-333333333333', reason: 'placeholder' },
    },
    { verdict: 'refuse', input: 42 },
  ],
});

/** AC-roles-01: one founder proposes giving or taking a role; it waits for a different founder. */
export const ACADEMY_ADMIN_PROPOSE_TEAM_CHANGE = defineProcedure({
  ...base,
  name: 'academy.admin.proposeTeamChange',
  kind: 'mutation',
  path: 'admin.proposeTeamChange',
  access: { caller: 'scope', scope: 'admin:write', module: 'academy' },
  refusals: {
    'academy.course_not_found': 'NOT_FOUND',
    'academy.permission_denied': 'FORBIDDEN',
    'academy.reason_required': 'BAD_REQUEST',
    'academy.role_escalation': 'FORBIDDEN',
    'academy.role_not_found': 'NOT_FOUND',
  },
  input: academyProposeTeamChangeInputSchema,
  output: academyTeamChangeSchema,
  samples: [
    {
      verdict: 'accept',
      input: {
        courseId: '33333333-3333-4333-8333-333333333333',
        accountId: '33333333-3333-4333-8333-333333333333',
        role: 'admin',
        kind: 'assign',
        reason: 'placeholder',
        requestId: 'placeholder',
      },
    },
    { verdict: 'refuse', input: 42 },
  ],
});

/** AC-roles-01: a different founder confirms a waiting role change; it takes effect now. */
export const ACADEMY_ADMIN_CONFIRM_TEAM_CHANGE = defineProcedure({
  ...base,
  name: 'academy.admin.confirmTeamChange',
  kind: 'mutation',
  path: 'admin.confirmTeamChange',
  access: { caller: 'scope', scope: 'admin:write', module: 'academy' },
  refusals: {
    'academy.permission_denied': 'FORBIDDEN',
    'academy.role_escalation': 'FORBIDDEN',
    'academy.role_not_found': 'NOT_FOUND',
    'academy.second_founder_required': 'FORBIDDEN',
  },
  input: academyConfirmTeamChangeInputSchema,
  output: academyTeamChangeSchema,
  samples: [
    { verdict: 'accept', input: { changeId: '33333333-3333-4333-8333-333333333333' } },
    { verdict: 'refuse', input: 42 },
  ],
});

/**
 * AC-certificates-02: issue one learner a certificate without every required item, with a reason, under two-person
 * approval (`academy.cert.exception`, payload `{userId, certId, reason}`). The grant audit and the issued list then
 * show it with the reason.
 */
export const ACADEMY_ADMIN_GRANT_CERT_EXCEPTION = defineProcedure({
  ...base,
  name: 'academy.admin.grantCertException',
  kind: 'mutation',
  path: 'admin.grantCertException',
  access: { caller: 'scope', scope: 'admin:write', module: 'academy' },
  refusals: {
    'academy.cert_already_granted': 'CONFLICT',
    'academy.cert_invalid': 'BAD_REQUEST',
    'academy.cert_not_found': 'NOT_FOUND',
    'academy.cert_revoked': 'CONFLICT',
    'academy.certificate_unpublished': 'PRECONDITION_FAILED',
  },
  input: academyGrantCertExceptionInputSchema,
  output: academyCertExceptionSchema,
  samples: [
    { verdict: 'accept', input: { userId: '33333333-3333-4333-8333-333333333333', certId: 'placeholder', reason: 'placeholder' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const ACADEMY_ADMIN_ADD_LEARNER_NOTE = defineProcedure({
  ...base,
  name: 'academy.admin.addLearnerNote',
  kind: 'mutation',
  path: 'admin.addLearnerNote',
  access: { caller: 'scope', scope: 'admin:read', module: 'academy' },
  refusals: { 'academy.permission_denied': 'FORBIDDEN', 'academy.reason_required': 'BAD_REQUEST', 'academy.revision_stale': 'CONFLICT' },
  input: academyAddLearnerNoteInputSchema,
  output: academyLearnerChangeSchema,
  samples: [
    { verdict: 'accept', input: { userId: '33333333-3333-4333-8333-333333333333', body: 'placeholder', key: 'placeholder' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const ACADEMY_ADMIN_MARK_COMPLETE_FOR = defineProcedure({
  ...base,
  name: 'academy.admin.markCompleteFor',
  kind: 'mutation',
  path: 'admin.markCompleteFor',
  access: { caller: 'scope', scope: 'admin:read', module: 'academy' },
  refusals: {
    'academy.curriculum_not_found': 'NOT_FOUND',
    'academy.permission_denied': 'FORBIDDEN',
    'academy.reason_required': 'BAD_REQUEST',
    'academy.slug_reserved': 'BAD_REQUEST',
  },
  input: academyMarkCompleteForInputSchema,
  output: academyLearnerChangeSchema,
  samples: [
    {
      verdict: 'accept',
      input: { userId: '33333333-3333-4333-8333-333333333333', itemSlug: 'placeholder', reason: 'placeholder', key: 'placeholder' },
    },
    { verdict: 'refuse', input: 42 },
  ],
});

export const ACADEMY_ADMIN_VOID_QUIZ_ATTEMPT = defineProcedure({
  ...base,
  name: 'academy.admin.voidQuizAttempt',
  kind: 'mutation',
  path: 'admin.voidQuizAttempt',
  access: { caller: 'scope', scope: 'admin:read', module: 'academy' },
  refusals: {
    'academy.attempt_not_found': 'NOT_FOUND',
    'academy.permission_denied': 'FORBIDDEN',
    'academy.reason_required': 'BAD_REQUEST',
    'academy.slug_reserved': 'BAD_REQUEST',
  },
  input: academyVoidQuizAttemptInputSchema,
  output: academyLearnerChangeSchema,
  samples: [
    {
      verdict: 'accept',
      input: { userId: '33333333-3333-4333-8333-333333333333', attemptId: '33333333-3333-4333-8333-333333333333', reason: 'placeholder' },
    },
    { verdict: 'refuse', input: 42 },
  ],
});

export const ACADEMY_ADMIN_GRANT_LEARNER_EXTENSION = defineProcedure({
  ...base,
  name: 'academy.admin.grantLearnerExtension',
  kind: 'mutation',
  path: 'admin.grantLearnerExtension',
  access: { caller: 'scope', scope: 'admin:read', module: 'academy' },
  refusals: {
    'academy.curriculum_not_found': 'NOT_FOUND',
    'academy.permission_denied': 'FORBIDDEN',
    'academy.reason_required': 'BAD_REQUEST',
    'academy.slug_reserved': 'BAD_REQUEST',
    'academy.window_invalid': 'BAD_REQUEST',
  },
  input: academyGrantLearnerExtensionInputSchema,
  output: academyLearnerChangeSchema,
  samples: [
    {
      verdict: 'accept',
      input: {
        userId: '33333333-3333-4333-8333-333333333333',
        itemSlug: 'placeholder',
        until: '2026-01-01T00:00:00.000Z',
        reason: 'placeholder',
        key: 'placeholder',
      },
    },
    { verdict: 'refuse', input: 42 },
  ],
});

export const ACADEMY_ADMIN_UNTAG_LEARNER = defineProcedure({
  ...base,
  name: 'academy.admin.untagLearner',
  kind: 'mutation',
  path: 'admin.untagLearner',
  access: { caller: 'scope', scope: 'admin:read', module: 'academy' },
  refusals: { 'academy.permission_denied': 'FORBIDDEN', 'academy.reason_required': 'BAD_REQUEST' },
  input: academyUntagLearnerInputSchema,
  output: academyLearnerChangeSchema,
  samples: [
    { verdict: 'accept', input: { userId: '33333333-3333-4333-8333-333333333333', tag: 'placeholder', reason: 'placeholder' } },
    { verdict: 'refuse', input: 42 },
  ],
});

/** `admin.grantAccess`: the samples are written by hand, since the door's stored sample ends in the past, which the door refuses. */
export const ACADEMY_ADMIN_GRANT_ACCESS = defineProcedure({
  ...base,
  name: 'academy.admin.grantAccess',
  kind: 'mutation',
  path: 'admin.grantAccess',
  access: { caller: 'scope', scope: 'admin:read', module: 'academy' },
  refusals: {
    'academy.grant_expired': 'FORBIDDEN',
    'academy.permission_denied': 'FORBIDDEN',
    'academy.reason_required': 'BAD_REQUEST',
    'academy.window_invalid': 'BAD_REQUEST',
  },
  input: academyGrantAccessInputSchema,
  output: academyLearnerChangeSchema,
  samples: [
    {
      verdict: 'accept',
      input: { userId: '33333333-3333-4333-8333-333333333333', pathSlug: 'foundations', reason: 'placeholder', expiresAt: null },
    },
    { verdict: 'refuse', input: 42 },
  ],
});

/** `admin.reinstateAccess`: the samples are written by hand, since the door's stored sample ends in the past, which the door refuses. */
export const ACADEMY_ADMIN_REINSTATE_ACCESS = defineProcedure({
  ...base,
  name: 'academy.admin.reinstateAccess',
  kind: 'mutation',
  path: 'admin.reinstateAccess',
  access: { caller: 'scope', scope: 'admin:read', module: 'academy' },
  refusals: {
    'academy.grant_active': 'CONFLICT',
    'academy.grant_not_found': 'NOT_FOUND',
    'academy.permission_denied': 'FORBIDDEN',
    'academy.reason_required': 'BAD_REQUEST',
    'academy.revision_stale': 'CONFLICT',
    'academy.window_invalid': 'BAD_REQUEST',
  },
  input: academyReinstateAccessInputSchema,
  output: academyLearnerChangeSchema,
  samples: [
    {
      verdict: 'accept',
      input: {
        userId: '33333333-3333-4333-8333-333333333333',
        grantId: '33333333-3333-4333-8333-333333333333',
        reason: 'placeholder',
        expiresAt: null,
        n: 1,
      },
    },
    { verdict: 'refuse', input: 42 },
  ],
});

/** AC-assignments-04: the grading policy, the course's graded items and each enrolled learner's scores. */
export const ACADEMY_ADMIN_COURSE_GRADEBOOK = defineProcedure({
  ...base,
  name: 'academy.admin.courseGradebook',
  kind: 'query',
  path: 'admin.courseGradebook',
  access: { caller: 'scope', scope: 'admin:read', module: 'academy' },
  refusals: { 'academy.course_not_found': 'NOT_FOUND', 'academy.permission_denied': 'FORBIDDEN', 'academy.role_not_found': 'NOT_FOUND' },
  input: academyCourseGradebookInputSchema,
  output: academyCourseGradebookSchema,
  samples: [
    { verdict: 'accept', input: { courseId: '33333333-3333-4333-8333-333333333333' } },
    { verdict: 'refuse', input: 42 },
  ],
});
