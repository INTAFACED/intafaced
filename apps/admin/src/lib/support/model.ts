import type { SupportKbAudience } from '@intafaced/contracts';
import { KB_AUDIENCES } from './audience';
import type { BulkChange } from './bulk';
import { readGroupActionRequest, type GroupActionRequest } from './groups';
import { readStaffAvailabilityRequest, type StaffAvailabilityRequest } from './staff';
import { clauseOf, parseFilterText, type FilterClause } from './queue-query';
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
const STATUSES: readonly string[] = ['open', 'pending', 'on_hold', 'resolved', 'closed'];

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
 * this says so before the click. A claim holds until its holder unclaims it or a lead reassigns it.
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

export const STATUS_CHOICES: readonly TicketStatus[] = ['open', 'pending', 'on_hold', 'resolved', 'closed'];

/** svc-support's lifecycle table, copied so the page can say "not from here" before the click. The service stays the judge. */
const TRANSITIONS: Readonly<Record<TicketStatus, readonly TicketStatus[]>> = {
  open: ['pending', 'on_hold', 'resolved', 'closed'],
  pending: ['open', 'on_hold', 'resolved', 'closed'],
  on_hold: ['open', 'pending', 'resolved', 'closed'],
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
  if (next === 'on_hold' && note.trim() === '')
    return { ok: false, why: 'Say why the request is on hold. The customer sees the reason in their history.' };
  return GO;
}

export function escalateGate(ticket: { status: string }, summary: string, busy: boolean): ActionGate {
  if (busy) return { ok: false, why: 'A step is already in progress.' };
  if (ticket.status === 'closed') return { ok: false, why: 'This ticket is closed, and svc-support does not escalate a closed ticket.' };
  if (summary.trim() === '') return { ok: false, why: 'Write what you concluded first. The case file keeps it.' };
  if (summary.length > SUMMARY_MAX) return { ok: false, why: `The summary can be at most ${SUMMARY_MAX} characters.` };
  return GO;
}

export const PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;
export const TICKET_TYPES = ['question', 'problem', 'incident'] as const;
export type Priority = (typeof PRIORITIES)[number];
export type TicketType = (typeof TICKET_TYPES)[number];
/** Same letters svc-support accepts for a label; the service stays the judge. */
export const LABEL_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
export const LABELS_MAX = 20;
export const REASON_MAX = 500;
/** svc-support's bound on a view name (`supportViewSaveInputSchema`). */
export const VIEW_NAME_MAX = 80;

/** Labels typed as text, separated by commas, spaces or new lines. Repeats collapse; order is kept. */
export function parseLabels(text: string): string[] {
  return [...new Set(text.split(/[\s,]+/).filter((l) => l !== ''))];
}

export type PropertiesChange = {
  /** Undefined leaves it as it is; null clears it. */
  readonly priority?: Priority | null;
  readonly ticketType?: TicketType | null;
  readonly labels?: readonly string[];
};

export function propertiesGate(ticket: { status: string }, change: PropertiesChange, reason: string, busy: boolean): ActionGate {
  if (busy) return { ok: false, why: 'A step is already in progress.' };
  if (ticket.status === 'closed') return { ok: false, why: 'This ticket is closed, and svc-support does not change a closed ticket.' };
  if (change.priority === undefined && change.ticketType === undefined && change.labels === undefined)
    return { ok: false, why: 'Change at least one of priority, type or labels first.' };
  if (change.labels) {
    if (change.labels.length > LABELS_MAX) return { ok: false, why: `A ticket can carry at most ${LABELS_MAX} labels.` };
    const bad = change.labels.find((l) => !LABEL_PATTERN.test(l));
    if (bad !== undefined)
      return { ok: false, why: `A label may hold letters, digits, hyphen and underscore only (up to 64). "${bad}" does not.` };
  }
  if (reason.length > REASON_MAX) return { ok: false, why: `The reason can be at most ${REASON_MAX} characters.` };
  return GO;
}

export type SupportActionRequest =
  | StaffAvailabilityRequest
  | GroupActionRequest
  | ({
      readonly action: 'properties';
      readonly ticketId: string;
      readonly clientRequestId: string;
      readonly reason?: string;
    } & PropertiesChange)
  | {
      readonly action: 'bulk';
      readonly batchKey: string;
      readonly ticketIds: readonly string[];
      readonly change: BulkChange;
      readonly reason?: string;
    }
  | { readonly action: 'merge'; readonly ticketId: string; readonly survivorId: string; readonly reason: string }
  | {
      readonly action: 'reply';
      readonly ticketId: string;
      readonly body: string;
      readonly expectedSequence?: number;
      /** How many replies this agent has already sent from this view: the same text sent again is a new reply, a retry is not. */
      readonly sent?: number;
    }
  | { readonly action: 'claim_next' }
  | { readonly action: 'unclaim'; readonly ticketId: string; readonly expectedSequence: number }
  | { readonly action: 'assign'; readonly ticketId: string; readonly assigneeId: string; readonly expectedSequence: number }
  | {
      readonly action: 'status';
      readonly ticketId: string;
      readonly status: TicketStatus;
      readonly note?: string;
      readonly expectedSequence?: number;
    }
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
  | {
      readonly action: 'view_save';
      readonly name: string;
      readonly shared: boolean;
      readonly filter: FilterClause;
      readonly reason: string;
    }
  | { readonly action: 'kb_unpublish'; readonly id: string; readonly baseRevision: number }
  | { readonly action: 'kb_audience'; readonly id: string; readonly baseRevision: number; readonly audience: SupportKbAudience };

const isText = (v: unknown, max: number): v is string => typeof v === 'string' && v.trim() !== '' && v.length <= max;
const isKey = (v: unknown): v is string => isText(v, 200);
/** A trail row number (`sequence`) the browser read: the stale check on a reply or status change, and the owner changes' business keys. */
const isSequence = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;

function readBulkChange(raw: unknown): BulkChange | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const c = raw as Record<string, unknown>;
  // Exactly the kind and its one field: a second field is a different request, not an extra to drop.
  if (Object.keys(c).length !== 2) return null;
  if (c.kind === 'status') {
    return typeof c.status === 'string' && STATUSES.includes(c.status) ? { kind: 'status', status: c.status as TicketStatus } : null;
  }
  if (c.kind === 'priority') {
    if (c.priority === null) return { kind: 'priority', priority: null };
    return PRIORITIES.includes(c.priority as Priority) ? { kind: 'priority', priority: c.priority as Priority } : null;
  }
  if (c.kind === 'assign') return isTicketId(c.assigneeId) ? { kind: 'assign', assigneeId: c.assigneeId } : null;
  return null;
}

/**
 * The strict reader for an action request from the browser. Anything that is not exactly a known shape is null and
 * nothing is sent to svc-support: a malformed request must not become a different request.
 */
export function readActionRequest(raw: Record<string, unknown>): SupportActionRequest | null {
  switch (raw.action) {
    case 'view_save': {
      const clause = clauseOf(raw.filter);
      const filter = clause ? parseFilterText(`${clause.field}:${clause.value}`) : null;
      if (!filter || !isText(raw.name, VIEW_NAME_MAX) || typeof raw.shared !== 'boolean' || !isText(raw.reason, REASON_MAX)) return null;
      return { action: 'view_save', name: raw.name.trim(), shared: raw.shared, filter, reason: raw.reason.trim() };
    }
    case 'reply':
      if (!isTicketId(raw.ticketId) || !isText(raw.body, REPLY_MAX)) return null;
      if (raw.expectedSequence !== undefined && !isSequence(raw.expectedSequence)) return null;
      if (raw.sent !== undefined && !isSequence(raw.sent)) return null;
      return {
        action: 'reply',
        ticketId: raw.ticketId,
        body: raw.body.trim(),
        ...(raw.expectedSequence === undefined ? {} : { expectedSequence: raw.expectedSequence }),
        ...(raw.sent === undefined ? {} : { sent: raw.sent }),
      };
    case 'claim_next':
      return Object.keys(raw).length === 1 ? { action: 'claim_next' } : null;
    case 'unclaim':
      return isTicketId(raw.ticketId) && isSequence(raw.expectedSequence)
        ? { action: 'unclaim', ticketId: raw.ticketId, expectedSequence: raw.expectedSequence }
        : null;
    case 'assign':
      return isTicketId(raw.ticketId) && isTicketId(raw.assigneeId) && isSequence(raw.expectedSequence)
        ? { action: 'assign', ticketId: raw.ticketId, assigneeId: raw.assigneeId, expectedSequence: raw.expectedSequence }
        : null;
    case 'status': {
      if (!isTicketId(raw.ticketId) || typeof raw.status !== 'string' || !STATUSES.includes(raw.status)) return null;
      if (raw.note !== undefined && !isText(raw.note, NOTE_MAX)) return null;
      if (raw.expectedSequence !== undefined && !isSequence(raw.expectedSequence)) return null;
      return {
        action: 'status',
        ticketId: raw.ticketId,
        status: raw.status as TicketStatus,
        ...(raw.note === undefined ? {} : { note: raw.note.trim() }),
        ...(raw.expectedSequence === undefined ? {} : { expectedSequence: raw.expectedSequence }),
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
    case 'staff_availability':
      return readStaffAvailabilityRequest(raw);
    case 'group_save':
    case 'group_member':
      return readGroupActionRequest(raw);
    case 'properties': {
      if (!isTicketId(raw.ticketId) || !isText(raw.clientRequestId, 200)) return null;
      if (raw.reason !== undefined && !isText(raw.reason, REASON_MAX)) return null;
      const out: { -readonly [K in keyof PropertiesChange]: PropertiesChange[K] } = {};
      if (raw.priority !== undefined) {
        if (raw.priority !== null && !PRIORITIES.includes(raw.priority as Priority)) return null;
        out.priority = raw.priority as Priority | null;
      }
      if (raw.ticketType !== undefined) {
        if (raw.ticketType !== null && !TICKET_TYPES.includes(raw.ticketType as TicketType)) return null;
        out.ticketType = raw.ticketType as TicketType | null;
      }
      if (raw.labels !== undefined) {
        if (!Array.isArray(raw.labels) || raw.labels.length > LABELS_MAX) return null;
        if (!raw.labels.every((l) => typeof l === 'string' && LABEL_PATTERN.test(l))) return null;
        out.labels = raw.labels as string[];
      }
      if (out.priority === undefined && out.ticketType === undefined && out.labels === undefined) return null;
      return {
        action: 'properties',
        ticketId: raw.ticketId,
        clientRequestId: raw.clientRequestId.trim(),
        ...(raw.reason === undefined ? {} : { reason: raw.reason.trim() }),
        ...out,
      };
    }
    case 'bulk': {
      if (!isText(raw.batchKey, 200) || !Array.isArray(raw.ticketIds)) return null;
      if (raw.ticketIds.length === 0 || raw.ticketIds.length > 1000 || !raw.ticketIds.every(isTicketId)) return null;
      if (new Set(raw.ticketIds).size !== raw.ticketIds.length) return null;
      if (raw.reason !== undefined && !isText(raw.reason, REASON_MAX)) return null;
      const change = readBulkChange(raw.change);
      if (!change) return null;
      return {
        action: 'bulk',
        batchKey: raw.batchKey.trim(),
        ticketIds: raw.ticketIds as string[],
        change,
        ...(raw.reason === undefined ? {} : { reason: raw.reason.trim() }),
      };
    }
    case 'merge': {
      if (!isTicketId(raw.ticketId) || !isTicketId(raw.survivorId) || raw.ticketId === raw.survivorId) return null;
      if (!isText(raw.reason, 400)) return null;
      return { action: 'merge', ticketId: raw.ticketId, survivorId: raw.survivorId, reason: raw.reason.trim() };
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
    case 'kb_audience':
      return isKey(raw.id) &&
        typeof raw.baseRevision === 'number' &&
        Number.isInteger(raw.baseRevision) &&
        raw.baseRevision >= 1 &&
        typeof raw.audience === 'string' &&
        (KB_AUDIENCES as readonly string[]).includes(raw.audience)
        ? { action: 'kb_audience', id: raw.id.trim(), baseRevision: raw.baseRevision, audience: raw.audience as SupportKbAudience }
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
