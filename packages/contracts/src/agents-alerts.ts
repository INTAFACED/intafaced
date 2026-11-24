import { z } from 'zod';
import { OWN_AGENT_DATA_CLASSES, OWN_AGENT_RULE_CHOICES } from './agents-own.js';

/**
 * svc-agents' agent alert desk (`opsAlerts.*`, AG-analytics-02, AG-guardrails-02; J-agents-16): what the service
 * answers, in one place, so the service declares its output and the founder console reads it from the same file.
 * Thresholds and values are decimal strings (percent for a rate, the fee asset for cost), never numbers.
 */

export const AGENT_ALERT_MEASURES = ['refusal_rate', 'failure_rate', 'cost'] as const;
export type AgentAlertMeasure = (typeof AGENT_ALERT_MEASURES)[number];

export const agentAlertRuleSchema = z.object({
  id: z.string(),
  name: z.string(),
  measure: z.enum(AGENT_ALERT_MEASURES),
  threshold: z.string(),
  windowMinutes: z.number().int(),
  agentId: z.string().nullable(),
  createdBy: z.string(),
  createdAt: z.string(),
});
export type AgentAlertRule = z.infer<typeof agentAlertRuleSchema>;

export const agentAlertSchema = z.object({
  id: z.string(),
  ruleId: z.string(),
  ruleName: z.string(),
  measure: z.enum(AGENT_ALERT_MEASURES),
  windowStart: z.string(),
  windowEnd: z.string(),
  actionRows: z.number().int().min(1),
  value: z.string(),
  threshold: z.string(),
  /** `pending` until svc-agents hands the alert to notifications; it stays pending while notifications are down. */
  delivery: z.enum(['pending', 'handed_off']),
  handedOffAt: z.string().nullable(),
  createdAt: z.string(),
});
export type AgentAlert = z.infer<typeof agentAlertSchema>;

export const agentAlertWindowSchema = z.object({
  ruleId: z.string(),
  windowStart: z.string(),
  windowEnd: z.string(),
  actionRows: z.number().int().min(0),
  /** Null when the window has no actions: there is no rate to show. */
  value: z.string().nullable(),
  breached: z.boolean(),
  /** True only for the evaluation that wrote the window's alert; a later one finds it already kept. */
  alertWritten: z.boolean(),
});
export type AgentAlertWindow = z.infer<typeof agentAlertWindowSchema>;

/** Whether alerts are handed to notifications. No one has set it: on. */
export const agentAlertNotificationsSchema = z.object({
  state: z.enum(['on', 'down']),
  setBy: z.string().nullable(),
  setAt: z.string().nullable(),
});
export type AgentAlertNotifications = z.infer<typeof agentAlertNotificationsSchema>;

export const agentAlertDeskSchema = z.object({
  notifications: agentAlertNotificationsSchema,
  rules: z.array(agentAlertRuleSchema),
  alerts: z.array(agentAlertSchema),
  alertsListed: z.number().int(),
});

export const agentAlertEvaluationSchema = z.object({ windows: z.array(agentAlertWindowSchema) });

export const agentPolicySchema = z.object({
  classes: z.array(
    z.object({
      dataClass: z.enum(OWN_AGENT_DATA_CLASSES),
      baseline: z.enum(OWN_AGENT_RULE_CHOICES).nullable(),
      override: z.enum(OWN_AGENT_RULE_CHOICES).nullable(),
      overrideSetBy: z.string().nullable(),
      overrideSetAt: z.string().nullable(),
      effective: z.enum(OWN_AGENT_RULE_CHOICES).nullable(),
    }),
  ),
});
export type AgentPolicy = z.infer<typeof agentPolicySchema>;

export const agentRuleCheckSchema = z.object({ verdict: z.literal('allowed'), effective: z.enum(OWN_AGENT_RULE_CHOICES) });
