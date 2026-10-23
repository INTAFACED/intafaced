/**
 * The public status page as a visitor reads it (SP-status-01), built from the founders' definition, the stored readings
 * and the published incident and maintenance notices.
 *
 * A component's state, in order: an open incident naming it (its newest impact), an active maintenance window naming it,
 * then its newest reading if that is inside the staleness window. Anything else is `no_data`, never operational. The top
 * level is the worst component state, so one component nobody can read keeps it from reading operational.
 */
import {
  STATUS_PAGE_SEVERITY,
  type StatusComponentBasis,
  type StatusPage,
  type StatusPageState,
  type StatusReadingState,
} from '@intafaced/contracts';
import type { StatusFeed } from '../notices/status-feed.js';
import type { StatusDefinition, StatusReading } from './book.js';

const DAY_MS = 86_400_000;
const INCIDENT_STATE = { minor: 'degraded', major: 'partial_outage', critical: 'major_outage' } as const;

const worse = (a: StatusPageState, b: StatusPageState): StatusPageState => (STATUS_PAGE_SEVERITY[b] > STATUS_PAGE_SEVERITY[a] ? b : a);

/** The first day of the uptime window: midnight UTC, `days - 1` days before today. */
export function uptimeStart(at: Date, days: number): Date {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()) - (days - 1) * DAY_MS);
}

function uptimeOf(
  componentId: string,
  readings: readonly StatusReading[],
  at: Date,
  days: number | null,
): StatusPage['components'][number]['uptime'] {
  if (days === null) return [];
  const start = uptimeStart(at, days).getTime();
  const out: { date: string; state: StatusReadingState | null }[] = [];
  for (let i = 0; i < days; i += 1) {
    const from = start + i * DAY_MS;
    let state: StatusReadingState | null = null;
    for (const r of readings) {
      const t = r.observedAt.getTime();
      if (r.componentId !== componentId || t < from || t >= from + DAY_MS || t > at.getTime()) continue;
      state = state === null ? r.state : (worse(state, r.state) as StatusReadingState);
    }
    out.push({ date: new Date(from).toISOString().slice(0, 10), state });
  }
  return out;
}

export function buildStatusPage(input: {
  definition: StatusDefinition;
  latest: readonly StatusReading[];
  window: readonly StatusReading[];
  feed: Pick<StatusFeed, 'incidents' | 'maintenance'>;
  at: Date;
}): StatusPage {
  const { definition, latest, window, feed, at } = input;
  const open = feed.incidents.filter((incident) => incident.resolvedAt === null);
  const components = definition.components.map((component) => {
    const reading = latest.find((r) => r.componentId === component.id) ?? null;
    let state: StatusPageState = 'no_data';
    let basis: StatusComponentBasis = 'no_reading';
    let incidentId: string | null = null;
    for (const incident of open) {
      if (!incident.components.includes(component.id) || !incident.impact || incident.impact === 'none') continue;
      const named = INCIDENT_STATE[incident.impact];
      if (incidentId === null || STATUS_PAGE_SEVERITY[named] > STATUS_PAGE_SEVERITY[state]) {
        state = named;
        incidentId = incident.id;
      }
    }
    if (incidentId !== null) basis = 'incident';
    else if (feed.maintenance.some((m) => m.components.includes(component.id))) {
      state = 'maintenance';
      basis = 'maintenance';
    } else if (reading && definition.stalenessSeconds === null) basis = 'staleness_unset';
    else if (reading && at.getTime() - reading.observedAt.getTime() > definition.stalenessSeconds! * 1000) basis = 'stale';
    else if (reading) {
      state = reading.state;
      basis = 'reading';
    }
    return {
      id: component.id,
      name: component.name,
      group: component.group,
      source: component.source,
      state,
      basis,
      reading: reading ? { state: reading.state, observedAt: reading.observedAt.toISOString(), source: reading.source } : null,
      incidentId,
      uptime: uptimeOf(component.id, window, at, definition.uptimeDays),
    };
  });
  const overall =
    components.length === 0 ? 'none_defined' : components.reduce<StatusPageState>((acc, c) => worse(acc, c.state), 'operational');
  return {
    asOf: at.toISOString(),
    revision: definition.revision,
    settings: {
      componentCap: definition.componentCap,
      stalenessSeconds: definition.stalenessSeconds,
      uptimeDays: definition.uptimeDays,
    },
    overall,
    components,
    incidents: feed.incidents.map((incident) => ({ ...incident, components: [...incident.components], updates: [...incident.updates] })),
  };
}
