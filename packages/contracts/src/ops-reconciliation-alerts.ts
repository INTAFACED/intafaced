/**
 * Reconciliation alerts (OPS-reconciliation-03).
 *
 * svc-ops owns the alert store. It reads every settled evaluation from svc-ledger's `reconciliationEvaluations` door and
 * keeps one alert per control, failing asset and period. Acknowledge and snooze never change a balance or a freeze, and
 * never turn a period green: a period is green only when its latest evaluation passed and it has no open or acknowledged alert.
 */

import { z } from 'zod';
import {
  reconciliationAssetEvidenceSchema,
  reconciliationControlRunSchema,
  reconciliationSeveritySetSchema,
} from './ledger-reconciliation.js';

export const OPS_ALERT_NOT_FOUND = 'ops.alert_not_found' as const;
/** The move does not fit the alert's state, or another founder moved it first. The stored alert is unchanged. */
export const OPS_ALERT_STATE_ILLEGAL = 'ops.alert_state_illegal' as const;
/** No owner value for how often a still-failing alert may notify again. Nothing is re-sent; the alert still counts. */
export const OPS_ALERT_REPEAT_UNSET = 'ops.alert_repeat_unset' as const;
/** svc-ops could not read the ledger's evaluations (unwired, refused, timed out or malformed). Never an empty list. */
export const OPS_ALERT_SOURCE_UNAVAILABLE = 'ops.alert_source_unavailable' as const;
/** An acknowledgement needs a note. */
export const OPS_ALERT_NOTE_REQUIRED = 'ops.alert_note_required' as const;
/** A snooze must end after it starts. */
export const OPS_ALERT_SNOOZE_END_INVALID = 'ops.alert_snooze_end_invalid' as const;

export const OPS_ALERT_KINDS = ['reconciliation'] as const;
export const OPS_ALERT_RECORD_STATES = ['open', 'acknowledged', 'resolved', 'accepted'] as const;
/** What happened to the in-console notice when an alert opened or failed again. */
export const OPS_ALERT_NOTICE_OUTCOMES = ['sent', 'not_due', 'repeat_unset', 'snoozed'] as const;
export const OPS_ALERT_TIMELINE_KINDS = ['opened', 'repeated', 'acknowledged', 'snoozed', 'unsnoozed'] as const;

export const OPS_ALERT_LIST_MAX = 200;

const isoSchema = z.string().datetime({ offset: true });
const keySchema = z.string().min(8).max(200);

export const opsAlertSnoozeSchema = z
  .object({
    id: z.string().uuid(),
    startsAt: isoSchema,
    endsAt: isoSchema,
    by: z.string().min(1),
    reason: z.string().nullable(),
    /** Set when a later snooze replaced it or it was lifted; an expired snooze stays readable. */
    expiredAt: isoSchema.nullable(),
  })
  .strict();
export type OpsAlertSnooze = z.infer<typeof opsAlertSnoozeSchema>;

export const opsAlertSchema = z
  .object({
    id: z.string().uuid(),
    kind: z.enum(OPS_ALERT_KINDS),
    state: z.enum(OPS_ALERT_RECORD_STATES),
    /** The fingerprint: one alert per control, failing asset and period. A failure with no asset (a broken chain) is null. */
    controlId: z.string().uuid(),
    assetId: z.string().nullable(),
    periodStart: isoSchema,
    periodEnd: isoSchema,
    severity: reconciliationSeveritySetSchema,
    occurrences: z.number().int().min(1),
    firstSeen: isoSchema,
    lastSeen: isoSchema,
    /** The latest failing evaluation: both sides with their as-of times, and this asset's figures as decimal strings. */
    evidence: z
      .object({
        run: reconciliationControlRunSchema.pick({
          id: true,
          status: true,
          asOf: true,
          readAt: true,
          sources: true,
          outsideSide: true,
          periodStart: true,
          periodEnd: true,
        }),
        finishedAt: isoSchema,
        asset: reconciliationAssetEvidenceSchema.nullable(),
      })
      .strict(),
    acknowledged: z
      .object({ by: z.string().min(1), at: isoSchema, note: z.string().min(1) })
      .strict()
      .nullable(),
    /** The snooze in force now, if any. It mutes notices only; the alert still counts. */
    snooze: opsAlertSnoozeSchema.nullable(),
    notices: z
      .object({
        sent: z.number().int().nonnegative(),
        lastSentAt: isoSchema.nullable(),
        repeat: z.union([
          z.object({ status: z.literal('set'), seconds: z.number().int().nonnegative(), nextDueAt: isoSchema.nullable() }).strict(),
          z.object({ status: z.literal('unset'), code: z.literal(OPS_ALERT_REPEAT_UNSET) }).strict(),
        ]),
        /** Notices that leave the platform are not built; each names its vendor code. */
        outside: z.object({ email: z.literal('vendor.email'), push: z.literal('vendor.push') }).strict(),
      })
      .strict(),
    version: z.number().int().min(1),
  })
  .strict();
export type OpsAlert = z.infer<typeof opsAlertSchema>;

export const opsAlertTimelineEntrySchema = z
  .object({
    id: z.string().regex(/^[1-9]\d*$/),
    at: isoSchema,
    kind: z.enum(OPS_ALERT_TIMELINE_KINDS),
    actor: z.string().min(1),
    note: z.string().nullable(),
    runId: z.string().uuid().nullable(),
    notice: z.enum(OPS_ALERT_NOTICE_OUTCOMES).nullable(),
    snoozeId: z.string().uuid().nullable(),
  })
  .strict();
export type OpsAlertTimelineEntry = z.infer<typeof opsAlertTimelineEntrySchema>;

/** Where svc-ops last read the ledger's evaluations. A failed read names its code; the list never reads it as empty. */
export const opsAlertSourceSchema = z.union([
  z.object({ status: z.literal('ok'), readAt: isoSchema }).strict(),
  z.object({ status: z.literal('never_read') }).strict(),
  z
    .object({
      status: z.literal('unavailable'),
      code: z.literal(OPS_ALERT_SOURCE_UNAVAILABLE),
      message: z.string(),
      since: isoSchema,
      lastOkAt: isoSchema.nullable(),
    })
    .strict(),
]);
export type OpsAlertSource = z.infer<typeof opsAlertSourceSchema>;

export const opsAlertCursorSchema = z.object({ lastSeen: isoSchema, id: z.string().uuid() }).strict();
export type OpsAlertCursor = z.infer<typeof opsAlertCursorSchema>;

export const opsAlertListInputSchema = z
  .object({
    /** Null reads from the newest. Newest first on (lastSeen, id). */
    after: opsAlertCursorSchema.nullable(),
    limit: z.number().int().min(1).max(OPS_ALERT_LIST_MAX),
    state: z.enum(OPS_ALERT_RECORD_STATES).optional(),
  })
  .strict();
export type OpsAlertListInput = z.infer<typeof opsAlertListInputSchema>;

export const opsAlertListSchema = z
  .object({
    source: opsAlertSourceSchema,
    alerts: z.array(opsAlertSchema),
    /** The cursor for the next page, or null when this page was the last. */
    next: opsAlertCursorSchema.nullable(),
  })
  .strict();
export type OpsAlertList = z.infer<typeof opsAlertListSchema>;

export const opsAlertGetInputSchema = z.object({ alertId: z.string().uuid() }).strict();
export const opsAlertDetailSchema = z
  .object({
    source: opsAlertSourceSchema,
    alert: opsAlertSchema,
    /** Append-only, oldest first. */
    timeline: z.array(opsAlertTimelineEntrySchema),
    /** Every snooze the alert ever had, newest first, expired ones included. */
    snoozes: z.array(opsAlertSnoozeSchema),
  })
  .strict();
export type OpsAlertDetail = z.infer<typeof opsAlertDetailSchema>;

export const opsAlertAcknowledgeInputSchema = z
  .object({ alertId: z.string().uuid(), note: z.string().max(1000), idempotencyKey: keySchema })
  .strict();
export type OpsAlertAcknowledgeInput = z.infer<typeof opsAlertAcknowledgeInputSchema>;

export const opsAlertSnoozeInputSchema = z
  .object({ alertId: z.string().uuid(), endsAt: isoSchema, reason: z.string().max(500).optional(), idempotencyKey: keySchema })
  .strict();
export type OpsAlertSnoozeInput = z.infer<typeof opsAlertSnoozeInputSchema>;

export const opsAlertUnsnoozeInputSchema = z.object({ alertId: z.string().uuid(), idempotencyKey: keySchema }).strict();
export type OpsAlertUnsnoozeInput = z.infer<typeof opsAlertUnsnoozeInputSchema>;

export const opsReconciliationPeriodsInputSchema = z
  .object({ controlId: z.string().uuid().optional(), limit: z.number().int().min(1).max(OPS_ALERT_LIST_MAX) })
  .strict();
export type OpsReconciliationPeriodsInput = z.infer<typeof opsReconciliationPeriodsInputSchema>;

export const opsReconciliationPeriodSchema = z
  .object({
    controlId: z.string().uuid(),
    periodStart: isoSchema,
    periodEnd: isoSchema,
    evaluations: z.number().int().min(1),
    lastRunId: z.string().uuid(),
    lastStatus: reconciliationControlRunSchema.shape.status,
    open: z.number().int().nonnegative(),
    acknowledged: z.number().int().nonnegative(),
    /** True only when the latest evaluation passed and no alert in the period is open or acknowledged. An ERROR or UNSET period is never green. */
    green: z.boolean(),
  })
  .strict();
export type OpsReconciliationPeriod = z.infer<typeof opsReconciliationPeriodSchema>;

export const opsReconciliationPeriodsSchema = z
  .object({ source: opsAlertSourceSchema, periods: z.array(opsReconciliationPeriodSchema) })
  .strict();
export type OpsReconciliationPeriods = z.infer<typeof opsReconciliationPeriodsSchema>;
