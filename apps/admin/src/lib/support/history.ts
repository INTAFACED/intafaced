import type { SupportTicketEvent, SupportTicketPropertyChange } from '@intafaced/contracts';

/**
 * One row of a ticket's history in the console: a trail event from the ticket's own record, or one field an agent
 * changed on its priority, type and labels (svc-support's property log, staff only). A save that changed three fields is
 * three rows.
 */
export interface HistoryRow {
  readonly key: string;
  /** The trail's own sequence; a property change has none (it is not on the owner's trail). */
  readonly sequence: number | null;
  readonly at: string;
  readonly what: string;
  readonly actorRole: string;
  readonly actorId: string;
  readonly note: string | null;
}

const FIELD_NAME = { priority: 'priority', type: 'type', labels: 'labels' } as const;

function propertyValue(value: string | readonly string[] | null): string {
  if (value === null) return 'none';
  if (typeof value === 'string') return value;
  return value.length === 0 ? 'none' : value.join(', ');
}

function eventWhat(e: SupportTicketEvent): string {
  return e.kind === 'status_changed' ? `status ${e.fromStatus} → ${e.toStatus}` : e.kind;
}

/** Trail events and property changes in time order; at the same instant a trail event comes first. */
export function historyRows(events: readonly SupportTicketEvent[], changes: readonly SupportTicketPropertyChange[]): HistoryRow[] {
  const rows: { row: HistoryRow; time: number; rank: number }[] = [
    ...events.map((e, i) => ({
      row: {
        key: `event:${e.id}`,
        sequence: e.sequence,
        at: e.occurredAt,
        what: eventWhat(e),
        actorRole: e.actorRole,
        actorId: e.actorId,
        note: e.note,
      },
      time: Date.parse(e.occurredAt),
      rank: i,
    })),
    ...changes.map((c, i) => ({
      row: {
        key: `property:${c.logId}:${c.field}`,
        sequence: null,
        at: c.setAt,
        what: `${FIELD_NAME[c.field]} ${propertyValue(c.from)} → ${propertyValue(c.to)}`,
        actorRole: 'operator',
        actorId: c.setBy,
        note: c.reason,
      },
      time: Date.parse(c.setAt),
      rank: events.length + i,
    })),
  ];
  return rows.sort((a, b) => a.time - b.time || a.rank - b.rank).map((r) => r.row);
}
