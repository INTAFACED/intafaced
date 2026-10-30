/**
 * Reconciliation alerts (OPS-reconciliation-03, -04).
 *
 * svc-ops owns the alert store. It reads every settled evaluation from svc-ledger's `reconciliationEvaluations` door and
 * keeps one alert per control, failing asset, period and cause. A FAIL is a money discrepancy raised to finance; an ERROR
 * (the run could not finish) is raised to the platform team, never to finance. Acknowledge, snooze, resolve and accept never
 * change a balance or a freeze, and never turn a period green: a period is green only when its latest evaluation passed and
 * it has no open or acknowledged alert. A resolved alert reopens on a repeat failure in its period; a passing run of the
 * same control and period resolves it automatically.
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

/** A corrective transaction id the ledger has never booked. Nothing was changed. */
export const OPS_RESOLVE_TRANSACTION_NOT_FOUND = 'ops.resolve_transaction_not_found' as const;
/** Accepting a discrepancy needs a note. Nothing was changed and no approval was spent. */
export const OPS_RESOLVE_NOTE_REQUIRED = 'ops.resolve_note_required' as const;
/** svc-ops could not ask the ledger whether the corrective transactions exist (unwired, refused, timed out). Nothing was changed. */
export const OPS_RESOLVE_LEDGER_UNAVAILABLE = 'ops.resolve_ledger_unavailable' as const;

/** The four-eyes action a discrepancy acceptance spends. */
export const OPS_ALERT_ACCEPT_ACTION = 'ops.reconciliation_alert.accept' as const;
/** How many corrective transactions one fix may link. */
export const OPS_ALERT_CORRECTIVE_MAX = 20;

export const OPS_ALERT_KINDS = ['reconciliation'] as const;
/** `fail`: the books disagree. `error`: the run could not finish. */
export const OPS_ALERT_CAUSES = ['fail', 'error'] as const;
/** Who an alert is raised to: a FAIL to finance, an ERROR to the platform team. */
export const OPS_ALERT_TEAMS = ['finance', 'platform'] as const;
/** `fixed`: an operator linked the corrective ledger transactions. `auto`: a later run of the same control and period passed. */
export const OPS_ALERT_RESOLUTIONS = ['fixed', 'auto'] as const;
export const OPS_ALERT_RECORD_STATES = ['open', 'acknowledged', 'resolved', 'accepted'] as const;
/** What happened to the in-console notice when an alert opened or failed again. */
export const OPS_ALERT_NOTICE_OUTCOMES = ['sent', 'not_due', 'repeat_unset', 'snoozed'] as const;
export const OPS_ALERT_TIMELINE_KINDS = [
  'opened',
  'repeated',
  'acknowledged',
  'snoozed',
  'unsnoozed',
  'resolved',
  'accepted',
  'reopened',
] as const;

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
    /** Part of the fingerprint. A FAIL goes to finance; an ERROR to the platform team. */
    cause: z.enum(OPS_ALERT_CAUSES),
    team: z.enum(OPS_ALERT_TEAMS),
    /** The ERROR run's own code and phase; null for a FAIL. */
    error: z
      .object({ code: z.string().min(1), phase: z.string().min(1).nullable() })
      .strict()
      .nullable(),
    /** The fingerprint: one alert per control, failing asset, period and cause. No asset (a broken chain, an ERROR) is null. */
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
    /** Set while the alert is resolved; a reopen clears it, and the timeline keeps it. */
    resolved: z
      .object({
        resolution: z.enum(OPS_ALERT_RESOLUTIONS),
        /** The operator, or `auto`. */
        by: z.string().min(1),
        at: isoSchema,
        /** Each checked to exist in the ledger; empty for `auto`. */
        correctiveTxIds: z.array(z.string().guid()).max(OPS_ALERT_CORRECTIVE_MAX),
        passingRunId: z.string().uuid().nullable(),
        note: z.string().nullable(),
      })
      .strict()
      .nullable(),
    /**
     * Set once a discrepancy is accepted by two founders. The evidence is frozen at the hash both signed: a later failure with
     * the same figures changes nothing, and one with different figures opens a new alert.
     */
    accepted: z
      .object({
        requestedBy: z.string().min(1),
        approvedBy: z.string().min(1),
        at: isoSchema,
        note: z.string().min(1),
        evidenceHash: z.string().regex(/^[0-9a-f]{64}$/),
      })
      .strict()
      .nullable(),
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
    /** The corrective ledger transactions a `resolved` entry linked; empty otherwise. */
    txIds: z.array(z.string().guid()),
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

export const opsAlertResolveInputSchema = z
  .object({
    alertId: z.string().uuid(),
    correctiveTxIds: z.array(z.string().guid()).min(1).max(OPS_ALERT_CORRECTIVE_MAX),
    note: z.string().max(1000).optional(),
    idempotencyKey: keySchema,
  })
  .strict();
export type OpsAlertResolveInput = z.infer<typeof opsAlertResolveInputSchema>;

/** Runs a discrepancy acceptance two founders approved. The approval binds the alert, the note and the evidence hash. */
export const opsAlertAcceptInputSchema = z
  .object({
    alertId: z.string().uuid(),
    note: z.string().max(500),
    evidenceHash: z.string().regex(/^[0-9a-f]{64}$/),
    approvalId: z.string().min(1).max(200),
    operationId: z.string().min(1).max(200),
  })
  .strict();
export type OpsAlertAcceptInput = z.infer<typeof opsAlertAcceptInputSchema>;

/**
 * The text an acceptance freezes: the alert's period and failing asset's figures (observed, expected, difference, tolerance),
 * parsed by this contract so its keys always come in the same order, as JSON. The run id and read times are left out, so a
 * later run that fails with the same figures does not void an approval in flight. svc-ops and the console hash it with
 * SHA-256 (hex); the approval binds that hash.
 */
export function opsAlertEvidenceCanonical(evidence: unknown): string {
  const parsed = opsAlertSchema.shape.evidence.parse(evidence);
  return JSON.stringify({ periodStart: parsed.run.periodStart, periodEnd: parsed.run.periodEnd, asset: parsed.asset });
}

/** The approval fields an acceptance binds. svc-ops and the console hash `{ actionType, ...fields }` the same way. */
export function opsAlertAcceptFields(alertId: string, note: string, evidenceHash: string) {
  return { targetId: `reconciliation-alert:${alertId}`, note, evidenceHash };
}

/** A ledger reconciliation run that could not finish, as svc-ops received it from `ledger.reconciliation_run.failed`. */
export const opsPlatformIncidentSchema = z
  .object({
    /** The event's business key: the same event delivered twice is one incident. */
    eventKey: z.string().min(1),
    team: z.literal('platform'),
    errorCode: z.string().min(1),
    phase: z.string().min(1),
    consecutiveIncomplete: z.number().int().min(1),
    /** The ledger's own reconcile run id, when it had one. Not a control run. */
    ledgerRunId: z.string().nullable(),
    occurredAt: isoSchema,
    receivedAt: isoSchema,
  })
  .strict();
export type OpsPlatformIncident = z.infer<typeof opsPlatformIncidentSchema>;

export const opsPlatformIncidentsInputSchema = z.object({ limit: z.number().int().min(1).max(OPS_ALERT_LIST_MAX) }).strict();
export const opsPlatformIncidentsSchema = z
  .object({
    /** Whether svc-ops is attached to the event bus now; detached, nothing new arrives and the list says so. */
    bus: z.enum(['attached', 'detached']),
    incidents: z.array(opsPlatformIncidentSchema),
  })
  .strict();
export type OpsPlatformIncidents = z.infer<typeof opsPlatformIncidentsSchema>;

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
