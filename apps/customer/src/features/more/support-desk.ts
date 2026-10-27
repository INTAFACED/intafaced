/**
 * Pure rules for the support desk: how a request is described, filtered and ordered, how a help article is grouped, and
 * what the person can and cannot do to a request today. No React, no network, so every rule here has a test.
 */
import type { SupportTicketCategory } from '@intafaced/contracts/support-categories';

/** Help articles that describe features this release does not offer (Deposits and withdrawals, Paper vs live). */
export const HIDDEN_FEATURE_ARTICLES: ReadonlySet<string> = new Set(['kb-deposit-withdraw-honest', 'kb-paper-vs-live']);

export type TicketStatus = 'open' | 'pending' | 'on_hold' | 'resolved' | 'closed';
export type TicketCategory = SupportTicketCategory;

export interface TicketLike {
  id: string;
  subject: string;
  body: string;
  category: string;
  status: TicketStatus;
  createdAt: string;
  updatedAt: string;
}

export const STATUS_FILTERS = ['all', 'active', 'resolved', 'closed'] as const;
export type StatusFilter = (typeof STATUS_FILTERS)[number];

/** "Active" is everything the team can still act on: not yet resolved, not closed (a request on hold is still active). */
export function matchesFilter(status: TicketStatus, filter: StatusFilter): boolean {
  if (filter === 'all') return true;
  if (filter === 'active') return status === 'open' || status === 'pending' || status === 'on_hold';
  return status === filter;
}

/** Newest activity first. A row with an unreadable time sinks to the bottom instead of jumping to the top. */
export function newestFirst<T extends { updatedAt: string }>(rows: readonly T[]): T[] {
  const time = (row: T) => {
    const at = Date.parse(row.updatedAt);
    return Number.isNaN(at) ? -Infinity : at;
  };
  return [...rows].sort((a, b) => time(b) - time(a));
}

/** Filter by status and by a search over subject, message and reference. Case and accents are ignored. */
export function filterTickets<T extends TicketLike>(rows: readonly T[], filter: StatusFilter, text: string): T[] {
  const needle = fold(text);
  return newestFirst(rows).filter((row) => {
    if (!matchesFilter(row.status, filter)) return false;
    if (!needle) return true;
    return fold(`${row.subject} ${row.body} ${ticketReference(row.id)}`).includes(needle);
  });
}

export function statusCounts(rows: readonly Pick<TicketLike, 'status'>[]): Record<StatusFilter, number> {
  const counts: Record<StatusFilter, number> = { all: rows.length, active: 0, resolved: 0, closed: 0 };
  for (const row of rows) {
    if (row.status === 'resolved') counts.resolved++;
    else if (row.status === 'closed') counts.closed++;
    else counts.active++;
  }
  return counts;
}

/** A short, readable handle for a request ("#A1B2C3D4") that a person can quote. The full id stays on the request. */
export function ticketReference(id: string): string {
  return `#${id.replace(/-/g, '').slice(0, 8).toUpperCase()}`;
}

/** A closed request cannot be reopened, so the way on is a new request that follows it. */
export function canFollowUp(status: TicketStatus): boolean {
  return status === 'closed';
}

/** The starting point of a follow-up: the same topic, and a subject that names what it follows (the 200-letter limit kept). */
export function followUpDraft(ticket: Pick<TicketLike, 'category' | 'subject'>, prefix: string): { category: string; subject: string } {
  return { category: ticket.category, subject: `${prefix} ${ticket.subject}`.slice(0, 200) };
}

/** A closed request takes no more messages. A resolved one reopens when the person replies. */
export function canReply(status: TicketStatus): boolean {
  return status !== 'closed';
}

export function replyReopens(status: TicketStatus): boolean {
  return status === 'resolved';
}

/**
 * What the person can do to a request right now, from its status. The support service has procedures for all three
 * (close, rate, attach), so each control is real. When one does not apply to this status, it stays on the page,
 * switched off, with the reason beside it (`reason` names a line in the desk copy).
 *
 * The service is the judge of the rules it enforces. These checks only keep the person from sending a request that the
 * service would refuse for a reason this page already knows.
 */
export type ActionReason = 'closeAlreadyClosed' | 'rateNotYet' | 'rateDone' | 'attachClosed';
export type ActionState = { readonly available: true } | { readonly available: false; readonly reason: ActionReason };

export function requestActionStates(status: TicketStatus, rated: boolean): Record<'close' | 'rate' | 'attach', ActionState> {
  return {
    close: status === 'closed' ? { available: false, reason: 'closeAlreadyClosed' } : { available: true },
    rate:
      status !== 'resolved' && status !== 'closed'
        ? { available: false, reason: 'rateNotYet' }
        : rated
          ? { available: false, reason: 'rateDone' }
          : { available: true },
    attach: status === 'closed' ? { available: false, reason: 'attachClosed' } : { available: true },
  };
}
export type RequestActionId = 'close' | 'rate' | 'attach';

/** The rating scale the service accepts: whole numbers 1 to 5. */
export const RATING_SCORES = [5, 4, 3, 2, 1] as const;
export const RATING_NOTE_MAX = 500;

/**
 * Help-article groups. Articles carry an id and two text keys but no category field, so the group comes from the id the desk
 * published (and falls back to "general" for an id this list has not seen). A group never hides an article: "All" is first.
 */
export const KB_CATEGORIES = ['all', 'account', 'security', 'trading', 'money', 'general'] as const;
export type KbCategory = (typeof KB_CATEGORIES)[number];

const KB_GROUP_BY_ID: Readonly<Record<string, Exclude<KbCategory, 'all'>>> = {
  'kb-account-access': 'account',
  'kb-security-basics': 'security',
  'kb-orders-status': 'trading',
  'kb-paper-vs-live': 'trading',
  'kb-deposit-withdraw-honest': 'money',
};
const KB_GROUP_BY_WORD: readonly (readonly [RegExp, Exclude<KbCategory, 'all'>])[] = [
  [/security|passkey|2fa|totp|password|phish/, 'security'],
  [/account|login|sign|verify|kyc|profile/, 'account'],
  [/order|trade|market|paper|convert|buy|sell/, 'trading'],
  [/deposit|withdraw|bank|pay|fee|card|transfer|money/, 'money'],
];

export function kbCategory(id: string): Exclude<KbCategory, 'all'> {
  const known = KB_GROUP_BY_ID[id];
  if (known) return known;
  const lower = id.toLowerCase();
  for (const [pattern, group] of KB_GROUP_BY_WORD) if (pattern.test(lower)) return group;
  return 'general';
}

/** How many articles each group holds, counting only groups that have any (plus "all"). */
export function kbCategoryCounts(ids: readonly string[]): Partial<Record<KbCategory, number>> {
  const counts: Partial<Record<KbCategory, number>> = { all: ids.length };
  for (const id of ids) {
    const group = kbCategory(id);
    counts[group] = (counts[group] ?? 0) + 1;
  }
  return counts;
}

export function inKbCategory(id: string, category: KbCategory): boolean {
  return category === 'all' || kbCategory(id) === category;
}

/**
 * The address a person who cannot sign in writes to, or `null` when none is published. There is no built-in address:
 * `VITE_SUPPORT_EMAIL` at build time is the only source here, and a blank or malformed value is "not set".
 */
export function supportEmail(configured?: string | undefined): string | null {
  const value = (configured ?? '').trim();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) ? value : null;
}

const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Where one request opens: its own address (SP-tickets-01). The id is the request's own id; the desk checks it belongs to the caller. */
export function supportRequestHref(ticketId: string): string {
  return `/support/tickets/${encodeURIComponent(ticketId)}`;
}

/** "My requests". */
export const SUPPORT_TICKETS_HREF = '/support/tickets';

/** The request form, with a subject drafted from the words the person searched for when there are any. */
export function supportNewHref(subject = ''): string {
  const draft = subject.trim().slice(0, SUBJECT_MAX);
  return draft ? `/support/new?${new URLSearchParams({ subject: draft })}` : '/support/new';
}

/** The request a `/support?request=<id>` address names (the address before requests had their own), or `null`. */
export function requestFromSearch(search: string): string | null {
  const value = new URLSearchParams(search).get('request');
  return value !== null && REQUEST_ID.test(value) ? value.toLowerCase() : null;
}

const SUBJECT_MAX = 200;

/**
 * Which part of the support desk an address opens. An address under /support/tickets/ that is not an id opens no request,
 * and any other address under /support/ is none of the desk's own.
 */
export type SupportRoute =
  | { view: 'help' }
  | { view: 'new'; subject: string }
  | { view: 'requests' }
  | { view: 'request'; id: string }
  | { view: 'badRequest' }
  | { view: 'unknown' };

export function supportRoute(pathname: string, search: string): SupportRoute {
  const path = pathname.replace(/\/+$/, '') || '/';
  if (path === '/support/new')
    return { view: 'new', subject: (new URLSearchParams(search).get('subject') ?? '').trim().slice(0, SUBJECT_MAX) };
  if (path === '/support/tickets') return { view: 'requests' };
  const one = /^\/support\/tickets\/([^/]+)$/.exec(path);
  if (one) {
    let id = '';
    try {
      id = decodeURIComponent(one[1]!);
    } catch {
      return { view: 'badRequest' };
    }
    return REQUEST_ID.test(id) ? { view: 'request', id: id.toLowerCase() } : { view: 'badRequest' };
  }
  if (path !== '/support') return { view: 'unknown' };
  const legacy = requestFromSearch(search);
  return legacy ? { view: 'request', id: legacy } : { view: 'help' };
}

/**
 * What the customer reads as a request's status: whose turn it is. The service says so (`customerStatus`); an older
 * service that does not falls back to the request's own status, where a finished request is solved.
 */
export type CustomerStatus = 'awaiting_reply' | 'open' | 'solved';
export function customerStatus(row: { status: TicketStatus; customerStatus?: CustomerStatus | undefined }): CustomerStatus {
  if (row.status === 'resolved' || row.status === 'closed') return 'solved';
  return row.customerStatus ?? 'open';
}

/** A mailto link that never carries a password, code or key: only the subject and a plain prompt the person finishes. */
export function supportMailto(address: string, subject: string, body: string): string {
  return `mailto:${address}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

function fold(text: string): string {
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLocaleLowerCase().trim();
}

/** The "rate this request" prompt shows only on a solved request whose stored rating has been read and found empty. */
export function showRatePrompt(status: TicketStatus, ratingRead: boolean, rated: boolean): boolean {
  return ratingRead && !rated && requestActionStates(status, rated).rate.available;
}
