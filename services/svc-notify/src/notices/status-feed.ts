/**
 * The machine-readable status feed: component states, incidents with their
 * update timelines, and a per-day record of incident minutes.
 *
 * Everything here is derived from published notices. Nothing probes a service,
 * so a component with no published notice about it reads `unknown`, never
 * `operational`, and the per-day record carries incident minutes only: it makes
 * no uptime percentage because nothing measures one.
 */

import type { IncidentImpact, NoticeRow, StatusComponent } from './board.js';
import { STATUS_COMPONENTS } from './board.js';

/** Published rows read to build the feed. Older rows fall outside it. */
export const STATUS_FEED_ROWS_MAX = 500;
export const STATUS_FEED_DAYS_MAX = 90;

export type ComponentState = 'unknown' | 'maintenance' | 'degraded' | 'partial_outage' | 'major_outage';

export type StatusUpdate = {
  readonly id: string;
  readonly body: string;
  readonly impact: IncidentImpact | null;
  readonly publishedAt: string;
  readonly resolves: boolean;
};

export type StatusIncident = {
  readonly id: string;
  readonly title: string;
  /** The impact on the newest entry. Null when no entry names one. */
  readonly impact: IncidentImpact | null;
  readonly components: readonly StatusComponent[];
  readonly openedAt: string;
  readonly resolvedAt: string | null;
  readonly updates: readonly StatusUpdate[];
};

export type StatusMaintenance = {
  readonly id: string;
  readonly title: string;
  readonly components: readonly StatusComponent[];
  readonly startsAt: string | null;
  readonly endsAt: string | null;
};

export type ComponentStatus = {
  readonly component: StatusComponent;
  readonly state: ComponentState;
  /** Why the state is what it is: a published notice, or nothing measuring it. */
  readonly basis: 'incident' | 'maintenance' | 'no_measurement';
  readonly since: string | null;
};

export type StatusDay = {
  /** UTC calendar day, `YYYY-MM-DD`. */
  readonly date: string;
  readonly components: ReadonlyArray<{
    readonly component: StatusComponent;
    readonly incidentMinutes: number;
    readonly worstImpact: IncidentImpact | null;
  }>;
};

export type StatusFeed = {
  readonly asOf: string;
  readonly components: readonly ComponentStatus[];
  /** Open incidents first, then resolved ones inside the window, newest first. */
  readonly incidents: readonly StatusIncident[];
  readonly maintenance: readonly StatusMaintenance[];
  readonly history: {
    /** Incident minutes come from published notices. No uptime percentage is made. */
    readonly basis: 'incident_notices_only';
    readonly days: readonly StatusDay[];
  };
};

const IMPACT_RANK: Record<IncidentImpact, number> = { none: 0, minor: 1, major: 2, critical: 3 };
const STATE_FOR: Record<Exclude<IncidentImpact, 'none'>, ComponentState> = {
  minor: 'degraded',
  major: 'partial_outage',
  critical: 'major_outage',
};
const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;

export function clampStatusDays(days: number): number {
  if (!Number.isInteger(days) || days < 1) throw new RangeError('notify.status_days_invalid');
  return Math.min(days, STATUS_FEED_DAYS_MAX);
}

type Thread = {
  readonly root: NoticeRow;
  readonly entries: readonly NoticeRow[];
  readonly latest: NoticeRow;
  readonly resolvedAt: Date | null;
};

function byPublished(a: NoticeRow, b: NoticeRow): number {
  return (a.publishedAt?.getTime() ?? 0) - (b.publishedAt?.getTime() ?? 0) || a.id.localeCompare(b.id);
}

function threadsOf(rows: readonly NoticeRow[], at: Date): Thread[] {
  const incidents = rows.filter((row) => row.kind === 'incident' && row.publishedAt !== null);
  const children = new Map<string, NoticeRow[]>();
  for (const row of incidents) {
    if (row.parentId === null) continue;
    children.set(row.parentId, [...(children.get(row.parentId) ?? []), row]);
  }
  const threads: Thread[] = [];
  for (const root of incidents.filter((row) => row.parentId === null)) {
    const entries = [root, ...(children.get(root.id) ?? [])].sort(byPublished);
    const latest = entries[entries.length - 1]!;
    // A legacy incident has no close flag; its own end time closes it, as the open-notice read does.
    const closedByTime = latest.endsAt !== null && latest.endsAt.getTime() <= at.getTime();
    const resolvedAt = latest.resolves ? latest.publishedAt : closedByTime ? latest.endsAt : null;
    threads.push({ root, entries, latest, resolvedAt });
  }
  return threads;
}

function dayKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function buildStatusFeed(rows: readonly NoticeRow[], at: Date, days: number): StatusFeed {
  const now = at.getTime();
  const windowStart = Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()) - (days - 1) * DAY_MS;
  const threads = threadsOf(rows, at);

  const open = threads.filter((t) => t.resolvedAt === null);
  const inWindow = threads.filter((t) => t.resolvedAt !== null && t.resolvedAt.getTime() >= windowStart);
  const shown = [
    ...open.sort((a, b) => byPublished(b.latest, a.latest)),
    ...inWindow.sort((a, b) => b.resolvedAt!.getTime() - a.resolvedAt!.getTime()),
  ];
  const incidents: StatusIncident[] = shown.map((t) => ({
    id: t.root.id,
    title: t.root.title,
    impact: t.latest.impact ?? t.root.impact,
    components: t.latest.components.length > 0 ? t.latest.components : t.root.components,
    openedAt: t.root.publishedAt!.toISOString(),
    resolvedAt: t.resolvedAt?.toISOString() ?? null,
    updates: t.entries.map((entry) => ({
      id: entry.id,
      body: entry.body,
      impact: entry.impact,
      publishedAt: entry.publishedAt!.toISOString(),
      resolves: entry.resolves,
    })),
  }));

  const maintenance: StatusMaintenance[] = rows
    .filter((row) => row.kind === 'maintenance' && row.publishedAt !== null)
    .filter((row) => (row.startsAt ? row.startsAt.getTime() <= now : true) && (row.endsAt ? row.endsAt.getTime() > now : true))
    .map((row) => ({
      id: row.id,
      title: row.title,
      components: row.components,
      startsAt: row.startsAt?.toISOString() ?? null,
      endsAt: row.endsAt?.toISOString() ?? null,
    }));

  const components: ComponentStatus[] = STATUS_COMPONENTS.map((component) => {
    let worst: { rank: number; state: ComponentState; since: Date } | null = null;
    for (const t of open) {
      const impact = t.latest.impact ?? t.root.impact;
      const affected = (t.latest.components.length > 0 ? t.latest.components : t.root.components).includes(component);
      if (!impact || impact === 'none' || !affected) continue;
      const rank = IMPACT_RANK[impact];
      if (!worst || rank > worst.rank) worst = { rank, state: STATE_FOR[impact], since: t.root.publishedAt! };
    }
    if (worst) return { component, state: worst.state, basis: 'incident', since: worst.since.toISOString() };
    const window = maintenance.find((m) => m.components.includes(component));
    if (window) return { component, state: 'maintenance', basis: 'maintenance', since: window.startsAt };
    return { component, state: 'unknown', basis: 'no_measurement', since: null };
  });

  const history: StatusDay[] = [];
  for (let i = 0; i < days; i += 1) {
    const dayStart = windowStart + i * DAY_MS;
    if (dayStart > now) break;
    const dayEnd = Math.min(dayStart + DAY_MS, now);
    history.push({
      date: dayKey(dayStart),
      components: STATUS_COMPONENTS.map((component) => {
        const spans: Array<[number, number]> = [];
        let worstRank = -1;
        let worstImpact: IncidentImpact | null = null;
        for (const t of threads) {
          const impact = t.latest.impact ?? t.root.impact;
          const affected = (t.latest.components.length > 0 ? t.latest.components : t.root.components).includes(component);
          if (!impact || impact === 'none' || !affected) continue;
          const from = Math.max(t.root.publishedAt!.getTime(), dayStart);
          const to = Math.min(t.resolvedAt?.getTime() ?? now, dayEnd);
          if (to <= from) continue;
          spans.push([from, to]);
          if (IMPACT_RANK[impact] > worstRank) {
            worstRank = IMPACT_RANK[impact];
            worstImpact = impact;
          }
        }
        // Overlapping incidents on one component count their shared minutes once.
        spans.sort((a, b) => a[0] - b[0]);
        let covered = 0;
        let reach = -Infinity;
        for (const [from, to] of spans) {
          covered += Math.max(0, to - Math.max(from, reach));
          reach = Math.max(reach, to);
        }
        const minutes = Math.floor(covered / MINUTE_MS);
        return { component, incidentMinutes: minutes, worstImpact };
      }),
    });
  }

  return {
    asOf: at.toISOString(),
    components,
    incidents,
    maintenance,
    history: { basis: 'incident_notices_only', days: history },
  };
}
