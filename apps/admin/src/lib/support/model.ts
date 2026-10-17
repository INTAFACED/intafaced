import type { QueueEntry, QueueRead, TicketStatus } from './types';

/**
 * Support queue: strict readers and the metrics that can honestly be computed from one page of the queue.
 *
 * The desk shows counts and ages of the tickets it was GIVEN. It says how many that is and whether the page was full
 * (so there may be more), and it never presents them as totals for the whole desk: svc-support has no aggregate read
 * (filed in admin-BACKEND-NEEDS.md).
 */

export const QUEUE_PAGE = 100;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATUSES: readonly string[] = ['open', 'pending', 'resolved', 'closed'];

export const isTicketId = (value: unknown): value is string => typeof value === 'string' && UUID.test(value);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function readEntry(raw: unknown): QueueEntry | null {
  if (!isRecord(raw)) return null;
  const { ticketId, userId, category, status, subject, score, ageMs, createdAt, timingKind, sla } = raw;
  if (!isTicketId(ticketId) || !isTicketId(userId)) return null;
  if (typeof category !== 'string' || category === '' || typeof subject !== 'string' || subject === '') return null;
  if (typeof status !== 'string' || !STATUSES.includes(status)) return null;
  if (typeof score !== 'number' || !Number.isFinite(score)) return null;
  if (typeof ageMs !== 'number' || !Number.isFinite(ageMs) || ageMs < 0) return null;
  if (typeof createdAt !== 'string' || !Number.isFinite(Date.parse(createdAt))) return null;
  // The service promises these two. If they ever change, the desk must not keep implying a score is not a promise.
  if (timingKind !== 'score_not_promise' || sla !== false) return null;
  return { ticketId, userId, category, status: status as TicketStatus, subject, score, ageMs, createdAt };
}

/** `listQueue`: `{status:'ok',entries}` or `{status:'empty'}`. Anything else is null, never an empty queue. */
export function readQueueResult(raw: unknown, limit: number): QueueRead | null {
  if (!isRecord(raw)) return null;
  if (raw.status === 'empty') return Object.keys(raw).length === 1 ? { entries: [], limit } : null;
  if (raw.status !== 'ok' || !Array.isArray(raw.entries)) return null;
  const entries: QueueEntry[] = [];
  for (const row of raw.entries) {
    const entry = readEntry(row);
    if (!entry) return null;
    entries.push(entry);
  }
  return { entries, limit };
}

export interface QueueMetrics {
  readonly shown: number;
  /** True when the page was full, so the real queue may hold more than `shown`. */
  readonly pageFull: boolean;
  readonly byStatus: Readonly<Record<string, number>>;
  readonly byCategory: Readonly<Record<string, number>>;
  readonly oldestAgeMs: number | null;
}

export function queueMetrics(read: QueueRead): QueueMetrics {
  const byStatus: Record<string, number> = {};
  const byCategory: Record<string, number> = {};
  let oldest: number | null = null;
  for (const e of read.entries) {
    byStatus[e.status] = (byStatus[e.status] ?? 0) + 1;
    byCategory[e.category] = (byCategory[e.category] ?? 0) + 1;
    if (oldest === null || e.ageMs > oldest) oldest = e.ageMs;
  }
  return { shown: read.entries.length, pageFull: read.entries.length >= read.limit, byStatus, byCategory, oldestAgeMs: oldest };
}

/** "3 h 12 min" from milliseconds. Whole units only; below a minute it says "under a minute". */
export function formatAge(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return 'under a minute';
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} h ${minutes % 60} min`;
  return `${Math.floor(hours / 24)} d ${hours % 24} h`;
}

export type ClaimGate = { readonly ok: true } | { readonly ok: false; readonly why: string };

/**
 * Whether a ticket can be claimed by this founder. svc-support refuses stealing and claiming a closed ticket anyway;
 * this says so before the click. There is no release or reassign in svc-support, so a claim is final from here.
 */
export function claimGate(ticket: { status: string; assigneeId: string | null }, userId: string, busy: boolean): ClaimGate {
  if (busy) return { ok: false, why: 'A step is already in progress.' };
  if (ticket.status === 'resolved' || ticket.status === 'closed')
    return { ok: false, why: `This ticket is ${ticket.status}, so it cannot be claimed.` };
  if (ticket.assigneeId !== null) {
    return ticket.assigneeId.toLowerCase() === userId.toLowerCase()
      ? { ok: false, why: 'You already own this ticket.' }
      : { ok: false, why: 'Another person already owns this ticket. svc-support does not allow taking it over.' };
  }
  return { ok: true };
}
