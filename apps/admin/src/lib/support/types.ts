import type {
  SupportTicketPropertyChange,
  SupportViewList,
  SupportTicketLifecycle,
  SupportTicketProperties,
  SupportCaseFile,
  SupportComment,
  SupportKbArticle,
  SupportTicket,
  SupportTicketEvent,
} from '@intafaced/contracts';
import type { Part } from '@/lib/desk/part';
import type { BulkPolicyView } from './bulk';
import type { SupportRatingSummary } from './ratings';
import type { QueueQuery } from './queue-query';

export type TicketStatus = 'open' | 'pending' | 'on_hold' | 'resolved' | 'closed';

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

export interface SupportBulkPolicyView {
  readonly asOf: string;
  readonly policy: Part<BulkPolicyView>;
}

/** The saved view a queue read was narrowed by. `mine` is whether this founder owns it (only the owner may change it). */
export interface QueueViewRef {
  readonly id: string;
  readonly name: string;
  readonly shared: boolean;
  readonly ownerId: string;
  readonly mine: boolean;
}

/** svc-support refused the filter, search or view; the queue beside it is the plain one. */
export interface QueueRefusal {
  readonly what: 'filter' | 'search' | 'view';
  readonly code: string | null;
  /** The field the filter named, as it was typed. */
  readonly field: string | null;
}

export interface SupportQueueView {
  readonly asOf: string;
  readonly queue: Part<QueueRead>;
  /** What the read was asked to narrow by. Absent on an older answer: the plain queue. */
  readonly query?: QueueQuery;
  readonly view?: QueueViewRef | null;
  readonly refused?: QueueRefusal;
}

export interface SupportViewsView {
  readonly asOf: string;
  readonly meId: string;
  readonly list: Part<SupportViewList>;
  readonly counts: Part<readonly { readonly viewId: string; readonly count: number }[]>;
}

export interface TicketDetail {
  readonly ticket: SupportTicket;
  readonly comments: Part<readonly SupportComment[]>;
  readonly events: Part<readonly SupportTicketEvent[]>;
  /** Changes to priority, type and labels, one per field. Absent on an older answer. */
  readonly propertyChanges?: Part<readonly SupportTicketPropertyChange[]>;
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

/** Who a ticket waits on, the first public reply and the request it follows. Staff only. */
export interface SupportLifecycleView {
  readonly asOf: string;
  readonly lifecycle: Part<SupportTicketLifecycle>;
}

/** Satisfaction ratings for the requests solved in a window the caller stated. */
export interface SupportRatingSummaryView {
  readonly asOf: string;
  readonly summary: Part<SupportRatingSummary>;
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

import type { DeskGroupView, DeskScopeView } from './groups';

/** Desk groups, the signed-in person's own scope and the roster to pick members from. Each its own part. */
export interface SupportGroupsView {
  readonly asOf: string;
  readonly meId: string;
  readonly groups: Part<readonly DeskGroupView[]>;
  readonly scope: Part<DeskScopeView>;
  readonly roster: Part<readonly StaffMemberView[]>;
}
