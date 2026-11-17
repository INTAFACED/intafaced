import { z } from 'zod';
import { MODULE_IDS } from '@intafaced/config/modules';

/**
 * Wire types for staff incidents in svc-ops (OPS-oncall-02, J-ops-console-19 #10): declare one, keep its timeline, its tasks
 * and who takes part, resolve it, and read the metrics. The public status page belongs to the developer and support modules;
 * this is the staff incident.
 *
 * - An incident declared with no severity is `pending`. The severities it can be given are an owner setting
 *   (`OPS_INCIDENT_SEVERITIES` in svc-ops): while it is blank, declaring with a severity refuses
 *   `ops.incident_severities_unset`; a name not in it refuses `ops.severity_unknown`.
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
/** No severities are set (`OPS_INCIDENT_SEVERITIES` is blank), so an incident can only be declared pending. */
export const INCIDENT_SEVERITIES_UNSET = 'ops.incident_severities_unset' as const;
/** The same request key was sent before with a different body: it is a different request, so it is refused, not merged. */
export const INCIDENT_REQUEST_KEY_REUSED = 'ops.incident_request_key_reused' as const;

/** An incident not assessed yet. Every other severity name comes from the owner's list. */
export const INCIDENT_SEVERITY_PENDING = 'pending' as const;
/** How a severity name is spelt in the owner's list: lower snake case, at most 40 characters, never `pending`. */
export const INCIDENT_SEVERITY_NAME = /^(?!pending$)[a-z][a-z0-9_]{0,39}$/;
export const INCIDENT_STATUSES = ['active', 'resolved'] as const;

const iso = z.string().datetime({ offset: true });
const id = z.string().uuid();
const userId = z.string().min(1).max(128);
const requestKey = z.string().trim().min(8).max(160);

export const incidentSeveritySchema = z.union([z.literal(INCIDENT_SEVERITY_PENDING), z.string().regex(INCIDENT_SEVERITY_NAME)]);
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
/** `severities` is the owner's list, or null while it is blank (declaring with a severity then refuses). */
export const incidentListOutputSchema = z.object({
  incidents: z.array(incidentSchema),
  severities: z.array(z.string().regex(INCIDENT_SEVERITY_NAME)).nullable(),
  asOf: iso,
});

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

/**
 * The severity an incident is declared with, against the owner's list (`null`: blank): pending when none is given, or the
 * typed refusal.
 */
export function declaredSeverity(
  raw: string | undefined,
  configured: readonly string[] | null,
): { ok: true; severity: IncidentSeverity } | { ok: false; code: typeof INCIDENT_SEVERITIES_UNSET | typeof INCIDENT_SEVERITY_UNKNOWN } {
  if (raw === undefined) return { ok: true, severity: INCIDENT_SEVERITY_PENDING };
  if (configured === null) return { ok: false, code: INCIDENT_SEVERITIES_UNSET };
  return configured.includes(raw) ? { ok: true, severity: raw } : { ok: false, code: INCIDENT_SEVERITY_UNKNOWN };
}

/**
 * The owner's severity list from its setting: comma separated, each name spelt as `INCIDENT_SEVERITY_NAME`, none twice. Blank
 * is null (no severities). Anything else throws, so a misspelt list refuses boot instead of being half read.
 */
export function parseIncidentSeverities(raw: string | undefined): string[] | null {
  if (raw === undefined || raw.trim() === '') return null;
  const names = raw.split(',').map((n) => n.trim());
  if (names.some((n) => !INCIDENT_SEVERITY_NAME.test(n)) || new Set(names).size !== names.length)
    throw new Error('OPS_INCIDENT_SEVERITIES: a comma list of distinct lower snake case names, none of them pending');
  return names;
}
