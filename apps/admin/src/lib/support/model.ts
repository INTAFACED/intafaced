import type { QueueEntry, QueueRead, SupportRating, TicketStatus } from './types';

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

/* ------------------------------------------------------------------ *
 * Desk actions: what a founder can send, checked before the network
 * ------------------------------------------------------------------ */

export const STATUS_CHOICES: readonly TicketStatus[] = ['open', 'pending', 'resolved', 'closed'];

/** svc-support's lifecycle table, copied so the page can say "not from here" before the click. The service stays the judge. */
const TRANSITIONS: Readonly<Record<TicketStatus, readonly TicketStatus[]>> = {
  open: ['pending', 'resolved', 'closed'],
  pending: ['open', 'resolved', 'closed'],
  resolved: ['open', 'closed'],
  closed: [],
};

export function allowedNextStatuses(from: string): readonly TicketStatus[] {
  return STATUS_CHOICES.includes(from as TicketStatus) ? TRANSITIONS[from as TicketStatus] : [];
}

export const ESCALATION_REASONS = [
  { id: 'account_state', label: 'Account state (frozen, closed or similar)' },
  { id: 'kyc_review', label: 'Identity verification review' },
  { id: 'money_request', label: 'Customer asked for money to move (this only files the request; support moves nothing)' },
  { id: 'technical', label: 'Technical problem' },
  { id: 'other', label: 'Something else' },
] as const;
export type EscalationReason = (typeof ESCALATION_REASONS)[number]['id'];

export const REPLY_MAX = 10_000;
export const NOTE_MAX = 500;
export const SUMMARY_MAX = 2_000;

export type ActionGate = { readonly ok: true } | { readonly ok: false; readonly why: string };
const GO: ActionGate = { ok: true };

export function replyGate(ticket: { status: string }, body: string, busy: boolean): ActionGate {
  if (busy) return { ok: false, why: 'A step is already in progress.' };
  if (ticket.status === 'closed') return { ok: false, why: 'This ticket is closed, and svc-support takes no replies on a closed ticket.' };
  if (body.trim() === '') return { ok: false, why: 'Write the reply first.' };
  if (body.length > REPLY_MAX) return { ok: false, why: `A reply can be at most ${REPLY_MAX} characters.` };
  return GO;
}

export function statusGate(ticket: { status: string }, next: string, note: string, busy: boolean): ActionGate {
  if (busy) return { ok: false, why: 'A step is already in progress.' };
  if (allowedNextStatuses(ticket.status).length === 0)
    return { ok: false, why: `This ticket is ${ticket.status}. A closed ticket stays closed, so its status cannot change.` };
  if (!allowedNextStatuses(ticket.status).includes(next as TicketStatus))
    return { ok: false, why: `svc-support does not move a ticket from ${ticket.status} to ${next}.` };
  if (note.length > NOTE_MAX) return { ok: false, why: `The reason can be at most ${NOTE_MAX} characters.` };
  return GO;
}

export function escalateGate(ticket: { status: string }, summary: string, busy: boolean): ActionGate {
  if (busy) return { ok: false, why: 'A step is already in progress.' };
  if (ticket.status === 'closed') return { ok: false, why: 'This ticket is closed, and svc-support does not escalate a closed ticket.' };
  if (summary.trim() === '') return { ok: false, why: 'Write what you concluded first. The case file keeps it.' };
  if (summary.length > SUMMARY_MAX) return { ok: false, why: `The summary can be at most ${SUMMARY_MAX} characters.` };
  return GO;
}

export type SupportActionRequest =
  | { readonly action: 'reply'; readonly ticketId: string; readonly body: string }
  | { readonly action: 'status'; readonly ticketId: string; readonly status: TicketStatus; readonly note?: string }
  | {
      readonly action: 'escalate';
      readonly ticketId: string;
      readonly reason: EscalationReason;
      readonly summary: string;
      readonly citedArticleIds?: readonly string[];
    }
  | {
      readonly action: 'kb_publish';
      readonly id: string;
      readonly titleKey: string;
      readonly bodyKey: string;
      readonly baseRevision: number;
      readonly category?: string;
      readonly tags?: readonly string[];
    }
  | { readonly action: 'kb_unpublish'; readonly id: string; readonly baseRevision: number };

const isText = (v: unknown, max: number): v is string => typeof v === 'string' && v.trim() !== '' && v.length <= max;
const isKey = (v: unknown): v is string => isText(v, 200);

/**
 * The strict reader for an action request from the browser. Anything that is not exactly a known shape is null and
 * nothing is sent to svc-support: a malformed request must not become a different request.
 */
export function readActionRequest(raw: Record<string, unknown>): SupportActionRequest | null {
  switch (raw.action) {
    case 'reply':
      return isTicketId(raw.ticketId) && isText(raw.body, REPLY_MAX)
        ? { action: 'reply', ticketId: raw.ticketId, body: raw.body.trim() }
        : null;
    case 'status': {
      if (!isTicketId(raw.ticketId) || typeof raw.status !== 'string' || !STATUSES.includes(raw.status)) return null;
      if (raw.note !== undefined && !isText(raw.note, NOTE_MAX)) return null;
      return {
        action: 'status',
        ticketId: raw.ticketId,
        status: raw.status as TicketStatus,
        ...(raw.note === undefined ? {} : { note: raw.note.trim() }),
      };
    }
    case 'escalate': {
      if (!isTicketId(raw.ticketId) || !ESCALATION_REASONS.some((r) => r.id === raw.reason) || !isText(raw.summary, SUMMARY_MAX))
        return null;
      let cited: string[] | undefined;
      if (raw.citedArticleIds !== undefined) {
        if (!Array.isArray(raw.citedArticleIds) || raw.citedArticleIds.length > 20 || !raw.citedArticleIds.every(isKey)) return null;
        cited = raw.citedArticleIds as string[];
      }
      return {
        action: 'escalate',
        ticketId: raw.ticketId,
        reason: raw.reason as EscalationReason,
        summary: raw.summary.trim(),
        ...(cited && cited.length > 0 ? { citedArticleIds: cited } : {}),
      };
    }
    case 'kb_publish': {
      if (!isKey(raw.id) || !isKey(raw.titleKey) || !isKey(raw.bodyKey)) return null;
      if (typeof raw.baseRevision !== 'number' || !Number.isInteger(raw.baseRevision) || raw.baseRevision < 0) return null;
      if (raw.category !== undefined && !isKey(raw.category)) return null;
      let tags: string[] | undefined;
      if (raw.tags !== undefined) {
        if (!Array.isArray(raw.tags) || raw.tags.length > 20 || !raw.tags.every(isKey)) return null;
        tags = raw.tags as string[];
      }
      return {
        action: 'kb_publish',
        id: raw.id.trim(),
        titleKey: raw.titleKey.trim(),
        bodyKey: raw.bodyKey.trim(),
        baseRevision: raw.baseRevision,
        ...(raw.category === undefined ? {} : { category: raw.category.trim() }),
        ...(tags && tags.length > 0 ? { tags: tags.map((t) => t.trim()) } : {}),
      };
    }
    case 'kb_unpublish':
      return isKey(raw.id) && typeof raw.baseRevision === 'number' && Number.isInteger(raw.baseRevision) && raw.baseRevision >= 1
        ? { action: 'kb_unpublish', id: raw.id.trim(), baseRevision: raw.baseRevision }
        : null;
    default:
      return null;
  }
}

/** `ratingOps`: the rating, or null when the customer has not rated. Anything else is null here, never "no rating". */
export function readRatingResult(raw: unknown): { readonly value: SupportRating | null } | null {
  if (raw === null) return { value: null };
  if (!isRecord(raw)) return null;
  const { ticketId, userId, score, note, createdAt } = raw;
  if (!isTicketId(ticketId) || !isTicketId(userId)) return null;
  if (typeof score !== 'number' || !Number.isInteger(score) || score < 1 || score > 5) return null;
  if (!(note === null || typeof note === 'string')) return null;
  if (typeof createdAt !== 'string' || !Number.isFinite(Date.parse(createdAt))) return null;
  return { value: { ticketId, userId, score, note, createdAt } };
}
