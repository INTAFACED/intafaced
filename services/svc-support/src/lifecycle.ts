import type { SupportTicketStatus } from '@intafaced/contracts';

/**
 * TICKET LIFECYCLE — which status moves are legal, as data.
 *
 * Before this table `setStatus` accepted any status for any ticket, because the
 * only validation was zod's "is this one of the four words". That let a desk do
 * two things it should not:
 *
 *   1. Re-open a CLOSED ticket. Closed is the one terminal state a desk has;
 *      if it can be re-opened silently then "closed" means nothing and the
 *      audit trail of a finished complaint can still grow.
 *   2. Move a ticket to the status it already has, writing an audit row that
 *      records no change. A trail full of `open → open` is a trail nobody
 *      reads, which is the same as not having one.
 *
 * `resolved → open` IS legal and deliberately so: a user replying "this is not
 * fixed" must be able to reach a human without opening a second ticket that
 * loses the history. The owner path is `comment()` — a user reply on `resolved`
 * writes this edge (and clears the assignee so the row re-enters the queue).
 * Operator `setStatus(resolved → open)` remains the staff path. Both record a
 * trail row; neither invents a second ticket.
 *
 * `closed` has no outgoing edges. That is the whole of the terminality claim —
 * asserted here and, because a psql session can route around TypeScript, again
 * as a CHECK-shaped trigger in the migration.
 */
export const TICKET_TRANSITIONS: Readonly<Record<SupportTicketStatus, readonly SupportTicketStatus[]>> = {
  open: ['pending', 'on_hold', 'resolved', 'closed'],
  pending: ['open', 'on_hold', 'resolved', 'closed'],
  /** Paused by the team. It leaves the queue; a customer reply or an agent brings it back. */
  on_hold: ['open', 'pending', 'resolved', 'closed'],
  resolved: ['open', 'closed'],
  /** Terminal. A finished complaint stays finished. */
  closed: [],
};

export type TransitionCheck = { readonly status: 'ok' } | { readonly status: 'refuse'; readonly reason: 'same_status' | 'illegal' };

/**
 * Pure transition check. Returns a reason CODE — callers map it to an error
 * code, and tests assert on the code, never on a sentence.
 */
export function checkTransition(from: SupportTicketStatus, to: SupportTicketStatus): TransitionCheck {
  if (from === to) return { status: 'refuse', reason: 'same_status' };
  const allowed = TICKET_TRANSITIONS[from] ?? [];
  if (!allowed.includes(to)) return { status: 'refuse', reason: 'illegal' };
  return { status: 'ok' };
}

/** Is this a terminal status — nothing may follow it. */
export function isTerminal(status: SupportTicketStatus): boolean {
  return (TICKET_TRANSITIONS[status] ?? []).length === 0;
}
