import { z } from 'zod';
import { ACADEMY_CURRICULUM_PATHS } from './academy-catalogue.js';

/**
 * J-academy-15: staff enrol people in bulk, invite an address, write to a course, and export learners by tag
 * (AC-enrolment-02, AC-enrolment-03, AC-notifications-02, AC-analytics-02).
 *
 * Operator procedures on svc-academy's admin router: reads need `admin:read`, changes `admin:write`, each with module
 * academy; the actor is the caller's own id from the edge-signed principal. Addresses are resolved to accounts by the
 * console through identity's exact lookup; an invitation keeps only a hash and a masked form. This build has no email
 * provider, so invitation and course mail name `vendor.email` and nobody is ever marked sent. No money moves.
 */

const isoInstant = z.string().datetime({ offset: true });
const account = z.string().guid();
const course = z.enum(ACADEMY_CURRICULUM_PATHS);
/** A reason as typed; blank is refused by svc-academy with `academy.reason_required`, never defaulted. */
const reasonAsTyped = z.string().max(500);
const requestKey = z.string().trim().min(1).max(200);
const tagName = z
  .string()
  .trim()
  .regex(/^[a-z0-9][a-z0-9-]{0,39}$/);

export const ACADEMY_ENROLMENT_BYPASSES = ['unpublished', 'hidden', 'window_not_started', 'window_ended', 'full'] as const;
export const ACADEMY_BULK_ROW_CODES = [
  'academy.address_invalid',
  'academy.learner_not_found',
  'academy.duplicate_address',
  'academy.prerequisite_unmet',
] as const;

export const academyStaffEnrolmentEventSchema = z.object({
  key: z.string(),
  path: z.string(),
  userId: account,
  source: z.enum(['staff', 'bulk']),
  bypassed: z.array(z.enum(ACADEMY_ENROLMENT_BYPASSES)),
  reason: z.string(),
  actorId: account,
  at: isoInstant,
});
export type AcademyStaffEnrolmentEvent = z.infer<typeof academyStaffEnrolmentEventSchema>;

/** `admin.staffEnrol`: one learner, past whatever closes the course, with the reason. */
export const academyStaffEnrolInputSchema = z.object({ path: course, userId: account, reason: reasonAsTyped }).strict();
export const academyStaffEnrolSchema = z.object({
  outcome: z.enum(['enrolled', 'already_enrolled']),
  event: academyStaffEnrolmentEventSchema.nullable(),
});

/** `admin.staffEnrolments`: the newest staff enrolments. */
export const academyStaffEnrolmentsInputSchema = z.object({ path: course.optional(), userId: account.optional() }).strict();
export const academyStaffEnrolmentsSchema = z.array(academyStaffEnrolmentEventSchema);

/** `admin.bulkEnrol`: one upload, each address with the account identity's lookup found for it (null: none). */
export const academyBulkEnrolInputSchema = z
  .object({
    path: course,
    rows: z
      .array(z.object({ address: z.string().max(320), userId: account.nullable() }).strict())
      .min(1)
      .max(1000),
    reason: reasonAsTyped,
  })
  .strict();
export const academyBulkEnrolSchema = z.object({
  key: z.string(),
  path: z.string(),
  rows: z.array(
    z.object({
      address: z.string(),
      outcome: z.enum(['enrolled', 'already_enrolled', 'refused']),
      code: z.enum(ACADEMY_BULK_ROW_CODES).nullable(),
      userId: account.nullable(),
    }),
  ),
  replayed: z.boolean(),
  /** A bulk enrolment sends no mail. */
  mail: z.literal('none'),
  at: isoInstant,
});
export type AcademyBulkEnrol = z.infer<typeof academyBulkEnrolSchema>;

/** `admin.inviteToCourse` and `admin.courseInvitations`. */
export const academyInviteToCourseInputSchema = z.object({ path: course, address: z.string().max(320), reason: reasonAsTyped }).strict();
export const academyCourseInvitationSchema = z.object({
  key: z.string(),
  path: z.string(),
  addressMask: z.string(),
  reason: z.string(),
  invitedBy: account,
  at: isoInstant,
  mail: z.literal('vendor.email'),
});
export type AcademyCourseInvitation = z.infer<typeof academyCourseInvitationSchema>;
export const academyInviteToCourseSchema = academyCourseInvitationSchema.extend({ replayed: z.boolean() });
export const academyCourseInvitationsInputSchema = z.object({ path: course.optional() }).strict();
export const academyCourseInvitationsSchema = z.array(academyCourseInvitationSchema);

/** A learner's own course email switch (`courseEmails`, `setCourseEmails`). */
export const academyCourseEmailsInputSchema = z.object({ slug: course }).strict();
export const academySetCourseEmailsInputSchema = z.object({ slug: course, on: z.boolean() }).strict();
export const academyCourseEmailsSchema = z.object({ path: z.string(), on: z.boolean() });

export const ACADEMY_BULK_EMAIL_RECIPIENT_STATES = ['not_sent', 'sent', 'skipped_opted_out', 'skipped_inactive'] as const;
export const academyBulkEmailSchema = z.object({
  id: z.string().guid(),
  key: z.string(),
  path: z.string(),
  subject: z.string(),
  inactiveDays: z.number().int().positive(),
  state: z.enum(['refused', 'sent']),
  refusal: z.literal('vendor.email').nullable(),
  actorId: account,
  at: isoInstant,
  counts: z.object({
    not_sent: z.number().int().nonnegative(),
    sent: z.number().int().nonnegative(),
    skipped_opted_out: z.number().int().nonnegative(),
    skipped_inactive: z.number().int().nonnegative(),
  }),
});
export type AcademyBulkEmail = z.infer<typeof academyBulkEmailSchema>;
export const academyBulkEmailDetailSchema = academyBulkEmailSchema.extend({
  recipients: z.array(z.object({ userId: account, state: z.enum(ACADEMY_BULK_EMAIL_RECIPIENT_STATES) })),
});
export type AcademyBulkEmailDetail = z.infer<typeof academyBulkEmailDetailSchema>;

/** `admin.sendBulkEmail`: keyed `mail:<course>:<n>` by the console, n the next number in the course's history. */
export const academySendBulkEmailInputSchema = z
  .object({ path: course, subject: z.string().max(200), body: z.string().max(20_000), key: requestKey })
  .strict();
export const academySendBulkEmailSchema = academyBulkEmailDetailSchema.extend({ replayed: z.boolean() });
export const academyBulkEmailsInputSchema = z.object({ path: course.optional() }).strict();
export const academyBulkEmailsSchema = z.array(academyBulkEmailSchema);
export const academyBulkEmailInputSchema = z.object({ id: z.string().guid() }).strict();

export const ACADEMY_REPORT_TASK_STATES = ['queued', 'running', 'done', 'failed'] as const;
export const academyReportTaskSchema = z.object({
  id: z.string().guid(),
  key: z.string(),
  kind: z.literal('learners'),
  tag: z.string().nullable(),
  requestedBy: account,
  state: z.enum(ACADEMY_REPORT_TASK_STATES),
  rows: z.number().int().nonnegative().nullable(),
  sha256: z.string().nullable(),
  failure: z.string().nullable(),
  requestedAt: isoInstant,
  finishedAt: isoInstant.nullable(),
  expiresAt: isoInstant.nullable(),
  expired: z.boolean(),
});
export type AcademyReportTask = z.infer<typeof academyReportTaskSchema>;

/** `admin.requestLearnerExport`: keyed `report:learners:<tag>:<n>` by the console, one per press of Request. */
export const academyRequestLearnerExportInputSchema = z.object({ tag: tagName.nullable(), key: requestKey }).strict();
export const academyRequestLearnerExportSchema = academyReportTaskSchema.extend({ replayed: z.boolean() });
export const academyReportTasksSchema = z.array(academyReportTaskSchema);
export const academyReportFileInputSchema = z.object({ id: z.string().guid() }).strict();
export const academyReportFileSchema = academyReportTaskSchema.extend({ csv: z.string() });
export type AcademyReportFile = z.infer<typeof academyReportFileSchema>;
