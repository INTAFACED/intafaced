import 'server-only';
import type { ModuleId } from '@intafaced/config';
import {
  SERVICE_RECORD_INVALID,
  SERVICE_STORAGE_UNCONFIGURED,
  serviceGetOutputSchema,
  type ServiceGetOutput,
  type ServiceSetInput,
} from '@intafaced/contracts/ops-console-services';
import { founderCall, type FounderCallContext } from '@/lib/desk/founder-call';
import { opsReadOf } from '@/lib/desk/ops-read';
import { writeRefusalOf } from '@/lib/desk/write-refusal';
import type { RefusalView } from '@/lib/desk/refusal-copy';
import { HEALTH_ROWS, boardReads, buildBoard } from '@/lib/module-health/board';
import { loadReads } from '@/lib/ops-desk/server';
import { MODULE_ALERTS_PAGE, MODULE_ALERT_LABEL, UNWIRED_PANELS, panelOf, readModuleAlerts, type ServicePageView } from './model';

const parseRecord = (raw: unknown): ServiceGetOutput | null => {
  const parsed = serviceGetOutputSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
};

export async function loadServiceRecord(ctx: FounderCallContext, module: ModuleId) {
  const result = await founderCall(ctx, 'ops', 'services.get', 'GET', { module }, parseRecord);
  return opsReadOf(result, SERVICE_STORAGE_UNCONFIGURED, 'service records');
}

/** svc-ops' alert rules labelled with this module, with their stored state. */
async function loadModuleAlerts(ctx: FounderCallContext, module: ModuleId) {
  const input = { label: { key: MODULE_ALERT_LABEL, value: module }, limit: MODULE_ALERTS_PAGE };
  const result = await founderCall(ctx, 'ops', 'alertRules.states', 'GET', input, readModuleAlerts);
  return opsReadOf(result, 'ops.alert_storage_unconfigured', 'alert rules');
}

/**
 * One module's service page, read as the signed-in founder when the page opens. The record, the module's state and its
 * alerts are read side by side; each one that fails refuses only its own panel. Nothing is cached.
 */
export async function loadServicePage(ctx: FounderCallContext, module: ModuleId, startedAt: Date): Promise<ServicePageView> {
  const spec = HEALTH_ROWS.find((r) => r.module === module);
  if (!spec) throw new Error(`service page: the health board has no row for ${module}`);
  const [record, outcomes, alerts] = await Promise.all([
    loadServiceRecord(ctx, module),
    loadReads(ctx, boardReads([spec]), startedAt),
    loadModuleAlerts(ctx, module),
  ]);
  const record_ = panelOf(record, 'service records');
  return {
    module,
    label: spec.label,
    record: record_.kind === 'read' ? { kind: 'read', data: record_.data.record } : record_,
    state: buildBoard(outcomes, [spec])[0]!,
    alerts: panelOf(alerts, 'alert rules'),
    ...UNWIRED_PANELS,
    asOf: startedAt.toISOString(),
  };
}

export async function saveServiceRecord(
  ctx: FounderCallContext,
  input: ServiceSetInput,
): Promise<{ status: number; reply: { ok: true; record: ServiceGetOutput['record'] } | ({ ok: false } & RefusalView) }> {
  const result = await founderCall(ctx, 'ops', 'services.set', 'POST', input, parseRecord);
  if (result.kind === 'ok') return { status: 200, reply: { ok: true, record: result.data.record } };
  const out = writeRefusalOf(result);
  // svc-ops names the fields it refused ("… takes: ownerTeam, runbook"); say which, in the form's words.
  if (result.kind === 'refused' && result.refusal.code === SERVICE_RECORD_INVALID) {
    const named = /takes: ([a-zA-Z, ]+)$/.exec(result.refusal.message)?.[1]?.split(', ') ?? [];
    const fields = named.map((f) => FIELD_LABEL[f]).filter((f): f is string => f !== undefined);
    if (fields.length > 0) return { ...out, reply: { ...out.reply, body: `Refused: ${fields.join(', ')}. ${out.reply.body}` } };
  }
  return out;
}

const FIELD_LABEL: Readonly<Record<string, string>> = { ownerTeam: 'owner team', runbook: 'runbook', dependencies: 'dependencies' };
