import type { SupportComment, SupportTicket, SupportTicketEvent } from '@intafaced/contracts';
import type { Part } from '@/lib/desk/part';

export type TicketStatus = 'open' | 'pending' | 'resolved' | 'closed';

/** One row of svc-support's operator queue (open and pending tickets, ordered by score). */
export interface QueueEntry {
  readonly ticketId: string;
  readonly userId: string;
  readonly category: string;
  readonly status: TicketStatus;
  readonly subject: string;
  /** A priority score. svc-support labels it `score_not_promise`: it is not a response-time promise. */
  readonly score: number;
  readonly ageMs: number;
  readonly createdAt: string;
}

export interface QueueRead {
  readonly entries: readonly QueueEntry[];
  /** The page size asked for. A full page means there may be more tickets than are shown. */
  readonly limit: number;
}

export interface SupportQueueView {
  readonly asOf: string;
  readonly queue: Part<QueueRead>;
}

export interface TicketDetail {
  readonly ticket: SupportTicket;
  readonly comments: Part<readonly SupportComment[]>;
  readonly events: Part<readonly SupportTicketEvent[]>;
}

export interface SupportTicketView {
  readonly asOf: string;
  readonly detail: Part<TicketDetail>;
}
