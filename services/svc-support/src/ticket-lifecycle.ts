/**
 * Lifecycle facts kept beside the ticket: who it waits on, when the first public reply
 * went out, and the closed request a new one follows. Staff read them; the ticket owner
 * reads the ticket row and never sees `waitingOn`. A ticket with no row has all three empty.
 */
import type { Sql } from 'postgres';
import type { SupportTicketLifecycle, SupportWaitingOn } from '@intafaced/contracts';

export interface LifecycleBook {
  get(ticketId: string): Promise<SupportTicketLifecycle>;
  /** Who the ticket waits on from `at`, or nobody (null). Setting the same side again keeps the first `waitingSince`. */
  setWaiting(ticketId: string, waitingOn: SupportWaitingOn | null, at: string): Promise<void>;
  /** The first public operator reply. Set once; later calls change nothing. */
  markFirstPublicReply(ticketId: string, at: string): Promise<void>;
  /** Link a new request to the closed one it follows. Set once. */
  linkFollowUp(ticketId: string, followsTicketId: string, at: string): Promise<void>;
}

const empty = (ticketId: string): SupportTicketLifecycle => ({
  ticketId,
  waitingOn: null,
  waitingSince: null,
  firstPublicReplyAt: null,
  followsTicketId: null,
});

export class MemoryLifecycleBook implements LifecycleBook {
  private readonly rows = new Map<string, SupportTicketLifecycle>();

  async get(ticketId: string): Promise<SupportTicketLifecycle> {
    return this.rows.get(ticketId) ?? empty(ticketId);
  }

  async setWaiting(ticketId: string, waitingOn: SupportWaitingOn | null, at: string): Promise<void> {
    const prior = await this.get(ticketId);
    if (prior.waitingOn === waitingOn) return;
    this.rows.set(ticketId, { ...prior, waitingOn, waitingSince: waitingOn === null ? null : at });
  }

  async markFirstPublicReply(ticketId: string, at: string): Promise<void> {
    const prior = await this.get(ticketId);
    if (prior.firstPublicReplyAt !== null) return;
    this.rows.set(ticketId, { ...prior, firstPublicReplyAt: at });
  }

  async linkFollowUp(ticketId: string, followsTicketId: string, _at: string): Promise<void> {
    const prior = await this.get(ticketId);
    if (prior.followsTicketId !== null) return;
    this.rows.set(ticketId, { ...prior, followsTicketId });
  }
}

type Row = {
  ticket_id: string;
  waiting_on: SupportWaitingOn | null;
  waiting_since: Date | string | null;
  first_public_reply_at: Date | string | null;
  follows_ticket_id: string | null;
};

const iso = (v: Date | string | null): string | null =>
  v === null ? null : v instanceof Date ? v.toISOString() : new Date(v).toISOString();

export class SqlLifecycleBook implements LifecycleBook {
  constructor(private readonly sql: Sql) {}

  async get(ticketId: string): Promise<SupportTicketLifecycle> {
    const rows = await this.sql<Row[]>`
      SELECT ticket_id, waiting_on, waiting_since, first_public_reply_at, follows_ticket_id
      FROM support.ticket_lifecycle WHERE ticket_id = ${ticketId}
    `;
    const row = rows[0];
    if (!row) return empty(ticketId);
    return {
      ticketId: row.ticket_id,
      waitingOn: row.waiting_on,
      waitingSince: iso(row.waiting_since),
      firstPublicReplyAt: iso(row.first_public_reply_at),
      followsTicketId: row.follows_ticket_id,
    };
  }

  async setWaiting(ticketId: string, waitingOn: SupportWaitingOn | null, at: string): Promise<void> {
    // Same side again keeps its first waiting_since (the CASE), so a replay or a second reply does not reset the clock.
    await this.sql`
      INSERT INTO support.ticket_lifecycle (ticket_id, waiting_on, waiting_since, updated_at)
      VALUES (${ticketId}, ${waitingOn}, ${waitingOn === null ? null : at}, ${at})
      ON CONFLICT (ticket_id) DO UPDATE SET
        waiting_since = CASE
          WHEN EXCLUDED.waiting_on IS NULL THEN NULL
          WHEN support.ticket_lifecycle.waiting_on IS NOT DISTINCT FROM EXCLUDED.waiting_on THEN support.ticket_lifecycle.waiting_since
          ELSE EXCLUDED.waiting_since END,
        waiting_on = EXCLUDED.waiting_on,
        updated_at = EXCLUDED.updated_at
    `;
  }

  async markFirstPublicReply(ticketId: string, at: string): Promise<void> {
    await this.sql`
      INSERT INTO support.ticket_lifecycle (ticket_id, first_public_reply_at, updated_at)
      VALUES (${ticketId}, ${at}, ${at})
      ON CONFLICT (ticket_id) DO UPDATE SET
        first_public_reply_at = COALESCE(support.ticket_lifecycle.first_public_reply_at, EXCLUDED.first_public_reply_at),
        updated_at = EXCLUDED.updated_at
    `;
  }

  async linkFollowUp(ticketId: string, followsTicketId: string, at: string): Promise<void> {
    await this.sql`
      INSERT INTO support.ticket_lifecycle (ticket_id, follows_ticket_id, updated_at)
      VALUES (${ticketId}, ${followsTicketId}, ${at})
      ON CONFLICT (ticket_id) DO UPDATE SET
        follows_ticket_id = COALESCE(support.ticket_lifecycle.follows_ticket_id, EXCLUDED.follows_ticket_id),
        updated_at = EXCLUDED.updated_at
    `;
  }
}
