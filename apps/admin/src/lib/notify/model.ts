import type { Part } from '@/lib/desk/part';

/**
 * Notification delivery health: strict reader and the figures that can honestly be computed from one page of
 * svc-notify's `operatorDeliveries` (admin:read).
 *
 * What the numbers are, and are not:
 *   - They cover the most recently UPDATED delivery rows the service returned, at most the page asked for. They are
 *     not all-time and not per-window totals, and the desk prints the span they cover.
 *   - `accepted` means the transport took it (the inbox was written, or a gateway accepted it). svc-notify has no
 *     `delivered` fact, so this desk never says "delivered".
 *   - No provider or push-gateway health is read here; only what each delivery row recorded. A channel with no rows in
 *     the page is "no recent deliveries", not "healthy".
 */

export const DELIVERIES_PAGE = 200;
export const STATUSES = ['pending', 'accepted', 'refused', 'failed', 'abandoned'] as const;
export type DeliveryStatus = (typeof STATUSES)[number];
export const FAILURE_STATUSES: readonly DeliveryStatus[] = ['refused', 'failed', 'abandoned'];

export interface DeliveryRow {
  readonly id: string;
  readonly notificationId: string;
  readonly channel: string;
  readonly status: DeliveryStatus;
  readonly attempts: number;
  readonly attemptedAt: string | null;
  readonly acceptedAt: string | null;
  readonly refusalCode: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface DeliveriesRead {
  readonly rows: readonly DeliveryRow[];
  readonly limit: number;
}

export interface NotifyHealth {
  readonly ok: boolean;
  readonly fanoutEnabled: boolean;
}

export interface NotifyView {
  readonly asOf: string;
  readonly deliveries: Part<DeliveriesRead>;
  readonly health: Part<NotifyHealth>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
const isIso = (v: unknown): v is string => typeof v === 'string' && Number.isFinite(Date.parse(v));

export function readDeliveries(raw: unknown, limit: number): DeliveriesRead | null {
  if (!Array.isArray(raw)) return null;
  const rows: DeliveryRow[] = [];
  for (const row of raw) {
    if (!isRecord(row)) return null;
    const { id, notificationId, channel, status, attempts, attemptedAt, acceptedAt, refusalCode, createdAt, updatedAt } = row;
    if (typeof id !== 'string' || typeof notificationId !== 'string' || typeof channel !== 'string' || channel === '') return null;
    if (typeof status !== 'string' || !(STATUSES as readonly string[]).includes(status)) return null;
    if (typeof attempts !== 'number' || !Number.isInteger(attempts) || attempts < 0) return null;
    if (!(attemptedAt === null || isIso(attemptedAt)) || !(acceptedAt === null || isIso(acceptedAt))) return null;
    if (!(refusalCode === null || typeof refusalCode === 'string')) return null;
    if (!isIso(createdAt) || !isIso(updatedAt)) return null;
    rows.push({
      id,
      notificationId,
      channel,
      status: status as DeliveryStatus,
      attempts,
      attemptedAt,
      acceptedAt,
      refusalCode,
      createdAt,
      updatedAt,
    });
  }
  return { rows, limit };
}

export function readHealth(raw: unknown): NotifyHealth | null {
  if (!isRecord(raw) || typeof raw.ok !== 'boolean' || typeof raw.fanoutEnabled !== 'boolean' || raw.service !== 'svc-notify') return null;
  return { ok: raw.ok, fanoutEnabled: raw.fanoutEnabled };
}

export interface ChannelStats {
  readonly channel: string;
  readonly total: number;
  readonly counts: Readonly<Record<DeliveryStatus, number>>;
  /** Rows that reached a final state: everything except `pending`. */
  readonly settled: number;
  /** Whole-number percent of settled rows that were accepted; null when nothing has settled. */
  readonly acceptedPercent: number | null;
  readonly oldestPendingCreatedAt: string | null;
  readonly topRefusalCodes: readonly { readonly code: string; readonly count: number }[];
}

const zero = (): Record<DeliveryStatus, number> => ({ pending: 0, accepted: 0, refused: 0, failed: 0, abandoned: 0 });

export function channelStats(rows: readonly DeliveryRow[]): ChannelStats[] {
  const by = new Map<string, DeliveryRow[]>();
  for (const row of rows) by.set(row.channel, [...(by.get(row.channel) ?? []), row]);
  return [...by.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([channel, list]) => {
      const counts = zero();
      const codes = new Map<string, number>();
      let oldestPending: string | null = null;
      for (const r of list) {
        counts[r.status] += 1;
        if (r.status === 'pending' && (oldestPending === null || Date.parse(r.createdAt) < Date.parse(oldestPending)))
          oldestPending = r.createdAt;
        if (FAILURE_STATUSES.includes(r.status) && r.refusalCode) codes.set(r.refusalCode, (codes.get(r.refusalCode) ?? 0) + 1);
      }
      const settled = list.length - counts.pending;
      return {
        channel,
        total: list.length,
        counts,
        settled,
        acceptedPercent: settled === 0 ? null : Math.floor((counts.accepted * 100) / settled),
        oldestPendingCreatedAt: oldestPending,
        topRefusalCodes: [...codes.entries()]
          .map(([code, count]) => ({ code, count }))
          .sort((a, b) => b.count - a.count || a.code.localeCompare(b.code))
          .slice(0, 3),
      };
    });
}

/** Failures, newest update first. */
export function failureRows(rows: readonly DeliveryRow[]): DeliveryRow[] {
  return rows
    .filter((r) => FAILURE_STATUSES.includes(r.status))
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt) || a.id.localeCompare(b.id));
}

export interface Span {
  readonly from: string;
  readonly to: string;
  readonly pageFull: boolean;
}

/** The time span the figures cover, by last update, and whether the page was full (so older rows exist unseen). */
export function spanOf(read: DeliveriesRead): Span | null {
  if (read.rows.length === 0) return null;
  const times = read.rows.map((r) => Date.parse(r.updatedAt));
  return {
    from: new Date(Math.min(...times)).toISOString(),
    to: new Date(Math.max(...times)).toISOString(),
    pageFull: read.rows.length >= read.limit,
  };
}
