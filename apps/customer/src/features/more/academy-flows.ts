import { z } from 'zod';
import type { ApiClient, ApiResult } from '../../shared/api';
import { publicCertCode, type AcademyPath } from './academy-lms';
import type { academyLmsCopy } from './academy-lms-copy';

/**
 * The Academy procedures behind assessments, public certificate checks and programme enrolments, with the answers
 * checked against what was asked. Nothing here invents a field: a reply that does not match is a failed read.
 *
 * Procedures (svc-academy router): assessment.get, assessment.submit, assessment.attempts, certVerify (public),
 * myEnrollments, enrollCertPath, leaveCertPath.
 */

type Failure = Extract<ApiResult<never>, { ok: false }>;
const isoDate = z.string().datetime({ offset: true });
const ref = z.string().min(1);

// ---------------------------------------------------------------- assessments

const question = z
  .object({
    id: ref,
    prompt: ref,
    kind: z.literal('single'),
    points: z.number().int().positive(),
    choices: z.array(z.object({ id: ref, text: ref })).min(2),
  })
  .refine((q) => new Set(q.choices.map((c) => c.id)).size === q.choices.length);
export type AssessmentQuestion = z.infer<typeof question>;

/** The published questions for one lesson. The service never sends the answer key. */
export function assessmentFor(slug: string) {
  return z
    .object({ slug: ref, kind: z.literal('quiz'), passMark: z.number().int().nonnegative(), questions: z.array(question).min(1).max(100) })
    .refine((view) => view.slug === slug && new Set(view.questions.map((q) => q.id)).size === view.questions.length);
}
export type Assessment = z.infer<ReturnType<typeof assessmentFor>>;

export const maxScoreOf = (assessment: Pick<Assessment, 'questions'>) => assessment.questions.reduce((sum, q) => sum + q.points, 0);

/** One scored attempt, as submit and attempts both return it. */
export function attemptFor(slug: string) {
  return z
    .object({
      slug: ref,
      score: z.number().int().nonnegative(),
      maxScore: z.number().int().nonnegative(),
      pass: z.boolean(),
      submittedAt: isoDate,
    })
    .refine((attempt) => attempt.slug === slug && attempt.score <= attempt.maxScore);
}
export type Attempt = z.infer<ReturnType<typeof attemptFor>>;
export const attemptsFor = (slug: string) => z.array(attemptFor(slug));

export const readAssessment = (api: ApiClient, slug: string, signal?: AbortSignal) =>
  api.query('academy', 'assessment.get', { slug }, assessmentFor(slug), { signal });
export const readAttempts = (api: ApiClient, slug: string, signal?: AbortSignal) =>
  api.query('academy', 'assessment.attempts', { slug }, attemptsFor(slug), { signal });

/** One reference per answering session. The service stores one attempt per reference, so a resend cannot count twice. */
export const newAttemptId = () => `attempt-${crypto.randomUUID()}`;

export type SubmitOutcome =
  /** Academy replied with the score. */
  | { kind: 'scored'; attempt: Attempt }
  /** The reply never arrived. Nothing is known about this attempt until the same reference is sent again. */
  | { kind: 'unconfirmed'; failure: Failure }
  /** Academy refused the submission in words (attempt limit, cooldown, answers that do not match). */
  | { kind: 'refused'; failure: Failure };

/**
 * Send answers under one attempt reference. A reply that never arrives (connection dropped, gateway error) is never
 * guessed at from the attempt history: its rows carry no reference, so another tab's attempt could be mistaken for this
 * one. The caller keeps the reference and sends the same answers again; the service answers a repeated reference with
 * the row it stored for it, without scoring again and before any attempt-limit or cooldown check.
 */
export async function submitAssessment(
  api: ApiClient,
  input: { slug: string; clientAttemptId: string; answers: readonly { questionId: string; choiceId: string }[] },
): Promise<SubmitOutcome> {
  const result = await api.mutate(
    'academy',
    'assessment.submit',
    { slug: input.slug, clientAttemptId: input.clientAttemptId, answers: input.answers },
    attemptFor(input.slug),
  );
  if (result.ok) return { kind: 'scored', attempt: result.data };
  if (result.reason !== 'uncertain') return { kind: 'refused', failure: result };
  return { kind: 'unconfirmed', failure: result };
}

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

const enrolmentRow = z.object({ userId: z.string().uuid(), pathSlug: ref, enrolledAt: isoDate });
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

/** Programme names from "academy.prerequisite_unmet missing=foundations,markets". */
export function missingProgrammes(message: string): string[] {
  const list = /\bmissing=([a-z0-9,-]+)/.exec(message)?.[1];
  return list ? list.split(',').filter(Boolean) : [];
}

export type RefusalKey =
  | 'refAssessmentUnpublished'
  | 'refPassMarkUnset'
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
  | 'refRequestReused';

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
