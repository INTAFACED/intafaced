/**
 * Request notification outbox (SP-email-01). Triggers from migration 0028 write one row
 * per opened request, status change and message, in the same transaction as the ticket
 * or message row. This sweep publishes each pending row as `support.ticket.opened`,
 * `support.ticket.updated` or `support.message.created`, under its business key, and
 * marks it. svc-notify decides who is told and how. With no bus the rows stay pending
 * and nothing is claimed sent. No request or message text is published.
 */
import type { Sql } from 'postgres';
import type { EventBus } from '@intafaced/events';

export type RequestEvent =
  | { key: string; name: 'supportTicketOpened'; ticketId: string; userId: string; occurredAt: string }
  | {
      key: string;
      name: 'supportTicketUpdated';
      ticketId: string;
      userId: string;
      status: 'open' | 'pending' | 'on_hold' | 'resolved' | 'closed';
      occurredAt: string;
    }
  | {
      key: string;
      name: 'supportMessageCreated';
      ticketId: string;
      userId: string;
      messageId: string;
      authorRole: 'user' | 'operator';
      occurredAt: string;
    };

export interface RequestEventBook {
  /** Rows the bus has not taken yet, oldest first. */
  pending(limit: number): Promise<RequestEvent[]>;
  markPublished(key: string, at: string): Promise<void>;
}

export interface RequestEventSink {
  send(event: RequestEvent): Promise<void>;
}

/** In-memory book for unit tests and a desk booted without Postgres. Rows are added by `add`, standing in for the triggers. */
export class MemoryRequestEventBook implements RequestEventBook {
  private readonly rows = new Map<string, RequestEvent & { publishedAt: string | null }>();

  add(event: RequestEvent): void {
    if (!this.rows.has(event.key)) this.rows.set(event.key, { ...event, publishedAt: null });
  }

  publishedAt(key: string): string | null {
    return this.rows.get(key)?.publishedAt ?? null;
  }

  async pending(limit: number): Promise<RequestEvent[]> {
    return [...this.rows.values()]
      .filter((r) => r.publishedAt === null)
      .sort((a, b) => a.occurredAt.localeCompare(b.occurredAt) || a.key.localeCompare(b.key))
      .slice(0, limit)
      .map(({ publishedAt: _published, ...event }) => event as RequestEvent);
  }

  async markPublished(key: string, at: string): Promise<void> {
    const row = this.rows.get(key);
    if (row && row.publishedAt === null) row.publishedAt = at;
  }
}

type Row = {
  event_key: string;
  event_name: RequestEvent['name'];
  ticket_id: string;
  user_id: string;
  status: string | null;
  message_id: string | null;
  author_role: string | null;
  occurred_at: Date | string;
};

const iso = (v: Date | string): string => (v instanceof Date ? v : new Date(v)).toISOString();

/** Maps one outbox row. A row whose shape does not fit its name is not guessed at: it throws and stays pending. */
export function rowToEvent(r: Row): RequestEvent {
  const base = { key: r.event_key, ticketId: r.ticket_id, userId: r.user_id, occurredAt: iso(r.occurred_at) };
  switch (r.event_name) {
    case 'supportTicketOpened':
      return { ...base, name: 'supportTicketOpened' };
    case 'supportTicketUpdated':
      if (r.status !== 'open' && r.status !== 'pending' && r.status !== 'on_hold' && r.status !== 'resolved' && r.status !== 'closed') {
        throw new Error(`support.event_outbox_row_invalid: ${r.event_key}`);
      }
      return { ...base, name: 'supportTicketUpdated', status: r.status };
    case 'supportMessageCreated':
      if (r.message_id === null || (r.author_role !== 'user' && r.author_role !== 'operator')) {
        throw new Error(`support.event_outbox_row_invalid: ${r.event_key}`);
      }
      return { ...base, name: 'supportMessageCreated', messageId: r.message_id, authorRole: r.author_role };
    default:
      throw new Error(`support.event_outbox_row_invalid: ${String(r.event_key)}`);
  }
}

export class SqlRequestEventBook implements RequestEventBook {
  constructor(private readonly sql: Sql) {}

  async pending(limit: number): Promise<RequestEvent[]> {
    const rows = await this.sql<Row[]>`
      SELECT event_key, event_name, ticket_id, user_id, status, message_id, author_role, occurred_at
      FROM support.event_outbox
      WHERE published_at IS NULL ORDER BY occurred_at, event_key LIMIT ${limit}
    `;
    const out: RequestEvent[] = [];
    for (const r of rows) {
      try {
        out.push(rowToEvent(r));
      } catch {
        // The CHECK constraint makes this unreachable; a bad row stays pending rather than being published wrong.
      }
    }
    return out;
  }

  async markPublished(key: string, at: string): Promise<void> {
    await this.sql`
      UPDATE support.event_outbox SET published_at = ${at}
      WHERE event_key = ${key} AND published_at IS NULL
    `;
  }
}

/** The bus end. The idempotency key is the row's business key, so a replay or a second replica publishes the same message. */
export function eventRequestEventSink(bus: EventBus): RequestEventSink {
  return {
    send: async (event) => {
      const opts = { idempotencyKey: event.key };
      switch (event.name) {
        case 'supportTicketOpened':
          await bus.publish('supportTicketOpened', { ticketId: event.ticketId, userId: event.userId, openedAt: event.occurredAt }, opts);
          return;
        case 'supportTicketUpdated':
          await bus.publish(
            'supportTicketUpdated',
            { ticketId: event.ticketId, userId: event.userId, status: event.status, updatedAt: event.occurredAt },
            opts,
          );
          return;
        case 'supportMessageCreated':
          await bus.publish(
            'supportMessageCreated',
            {
              ticketId: event.ticketId,
              messageId: event.messageId,
              userId: event.userId,
              authorRole: event.authorRole,
              createdAt: event.occurredAt,
            },
            opts,
          );
          return;
      }
    },
  };
}

/** How many rows one sweep takes. A batch size, not a business limit. */
const SWEEP_BATCH = 100;

export class RequestEventOutbox {
  constructor(
    private readonly book: RequestEventBook,
    /** Resolves null while no bus is connected: rows stay pending and `flush` publishes nothing. */
    private readonly sink: () => Promise<RequestEventSink | null>,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /**
   * Publish what is pending. A failed publish keeps its row and the sweep goes on to the
   * next; a crash between publish and mark re-publishes under the same key. Returns the
   * number the bus took.
   */
  flush(): Promise<number> {
    this.sweeping ??= this.sweep().finally(() => {
      this.sweeping = null;
    });
    return this.sweeping;
  }

  private sweeping: Promise<number> | null = null;

  private async sweep(): Promise<number> {
    const sink = await this.sink();
    if (!sink) return 0;
    let sent = 0;
    for (const event of await this.book.pending(SWEEP_BATCH)) {
      try {
        await sink.send(event);
        await this.book.markPublished(event.key, this.now().toISOString());
        sent += 1;
      } catch {
        // Stays pending; the next sweep tries again under the same key.
      }
    }
    return sent;
  }
}
