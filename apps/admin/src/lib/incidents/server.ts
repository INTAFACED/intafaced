import 'server-only';
import {
  INCIDENT_STORAGE_UNCONFIGURED,
  incidentDetailSchema,
  incidentListOutputSchema,
  incidentMetricsSchema,
  type IncidentDetail,
} from '@intafaced/contracts/ops-incidents';
import { founderCall, type FounderCallContext } from '@/lib/desk/founder-call';
import { opsReadOf } from '@/lib/desk/ops-read';
import { writeRefusalOf } from '@/lib/desk/write-refusal';
import type { RefusalView } from '@/lib/desk/refusal-copy';

/** svc-ops' staff incidents (OPS-oncall-02), read and changed as the signed-in person. Nothing is cached. */

const parse =
  <T>(schema: { safeParse(raw: unknown): { success: true; data: T } | { success: false } }) =>
  (raw: unknown): T | null => {
    const parsed = schema.safeParse(raw);
    return parsed.success ? parsed.data : null;
  };

export const INCIDENT_LIST_PAGE = 50;

export async function loadIncidents(ctx: FounderCallContext) {
  const [list, metrics] = await Promise.all([
    founderCall(ctx, 'ops', 'incidents.list', 'GET', { limit: INCIDENT_LIST_PAGE }, parse(incidentListOutputSchema)),
    founderCall(ctx, 'ops', 'incidents.metrics', 'GET', undefined, parse(incidentMetricsSchema)),
  ]);
  return {
    list: opsReadOf(list, INCIDENT_STORAGE_UNCONFIGURED, 'incidents'),
    metrics: opsReadOf(metrics, INCIDENT_STORAGE_UNCONFIGURED, 'incident metrics'),
  };
}

export async function loadIncident(ctx: FounderCallContext, incidentId: string) {
  const result = await founderCall(ctx, 'ops', 'incidents.get', 'GET', { incidentId }, parse(incidentDetailSchema));
  return opsReadOf(result, INCIDENT_STORAGE_UNCONFIGURED, 'incidents');
}

export const INCIDENT_ACTIONS = ['declare', 'note', 'invite', 'task', 'resolve'] as const;
export type IncidentAction = (typeof INCIDENT_ACTIONS)[number];

export async function changeIncident(
  ctx: FounderCallContext,
  action: IncidentAction,
  input: Record<string, unknown>,
): Promise<{ status: number; reply: { ok: true; detail: IncidentDetail } | ({ ok: false } & RefusalView) }> {
  const result = await founderCall(ctx, 'ops', `incidents.${action}`, 'POST', input, parse(incidentDetailSchema));
  if (result.kind === 'ok') return { status: 200, reply: { ok: true, detail: result.data } };
  return writeRefusalOf(result);
}
