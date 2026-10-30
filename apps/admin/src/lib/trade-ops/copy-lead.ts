/**
 * The copy-trading desk's data, as svc-trade sends it (`copy.ops.leadDesk.*`, services/svc-trade/src/copy/lead-applications.ts).
 * Plain data and parsers, safe in server and browser code: a body of any other shape is refused, never guessed at.
 */

export type LeadApplicationStatus = 'pending' | 'awaiting_second' | 'approved' | 'rejected';
export type LeadListingState = 'unlisted' | 'listed' | 'suspended' | 'delisted';

export interface LeadCriteria {
  readonly minTrackRecordDays: number;
  readonly setBy: string;
  readonly setAt: string;
}

export interface LeadApplication {
  readonly id: string;
  readonly userId: string;
  readonly displayName: string;
  readonly status: LeadApplicationStatus;
  readonly appliedAt: string;
  readonly approvalId: string | null;
  readonly proposedBy: string | null;
  readonly reason: string | null;
  readonly leaderRef: string | null;
}

export interface LeadListing {
  readonly leaderRef: string;
  readonly displayName: string;
  readonly state: LeadListingState;
  readonly listedAt: string | null;
  readonly stateChangedAt: string;
}

export interface LeadAuditRow {
  readonly id: string;
  readonly at: string;
  readonly action: string;
  readonly operatorId: string;
  readonly subject: string;
  readonly reason: string | null;
  /** A lead decision's business key (`copy.ops.decide:<applicationId>:<decision>`); null on other rows. */
  readonly key: string | null;
}

export interface LeadQueue {
  readonly applications: readonly LeadApplication[];
  readonly criteria: LeadCriteria | null;
}

export interface LeadDeskRead {
  readonly queue: LeadQueue;
  readonly leads: readonly LeadListing[];
  readonly audit: readonly LeadAuditRow[];
}

export const LEAD_STATUS_TEXT: Record<LeadApplicationStatus, string> = {
  pending: 'Waiting for review',
  awaiting_second: 'Waiting for a second founder',
  approved: 'Approved and listed',
  rejected: 'Rejected',
};

export const LEAD_STATE_TEXT: Record<LeadListingState, string> = {
  unlisted: 'Not listed',
  listed: 'Listed',
  suspended: 'Suspended',
  delisted: 'Delisted',
};

const STATUSES: readonly string[] = ['pending', 'awaiting_second', 'approved', 'rejected'];
const STATES: readonly string[] = ['unlisted', 'listed', 'suspended', 'delisted'];

type Raw = Record<string, unknown>;
const obj = (v: unknown): Raw | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Raw) : null);
const str = (v: unknown): v is string => typeof v === 'string';
const strOrNull = (v: unknown): v is string | null => v === null || typeof v === 'string';

function all<T>(raw: unknown, one: (r: unknown) => T | null): T[] | null {
  if (!Array.isArray(raw)) return null;
  const rows = raw.map(one);
  return rows.every((r): r is T => r !== null) ? rows : null;
}

export function parseCriteria(raw: unknown): LeadCriteria | null {
  const r = obj(raw);
  if (!r || !Number.isInteger(r.minTrackRecordDays) || !str(r.setBy) || !str(r.setAt)) return null;
  return { minTrackRecordDays: r.minTrackRecordDays as number, setBy: r.setBy, setAt: r.setAt };
}

export function parseApplication(raw: unknown): LeadApplication | null {
  const r = obj(raw);
  if (!r || !str(r.id) || !str(r.userId) || !str(r.displayName) || !str(r.appliedAt)) return null;
  if (!str(r.status) || !STATUSES.includes(r.status)) return null;
  if (!strOrNull(r.approvalId) || !strOrNull(r.proposedBy) || !strOrNull(r.reason) || !strOrNull(r.leaderRef)) return null;
  return {
    id: r.id,
    userId: r.userId,
    displayName: r.displayName,
    status: r.status as LeadApplicationStatus,
    appliedAt: r.appliedAt,
    approvalId: r.approvalId,
    proposedBy: r.proposedBy,
    reason: r.reason,
    leaderRef: r.leaderRef,
  };
}

export function parseQueue(raw: unknown): LeadQueue | null {
  const r = obj(raw);
  if (!r) return null;
  const applications = all(r.applications, parseApplication);
  const criteria = r.criteria === null ? null : parseCriteria(r.criteria);
  if (!applications || (r.criteria !== null && criteria === null)) return null;
  return { applications, criteria };
}

export function parseListing(raw: unknown): LeadListing | null {
  const r = obj(raw);
  if (!r || !str(r.leaderRef) || !str(r.displayName) || !str(r.stateChangedAt) || !strOrNull(r.listedAt)) return null;
  if (!str(r.state) || !STATES.includes(r.state)) return null;
  return {
    leaderRef: r.leaderRef,
    displayName: r.displayName,
    state: r.state as LeadListingState,
    listedAt: r.listedAt,
    stateChangedAt: r.stateChangedAt,
  };
}

export const parseListings = (raw: unknown) => all(raw, parseListing);

export function parseAuditRow(raw: unknown): LeadAuditRow | null {
  const r = obj(raw);
  if (!r || !str(r.id) || !str(r.at) || !str(r.action) || !str(r.operatorId) || !str(r.subject) || !strOrNull(r.reason)) return null;
  const key = strOrNull(r.key) ? (r.key as string | null) : null;
  return { id: r.id, at: r.at, action: r.action, operatorId: r.operatorId, subject: r.subject, reason: r.reason, key };
}

export const parseAudit = (raw: unknown) => all(raw, parseAuditRow);

/** The criteria as a founder types them: a whole number of days, 0 to 3650. Anything else is refused, not rounded. */
export function checkDays(value: unknown): { ok: true; days: number } | { ok: false; message: string } {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!/^(?:0|[1-9]\d{0,3})$/.test(text) || Number(text) > 3650)
    return { ok: false, message: 'Enter the minimum track record as a whole number of days, 0 to 3650.' };
  return { ok: true, days: Number(text) };
}

/** A reason a founder writes for a rejection or a suspension, kept in the audit and shown to the applicant. */
export function checkLeadReason(value: unknown): { ok: true; reason: string } | { ok: false; message: string } {
  const text = typeof value === 'string' ? value.trim() : '';
  if (text.length < 3 || text.length > 500) return { ok: false, message: 'Write a reason of 3 to 500 characters.' };
  return { ok: true, reason: text };
}
