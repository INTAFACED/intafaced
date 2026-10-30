import 'server-only';
import {
  opsAlertDetailSchema,
  opsAlertListSchema,
  opsPlatformIncidentsSchema,
  opsReconciliationPeriodsSchema,
  type OpsAlertCursor,
  type OpsAlertDetail,
  type OpsAlertList,
  type OpsPlatformIncidents,
  type OpsReconciliationPeriods,
} from '@intafaced/contracts/ops-reconciliation-alerts';
import { founderCall, parseWith, type FounderCallContext } from '@/lib/desk/founder-call';
import { partFrom, type Part } from '@/lib/desk/part';
import { refusalWords } from './model';

const labels = {
  service: 'svc-ops',
  forbiddenMessage:
    'svc-ops did not accept this founder session for reconciliation alerts. It needs the admin read permission (admin:read).',
  refusedMessage: refusalWords,
} as const;

export const ALERT_PAGE = 50;

export interface AlertsRoom {
  readonly asOf: string;
  readonly list: Part<OpsAlertList>;
  readonly periods: Part<OpsReconciliationPeriods>;
  /** Runs the ledger could not finish, as svc-ops received them from the bus: the platform team's, never finance's. */
  readonly incidents: Part<OpsPlatformIncidents>;
}

/** The list, the periods and the platform incidents, each read on its own so one failure never hides another. */
export async function readAlertsRoom(ctx: FounderCallContext, after: OpsAlertCursor | null): Promise<AlertsRoom> {
  const [list, periods, incidents] = await Promise.all([
    founderCall(ctx, 'ops', 'alerts.list', 'GET', { after, limit: ALERT_PAGE }, parseWith(opsAlertListSchema)),
    founderCall(ctx, 'ops', 'alerts.periods', 'GET', { limit: 50 }, parseWith(opsReconciliationPeriodsSchema)),
    founderCall(ctx, 'ops', 'alerts.platformIncidents', 'GET', { limit: 50 }, parseWith(opsPlatformIncidentsSchema)),
  ]);
  return {
    asOf: new Date().toISOString(),
    list: partFrom(list, (d) => d, labels),
    periods: partFrom(periods, (d) => d, labels),
    incidents: partFrom(incidents, (d) => d, labels),
  };
}

export async function readAlertDetail(ctx: FounderCallContext, alertId: string): Promise<Part<OpsAlertDetail>> {
  const result = await founderCall(ctx, 'ops', 'alerts.get', 'GET', { alertId }, parseWith(opsAlertDetailSchema));
  return partFrom(result, (d) => d, labels);
}

/** `?after=<lastSeen>|<id>` as the list's cursor, or null for the newest page. */
export function cursorFrom(raw: string | string[] | undefined): OpsAlertCursor | null {
  if (typeof raw !== 'string') return null;
  const [lastSeen, id] = raw.split('|');
  return lastSeen && id && !Number.isNaN(Date.parse(lastSeen)) && /^[0-9a-f-]{36}$/i.test(id) ? { lastSeen, id } : null;
}
