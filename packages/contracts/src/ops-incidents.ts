import { z } from 'zod';
import { MODULE_IDS } from '@intafaced/config/modules';

/**
 * Wire types for staff incidents in svc-ops (OPS-oncall-02, J-ops-console-19 #10): declare one, keep its timeline, its tasks
 * and who takes part, resolve it, and read the metrics. The public status page belongs to the developer and support modules;
 * this is the staff incident.
 *
 * - An incident declared with no severity is `pending`. A severity outside `INCIDENT_SEVERITIES` refuses
 *   `ops.severity_unknown`.
 * - A private incident is seen only by its participants: to anyone else its id is `ops.incident_not_found` (never
 *   "forbidden", which would say it exists), it is not listed, and it is left out of the metrics.
 * - Each change carries a `requestKey` (the console's business key for that action), so a lost reply is read back, never
 *   applied twice: a timeline note added twice under one key is one note.
 * - A task names an assignee who already takes part; anyone else refuses `ops.assignee_not_participant`.
 * - Resolving stores the end time from the resolve call; the time to resolve is computed from the two stored times.
 *
 * No money. Browser-safe: zod and the module registry only.
 */

export const INCIDENT_NOT_FOUND = 'ops.incident_not_found' as const;
export const INCIDENT_ASSIGNEE_NOT_PARTICIPANT = 'ops.assignee_not_participant' as const;
export const INCIDENT_SEVERITY_UNKNOWN = 'ops.severity_unknown' as const;
export const INCIDENT_ALREADY_RESOLVED = 'ops.incident_already_resolved' as const;
export const INCIDENT_STORAGE_UNCONFIGURED = 'ops.incident_storage_unconfigured' as const;
/** The same request key was sent before with a different body: it is a different request, so it is refused, not merged. */
export const INCIDENT_REQUEST_KEY_REUSED = 'ops.incident_request_key_reused' as const;

/** The severities an incident can carry once it is assessed. Until then it is `pending`. */
export const INCIDENT_SEVERITIES = ['critical', 'major', 'minor'] as const;
export const INCIDENT_SEVERITY_PENDING = 'pending' as const;
export const INCIDENT_STATUSES = ['active', 'resolved'] as const;

const iso = z.string().datetime({ offset: true });
const id = z.string().uuid();
const userId = z.string().min(1).max(128);
const requestKey = z.string().trim().min(8).max(160);

export const incidentSeveritySchema = z.enum([INCIDENT_SEVERITY_PENDING, ...INCIDENT_SEVERITIES]);
export type IncidentSeverity = z.infer<typeof incidentSeveritySchema>;

export const incidentSchema = z.object({
  id,
  /** The incident's number, from a database sequence: what people call it ("incident 12"). */
  number: z.number().int().min(1),
  title: z.string().min(1).max(200),
  /** The module it affects, when one was named. */
  module: z.enum(MODULE_IDS).nullable(),
  severity: incidentSeveritySchema,
  status: z.enum(INCIDENT_STATUSES),
  private: z.boolean(),
  declaredBy: userId,
  startedAt: iso,
  /** Null until resolved. */
  endedAt: iso.nullable(),
});
export type Incident = z.infer<typeof incidentSchema>;

export const incidentTimelineEntrySchema = z.object({
  id,
  kind: z.enum(['declared', 'note', 'participant', 'task', 'resolved']),
  body: z.string().max(2000),
  actorId: userId,
  at: iso,
});
export type IncidentTimelineEntry = z.infer<typeof incidentTimelineEntrySchema>;

export const incidentTaskSchema = z.object({
  id,
  title: z.string().min(1).max(200),
  assigneeId: userId,
  status: z.enum(['open', 'done']),
  createdBy: userId,
  createdAt: iso,
});
export type IncidentTask = z.infer<typeof incidentTaskSchema>;

export const incidentDetailSchema = z.object({
  incident: incidentSchema,
  participants: z.array(z.object({ userId, addedBy: userId, addedAt: iso })),
  timeline: z.array(incidentTimelineEntrySchema),
  tasks: z.array(incidentTaskSchema),
  asOf: iso,
});
export type IncidentDetail = z.infer<typeof incidentDetailSchema>;

// ── Inputs ──────────────────────────────────────────────────────────────────

/** Severity is optional: none given is `pending`. Any string is accepted here so an unknown one gets its own typed refusal. */
export const incidentDeclareInputSchema = z.object({
  requestKey,
  title: z.string().trim().min(1).max(200),
  module: z.enum(MODULE_IDS).nullable().optional(),
  severity: z.string().trim().min(1).max(40).optional(),
  private: z.boolean().optional(),
});
export type IncidentDeclareInput = z.infer<typeof incidentDeclareInputSchema>;

export const incidentGetInputSchema = z.object({ incidentId: id });
export const incidentListInputSchema = z.object({
  status: z.enum(INCIDENT_STATUSES).optional(),
  module: z.enum(MODULE_IDS).optional(),
  limit: z.number().int().min(1).max(200),
});
export const incidentListOutputSchema = z.object({ incidents: z.array(incidentSchema), asOf: iso });

export const incidentNoteInputSchema = z.object({ incidentId: id, requestKey, body: z.string().trim().min(1).max(2000) });
export const incidentInviteInputSchema = z.object({ incidentId: id, requestKey, userId });
export const incidentTaskInputSchema = z.object({
  incidentId: id,
  requestKey,
  title: z.string().trim().min(1).max(200),
  assigneeId: userId,
});
export const incidentResolveInputSchema = z.object({ incidentId: id, requestKey });

// ── Metrics ─────────────────────────────────────────────────────────────────

/**
 * Counts by state and severity over the incidents the reader may see (private ones only for their participants), and the mean
 * time to resolve over the resolved ones, in whole seconds from the stored start and end times. With no incidents every list
 * is empty and the mean is null: nothing is a sample figure.
 */
export const incidentMetricsSchema = z.object({
  byStatus: z.array(z.object({ status: z.enum(INCIDENT_STATUSES), count: z.number().int().min(1) })),
  bySeverity: z.array(z.object({ severity: incidentSeveritySchema, count: z.number().int().min(1) })),
  resolvedCount: z.number().int().min(0),
  meanSecondsToResolve: z.number().int().min(0).nullable(),
  asOf: iso,
});
export type IncidentMetrics = z.infer<typeof incidentMetricsSchema>;

/** The severity an incident is declared with: pending when none is given, null when the name is not a known one. */
export function declaredSeverity(raw: string | undefined): IncidentSeverity | null {
  if (raw === undefined) return INCIDENT_SEVERITY_PENDING;
  return (INCIDENT_SEVERITIES as readonly string[]).includes(raw) ? (raw as IncidentSeverity) : null;
}
