import 'server-only';
import {
  INCIDENT_STORAGE_UNCONFIGURED,
  incidentDetailSchema,
  incidentListOutputSchema,
  incidentMetricsSchema,
  type IncidentDetail,
} from '@intafaced/contracts/ops-incidents';
import { opsReadOf, writeRefusalOf, type FounderCallContext, type RefusalView, founderRecordRead, founderAskedCall } from '@/lib/desk';
import {
  OPS_INCIDENTS_LIST,
  OPS_INCIDENTS_METRICS,
  OPS_INCIDENTS_GET,
  OPS_INCIDENTS_DECLARE,
  OPS_INCIDENTS_NOTE,
  OPS_INCIDENTS_INVITE,
  OPS_INCIDENTS_TASK,
  OPS_INCIDENTS_RESOLVE,
} from '@intafaced/contracts/ops-incidents-procedures';

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
    founderRecordRead(ctx, OPS_INCIDENTS_LIST, { limit: INCIDENT_LIST_PAGE }, parse(incidentListOutputSchema)),
    founderRecordRead(ctx, OPS_INCIDENTS_METRICS, undefined, parse(incidentMetricsSchema)),
  ]);
  return {
    list: opsReadOf(list, INCIDENT_STORAGE_UNCONFIGURED, 'incidents'),
    metrics: opsReadOf(metrics, INCIDENT_STORAGE_UNCONFIGURED, 'incident metrics'),
  };
}

export async function loadIncident(ctx: FounderCallContext, incidentId: string) {
  const result = await founderRecordRead(ctx, OPS_INCIDENTS_GET, { incidentId }, parse(incidentDetailSchema));
  return opsReadOf(result, INCIDENT_STORAGE_UNCONFIGURED, 'incidents');
}

export const INCIDENT_ACTIONS = ['declare', 'note', 'invite', 'task', 'resolve'] as const;
export type IncidentAction = (typeof INCIDENT_ACTIONS)[number];

export async function changeIncident(
  ctx: FounderCallContext,
  action: IncidentAction,
  input: Record<string, unknown>,
): Promise<{ status: number; reply: { ok: true; detail: IncidentDetail } | ({ ok: false } & RefusalView) }> {
  const result = await (action === 'declare'
    ? founderAskedCall(ctx, OPS_INCIDENTS_DECLARE, input)
    : action === 'note'
      ? founderAskedCall(ctx, OPS_INCIDENTS_NOTE, input)
      : action === 'invite'
        ? founderAskedCall(ctx, OPS_INCIDENTS_INVITE, input)
        : action === 'task'
          ? founderAskedCall(ctx, OPS_INCIDENTS_TASK, input)
          : founderAskedCall(ctx, OPS_INCIDENTS_RESOLVE, input));
  if (result.kind === 'ok') return { status: 200, reply: { ok: true, detail: result.data } };
  return writeRefusalOf(result);
}
