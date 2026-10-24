import type { ModuleId } from '@intafaced/config';
import { SERVICE_SOURCE_UNAVAILABLE, type ServiceRecord } from '@intafaced/contracts/ops-console-services';
import type { OpsRead } from '@/lib/console-announcements/model';
import { HEALTH_SOURCE_UNWIRED, type HealthRow } from '@/lib/module-health/board';

/**
 * One module's service page (`/health/:module`, OPS-service-health-01) as the console read it. Pure, so the page, the
 * loader and the tests read it the same way.
 *
 * Each panel stands alone: one panel's source failing refuses that panel only (`ops.service_source_unavailable`), and a
 * panel with no source in this build says so with its blocker (`ops.health_source_unwired`) and shows nothing in its place.
 */

export type Panel<T> =
  | { readonly kind: 'read'; readonly data: T }
  | { readonly kind: 'unwired'; readonly blocker: string; readonly code: typeof HEALTH_SOURCE_UNWIRED }
  | {
      readonly kind: 'unavailable';
      readonly service: string;
      readonly message: string;
      readonly cause: string | null;
      readonly code: typeof SERVICE_SOURCE_UNAVAILABLE;
    };

const unwired = (blocker: string): Panel<never> => ({ kind: 'unwired', blocker, code: HEALTH_SOURCE_UNWIRED });

/** The panels this build has no source for, each with what is missing. Nothing stands in for them. */
export const UNWIRED_PANELS = {
  onCall: unwired(
    'There is no on-call rota in this build: the on-call desk (schedules, and who holds the pager now) is not built, so nobody is shown as on call.',
  ),
  incidents: unwired('There is no incident desk in this build, so no incident is listed here and none can be declared or escalated.'),
  objectives: unwired(
    'No service level objective exists yet: an objective’s target and window are the owner’s values, the objectives desk is not built, and none is invented.',
  ),
  dashboards: unwired('No dashboard is linked to a module yet: the dashboards desk is not built.'),
} as const;

/** What escalate and declare would need. Both buttons show, disabled, with this reason. */
export const INCIDENT_ACTIONS_BLOCKER = 'Needs the incident desk, which is not built in this build. Nothing is sent.';

/** One alert rule labelled with this module, and its stored state; a rule not yet evaluated has none. */
export interface ModuleAlert {
  readonly rule: { readonly id: string; readonly name: string };
  readonly status: { readonly state: 'normal' | 'pending' | 'firing'; readonly health: 'ok' | 'error' | 'no_data' } | null;
}
export interface ModuleAlerts {
  readonly items: readonly ModuleAlert[];
  readonly nextCursor: string | null;
}

const isRecord = (v: unknown): v is Record<string, unknown> => Boolean(v && typeof v === 'object' && !Array.isArray(v));
const STATES = ['normal', 'pending', 'firing'] as const;
const HEALTH = ['ok', 'error', 'no_data'] as const;

function readAlert(raw: unknown): ModuleAlert | null {
  if (!isRecord(raw) || !isRecord(raw.rule) || typeof raw.rule.id !== 'string' || typeof raw.rule.name !== 'string') return null;
  if (raw.status === null) return { rule: { id: raw.rule.id, name: raw.rule.name }, status: null };
  const s = raw.status;
  if (!isRecord(s)) return null;
  const state = STATES.find((x) => x === s.state);
  const health = HEALTH.find((x) => x === s.health);
  return state && health ? { rule: { id: raw.rule.id, name: raw.rule.name }, status: { state, health } } : null;
}

/** svc-ops `alertRules.states`, the parts this page shows; any other shape is null (the panel then refuses). */
export function readModuleAlerts(raw: unknown): ModuleAlerts | null {
  if (!isRecord(raw) || !Array.isArray(raw.items) || !(raw.nextCursor === null || typeof raw.nextCursor === 'string')) return null;
  const items = raw.items.map(readAlert);
  return items.every((i): i is ModuleAlert => i !== null) ? { items, nextCursor: raw.nextCursor } : null;
}

/** The alert rules a module's page lists: those labelled `module=<id>`, a page of this many at most. */
export const MODULE_ALERTS_PAGE = 50;
export const MODULE_ALERT_LABEL = 'module';

export interface ServicePageView {
  readonly module: ModuleId;
  readonly label: string;
  readonly record: Panel<ServiceRecord>;
  readonly state: HealthRow;
  readonly alerts: Panel<ModuleAlerts>;
  readonly onCall: Panel<never>;
  readonly incidents: Panel<never>;
  readonly objectives: Panel<never>;
  readonly dashboards: Panel<never>;
  readonly asOf: string;
}

/** An svc-ops read as one panel: read, or refused on its own with svc-ops' reason. */
export function panelOf<T>(read: OpsRead<T>, what: string): Panel<T> {
  if (read.kind === 'read') return { kind: 'read', data: read.data };
  return {
    kind: 'unavailable',
    service: 'svc-ops',
    message: read.kind === 'unconfigured' ? `svc-ops has no storage for ${what} on this deployment.` : read.message,
    cause: read.kind === 'unknown' ? read.code : null,
    code: SERVICE_SOURCE_UNAVAILABLE,
  };
}
