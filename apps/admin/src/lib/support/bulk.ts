import { REASON_MAX, isTicketId, type ActionGate, type Priority } from './model';
import type { TicketStatus } from './types';

/**
 * Bulk change of support requests, as the console reads and sends it.
 *
 * svc-support applies one change (an assignee, a status or a priority) to a list of requests under one batch key and
 * answers each request on its own: changed, unchanged or refused with a typed code. The batch size is the owner's blank
 * setting: while it is blank the policy says `cap: null` and the bulk bar says so and sends nothing. Nothing here
 * invents a batch size.
 */

export type BulkKind = 'status' | 'priority' | 'assign';
export const BULK_KINDS: readonly BulkKind[] = ['status', 'priority', 'assign'];

/** What the bar holds. `priority: 'none'` clears the priority; `''` is not chosen yet. */
export interface BulkForm {
  readonly kind: BulkKind;
  readonly status: TicketStatus | '';
  readonly priority: Priority | 'none' | '';
  readonly assigneeId: string;
  readonly reason: string;
}

export const emptyBulkForm: BulkForm = { kind: 'status', status: '', priority: '', assigneeId: '', reason: '' };

export type BulkChange =
  | { readonly kind: 'status'; readonly status: TicketStatus }
  | { readonly kind: 'priority'; readonly priority: Priority | null }
  | { readonly kind: 'assign'; readonly assigneeId: string };

/** The change the form describes, or null while it is not complete. */
export function bulkChangeOf(form: BulkForm): BulkChange | null {
  if (form.kind === 'status') return form.status === '' ? null : { kind: 'status', status: form.status };
  if (form.kind === 'priority') {
    if (form.priority === '') return null;
    return { kind: 'priority', priority: form.priority === 'none' ? null : form.priority };
  }
  return isTicketId(form.assigneeId) ? { kind: 'assign', assigneeId: form.assigneeId } : null;
}

export interface BulkPolicyView {
  /** The owner's batch size, or null while it is not set. */
  readonly cap: number | null;
}

const isRecord = (v: unknown): v is Record<string, unknown> => Boolean(v && typeof v === 'object' && !Array.isArray(v));

/** `bulkPolicy`: exactly `{ cap, missing }`, with `missing` named only while `cap` is blank. Anything else is null. */
export function readBulkPolicy(raw: unknown): BulkPolicyView | null {
  if (!isRecord(raw)) return null;
  const { cap, missing } = raw;
  if (cap === null) return missing === 'support.bulk_cap' ? { cap: null } : null;
  if (typeof cap === 'number' && Number.isInteger(cap) && cap > 0 && missing === null) return { cap };
  return null;
}

export type BulkOutcome = 'changed' | 'unchanged' | 'refused';

export interface BulkRow {
  readonly ticketId: string;
  readonly outcome: BulkOutcome;
  readonly code: string | null;
}

const OUTCOMES: readonly string[] = ['changed', 'unchanged', 'refused'];

/** `bulkUpdate`: every row must read, or the whole answer is null; never a shorter list that hides a request. */
export function readBulkResults(raw: unknown): BulkRow[] | null {
  if (!isRecord(raw) || typeof raw.batchKey !== 'string' || !Array.isArray(raw.results)) return null;
  const out: BulkRow[] = [];
  for (const row of raw.results) {
    if (!isRecord(row) || !isTicketId(row.ticketId)) return null;
    if (typeof row.outcome !== 'string' || !OUTCOMES.includes(row.outcome)) return null;
    if (row.code !== null && typeof row.code !== 'string') return null;
    out.push({ ticketId: row.ticketId, outcome: row.outcome as BulkOutcome, code: row.code });
  }
  return out;
}

export interface BulkSelectionLimits {
  readonly selected: number;
  readonly policy: BulkPolicyView | null;
}

/** Why the bar will not send yet, in words; ok when it can. */
export function bulkGate(limits: BulkSelectionLimits, form: BulkForm, busy: boolean): ActionGate {
  if (busy) return { ok: false, why: 'A change is being sent.' };
  if (limits.policy === null) return { ok: false, why: 'The batch size could not be read from svc-support, so nothing is sent.' };
  if (limits.policy.cap === null) {
    return { ok: false, why: 'The owner has not set the batch size (support.bulk_cap), so svc-support refuses bulk changes.' };
  }
  if (limits.selected === 0) return { ok: false, why: 'Tick at least one request.' };
  if (limits.selected > limits.policy.cap) {
    return { ok: false, why: `The owner allows ${limits.policy.cap} requests at a time; ${limits.selected} are ticked.` };
  }
  if (bulkChangeOf(form) === null) {
    return {
      ok: false,
      why: form.kind === 'assign' ? 'Choose who to assign the requests to.' : `Choose the ${form.kind} to set.`,
    };
  }
  if (form.reason.length > REASON_MAX) return { ok: false, why: `The reason can be at most ${REASON_MAX} characters.` };
  return { ok: true };
}

const CODE_WORDS: Readonly<Record<string, string>> = {
  'support.not_found': 'no such request',
  'support.transition_illegal': 'that status change is not allowed from where it is',
  'support.hold_reason_required': 'a request on hold needs a reason',
  'support.not_lead': 'only a lead can assign',
  'support.not_staff': 'that person is not on the desk staff',
  'support.idempotency_conflict': 'this batch key was already used for a different change',
};

/** A refusal code in plain words. A code this console does not know is shown as its code and nothing else. */
export function bulkCodeWords(code: string | null): string {
  if (code === null) return '';
  return CODE_WORDS[code] ?? code;
}

export interface BulkTally {
  readonly changed: number;
  readonly unchanged: number;
  readonly refused: number;
}

export function bulkTally(rows: readonly BulkRow[]): BulkTally {
  return {
    changed: rows.filter((r) => r.outcome === 'changed').length,
    unchanged: rows.filter((r) => r.outcome === 'unchanged').length,
    refused: rows.filter((r) => r.outcome === 'refused').length,
  };
}

/** One sentence from svc-support's own per-request answers, never from what was sent. */
export function bulkSummary(rows: readonly BulkRow[]): string {
  const t = bulkTally(rows);
  return `svc-support changed ${t.changed}, found ${t.unchanged} already there and refused ${t.refused} of ${rows.length} requests.`;
}
