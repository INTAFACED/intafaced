/**
 * Pure rules for the support desk: how a request is described, filtered and ordered, how a help article is grouped, and
 * what the person can and cannot do to a request today. No React, no network, so every rule here has a test.
 */

export type TicketStatus = 'open' | 'pending' | 'resolved' | 'closed';
export type TicketCategory = 'account' | 'trading' | 'deposit_withdraw' | 'other';

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

/** "Active" is everything the team can still act on: not yet resolved, not closed. */
export function matchesFilter(status: TicketStatus, filter: StatusFilter): boolean {
  if (filter === 'all') return true;
  if (filter === 'active') return status === 'open' || status === 'pending';
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

/** A closed request takes no more messages. A resolved one reopens when the person replies. */
export function canReply(status: TicketStatus): boolean {
  return status !== 'closed';
}

export function replyReopens(status: TicketStatus): boolean {
  return status === 'resolved';
}

/**
 * What the support service can do for the signed-in person today. The service has procedures to create a request, read it,
 * read its conversation and history, and reply. It has none to close, rate or attach a file, so those three stay visible and
 * switched off with the reason, instead of being left out or pretending.
 */
export const REQUEST_ACTIONS = {
  reply: { available: true },
  close: { available: false, reason: 'noCloseProcedure' },
  rate: { available: false, reason: 'noRateProcedure' },
  attach: { available: false, reason: 'noAttachProcedure' },
} as const;
export type RequestActionId = keyof typeof REQUEST_ACTIONS;

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
 * Where a person who cannot sign in writes to. One place, one address; `VITE_SUPPORT_EMAIL` overrides it per deployment.
 * The default is the company address recorded in the repository's contact notes (docs/TV-APPLY-PACK.md).
 */
export const DEFAULT_SUPPORT_EMAIL = 'hello@intafaced.com';

export function supportEmail(configured?: string | undefined): string {
  const value = (configured ?? '').trim();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) ? value : DEFAULT_SUPPORT_EMAIL;
}

/** A mailto link that never carries a password, code or key: only the subject and a plain prompt the person finishes. */
export function supportMailto(address: string, subject: string, body: string): string {
  return `mailto:${address}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

function fold(text: string): string {
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLocaleLowerCase().trim();
}
