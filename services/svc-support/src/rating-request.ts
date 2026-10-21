/**
 * The emailed rating request, as an outbox. A resolved ticket gets one row; the row is
 * published as `support.ticket.resolved` and marked. svc-notify decides whether anyone
 * is reached (inbox always, email when an address is confirmed and the gateway is set).
 * With no bus the rows stay pending and nothing is claimed sent.
 */
import type { Sql } from 'postgres';
import type { EventBus } from '@intafaced/events';

export interface RatingRequest {
  ticketId: string;
  userId: string;
  resolvedAt: string;
}

export interface RatingRequestBook {
  /** Remember the ask. Only the first resolve of a ticket records; later calls change nothing. */
  record(request: RatingRequest): Promise<void>;
  /** Asks the bus has not taken yet, oldest first. */
  pending(limit: number): Promise<RatingRequest[]>;
  markPublished(ticketId: string, at: string): Promise<void>;
}

export interface RatingRequestSink {
  send(request: RatingRequest): Promise<void>;
}

export class MemoryRatingRequestBook implements RatingRequestBook {
  private readonly rows = new Map<string, RatingRequest & { publishedAt: string | null }>();

  async record(request: RatingRequest): Promise<void> {
    if (!this.rows.has(request.ticketId)) this.rows.set(request.ticketId, { ...request, publishedAt: null });
  }

  async pending(limit: number): Promise<RatingRequest[]> {
    return [...this.rows.values()]
      .filter((r) => r.publishedAt === null)
      .sort((a, b) => a.resolvedAt.localeCompare(b.resolvedAt))
      .slice(0, limit)
      .map(({ ticketId, userId, resolvedAt }) => ({ ticketId, userId, resolvedAt }));
  }

  async markPublished(ticketId: string, at: string): Promise<void> {
    const row = this.rows.get(ticketId);
    if (row && row.publishedAt === null) row.publishedAt = at;
  }
}

type Row = { ticket_id: string; user_id: string; resolved_at: Date | string };

export class SqlRatingRequestBook implements RatingRequestBook {
  constructor(private readonly sql: Sql) {}

  async record(request: RatingRequest): Promise<void> {
    await this.sql`
      INSERT INTO support.rating_requests (ticket_id, user_id, resolved_at)
      VALUES (${request.ticketId}, ${request.userId}, ${request.resolvedAt})
      ON CONFLICT (ticket_id) DO NOTHING
    `;
  }

  async pending(limit: number): Promise<RatingRequest[]> {
    const rows = await this.sql<Row[]>`
      SELECT ticket_id, user_id, resolved_at FROM support.rating_requests
      WHERE published_at IS NULL ORDER BY resolved_at, ticket_id LIMIT ${limit}
    `;
    return rows.map((r) => ({
      ticketId: r.ticket_id,
      userId: r.user_id,
      resolvedAt: (r.resolved_at instanceof Date ? r.resolved_at : new Date(r.resolved_at)).toISOString(),
    }));
  }

  async markPublished(ticketId: string, at: string): Promise<void> {
    await this.sql`
      UPDATE support.rating_requests SET published_at = ${at}
      WHERE ticket_id = ${ticketId} AND published_at IS NULL
    `;
  }
}

/** The bus end. The key is the business key, so a replay or a second replica publishes the same message. */
export function eventRatingRequestSink(bus: EventBus): RatingRequestSink {
  return {
    send: async (request) => {
      await bus.publish(
        'supportTicketResolved',
        { ticketId: request.ticketId, userId: request.userId, resolvedAt: request.resolvedAt },
        { idempotencyKey: `support.rating_request:${request.ticketId}` },
      );
    },
  };
}

/** How many asks one sweep takes. A batch size, not a business limit. */
const SWEEP_BATCH = 50;

export class RatingRequestOutbox {
  constructor(
    private readonly book: RatingRequestBook,
    /** Resolves null while no bus is connected: asks stay pending and `flush` publishes nothing. */
    private readonly sink: () => Promise<RatingRequestSink | null>,
    private readonly now: () => Date = () => new Date(),
  ) {}

  record(request: RatingRequest): Promise<void> {
    return this.book.record(request);
  }

  /**
   * Publish what is pending. A failed publish keeps its row and the sweep goes on to the
   * next; a crash between publish and mark re-publishes under the same key. Returns the
   * number the bus took.
   */
  flush(): Promise<number> {
    // One sweep at a time: a resolve click that starts one and the timer joining it send each ask once.
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
    for (const request of await this.book.pending(SWEEP_BATCH)) {
      try {
        await sink.send(request);
        await this.book.markPublished(request.ticketId, this.now().toISOString());
        sent += 1;
      } catch {
        // Stays pending; the next sweep tries again.
      }
    }
    return sent;
  }
}
