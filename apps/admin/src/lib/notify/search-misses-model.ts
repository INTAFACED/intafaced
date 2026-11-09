/**
 * Header searches that found nothing (HM-navigation-04; svc-notify `navMetrics.searchMisses`, admin:read): one count per
 * UTC day. svc-notify keeps no account, no words and no per-search row (its `nav_metric_counts` table holds only kind, day
 * and count), so this desk can say how often a search missed, never who searched or for what. The counts are approximate:
 * the app sends each one once with no retry, and anyone can add to it.
 *
 * The service names no default window and refuses a blank one, so the desk names its own: the last `SEARCH_MISS_DAYS` days.
 */

export const SEARCH_MISS_DAYS = 14;

export interface SearchMissDay {
  readonly day: string;
  readonly count: number;
}

export interface SearchMisses {
  readonly from: string;
  readonly to: string;
  readonly days: readonly SearchMissDay[];
  readonly total: number;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** svc-notify's answer, read strictly: anything else is no answer, never zero. */
export function readSearchMisses(raw: unknown): SearchMisses | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (r.kind !== 'search_miss' || r.approximate !== true) return null;
  if (typeof r.from !== 'string' || typeof r.to !== 'string' || !Array.isArray(r.days)) return null;
  const days: SearchMissDay[] = [];
  for (const d of r.days) {
    if (!d || typeof d !== 'object') return null;
    const { day, count } = d as Record<string, unknown>;
    if (typeof day !== 'string' || !DAY.test(day) || typeof count !== 'number' || !Number.isInteger(count) || count < 0) return null;
    days.push({ day, count });
  }
  return { from: r.from, to: r.to, days, total: days.reduce((sum, d) => sum + d.count, 0) };
}
