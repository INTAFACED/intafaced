/**
 * OPS ALERT RULES — the shape of a platform alert rule (OPS-alerts-01).
 *
 * A rule watches one internal signal, a metric id in `ANALYTICS_METRICS_V0`,
 * never an outside data source. Every limit, threshold, interval and
 * retention period is a blank owner value: the input fields are optional so a
 * blank reaches svc-ops' typed refusal (`ops.alert_threshold_unset`) instead of
 * a bare "Required", and nothing here picks a number.
 *
 * Browser-safe: zod and string helpers only, no hashing.
 */

import { z } from 'zod';

export const OPS_ALERT_THRESHOLD_UNSET = 'ops.alert_threshold_unset' as const;
export const OPS_ALERT_INTERVAL_UNSET = 'ops.alert_interval_unset' as const;
export const OPS_ALERT_LABELS_DUPLICATE = 'ops.alert_labels_duplicate' as const;
export const OPS_ALERT_FORBIDDEN = 'ops.alert_forbidden' as const;
export const OPS_ALERT_SIGNAL_UNKNOWN = 'ops.alert_signal_unknown' as const;
export const OPS_ALERT_HISTORY_RETENTION_UNSET = 'ops.alert_history_retention_unset' as const;

export const OPS_ALERT_REFUSAL_CODES = [
  OPS_ALERT_THRESHOLD_UNSET,
  OPS_ALERT_INTERVAL_UNSET,
  OPS_ALERT_LABELS_DUPLICATE,
  OPS_ALERT_FORBIDDEN,
  OPS_ALERT_SIGNAL_UNKNOWN,
  OPS_ALERT_HISTORY_RETENTION_UNSET,
] as const;
export type OpsAlertRefusalCode = (typeof OPS_ALERT_REFUSAL_CODES)[number];

/** normal -> pending (condition true, waiting out the pending period) -> firing. */
export const OPS_ALERT_STATES = ['normal', 'pending', 'firing'] as const;
export type OpsAlertState = (typeof OPS_ALERT_STATES)[number];

/** Whether the last check itself worked. A failed or empty check is never read as normal. */
export const OPS_ALERT_HEALTH = ['ok', 'error', 'no_data'] as const;
export type OpsAlertHealth = (typeof OPS_ALERT_HEALTH)[number];

/**
 * What a rule does when its check returns no data or errors.
 * `alerting` is the default and fails closed; `keep_last` keeps the stored state and labels it so.
 */
export const OPS_ALERT_UNHEALTHY_HANDLING = ['alerting', 'keep_last', 'normal'] as const;
export type OpsAlertUnhealthyHandling = (typeof OPS_ALERT_UNHEALTHY_HANDLING)[number];

export const OPS_ALERT_OPERATORS = ['gt', 'gte', 'lt', 'lte', 'eq'] as const;
export type OpsAlertOperator = (typeof OPS_ALERT_OPERATORS)[number];

const labelKey = z.string().regex(/^[a-z][a-z0-9_]{0,62}$/, 'label names are lowercase letters, digits and underscores');
const labelValue = z.string().min(1).max(200);
/** Labels route a rule. Bounded so a rule cannot carry a document. */
export const opsAlertLabelsSchema = z.record(labelKey, labelValue).refine((l) => Object.keys(l).length <= 20, {
  message: 'at most 20 labels',
});

/** A decimal string, so a money metric is never compared as a JS number. */
const decimalString = z.string().regex(/^-?\d+(\.\d{1,18})?$/, 'threshold is a decimal string');

export const opsAlertConditionSchema = z.object({
  operator: z.enum(OPS_ALERT_OPERATORS),
  threshold: decimalString,
});

export const opsAlertAnnotationsSchema = z.object({
  summary: z.string().min(1).max(500).optional(),
  runbookUrl: z.string().url().max(500).optional(),
});

const ruleName = z.string().trim().min(1).max(120);
const ruleFolder = z.string().trim().min(1).max(80);

/** Fields a staff member sets. A blank threshold, interval or pending period is a typed refusal in svc-ops. */
export const opsAlertRuleDraftSchema = z.object({
  name: ruleName,
  folder: ruleFolder,
  group: ruleFolder,
  signal: z.string().trim().min(1).max(120),
  condition: z.object({ operator: z.enum(OPS_ALERT_OPERATORS), threshold: decimalString.optional() }),
  intervalSeconds: z.number().int().min(1).optional(),
  pendingSeconds: z.number().int().min(0).optional(),
  labels: opsAlertLabelsSchema.default({}),
  annotations: opsAlertAnnotationsSchema.default({}),
  noData: z.enum(OPS_ALERT_UNHEALTHY_HANDLING).default('alerting'),
  execError: z.enum(OPS_ALERT_UNHEALTHY_HANDLING).default('alerting'),
  /** Why this save, kept with the version. */
  reason: z.string().trim().min(1).max(500),
});
export type OpsAlertRuleDraft = z.infer<typeof opsAlertRuleDraftSchema>;

export const opsAlertRuleSchema = z.object({
  id: z.string().uuid(),
  name: ruleName,
  folder: ruleFolder,
  group: ruleFolder,
  signal: z.string().min(1),
  condition: opsAlertConditionSchema,
  intervalSeconds: z.number().int().min(1),
  pendingSeconds: z.number().int().min(0),
  labels: opsAlertLabelsSchema,
  annotations: opsAlertAnnotationsSchema,
  noData: z.enum(OPS_ALERT_UNHEALTHY_HANDLING),
  execError: z.enum(OPS_ALERT_UNHEALTHY_HANDLING),
  paused: z.boolean(),
  /** Every save keeps a version; the number only grows. */
  version: z.number().int().min(1),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
  /** Retired, never destroyed. */
  retiredAt: z.string().datetime({ offset: true }).nullable(),
});
export type OpsAlertRule = z.infer<typeof opsAlertRuleSchema>;

/** The business key of one alert instance: stable across an evaluator restart because the epoch is a stored counter, not a clock. */
export function opsAlertBusinessKey(ruleId: string, instance: string, epoch: number): string {
  return `ops:alert:${ruleId}:${instance}:${epoch}`;
}
