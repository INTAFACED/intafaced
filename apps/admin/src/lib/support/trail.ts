import type { SupportTicketEvent } from '@intafaced/contracts';

/** The last trail row (`sequence`) in what the page read, or 0 when it read none. */
export function lastSequence(events: readonly SupportTicketEvent[]): number {
  return events.reduce((max, e) => (e.sequence > max ? e.sequence : max), 0);
}

/**
 * The rows someone else wrote after `seen`, oldest first: what made a reply stale. The same rule as svc-support's own
 * check: a person's own rows and an account read (which changes nothing) do not count.
 */
export function newerByOthers(events: readonly SupportTicketEvent[], seen: number, me: string): SupportTicketEvent[] {
  return events
    .filter((e) => e.sequence > seen && e.actorId.toLowerCase() !== me.toLowerCase() && e.kind !== 'grounding_read')
    .sort((a, b) => a.sequence - b.sequence);
}

/** One trail row in words, from the row's own fields. */
export function trailWords(e: SupportTicketEvent): string {
  const move = e.kind === 'status_changed' ? ` from ${e.fromStatus ?? '?'} to ${e.toStatus ?? '?'}` : '';
  return `#${e.sequence} ${e.kind}${move}${e.note ? ` (${e.note})` : ''}`;
}
