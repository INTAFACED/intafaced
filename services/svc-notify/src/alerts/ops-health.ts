/**
 * Alert engine and delivery health for the founder console (C-ops-01 (b) (c); J-charts-desk-18 #3 #4).
 *
 *   notify.opsAlertEngineHealth   admin:read. The sweep's last pass and its lag, firings today by kind, alert deliveries
 *                                 today by channel and status, and the alert counts the charts module metrics show.
 *
 * Every figure is a count of rows this service keeps (notify.price_alerts, notify.alert_fires, notify.notifications,
 * notify.deliveries) or the sweep's own record of its last pass. Nothing is estimated. A pass that never completed is
 * `null`, never zero. "Today" is the UTC day. Read only: nothing here retries, pauses or writes.
 */
import type { Sql } from 'postgres';
import type { AlertSweepReport } from './service.js';

/** The sweep's record of its last pass, kept by `AlertService.evaluateDueAlerts`. */
export interface AlertSweepRecord {
  readonly startedAt: Date;
  readonly finishedAt: Date;
  readonly report: AlertSweepReport;
}

/** The last failed pass, when the newest pass failed. */
export interface AlertSweepFailure {
  readonly at: Date;
  readonly message: string;
}

export const DELIVERY_STATUSES = ['pending', 'accepted', 'refused', 'failed', 'abandoned'] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

export interface ChannelDeliveries {
  readonly channel: string;
  readonly total: number;
  readonly byStatus: Readonly<Record<DeliveryStatus, number>>;
  /** failed + abandoned: a delivery that was tried and did not get through. */
  readonly failures: number;
}

export interface AlertEngineHealth {
  readonly asOf: string;
  /** Start of the UTC day the "today" counts cover. */
  readonly since: string;
  readonly sweep: {
    readonly intervalMs: number;
    readonly lastStartedAt: string | null;
    readonly lastFinishedAt: string | null;
    /** How long the last pass took, ms. */
    readonly lastDurationMs: number | null;
    /**
     * Evaluation lag: seconds from the end of the last completed pass to now. A watch is evaluated at most this long after
     * its last look, plus the next pass's own duration. Null when no pass has completed since this process started.
     */
    readonly lagSeconds: number | null;
    /** Whether the lag is past one interval and a half: the sweep is late or stopped. */
    readonly late: boolean | null;
    readonly last: AlertSweepReport | null;
    readonly lastFailure: { readonly at: string; readonly message: string } | null;
  };
  /** Fires today, all kinds and by kind (price, funding, …). */
  readonly firings: { readonly total: number; readonly byKind: Readonly<Record<string, number>> };
  /** Deliveries of alert notifications created today, by channel. */
  readonly deliveries: readonly ChannelDeliveries[];
  /** For the charts module metrics: alerts people hold open now (active or stopped), and how many fired today. */
  readonly alerts: { readonly open: number; readonly firedToday: number; readonly byKindOpen: Readonly<Record<string, number>> };
}

const startOfUtcDay = (at: Date): Date => new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));

function emptyStatuses(): Record<DeliveryStatus, number> {
  return { pending: 0, accepted: 0, refused: 0, failed: 0, abandoned: 0 };
}

/** Rows of (channel, status, n) to one entry per channel. Pure. */
export function channelDeliveries(rows: readonly { channel: string; status: string; n: number }[]): ChannelDeliveries[] {
  const by = new Map<string, Record<DeliveryStatus, number>>();
  for (const row of rows) {
    const statuses = by.get(row.channel) ?? emptyStatuses();
    if ((DELIVERY_STATUSES as readonly string[]).includes(row.status)) statuses[row.status as DeliveryStatus] += row.n;
    by.set(row.channel, statuses);
  }
  return [...by.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([channel, byStatus]) => ({
      channel,
      byStatus,
      total: DELIVERY_STATUSES.reduce((sum, s) => sum + byStatus[s], 0),
      failures: byStatus.failed + byStatus.abandoned,
    }));
}

/** The sweep half of the view, from its record. Pure. */
export function sweepView(
  record: AlertSweepRecord | null,
  failure: AlertSweepFailure | null,
  intervalMs: number,
  now: Date,
): AlertEngineHealth['sweep'] {
  const lagSeconds = record ? Math.max(0, Math.floor((now.getTime() - record.finishedAt.getTime()) / 1000)) : null;
  const lastFailure =
    failure && (!record || failure.at > record.finishedAt) ? { at: failure.at.toISOString(), message: failure.message } : null;
  return {
    intervalMs,
    lastStartedAt: record?.startedAt.toISOString() ?? null,
    lastFinishedAt: record?.finishedAt.toISOString() ?? null,
    lastDurationMs: record ? record.finishedAt.getTime() - record.startedAt.getTime() : null,
    lagSeconds,
    late: lagSeconds === null ? null : lagSeconds * 1000 > intervalMs * 1.5,
    last: record?.report ?? null,
    lastFailure,
  };
}

export class AlertOpsReader {
  constructor(private readonly sql: Sql) {}

  async health(
    sweep: { record: AlertSweepRecord | null; failure: AlertSweepFailure | null; intervalMs: number },
    now: Date = new Date(),
  ): Promise<AlertEngineHealth> {
    const since = startOfUtcDay(now);
    const fires = await this.sql<{ kind: string; n: number }[]>`
      SELECT coalesce(a.kind, 'price') AS kind, count(*)::int AS n
        FROM notify.alert_fires f
        LEFT JOIN notify.price_alerts a ON a.id = f.alert_id
       WHERE f.fired_at >= ${since}
       GROUP BY 1`;
    const deliveries = await this.sql<{ channel: string; status: string; n: number }[]>`
      SELECT d.channel, d.status, count(*)::int AS n
        FROM notify.deliveries d
        JOIN notify.notifications n ON n.id = d.notification_id
       WHERE n.kind LIKE 'alert.%' AND n.created_at >= ${since}
       GROUP BY 1, 2`;
    const open = await this.sql<{ kind: string; n: number }[]>`
      SELECT kind, count(*)::int AS n FROM notify.price_alerts WHERE status IN ('active', 'stopped') GROUP BY 1`;
    const byKind = Object.fromEntries(fires.map((r) => [r.kind, r.n]));
    const firedToday = fires.reduce((sum, r) => sum + r.n, 0);
    const byKindOpen = Object.fromEntries(open.map((r) => [r.kind, r.n]));
    return {
      asOf: now.toISOString(),
      since: since.toISOString(),
      sweep: sweepView(sweep.record, sweep.failure, sweep.intervalMs, now),
      firings: { total: firedToday, byKind },
      deliveries: channelDeliveries(deliveries),
      alerts: { open: open.reduce((sum, r) => sum + r.n, 0), firedToday, byKindOpen },
    };
  }
}
