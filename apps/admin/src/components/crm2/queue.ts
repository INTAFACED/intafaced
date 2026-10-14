/**
 * The Inbox's rules, as pure functions: who is "waiting on us", in which section, for how long, and how late that is.
 * The server decides who is in the queue (`GET /api/crm?queue=waiting`) and returns it oldest-waiting first. Everything here
 * only sorts that list into sections and tabs and words it. Business days skip Saturday and Sunday in the founder's own time.
 */
import type { CrmContact, CrmOpportunityPage, CrmOpportunityRow } from '@intafaced/contracts';
import { describeDue } from '@/lib/crm-due';
import { REPLY_TARGET_BUSINESS_DAYS } from './policy';

/** One line of the Inbox: the opportunity plus what the list response says about its contact and submission. */
export type QueueEntry = {
  row: CrmOpportunityRow;
  contact: CrmContact | null;
  /** The organisation name from the questionnaire, or null. */
  organisation: string | null;
  /** True while the questionnaire is unfinished. */
  partial: boolean;
  /** Set when a search matched a merged-away contact: the old name. */
  alias?: string;
};

/** Joins the list response's rows to their contacts and submissions. Rows whose contact is missing are kept, with no name. */
export function entriesOf(
  page: Pick<CrmOpportunityPage, 'items' | 'contacts' | 'submissions'> & { aliasMatches?: CrmOpportunityPage['aliasMatches'] },
): QueueEntry[] {
  const contacts = new Map(page.contacts.map((contact) => [contact.id, contact]));
  const submissions = new Map(page.submissions.map((submission) => [submission.submissionId, submission]));
  const aliases = new Map(page.aliasMatches?.map((match) => [match.opportunityId, match.name]) ?? []);
  return page.items.map((row) => {
    const submission = submissions.get(row.submissionId);
    const alias = aliases.get(row.id);
    return {
      row,
      contact: contacts.get(row.contactId) ?? null,
      organisation: submission?.organisationName ?? null,
      partial: submission ? submission.completedAt === null : false,
      ...(alias ? { alias } : {}),
    };
  });
}

/* ------------------------------------------------------------------ sections */

export type QueueSection = 'overdue' | 'no_reply' | 'due_today';
export const SECTION_ORDER: readonly QueueSection[] = ['overdue', 'no_reply', 'due_today'];
export const SECTION_TITLE: Record<QueueSection, string> = {
  overdue: 'Overdue',
  no_reply: 'No reply yet',
  due_today: 'Due today',
};

export const startOfLocalDay = (time: number) => {
  const day = new Date(time);
  return new Date(day.getFullYear(), day.getMonth(), day.getDate()).getTime();
};

/**
 * Overdue: the next action fell due before today. Otherwise, No reply yet: nobody has replied. Otherwise, Due today: the next
 * action is due now (earlier today). A closed row has no next action and never reaches the queue; it falls into the last section.
 */
export function sectionOf(row: Pick<CrmOpportunityRow, 'nextAction' | 'firstReplyAt'>, now = Date.now()): QueueSection {
  const due = row.nextAction ? Date.parse(row.nextAction.dueAt) : Number.NaN;
  if (!Number.isNaN(due) && due < startOfLocalDay(now)) return 'overdue';
  if (row.firstReplyAt === null) return 'no_reply';
  return 'due_today';
}

const sinceOf = (row: Pick<CrmOpportunityRow, 'waitingSince'>) =>
  row.waitingSince ? Date.parse(row.waitingSince) : Number.POSITIVE_INFINITY;

/** Oldest waiting first; a row with no waiting time goes last. Ties keep their order. */
export function oldestFirst<T extends { row: Pick<CrmOpportunityRow, 'waitingSince'> }>(entries: readonly T[]): T[] {
  return entries
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => {
      const left = sinceOf(a.entry.row);
      const right = sinceOf(b.entry.row);
      if (left !== right) return left < right ? -1 : 1;
      return a.index - b.index;
    })
    .map(({ entry }) => entry);
}

export type QueueGroup<T> = { section: QueueSection; title: string; entries: T[] };
/** The three sections in order, each oldest first. Empty sections are left out. */
export function sectionQueue<T extends { row: Pick<CrmOpportunityRow, 'nextAction' | 'firstReplyAt' | 'waitingSince'> }>(
  entries: readonly T[],
  now = Date.now(),
): QueueGroup<T>[] {
  const groups = new Map<QueueSection, T[]>(SECTION_ORDER.map((section) => [section, []]));
  for (const entry of oldestFirst(entries)) groups.get(sectionOf(entry.row, now))!.push(entry);
  return SECTION_ORDER.filter((section) => groups.get(section)!.length > 0).map((section) => ({
    section,
    title: SECTION_TITLE[section],
    entries: groups.get(section)!,
  }));
}

/* ------------------------------------------------------------------ tabs */

export type InboxTab = 'investors' | 'others' | 'mine' | 'all';
export const INBOX_TABS: ReadonlyArray<{ value: InboxTab; label: string }> = [
  { value: 'investors', label: 'Investors' },
  { value: 'others', label: 'Everyone else' },
  { value: 'mine', label: 'Mine' },
  { value: 'all', label: 'All' },
];
export const DEFAULT_INBOX_TAB: InboxTab = 'investors';

export function inTab<T extends { row: Pick<CrmOpportunityRow, 'audience' | 'ownerUserId'> }>(
  tab: InboxTab,
  entry: T,
  userId: string,
): boolean {
  if (tab === 'investors') return entry.row.audience === 'investor';
  if (tab === 'others') return entry.row.audience !== 'investor';
  if (tab === 'mine') return entry.row.ownerUserId === userId;
  return true;
}
export function tabRows<T extends { row: Pick<CrmOpportunityRow, 'audience' | 'ownerUserId'> }>(
  tab: InboxTab,
  entries: readonly T[],
  userId: string,
): T[] {
  return entries.filter((entry) => inTab(tab, entry, userId));
}
export function tabCounts<T extends { row: Pick<CrmOpportunityRow, 'audience' | 'ownerUserId'> }>(
  entries: readonly T[],
  userId: string,
): Record<InboxTab, number> {
  return {
    investors: tabRows('investors', entries, userId).length,
    others: tabRows('others', entries, userId).length,
    mine: tabRows('mine', entries, userId).length,
    all: entries.length,
  };
}

/* ------------------------------------------------------------------ waiting time */

const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

/** "3d", "5h", "12m" or "<1m": how long this person has waited. "—" when there is no waiting time. */
export function waitingText(since: string | null, now = Date.now()): string {
  if (!since) return '—';
  const ms = now - Date.parse(since);
  if (Number.isNaN(ms)) return '—';
  if (ms < MINUTE) return '<1m';
  if (ms < HOUR) return `${Math.floor(ms / MINUTE)}m`;
  if (ms < DAY) return `${Math.floor(ms / HOUR)}h`;
  return `${Math.floor(ms / DAY)}d`;
}

/** How long a wait has run with Saturdays and Sundays (the founder's local days) taken out. */
export function businessMsBetween(fromMs: number, toMs: number): number {
  if (!(toMs > fromMs)) return 0;
  let total = 0;
  let cursor = fromMs;
  // A guard of 800 days keeps a corrupt date from looping for long.
  for (let step = 0; cursor < toMs && step < 800; step += 1) {
    const day = new Date(cursor);
    const next = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1).getTime();
    const end = Math.min(next, toMs);
    const weekday = day.getDay();
    if (weekday !== 0 && weekday !== 6) total += end - cursor;
    cursor = end;
  }
  return total;
}

export type WaitSeverity = 'ok' | 'late' | 'very_late';
export const SEVERITY_WORD: Record<WaitSeverity, string> = { ok: '', late: 'Late', very_late: 'Very late' };

/** The reply target for an audience, in business days. */
export const replyTargetDays = (audience: string) =>
  audience === 'investor' ? REPLY_TARGET_BUSINESS_DAYS.investor : REPLY_TARGET_BUSINESS_DAYS.other;

/** Amber ("late") once the wait passes the reply target, red ("very late") once it passes twice the target. */
export function waitSeverity(audience: string, since: string | null, now = Date.now()): WaitSeverity {
  if (!since) return 'ok';
  const start = Date.parse(since);
  if (Number.isNaN(start)) return 'ok';
  const waited = businessMsBetween(start, now);
  const target = replyTargetDays(audience) * DAY;
  if (waited > 2 * target) return 'very_late';
  if (waited > target) return 'late';
  return 'ok';
}

/** The next action as a row shows it: its words, when it is due, and the overdue wording if it is. */
export function nextActionLine(row: Pick<CrmOpportunityRow, 'nextAction' | 'closedDisposition'>, now = Date.now()) {
  if (!row.nextAction) return null;
  const due = describeDue(row.nextAction.dueAt, now);
  return { description: row.nextAction.description, when: due.when, overdue: due.overdue };
}

/** The empty-state sentence: how many enquiries are open, so "nobody is waiting" is checkable. */
export function emptyQueueNote(openEnquiries: number | null): string {
  if (openEnquiries === null) return '';
  return `${openEnquiries.toLocaleString('en-GB')} open ${openEnquiries === 1 ? 'enquiry' : 'enquiries'} in total.`;
}

export type WaitingState = {
  kind: 'us' | 'them' | 'closed';
  /** "No reply yet", "Follow-up due", "Waiting on them" or "Closed". */
  headline: string;
};
/** Whose move it is. On us when nobody has replied or the next action is due now; on them otherwise; closed has no move. */
export function waitingState(row: Pick<CrmOpportunityRow, 'stage' | 'nextAction' | 'firstReplyAt'>, now = Date.now()): WaitingState {
  if (row.stage === 'closed' || !row.nextAction) return { kind: 'closed', headline: 'Closed' };
  if (row.firstReplyAt === null) return { kind: 'us', headline: 'No reply yet' };
  const due = Date.parse(row.nextAction.dueAt);
  if (!Number.isNaN(due) && due <= now) return { kind: 'us', headline: 'Follow-up due' };
  return { kind: 'them', headline: 'Waiting on them' };
}
