import 'server-only';
import {
  type OpsAlertCursor,
  type OpsAlertDetail,
  type OpsAlertList,
  type OpsPlatformIncidents,
  type OpsReconciliationPeriods,
  type NotifyReconAlertFeed,
} from '@intafaced/contracts/ops-reconciliation-alerts';
import { type FounderCallContext, partFrom, type Part, founderRecordCall } from '@/lib/desk';
import { refusalWords } from './model';
import { NOTIFY_RECONCILIATION_ALERT_FEED_LIST } from '@intafaced/contracts/notify-reconciliation-alert-feed-procedures';
import {
  OPS_ALERTS_LIST,
  OPS_ALERTS_PERIODS,
  OPS_ALERTS_PLATFORM_INCIDENTS,
  OPS_ALERTS_GET,
} from '@intafaced/contracts/ops-alerts-procedures';

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
    founderRecordCall(ctx, OPS_ALERTS_LIST, { after, limit: ALERT_PAGE }),
    founderRecordCall(ctx, OPS_ALERTS_PERIODS, { limit: 50 }),
    founderRecordCall(ctx, OPS_ALERTS_PLATFORM_INCIDENTS, { limit: 50 }),
  ]);
  return {
    asOf: new Date().toISOString(),
    list: partFrom(list, (d) => d, labels),
    periods: partFrom(periods, (d) => d, labels),
    incidents: partFrom(incidents, (d) => d, labels),
  };
}

export async function readAlertDetail(ctx: FounderCallContext, alertId: string): Promise<Part<OpsAlertDetail>> {
  const result = await founderRecordCall(ctx, OPS_ALERTS_GET, { alertId });
  return partFrom(result, (d) => d, labels);
}

const feedLabels = {
  service: 'svc-notify',
  forbiddenMessage: 'svc-notify did not accept this founder session for the alert feed. It needs the admin read permission (admin:read).',
} as const;

/** What svc-notify received of this alert's transitions: its own record, one per business key, read apart from svc-ops. */
export async function readAlertFeed(ctx: FounderCallContext, alertId: string): Promise<Part<NotifyReconAlertFeed>> {
  const result = await founderRecordCall(ctx, NOTIFY_RECONCILIATION_ALERT_FEED_LIST, { alertId });
  return partFrom(result, (d) => d, feedLabels);
}

/** `?after=<lastSeen>|<id>` as the list's cursor, or null for the newest page. */
export function cursorFrom(raw: string | string[] | undefined): OpsAlertCursor | null {
  if (typeof raw !== 'string') return null;
  const [lastSeen, id] = raw.split('|');
  return lastSeen && id && !Number.isNaN(Date.parse(lastSeen)) && /^[0-9a-f-]{36}$/i.test(id) ? { lastSeen, id } : null;
}
