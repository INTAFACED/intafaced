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
  /** Rows the bus has not taken yet and that are due (not backing off), oldest first. */
  pending(limit: number, now: string): Promise<RequestEvent[]>;
  markPublished(key: string, at: string): Promise<void>;
  /** A publish failed: count it and back it off by `retryDelayMs(attempts)` from `now`, so later rows go first. Returns the new attempt count. */
  markFailed(key: string, error: string, now: string): Promise<number>;
}

/** Backoff after the n-th failed publish: 1, 2, 4 … minutes, capped at one hour. A sweep cadence, not a business limit. */
export function retryDelayMs(attempts: number): number {
  return Math.min(60 * 60_000, 60_000 * 2 ** Math.max(0, attempts - 1));
}

export interface RequestEventSink {
  send(event: RequestEvent): Promise<void>;
}

/** In-memory book for unit tests and a desk booted without Postgres. Rows are added by `add`, standing in for the triggers. */
export class MemoryRequestEventBook implements RequestEventBook {
  private readonly rows = new Map<string, RequestEvent & { publishedAt: string | null; attempts: number; nextAttemptAt: string | null }>();

  add(event: RequestEvent): void {
    if (!this.rows.has(event.key)) this.rows.set(event.key, { ...event, publishedAt: null, attempts: 0, nextAttemptAt: null });
  }

  attempts(key: string): number {
    return this.rows.get(key)?.attempts ?? 0;
  }

  publishedAt(key: string): string | null {
    return this.rows.get(key)?.publishedAt ?? null;
  }

  async pending(limit: number, now: string): Promise<RequestEvent[]> {
    return [...this.rows.values()]
      .filter((r) => r.publishedAt === null && (r.nextAttemptAt === null || r.nextAttemptAt <= now))
      .sort((a, b) => a.occurredAt.localeCompare(b.occurredAt) || a.key.localeCompare(b.key))
      .slice(0, limit)
      .map(({ publishedAt: _p, attempts: _a, nextAttemptAt: _n, ...event }) => event as RequestEvent);
  }

  async markFailed(key: string, _error: string, now: string): Promise<number> {
    const row = this.rows.get(key);
    if (!row || row.publishedAt !== null) return 0;
    row.attempts += 1;
    row.nextAttemptAt = new Date(Date.parse(now) + retryDelayMs(row.attempts)).toISOString();
    return row.attempts;
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

  async pending(limit: number, now: string): Promise<RequestEvent[]> {
    const rows = await this.sql<Row[]>`
      SELECT event_key, event_name, ticket_id, user_id, status, message_id, author_role, occurred_at
      FROM support.event_outbox
      WHERE published_at IS NULL AND (next_attempt_at IS NULL OR next_attempt_at <= ${now})
      ORDER BY occurred_at, event_key LIMIT ${limit}
    `;
    const out: RequestEvent[] = [];
    for (const r of rows) {
      try {
        out.push(rowToEvent(r));
      } catch (err) {
        // Unreachable under the CHECK constraint. Never published wrong: backed off so it cannot block the rows behind it.
        await this.markFailed(r.event_key, err instanceof Error ? err.message : String(err), now);
      }
    }
    return out;
  }

  async markFailed(key: string, error: string, now: string): Promise<number> {
    const [row] = await this.sql<{ attempts: number }[]>`
      UPDATE support.event_outbox
      SET attempts = attempts + 1,
          next_attempt_at = ${now}::timestamptz + make_interval(secs => LEAST(3600, 60 * power(2, attempts))),
          last_error = ${error.slice(0, 500)}
      WHERE event_key = ${key} AND published_at IS NULL
      RETURNING attempts
    `;
    return row?.attempts ?? 0;
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

/** How many rows one page takes. A page size, not a cap: a sweep keeps paging until the due backlog is drained. */
export const SWEEP_PAGE = 100;

export type OutboxLog = (event: { key: string; error: string; attempts: number }) => void;

export class RequestEventOutbox {
  constructor(
    private readonly book: RequestEventBook,
    /** Resolves null while no bus is connected: rows stay pending and `flush` publishes nothing. */
    private readonly sink: () => Promise<RequestEventSink | null>,
    private readonly now: () => Date = () => new Date(),
    /** Told about each failed publish, so a stuck row is visible instead of silent. */
    private readonly onFailure: OutboxLog = () => undefined,
    private readonly pageSize: number = SWEEP_PAGE,
  ) {}

  /**
   * Publish everything due. A failed publish is counted and backed off (1, 2, 4 … minutes,
   * at most an hour), so it drops out of the next pages and never holds up the rows behind
   * it; a crash between publish and mark re-publishes under the same key. Pages until a page
   * comes back short, so the backlog is drained in one sweep rather than a page a minute.
   * Returns the number the bus took.
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
    const attempts = new Map<string, number>(); // keys that failed in this sweep
    for (;;) {
      const now = this.now();
      const page = await this.book.pending(this.pageSize, now.toISOString());
      let progressed = false;
      for (const event of page) {
        if (attempts.has(event.key)) continue; // already tried in this sweep; it is backing off
        try {
          await sink.send(event);
          await this.book.markPublished(event.key, this.now().toISOString());
          sent += 1;
          progressed = true;
        } catch (err) {
          const error = err instanceof Error ? err.message : String(err);
          const tries = await this.book.markFailed(event.key, error, now.toISOString());
          attempts.set(event.key, tries);
          this.onFailure({ key: event.key, error, attempts: tries });
          progressed = true;
        }
      }
      if (page.length < this.pageSize || !progressed) return sent;
    }
  }
}
