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
  /** The log for one ticket, oldest first, one entry per field that changed. At most `limit` log rows are read. */
  changes(ticketId: string, limit: number): Promise<SupportTicketPropertyChange[]>;
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

type LogEntry = {
  readonly id: string;
  readonly ticketId: string;
  readonly before: SupportTicketProperties;
  readonly after: SupportTicketProperties;
  readonly by: string;
  readonly reason: string | null;
  readonly at: string;
};

/** One log row as the fields it changed, in a fixed order: priority, type, labels. */
export function fieldChanges(entry: LogEntry): SupportTicketPropertyChange[] {
  const base = { logId: entry.id, ticketId: entry.ticketId, setBy: entry.by, reason: entry.reason, setAt: entry.at };
  const out: SupportTicketPropertyChange[] = [];
  const { before, after } = entry;
  if (before.priority !== after.priority) out.push({ ...base, field: 'priority', from: before.priority, to: after.priority });
  if (before.ticketType !== after.ticketType) out.push({ ...base, field: 'type', from: before.ticketType, to: after.ticketType });
  const beforeLabels = normaliseLabels(before.labels);
  const afterLabels = normaliseLabels(after.labels);
  if (beforeLabels.length !== afterLabels.length || beforeLabels.some((l, i) => l !== afterLabels[i])) {
    out.push({ ...base, field: 'labels', from: beforeLabels, to: afterLabels });
  }
  return out;
}

export class MemoryPropertiesBook implements PropertiesBook {
  private readonly rows = new Map<string, SupportTicketProperties>();
  readonly log: {
    id: string;
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
    this.log.push({
      id: String(this.log.length + 1),
      ticketId: change.ticketId,
      before: prior,
      after: next,
      by: change.by,
      reason: change.reason,
      at: change.at,
    });
    return next;
  }

  async ticketsWithLabel(label: string): Promise<Set<string>> {
    return new Set([...this.rows.values()].filter((p) => p.labels.includes(label)).map((p) => p.ticketId));
  }

  async changes(ticketId: string, limit: number): Promise<SupportTicketPropertyChange[]> {
    return this.log
      .filter((e) => e.ticketId === ticketId)
      .slice(0, limit)
      .flatMap(fieldChanges);
  }
}

type Row = {
  ticket_id: string;
  priority: SupportTicketPriority | null;
  ticket_type: SupportTicketType | null;
  labels: string[];
  updated_at: Date | string;
};

type LogRow = {
  id: string;
  ticket_id: string;
  before: SupportTicketProperties;
  after: SupportTicketProperties;
  set_by: string;
  reason: string | null;
  set_at: Date | string;
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

  async changes(ticketId: string, limit: number): Promise<SupportTicketPropertyChange[]> {
    const rows = await this.sql<LogRow[]>`
      SELECT id::text AS id, ticket_id, before, after, set_by, reason, set_at FROM support.ticket_property_log
      WHERE ticket_id = ${ticketId} ORDER BY id LIMIT ${limit}
    `;
    return rows.flatMap((row) =>
      fieldChanges({
        id: row.id,
        ticketId: row.ticket_id,
        before: row.before,
        after: row.after,
        by: row.set_by,
        reason: row.reason,
        at: row.set_at instanceof Date ? row.set_at.toISOString() : new Date(row.set_at).toISOString(),
      }),
    );
  }
}
