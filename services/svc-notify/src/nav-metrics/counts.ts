/**
 * Navigation metric counts (HM-navigation-04's search-miss counter, received here for the founders' metrics desk of
 * HM-desks-02). A count is a number per kind and UTC day and nothing else: no account id, no query text, no per-event row,
 * so it can never say who searched or for what. A count is approximate, and every read says so: the customer app sends
 * each count once and never retries, so a lost one stays lost, and the write is public, so anyone can add to it.
 */
import type { Sql } from 'postgres';

export const NAV_METRIC_KINDS = ['search_miss'] as const;
export type NavMetricKind = (typeof NAV_METRIC_KINDS)[number];

/** The longest window a founder may read at once, in days. */
export const NAV_METRIC_DAYS_MAX = 90;

export interface NavMetricDay {
  /** UTC day, `YYYY-MM-DD`. */
  day: string;
  count: number;
}

export interface NavMetricStore {
  /** Adds one to `kind`'s count for the UTC day of `at`. */
  count(kind: NavMetricKind, at: Date): Promise<void>;
  /** The days from `from` to `to` (UTC, inclusive) that have a count, oldest first. */
  read(kind: NavMetricKind, from: string, to: string): Promise<NavMetricDay[]>;
}

export const utcDay = (at: Date): string => at.toISOString().slice(0, 10);

/** The UTC days of a window that ends today and is `days` long: `[from, to]`. */
export function windowDays(now: Date, days: number): { from: string; to: string } {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - (days - 1)));
  return { from: utcDay(start), to: utcDay(now) };
}

export class MemoryNavMetricStore implements NavMetricStore {
  private readonly counts = new Map<string, number>();

  async count(kind: NavMetricKind, at: Date): Promise<void> {
    const key = `${kind}:${utcDay(at)}`;
    this.counts.set(key, (this.counts.get(key) ?? 0) + 1);
  }

  async read(kind: NavMetricKind, from: string, to: string): Promise<NavMetricDay[]> {
    return [...this.counts]
      .filter(([key]) => key.startsWith(`${kind}:`))
      .map(([key, count]) => ({ day: key.slice(kind.length + 1), count }))
      .filter((row) => row.day >= from && row.day <= to)
      .sort((a, b) => a.day.localeCompare(b.day));
  }
}

/** On notify.nav_metric_counts (0036_notify_nav_metric_counts.sql). */
export class SqlNavMetricStore implements NavMetricStore {
  constructor(private readonly sql: Sql) {}

  async count(kind: NavMetricKind, at: Date): Promise<void> {
    await this.sql`
      INSERT INTO notify.nav_metric_counts (kind, day, count) VALUES (${kind}, ${utcDay(at)}::date, 1)
      ON CONFLICT (kind, day) DO UPDATE SET count = notify.nav_metric_counts.count + 1
    `;
  }

  async read(kind: NavMetricKind, from: string, to: string): Promise<NavMetricDay[]> {
    const rows = await this.sql<{ day: string; count: string }[]>`
      SELECT to_char(day, 'YYYY-MM-DD') AS day, count::text AS count FROM notify.nav_metric_counts
       WHERE kind = ${kind} AND day BETWEEN ${from}::date AND ${to}::date
       ORDER BY day
    `;
    return rows.map((row) => ({ day: row.day, count: Number(row.count) }));
  }
}
