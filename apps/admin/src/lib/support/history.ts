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

function propertyValue(value: string | readonly string[] | null): string {
  if (value === null) return 'none';
  if (typeof value === 'string') return value;
  return value.length === 0 ? 'none' : value.join(', ');
}

function eventWhat(e: SupportTicketEvent): string {
  return e.kind === 'status_changed' ? `status ${e.fromStatus} → ${e.toStatus}` : e.kind;
}

/** Trail events and property changes in time order; at the same instant a trail event comes first (the sort is stable). */
export function historyRows(events: readonly SupportTicketEvent[], changes: readonly SupportTicketPropertyChange[]): HistoryRow[] {
  const rows: HistoryRow[] = [
    ...events.map((e) => ({
      key: `event:${e.id}`,
      sequence: e.sequence,
      at: e.occurredAt,
      what: eventWhat(e),
      actorRole: e.actorRole,
      actorId: e.actorId,
      note: e.note,
    })),
    ...changes.map((c) => ({
      key: `property:${c.logId}:${c.field}`,
      sequence: null,
      at: c.setAt,
      what: `${c.field} ${propertyValue(c.from)} → ${propertyValue(c.to)}`,
      // Only `setProperties` writes the log, and it is support:ops.
      actorRole: 'operator',
      actorId: c.setBy,
      note: c.reason,
    })),
  ];
  return rows.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}
