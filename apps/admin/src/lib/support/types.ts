import type {
  SupportTicketProperties,
  SupportCaseFile,
  SupportComment,
  SupportKbArticle,
  SupportTicket,
  SupportTicketEvent,
} from '@intafaced/contracts';
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

/** A customer's rating of a finished ticket, as svc-support's operator read returns it. */
export interface SupportRating {
  readonly ticketId: string;
  readonly userId: string;
  readonly score: number;
  readonly note: string | null;
  readonly createdAt: string;
}

/** The two operator-only reads on a ticket. Each is its own part, so one failing never hides the other or the ticket. */
export interface TicketExtrasView {
  readonly asOf: string;
  readonly caseFile: Part<SupportCaseFile | null>;
  readonly rating: Part<SupportRating | null>;
}

export interface SupportKbView {
  readonly asOf: string;
  /** Published articles only: svc-support has no read for an unpublished one. */
  readonly articles: Part<readonly SupportKbArticle[]>;
}

/** Priority, type and labels an agent set on one ticket. Null priority or type means nobody set one. */
export interface SupportPropertiesView {
  readonly asOf: string;
  readonly properties: Part<SupportTicketProperties>;
}

import type { StaffMemberView, StaffPolicyView } from './staff';

/** The staff roster and the automatic-offline policy. Each is its own part, so one failing never hides the other. */
export interface SupportStaffView {
  readonly asOf: string;
  /** The signed-in person's own id, so the page can tell which row is theirs. Taken from the session, not from the roster. */
  readonly meId: string;
  readonly roster: Part<readonly StaffMemberView[]>;
  readonly policy: Part<StaffPolicyView>;
}
