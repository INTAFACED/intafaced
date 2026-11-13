import { z } from 'zod';
import { ACADEMY_LEARNER_TAG_PATTERN } from './academy-learner-desk.js';

/**
 * AC-analytics-01 and AC-analytics-02 (J-academy-16): what the founder console reads about learning, and the reports
 * centre. Operator only (`admin:read`, `admin:write` with module academy). No money moves here.
 *
 * Learner summaries are one row per learner with an open enrolment: how many enrolments they hold, how many items they
 * have completed and when they were last active. Their page size is an owner value: blank refuses
 * `academy.learner_summaries_list_limit_unset`.
 *
 * A report is a task: requested, then run by the service's report sweep (queued, running, then done or failed), and
 * staff can abort it while it waits or runs, download its stored file once done, and delete it. The file is a CSV with
 * its time and the SHA-256 of its bytes, kept for the owner's retention period; after it a download refuses
 * `academy.report_expired`. A founder's requests are numbered (`report:<kind>:<founder>:<n>`), so a retried request
 * answers the task it made the first time and never makes a second.
 */
const isoInstant = z.string().datetime({ offset: true });
const utcDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/** Learner tags, as the learner desk writes them (AC-enrolment-03). */
const tag = z.string().trim().regex(ACADEMY_LEARNER_TAG_PATTERN);

export const academyLearnerSummariesInputSchema = z
  .object({
    tag: tag.optional(),
    /** The last learner id of the page before; omitted for the first page. */
    after: z.string().guid().optional(),
  })
  .strict();
export type AcademyLearnerSummariesInput = z.infer<typeof academyLearnerSummariesInputSchema>;

export const academyLearnerSummarySchema = z.object({
  userId: z.string().guid(),
  /** Open enrolments: curriculum paths and courses staff made. */
  enrolments: z.number().int().min(0),
  itemsCompleted: z.number().int().min(0),
  /** The newest lesson read, completion or enrolment; null when none is recorded. */
  lastActiveAt: isoInstant.nullable(),
  tags: z.array(z.string()),
});
export type AcademyLearnerSummary = z.infer<typeof academyLearnerSummarySchema>;

export const academyLearnerSummariesSchema = z.object({
  tag: z.string().nullable(),
  pageSize: z.number().int().positive(),
  rows: z.array(academyLearnerSummarySchema),
  /** Pass as `after` for the next page; null on the last one. */
  next: z.string().guid().nullable(),
});
export type AcademyLearnerSummaries = z.infer<typeof academyLearnerSummariesSchema>;

/** The daily activity table (`admin.opsMetrics`): a day before `recordingSince` was not recorded, so it has no figure. */
export const academyMetricCellSchema = z.object({
  value: z.number().int().min(0).nullable(),
  reason: z.enum(['metric_not_recorded']).nullable(),
});
export const academyOpsMetricsSchema = z.object({
  from: utcDay,
  to: utcDay,
  /** The first UTC day the service recorded learning activity on. */
  recordingSince: utcDay,
  days: z.array(
    z.object({
      date: utcDay,
      lessonsRead: academyMetricCellSchema,
      completions: academyMetricCellSchema,
      grants: academyMetricCellSchema,
    }),
  ),
});
export type AcademyOpsMetrics = z.infer<typeof academyOpsMetricsSchema>;

export const ACADEMY_REPORT_CENTRE_KINDS = ['learners'] as const;
export const ACADEMY_REPORT_CENTRE_STATES = ['queued', 'running', 'done', 'aborted', 'failed'] as const;

export const academyReportCentreTaskSchema = z.object({
  id: z.string().guid(),
  n: z.number().int().positive(),
  kind: z.enum(ACADEMY_REPORT_CENTRE_KINDS),
  /** The learner tag the report is filtered by; null for every learner. */
  tag: z.string().nullable(),
  state: z.enum(ACADEMY_REPORT_CENTRE_STATES),
  requestedBy: z.string().guid(),
  requestedAt: isoInstant,
  startedAt: isoInstant.nullable(),
  finishedAt: isoInstant.nullable(),
  /** When a finished file is no longer served. */
  expiresAt: isoInstant.nullable(),
  /** True once `expiresAt` has passed: the file is gone. */
  expired: z.boolean(),
  rows: z.number().int().min(0).nullable(),
  sha256: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .nullable(),
  /** Why a failed task failed, as a refusal code. */
  failure: z.string().nullable(),
});
export type AcademyReportCentreTask = z.infer<typeof academyReportCentreTaskSchema>;

export const academyReportCentreTasksSchema = z.object({
  pageSize: z.number().int().positive(),
  /** Every task not deleted, newest first, up to the page size. */
  tasks: z.array(academyReportCentreTaskSchema),
  /** The number the signed-in founder's next request takes. */
  nextN: z.number().int().positive(),
});
export type AcademyReportCentreTasks = z.infer<typeof academyReportCentreTasksSchema>;

export const academyRequestReportInputSchema = z
  .object({
    kind: z.enum(ACADEMY_REPORT_CENTRE_KINDS),
    tag: tag.nullable(),
    /** The founder's next request number as the desk read it. */
    n: z.number().int().positive(),
  })
  .strict();
export type AcademyRequestReportInput = z.infer<typeof academyRequestReportInputSchema>;

export const academyReportTaskInputSchema = z.object({ taskId: z.string().guid() }).strict();
export type AcademyReportTaskInput = z.infer<typeof academyReportTaskInputSchema>;

export const academyReportCentreFileSchema = academyReportCentreTaskSchema.extend({ csv: z.string() });
export type AcademyReportCentreFile = z.infer<typeof academyReportCentreFileSchema>;

/** `admin.deleteReport`: the task is off the list and its file is gone. */
export const academyReportDeletedSchema = z.object({ taskId: z.string().guid(), deleted: z.literal(true) });
export type AcademyReportDeleted = z.infer<typeof academyReportDeletedSchema>;
