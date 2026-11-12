import type {
  AcademyBulkEmail,
  AcademyBulkEmailDetail,
  AcademyCourseInvitation,
  AcademyReportTask,
  AcademyStaffEnrolmentEvent,
} from '@intafaced/contracts/academy-staff-enrolment';
import type { Part } from '@/lib/desk/part';
import type { RefusalView } from '@/lib/desk/refusal-copy';

/**
 * Staff enrolment, invitations, course email and learner exports (J-academy-15). Pure, so the server loader, the route
 * and the browser components share it.
 */
export type { AcademyBulkEmail, AcademyBulkEmailDetail, AcademyCourseInvitation, AcademyReportTask, AcademyStaffEnrolmentEvent };

export const COURSES = [
  { slug: 'foundations', title: 'Foundations' },
  { slug: 'markets', title: 'Markets' },
  { slug: 'builder', title: 'Builder' },
  { slug: 'sovereign', title: 'Sovereign' },
] as const;
export const courseTitle = (slug: string) => COURSES.find((c) => c.slug === slug)?.title ?? slug;

export const BYPASS_WORDS: Record<string, string> = {
  full: 'the course was full',
  hidden: 'the course is hidden',
  unpublished: 'the course is unpublished',
  window_not_started: 'enrolment had not opened',
  window_ended: 'enrolment had closed',
};

export const ROW_CODE_WORDS: Record<string, string> = {
  'academy.address_invalid': 'Not an email address.',
  'academy.learner_not_found': 'No account has this address. Invite it instead.',
  'academy.duplicate_address': 'This address is already in the upload.',
  'academy.prerequisite_unmet': 'The learner has not met this course’s prerequisites.',
};

export const RECIPIENT_WORDS: Record<string, string> = {
  not_sent: 'Not sent',
  sent: 'Sent',
  skipped_opted_out: 'Left out: opted out of this course’s email',
  skipped_inactive: 'Left out: inactive',
};

/** The allowlisted words for a mail that needs an email provider (`vendor.email`). */
export const MAIL_NOT_CONNECTED = (action: string) => `${action} needs an email provider. It is switched off in this build.`;

export interface EnrolmentView {
  readonly events: Part<AcademyStaffEnrolmentEvent[]>;
  readonly invitations: Part<AcademyCourseInvitation[]>;
  readonly tags: Part<Array<{ tag: string; learners: number }>>;
  readonly asOf: string;
}

export interface MailView {
  readonly history: Part<AcademyBulkEmail[]>;
  readonly detail: Part<AcademyBulkEmailDetail> | null;
  readonly asOf: string;
}

export interface ReportsView {
  readonly tasks: Part<AcademyReportTask[]>;
  readonly tags: Part<Array<{ tag: string; learners: number }>>;
  readonly asOf: string;
}

export type EnrolmentReply =
  | { readonly ok: true; readonly what: string; readonly data?: unknown }
  | {
      readonly ok: false;
      readonly title: string;
      readonly body: string;
      readonly next: string;
      readonly code: string | null;
      readonly changed: 'no' | 'unknown';
    };

/** These pages' own words for svc-academy's codes; the rest come from the shared catalogue. */
export const ENROLMENT_COPY: Record<string, Omit<RefusalView, 'code' | 'changed'>> = {
  'academy.reason_required': {
    title: 'A reason is required',
    body: 'Every staff enrolment, invitation and tag keeps who made it and why, so one with no reason is refused.',
    next: 'Say why, then try again. Nothing was changed.',
  },
  'academy.bulk_limit_unset': {
    title: 'Bulk upload limit not set',
    body: 'How many addresses one upload may hold is the owner’s value, and it is not set, so bulk enrolment is refused.',
    next: 'Nothing was changed. The owner sets the limit (ACADEMY_BULK_ENROL_ROWS).',
  },
  'academy.bulk_limit_exceeded': {
    title: 'Too many addresses',
    body: 'This upload holds more addresses than the owner’s limit for one upload.',
    next: 'Nothing was changed. Split the list and upload each part.',
  },
  'academy.address_invalid': {
    title: 'Not an email address',
    body: 'An invitation needs a whole email address.',
    next: 'Nothing was changed. Correct the address and try again.',
  },
  'academy.learner_not_found': {
    title: 'No such learner',
    body: 'No account has that email or handle.',
    next: 'Nothing was changed. Check it, or invite the address instead.',
  },
  'academy.prerequisite_unmet': {
    title: 'Prerequisites not met',
    body: 'The learner has not met this course’s prerequisites; a staff enrolment does not go past them.',
    next: 'Nothing was changed.',
  },
  'academy.inactivity_period_unset': {
    title: 'Inactivity period not set',
    body: 'A course email leaves out learners with no learning for longer than the owner’s inactivity period, and that period is not set, so the email is refused.',
    next: 'Nothing was written. The owner sets the period (ACADEMY_BULK_EMAIL_INACTIVE_DAYS).',
  },
  'academy.email_incomplete': {
    title: 'Subject and message are required',
    body: 'A course email needs a subject and a message.',
    next: 'Nothing was written. Fill in both and try again.',
  },
  'academy.audience_empty': {
    title: 'Nobody to write to',
    body: 'No learner is enrolled in this course.',
    next: 'Nothing was written.',
  },
  'academy.report_retention_unset': {
    title: 'Report retention not set',
    body: 'How long a finished export is kept is the owner’s value, and it is not set, so the export is refused.',
    next: 'Nothing was requested. The owner sets it (ACADEMY_REPORT_RETENTION_HOURS).',
  },
  'academy.report_limit_unset': {
    title: 'Report size limit not set',
    body: 'How many learners one export may hold is the owner’s value, and it is not set, so the export is refused.',
    next: 'Nothing was requested. The owner sets it (ACADEMY_LEARNER_EXPORT_ROWS).',
  },
  'academy.report_not_ready': {
    title: 'Not finished',
    body: 'This export has not finished, or did not finish.',
    next: 'Read the list again.',
  },
  'academy.report_expired': {
    title: 'Expired',
    body: 'This export passed the owner’s retention period and is no longer served.',
    next: 'Request a new export.',
  },
  'academy.permission_denied': {
    title: 'Not permitted: this session may only read',
    body: 'Your role can read these pages but not change anything.',
    next: 'Ask someone with the Academy write permission. Nothing was changed.',
  },
};
