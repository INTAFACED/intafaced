/**
 * Agent-set ticket properties: priority, type and labels.
 *
 * Operator-only and kept beside the ticket rather than on it, because the
 * ticket owner reads the ticket. A ticket nobody has touched has none set
 * (null, null, no labels); nothing is guessed.
 */
import type { Sql } from 'postgres';
import type { SupportTicketPriority, SupportTicketProperties, SupportTicketPropertyChange, SupportTicketType } from '@intafaced/contracts';

export interface PropertyChange {
  readonly ticketId: string;
  /** undefined leaves the field alone; null clears it. */
  readonly priority?: SupportTicketPriority | null;
  readonly ticketType?: SupportTicketType | null;
  /** Replaces the whole set when given. */
  readonly labels?: readonly string[];
  readonly by: string;
  readonly reason: string | null;
  readonly at: string;
}

export interface PropertiesBook {
  get(ticketId: string): Promise<SupportTicketProperties>;
  /** Writes and logs one row only when something actually changed. */
  set(change: PropertyChange): Promise<SupportTicketProperties>;
  /** Ids of tickets carrying a label. */
  ticketsWithLabel(label: string): Promise<Set<string>>;
  /** One row per field each logged save changed, oldest first, at most `limit` rows. */
  history(ticketId: string, limit: number): Promise<SupportTicketPropertyChange[]>;
}

type LogRow = { before: SupportTicketProperties; after: SupportTicketProperties; by: string; reason: string | null; at: string };

const labelText = (labels: readonly string[]): string | null => (labels.length === 0 ? null : normaliseLabels(labels).join(', '));

/** Split one logged save into a row per field it changed. Never a row for a field it left alone. */
export function fieldChanges(ticketId: string, row: LogRow): SupportTicketPropertyChange[] {
  const base = { ticketId, setBy: row.by, reason: row.reason, setAt: row.at };
  const out: SupportTicketPropertyChange[] = [];
  if (row.before.priority !== row.after.priority)
    out.push({ ...base, field: 'priority', before: row.before.priority, after: row.after.priority });
  if (row.before.ticketType !== row.after.ticketType)
    out.push({ ...base, field: 'type', before: row.before.ticketType, after: row.after.ticketType });
  const before = labelText(row.before.labels);
  const after = labelText(row.after.labels);
  if (before !== after) out.push({ ...base, field: 'labels', before, after });
  return out;
}

const empty = (ticketId: string): SupportTicketProperties => ({ ticketId, priority: null, ticketType: null, labels: [], updatedAt: null });

/** Sorted, de-duplicated label set so equal sets compare equal. */
export function normaliseLabels(labels: readonly string[]): string[] {
  return [...new Set(labels)].sort();
}

function apply(prior: SupportTicketProperties, change: PropertyChange): SupportTicketProperties {
  return {
    ticketId: prior.ticketId,
    priority: change.priority === undefined ? prior.priority : change.priority,
    ticketType: change.ticketType === undefined ? prior.ticketType : change.ticketType,
    labels: change.labels === undefined ? prior.labels : normaliseLabels(change.labels),
    updatedAt: change.at,
  };
}

const same = (a: SupportTicketProperties, b: SupportTicketProperties): boolean =>
  a.priority === b.priority &&
  a.ticketType === b.ticketType &&
  a.labels.length === b.labels.length &&
  a.labels.every((l, i) => l === b.labels[i]);

export class MemoryPropertiesBook implements PropertiesBook {
  private readonly rows = new Map<string, SupportTicketProperties>();
  readonly log: {
    ticketId: string;
    before: SupportTicketProperties;
    after: SupportTicketProperties;
    by: string;
    reason: string | null;
    at: string;
  }[] = [];

  async get(ticketId: string): Promise<SupportTicketProperties> {
    return this.rows.get(ticketId) ?? empty(ticketId);
  }

  async set(change: PropertyChange): Promise<SupportTicketProperties> {
    const prior = await this.get(change.ticketId);
    const next = apply(prior, change);
    if (same(prior, next)) return prior;
    this.rows.set(change.ticketId, next);
    this.log.push({ ticketId: change.ticketId, before: prior, after: next, by: change.by, reason: change.reason, at: change.at });
    return next;
  }

  async ticketsWithLabel(label: string): Promise<Set<string>> {
    return new Set([...this.rows.values()].filter((p) => p.labels.includes(label)).map((p) => p.ticketId));
  }

  async history(ticketId: string, limit: number): Promise<SupportTicketPropertyChange[]> {
    return this.log
      .filter((row) => row.ticketId === ticketId)
      .flatMap((row) => fieldChanges(ticketId, row))
      .slice(0, limit);
  }
}

type Row = {
  ticket_id: string;
  priority: SupportTicketPriority | null;
  ticket_type: SupportTicketType | null;
  labels: string[];
  updated_at: Date | string;
};

const fromRow = (row: Row): SupportTicketProperties => ({
  ticketId: row.ticket_id,
  priority: row.priority,
  ticketType: row.ticket_type,
  labels: [...row.labels],
  updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : new Date(row.updated_at).toISOString(),
});

export class SqlPropertiesBook implements PropertiesBook {
  constructor(private readonly sql: Sql) {}

  async get(ticketId: string): Promise<SupportTicketProperties> {
    const rows = await this.sql<Row[]>`
      SELECT ticket_id, priority, ticket_type, labels, updated_at FROM support.ticket_properties WHERE ticket_id = ${ticketId}
    `;
    return rows[0] ? fromRow(rows[0]) : empty(ticketId);
  }

  async set(change: PropertyChange): Promise<SupportTicketProperties> {
    return this.sql.begin(async (tx) => {
      // The ticket row is the lock: writers of one ticket's properties serialise on it.
      await tx`SELECT 1 FROM support.tickets WHERE id = ${change.ticketId} FOR UPDATE`;
      const rows = await tx<Row[]>`
        SELECT ticket_id, priority, ticket_type, labels, updated_at FROM support.ticket_properties WHERE ticket_id = ${change.ticketId}
      `;
      const prior = rows[0] ? fromRow(rows[0]) : empty(change.ticketId);
      const next = apply(prior, change);
      if (same(prior, next)) return prior;
      await tx`
        INSERT INTO support.ticket_properties (ticket_id, priority, ticket_type, labels, updated_by, updated_at)
        VALUES (${change.ticketId}, ${next.priority}, ${next.ticketType}, ${next.labels}, ${change.by}, ${change.at})
        ON CONFLICT (ticket_id) DO UPDATE SET priority = EXCLUDED.priority, ticket_type = EXCLUDED.ticket_type,
          labels = EXCLUDED.labels, updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at
      `;
      await tx`
        INSERT INTO support.ticket_property_log (ticket_id, before, after, set_by, reason, set_at)
        VALUES (${change.ticketId}, ${tx.json(prior as never)}, ${tx.json(next as never)}, ${change.by}, ${change.reason}, ${change.at})
      `;
      return next;
    }) as Promise<SupportTicketProperties>;
  }

  async ticketsWithLabel(label: string): Promise<Set<string>> {
    const rows = await this.sql<{ ticket_id: string }[]>`SELECT ticket_id FROM support.ticket_properties WHERE ${label} = ANY(labels)`;
    return new Set(rows.map((r) => r.ticket_id));
  }

  async history(ticketId: string, limit: number): Promise<SupportTicketPropertyChange[]> {
    // A save changes at most three fields, so `limit` log rows always cover `limit` field rows.
    const rows = await this.sql<
      { before: SupportTicketProperties; after: SupportTicketProperties; set_by: string; reason: string | null; set_at: Date | string }[]
    >`
      SELECT before, after, set_by, reason, set_at FROM support.ticket_property_log
      WHERE ticket_id = ${ticketId} ORDER BY id ASC LIMIT ${limit}
    `;
    return rows
      .flatMap((r) =>
        fieldChanges(ticketId, {
          before: r.before,
          after: r.after,
          by: r.set_by,
          reason: r.reason,
          at: r.set_at instanceof Date ? r.set_at.toISOString() : new Date(r.set_at).toISOString(),
        }),
      )
      .slice(0, limit);
  }
}
