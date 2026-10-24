import { z } from 'zod';
import { academyQuizSchema } from '@intafaced/contracts/academy-catalogue';
import type { ApiClient, ApiResult } from '../../shared/api';
import { publicCertCode, type AcademyPath } from './academy-lms';
import type { academyLmsCopy } from './academy-lms-copy';

/**
 * The Academy procedures behind assessments, public certificate checks and programme enrolments, with the answers
 * checked against what was asked. Nothing here invents a field: a reply that does not match is a failed read.
 *
 * Procedures (svc-academy router): assessment.get, assessment.attempts, certVerify (public),
 * myEnrollments, enrollCertPath, leaveCertPath.
 */

type Failure = Extract<ApiResult<never>, { ok: false }>;
const isoDate = z.string().datetime({ offset: true });
const ref = z.string().min(1);

// ---------------------------------------------------------------- assessments

/** One attempt, as the attempts list returns it: scored, or with its result hidden until a date (AC-progress-02). */
export function attemptFor(slug: string) {
  return z
    .union([
      z.object({
        slug: ref,
        score: z.number().int().nonnegative(),
        maxScore: z.number().int().nonnegative(),
        pass: z.boolean(),
        submittedAt: isoDate,
        hiddenUntil: z.null(),
      }),
      z.object({ slug: ref, score: z.null(), maxScore: z.null(), pass: z.null(), submittedAt: isoDate, hiddenUntil: isoDate }),
    ])
    .refine((attempt) => attempt.slug === slug && (attempt.score === null || attempt.score <= attempt.maxScore!));
}
export type Attempt = z.infer<ReturnType<typeof attemptFor>>;
export const attemptsFor = (slug: string) => z.array(attemptFor(slug));

/** The published quiz for one lesson (AC-quizzes-03). The service never sends the answer key. */
export const readQuiz = (api: ApiClient, slug: string, signal?: AbortSignal) =>
  api.query(
    'academy',
    'assessment.get',
    { slug },
    academyQuizSchema.refine((quiz) => quiz.slug === slug && new Set(quiz.questions.map((q) => q.id)).size === quiz.questions.length),
    { signal },
  );
export const readAttempts = (api: ApiClient, slug: string, signal?: AbortSignal) =>
  api.query('academy', 'assessment.attempts', { slug }, attemptsFor(slug), { signal });

// ------------------------------------------------------------ certificate check

export const verifiedCertificate = z.object({
  certId: ref,
  title: ref,
  grantedAt: isoDate,
  status: z.enum(['valid', 'revoked']),
  holderName: z.string().min(1).optional(),
});
export type VerifiedCertificate = z.infer<typeof verifiedCertificate>;

/** The public check. It needs no sign-in on the service; the code is the only input. */
export const verifyCertificate = (api: ApiClient, code: string, signal?: AbortSignal) => {
  if (!publicCertCode.safeParse(code).success) throw new Error('A verification code is 32 lowercase hex characters');
  return api.query('academy', 'certVerify', { publicId: code }, verifiedCertificate, { signal });
};

// ----------------------------------------------------------------- enrolments

const enrolmentRow = z.object({ userId: z.string().guid(), pathSlug: ref, enrolledAt: isoDate });
export type Enrolment = z.infer<typeof enrolmentRow>;

/** Active enrolments on this account. The service lists only programmes not left. */
export const enrolmentsFor = (owner: string | null | undefined) =>
  z
    .array(enrolmentRow)
    .refine((rows) => rows.every((row) => row.userId === owner) && new Set(rows.map((row) => row.pathSlug)).size === rows.length);

export const readEnrolments = (api: ApiClient, owner: string | null | undefined, signal?: AbortSignal) =>
  api.query('academy', 'myEnrollments', undefined, enrolmentsFor(owner), { signal });

export const enrolReceipt = (owner: string | null | undefined, path: string) =>
  enrolmentRow.refine((row) => row.userId === owner && row.pathSlug === path);
export const leaveReceipt = (owner: string | null | undefined, path: string) =>
  enrolmentRow.extend({ leftAt: isoDate }).refine((row) => row.userId === owner && row.pathSlug === path);

/** One reference per leave decision. The service answers a repeated reference with the first leave, so a resend cannot leave twice. */
export const newLeaveId = () => `leave-${crypto.randomUUID()}`;

/**
 * A write whose reply never arrived is settled by reading the enrolments, not by sending it again.
 * `landed` says whether the intended change is visible; when it is, the request counts as done.
 */
export async function settleByReading(
  result: ApiResult<unknown>,
  read: () => Promise<ApiResult<Enrolment[]>>,
  landed: (rows: readonly Enrolment[]) => boolean,
  notRecorded: () => Failure,
): Promise<ApiResult<unknown>> {
  if (result.ok || result.reason !== 'uncertain') return result;
  const rows = await read();
  if (!rows.ok) return result;
  return landed(rows.data) ? { ok: true, data: { settledBy: 'enrolments' } } : notRecorded();
}

// ------------------------------------------------------------------- refusals

const pathCopyKeys: Record<AcademyPath, 'pathFoundations' | 'pathMarkets' | 'pathBuilder' | 'pathSovereign'> = {
  foundations: 'pathFoundations',
  markets: 'pathMarkets',
  builder: 'pathBuilder',
  sovereign: 'pathSovereign',
};

/** The Academy code of a refusal: the typed code when the gateway passed it, otherwise one named inside the message. */
export function academyCodeOf(failure: Pick<Failure, 'code' | 'message'>): string | null {
  if (failure.code?.startsWith('academy.')) return failure.code;
  return /\bacademy\.[a-z_]+\b/.exec(failure.message)?.[0] ?? null;
}

/** Curriculum item slugs from "academy.prerequisite_unmet missing=a-lesson,another" (an item's own prerequisite). */
export function missingItems(message: string): string[] {
  const list = /\bmissing=(\S+)/.exec(message)?.[1];
  return list ? list.split(',').filter(Boolean) : [];
}

/** Programme names from "academy.prerequisite_unmet missing=foundations,markets". */
export function missingProgrammes(message: string): string[] {
  const list = /\bmissing=([a-z0-9,-]+)/.exec(message)?.[1];
  return list ? list.split(',').filter(Boolean) : [];
}

export type RefusalKey =
  | 'refAssessmentUnpublished'
  | 'refPassMarkUnset'
  | 'refCertNotDue'
  | 'refCertRevoked'
  | 'refAssessmentInvalid'
  | 'refAttemptLimit'
  | 'refAttemptCooldown'
  | 'refCertNotFound'
  | 'refCertUnpublished'
  | 'refVerifyRateLimited'
  | 'refVerifyRateUnset'
  | 'refVerifyAddressUnset'
  | 'refEnrollmentNotFound'
  | 'refProgrammeInvalid'
  | 'refProgrammeNotFound'
  | 'refPrerequisite'
  | 'refPrerequisiteUnnamed'
  | 'refVideoStorageUnconfigured'
  | 'refVideoUrlTtlUnset'
  | 'refVideoRegionUnset'
  | 'refVideoGrantRequired'
  | 'refVideoNotFound'
  | 'refSignInRequired'
  | 'refCurriculumNotFound'
  | 'refCourseNotFound'
  | 'refEnrolmentClosed'
  | 'refItemNotOpen'
  | 'refCompletionRuleUnmet'
  | 'refRequestReused'
  | 'refAttemptClosed'
  | 'refAttemptNotFound'
  | 'refAttemptOpen'
  | 'refAttemptRequired'
  | 'refGradesHidden'
  | 'refPlannerLimitUnset'
  | 'refPlannerFull'
  | 'refTodoNotFound'
  | 'refGoalInvalid'
  | 'refEnrolmentRequired'
  | 'refSubmissionIncomplete'
  | 'refSubmissionIncompleteFile'
  | 'refSubmissionIncompleteText'
  | 'refAssignmentNotFound'
  | 'refAssignmentClosed'
  | 'refSubmissionStale'
  | 'refUploadLimitsUnset'
  | 'refUploadTooLarge'
  | 'refUploadTypeRefused'
  | 'refFileTypeMismatch'
  | 'refUploadIncomplete'
  | 'refPeerCountUnset'
  | 'refReviewMarksInvalid'
  | 'refReviewTaskNotFound'
  | 'refReviewAlreadySent'
  | 'refFileUnavailable'
  | 'refGradeNotFound'
  | 'refPostLimitUnset'
  | 'refPostTooLong'
  | 'refAttachmentLimitUnset'
  | 'refAttachmentTooLarge'
  | 'refAttachmentTypeRefused'
  | 'refPostNotFound'
  | 'refPermissionDenied'
  | 'refTopicNotFound'
  | 'refMessageLimitUnset'
  | 'refMessageTooLong'
  | 'refConversationNotFound';

/** Which sentence words a typed Academy refusal, or null when Academy did not type it (a dropped connection, a sign-in problem). */
export function academyRefusalKey(failure: Pick<Failure, 'code' | 'message'>): RefusalKey | null {
  switch (academyCodeOf(failure)) {
    case 'academy.assessment_unpublished':
      return 'refAssessmentUnpublished';
    case 'academy.pass_mark_unset':
      return 'refPassMarkUnset';
    case 'academy.assessment_invalid':
      return 'refAssessmentInvalid';
    case 'academy.attempt_limit':
      return 'refAttemptLimit';
    case 'academy.attempt_cooldown':
      return 'refAttemptCooldown';
    case 'academy.cert_not_found':
      return 'refCertNotFound';
    case 'academy.certificate_unpublished':
      return 'refCertUnpublished';
    case 'academy.cert_not_due':
      return 'refCertNotDue';
    case 'academy.cert_revoked':
      return 'refCertRevoked';
    case 'academy.verify_rate_limited':
      return 'refVerifyRateLimited';
    case 'academy.verify_rate_unset':
      return 'refVerifyRateUnset';
    case 'academy.verify_address_unset':
      return 'refVerifyAddressUnset';
    case 'academy.enrollment_not_found':
      return 'refEnrollmentNotFound';
    case 'academy.cert_invalid':
    case 'academy.path_not_found':
      return 'refProgrammeInvalid';
    case 'academy.programme_not_found':
      return 'refProgrammeNotFound';
    case 'academy.prerequisite_unmet':
      return missingProgrammes(failure.message).length > 0 ? 'refPrerequisite' : 'refPrerequisiteUnnamed';
    case 'academy.video_storage_unconfigured':
      return 'refVideoStorageUnconfigured';
    case 'academy.video_url_ttl_unset':
      return 'refVideoUrlTtlUnset';
    case 'academy.video_s3_region_unset':
      return 'refVideoRegionUnset';
    case 'academy.video_grant_required':
      return 'refVideoGrantRequired';
    case 'academy.video_not_found':
      return 'refVideoNotFound';
    case 'academy.sign_in_required':
      return 'refSignInRequired';
    case 'academy.curriculum_not_found':
      return 'refCurriculumNotFound';
    case 'academy.course_not_found':
      return 'refCourseNotFound';
    case 'academy.enrolment_closed':
      return 'refEnrolmentClosed';
    case 'academy.window_invalid':
      return 'refItemNotOpen';
    case 'academy.completion_rule_unmet':
      return 'refCompletionRuleUnmet';
    case 'academy.request_reused':
      return 'refRequestReused';
    case 'academy.attempt_closed':
      return 'refAttemptClosed';
    case 'academy.attempt_not_found':
      return 'refAttemptNotFound';
    case 'academy.attempt_open':
      return 'refAttemptOpen';
    case 'academy.attempt_required':
      return 'refAttemptRequired';
    case 'academy.grades_hidden':
      return 'refGradesHidden';
    case 'academy.planner_limit_unset':
      return 'refPlannerLimitUnset';
    case 'academy.planner_full':
      return 'refPlannerFull';
    case 'academy.todo_not_found':
      return 'refTodoNotFound';
    case 'academy.goal_invalid':
      return 'refGoalInvalid';
    case 'academy.enrolment_required':
      return 'refEnrolmentRequired';
    case 'academy.submission_incomplete': {
      const missing = /\bmissing=(\S+)/.exec(failure.message)?.[1];
      return missing === 'file'
        ? 'refSubmissionIncompleteFile'
        : missing === 'text'
          ? 'refSubmissionIncompleteText'
          : 'refSubmissionIncomplete';
    }
    case 'academy.assignment_not_found':
      return 'refAssignmentNotFound';
    case 'academy.assignment_closed':
      return 'refAssignmentClosed';
    case 'academy.submission_version_stale':
      return 'refSubmissionStale';
    case 'academy.upload_limits_unset':
      return 'refUploadLimitsUnset';
    case 'academy.upload_too_large':
      return 'refUploadTooLarge';
    case 'academy.upload_type_refused':
      return 'refUploadTypeRefused';
    case 'academy.file_type_mismatch':
      return 'refFileTypeMismatch';
    case 'academy.upload_incomplete':
      return 'refUploadIncomplete';
    case 'academy.peer_count_unset':
      return 'refPeerCountUnset';
    case 'academy.review_marks_invalid':
      return 'refReviewMarksInvalid';
    case 'academy.review_task_not_found':
      return 'refReviewTaskNotFound';
    case 'academy.review_already_sent':
      return 'refReviewAlreadySent';
    case 'academy.file_unavailable':
      return 'refFileUnavailable';
    case 'academy.submission_not_found':
      return 'refGradeNotFound';
    case 'academy.post_limit_unset':
      return 'refPostLimitUnset';
    case 'academy.post_too_long':
      return 'refPostTooLong';
    case 'academy.attachment_limit_unset':
      return 'refAttachmentLimitUnset';
    case 'academy.attachment_too_large':
      return 'refAttachmentTooLarge';
    case 'academy.attachment_type_refused':
      return 'refAttachmentTypeRefused';
    case 'academy.post_not_found':
      return 'refPostNotFound';
    case 'academy.permission_denied':
      return 'refPermissionDenied';
    case 'academy.topic_not_found':
      return 'refTopicNotFound';
    case 'academy.message_limit_unset':
      return 'refMessageLimitUnset';
    case 'academy.message_too_long':
      return 'refMessageTooLong';
    case 'academy.conversation_not_found':
      return 'refConversationNotFound';
    default:
      return null;
  }
}

/** The typed refusal in plain words in the language `t` speaks, or null when Academy did not type it. */
export function academyRefusalText(failure: Pick<Failure, 'code' | 'message'>, t: (typeof academyLmsCopy)['t']): string | null {
  const key = academyRefusalKey(failure);
  if (key === null) return null;
  if (key !== 'refPrerequisite') return t(key);
  const names = missingProgrammes(failure.message).map((slug) => (slug in pathCopyKeys ? t(pathCopyKeys[slug as AcademyPath]) : slug));
  return t(key, { programmes: names.join(', ') });
}
