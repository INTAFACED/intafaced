/**
 * Alert engine and delivery health, and the charts module metrics (C-ops-01; J-charts-desk-18 #3 #4): what svc-notify
 * `notify.opsAlertEngineHealth` answers, parsed. Client-safe. A figure the service did not send is "—", never zero.
 */

export const DELIVERY_STATUSES = ['pending', 'accepted', 'refused', 'failed', 'abandoned'] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

export interface ChannelDeliveries {
  readonly channel: string;
  readonly total: number;
  readonly byStatus: Readonly<Record<DeliveryStatus, number>>;
  readonly failures: number;
}

export interface SweepReport {
  readonly markets: number;
  readonly fired: number;
  readonly held: number;
  readonly refused: number;
  readonly refusals: Readonly<Record<string, number>>;
}

export interface AlertEngineHealth {
  readonly asOf: string;
  readonly since: string;
  readonly sweep: {
    readonly intervalMs: number;
    readonly lastStartedAt: string | null;
    readonly lastFinishedAt: string | null;
    readonly lastDurationMs: number | null;
    readonly lagSeconds: number | null;
    readonly late: boolean | null;
    readonly last: SweepReport | null;
    readonly lastFailure: { readonly at: string; readonly message: string } | null;
  };
  readonly firings: { readonly total: number; readonly byKind: Readonly<Record<string, number>> };
  readonly deliveries: readonly ChannelDeliveries[];
  readonly alerts: { readonly open: number; readonly firedToday: number; readonly byKindOpen: Readonly<Record<string, number>> };
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const int = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;
const strOrNull = (v: unknown): v is string | null => v === null || typeof v === 'string';
const counts = (v: unknown): v is Record<string, number> => isObj(v) && Object.values(v).every(int);

function parseReport(v: unknown): SweepReport | null | undefined {
  if (v === null) return null;
  if (!isObj(v) || !int(v.markets) || !int(v.fired) || !int(v.held) || !int(v.refused) || !counts(v.refusals)) return undefined;
  return { markets: v.markets, fired: v.fired, held: v.held, refused: v.refused, refusals: v.refusals };
}

export function parseAlertEngineHealth(raw: unknown): AlertEngineHealth | null {
  if (!isObj(raw) || typeof raw.asOf !== 'string' || typeof raw.since !== 'string') return null;
  const s = raw.sweep;
  if (!isObj(s) || typeof s.intervalMs !== 'number') return null;
  if (!strOrNull(s.lastStartedAt) || !strOrNull(s.lastFinishedAt)) return null;
  if (!(s.lastDurationMs === null || int(s.lastDurationMs)) || !(s.lagSeconds === null || int(s.lagSeconds))) return null;
  if (!(s.late === null || typeof s.late === 'boolean')) return null;
  const last = parseReport(s.last);
  if (last === undefined) return null;
  const f = s.lastFailure;
  if (!(f === null || (isObj(f) && typeof f.at === 'string' && typeof f.message === 'string'))) return null;
  const firings = raw.firings;
  if (!isObj(firings) || !int(firings.total) || !counts(firings.byKind)) return null;
  const a = raw.alerts;
  if (!isObj(a) || !int(a.open) || !int(a.firedToday) || !counts(a.byKindOpen)) return null;
  if (!Array.isArray(raw.deliveries)) return null;
  const deliveries: ChannelDeliveries[] = [];
  for (const d of raw.deliveries) {
    if (!isObj(d) || typeof d.channel !== 'string' || !int(d.total) || !int(d.failures) || !isObj(d.byStatus)) return null;
    const by = d.byStatus;
    if (!DELIVERY_STATUSES.every((st) => int(by[st]))) return null;
    deliveries.push({ channel: d.channel, total: d.total, failures: d.failures, byStatus: by as Record<DeliveryStatus, number> });
  }
  return {
    asOf: raw.asOf,
    since: raw.since,
    sweep: {
      intervalMs: s.intervalMs,
      lastStartedAt: s.lastStartedAt as string | null,
      lastFinishedAt: s.lastFinishedAt as string | null,
      lastDurationMs: s.lastDurationMs as number | null,
      lagSeconds: s.lagSeconds as number | null,
      late: s.late as boolean | null,
      last,
      lastFailure: f === null ? null : { at: (f as { at: string }).at, message: (f as { message: string }).message },
    },
    firings: { total: firings.total, byKind: firings.byKind },
    deliveries,
    alerts: { open: a.open, firedToday: a.firedToday, byKindOpen: a.byKindOpen },
  };
}

/**
 * The charts module counts the server does not keep yet, each with what is missing (J-charts-desk-18 #3 "named
 * blockers"). They are shown as not served, never as zero. Each leaves this list when its store exists.
 */
export const CHART_METRIC_BLOCKERS = [
  {
    key: 'chart_opens',
    label: 'Chart opens',
    owner: 'apps/customer, svc-trade',
    text: 'Not served: the chart workbench records no chart open on the server, so nothing can count them.',
  },
  {
    key: 'layouts',
    label: 'Saved layouts',
    owner: 'svc-identity preferences (C-workspace-02)',
    text: "Not served: layouts are kept in the person's browser, not on the server, until the layout store is built.",
  },
  {
    key: 'indicator_use',
    label: 'Indicator use',
    owner: 'apps/customer, svc-identity preferences (C-workspace-02)',
    text: 'Not served: indicators are added on the device and no server records which ones are used.',
  },
] as const;

export const utcSecond = (iso: string): string => `${iso.slice(0, 19).replace('T', ' ')} UTC`;
