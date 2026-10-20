import type { Preferences } from '../../shared/preferences';
import type { ActivityItem } from './deps';
import type { ActivityGroup } from './activity-view';

type Zone = Preferences['timeZone'];

export type DirectionFilter = 'all' | 'in' | 'out';
export interface ActivityFilters {
  /** Free text: what is on the row, a handle, an account name, an asset, an amount or a reference. */
  q: string;
  dir: DirectionFilter;
  /** `YYYY-MM-DD`, first day included. */
  from: string;
  /** `YYYY-MM-DD`, last day included. */
  to: string;
  /** Only lines the customer wrote a note or a report description on. */
  hasNote: boolean;
  /** Asked of the bank, not worked out here: oldest first, one account (`main` or a named account id), one UTC year, part of an address. */
  sort: 'desc' | 'asc';
  accountId: string;
  year: string;
  address: string;
}
export const NO_FILTERS: ActivityFilters = {
  q: '',
  dir: 'all',
  from: '',
  to: '',
  hasNote: false,
  sort: 'desc',
  accountId: '',
  year: '',
  address: '',
};
/** The shortest address the bank will search for. */
export const ADDRESS_MIN = 4;
/** The longest the bank accepts. */
export const ADDRESS_MAX = 128;
export const hasFilters = (f: ActivityFilters): boolean =>
  f.q.trim() !== '' ||
  f.dir !== 'all' ||
  f.from !== '' ||
  f.to !== '' ||
  f.hasNote ||
  f.sort !== 'desc' ||
  f.accountId !== '' ||
  f.year !== '' ||
  f.address.trim() !== '';

/** The filters the bank applies itself. An address under the bank's minimum, or a year that is not a number, is not sent. */
export function serverOptions(f: ActivityFilters): { sort?: 'asc'; accountId?: string; year?: number; address?: string } {
  const year = /^\d{4}$/.test(f.year) ? Number(f.year) : undefined;
  const address = f.address.trim();
  return {
    ...(f.sort === 'asc' ? { sort: 'asc' as const } : {}),
    ...(f.accountId ? { accountId: f.accountId } : {}),
    ...(year !== undefined ? { year } : {}),
    ...(address.length >= ADDRESS_MIN ? { address } : {}),
  };
}
/** True when the bank was asked to narrow the list. Reordering alone does not narrow it. */
export const askedOfTheBank = (f: ActivityFilters): boolean => {
  const { sort: _order, ...narrowing } = serverOptions(f);
  return Object.keys(narrowing).length > 0;
};

const hasWords = (item: ActivityItem): boolean => item.privateNote !== undefined || item.reportDescription !== undefined;

const DAY = 24 * 60 * 60 * 1000;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** The first millisecond of a calendar day in the viewer's chosen clock; null when the text is not a real date. */
export function dayStart(date: string, zone: Zone): number | null {
  const match = DATE.exec(date);
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const utc = Date.UTC(year, month - 1, day);
  const check = new Date(utc);
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) return null;
  if (zone === 'UTC') return utc;
  if (zone === 'UTC+8') return utc - 8 * 60 * 60 * 1000;
  return new Date(year, month - 1, day).getTime();
}

/** Why a date range cannot be used, or null. An empty end means "up to now". */
export function rangeProblem(f: ActivityFilters, zone: Zone): 'from' | 'to' | 'order' | null {
  const from = f.from ? dayStart(f.from, zone) : null;
  const to = f.to ? dayStart(f.to, zone) : null;
  if (f.from && from === null) return 'from';
  if (f.to && to === null) return 'to';
  if (from !== null && to !== null && from > to) return 'order';
  return null;
}

export function inRange(postedAt: string, f: ActivityFilters, zone: Zone): boolean {
  const at = Date.parse(postedAt);
  if (!Number.isFinite(at)) return !f.from && !f.to;
  const from = f.from ? dayStart(f.from, zone) : null;
  const to = f.to ? dayStart(f.to, zone) : null;
  if (from !== null && at < from) return false;
  if (to !== null && at >= to + DAY) return false;
  return true;
}

function haystack(item: ActivityItem, title: string): string {
  return [title, item.kind, item.asset, item.amount, item.counterparty?.handle, item.spaceName, item.txId, item.id, item.orderId]
    .filter((part): part is string => typeof part === 'string' && part !== '')
    .join(' ')
    .toLowerCase();
}

/** True when the row passes every active filter. `title` is the row's own words, so what is searched is what is read. */
export function groupMatches(group: ActivityGroup, f: ActivityFilters, zone: Zone, title: string): boolean {
  if (f.dir !== 'all' && group.main.direction !== f.dir) return false;
  if (!inRange(group.main.postedAt, f, zone)) return false;
  if (f.hasNote && !hasWords(group.main) && !group.lines.some(hasWords)) return false;
  const needle = f.q.trim().replace(/^@/, '').toLowerCase();
  if (!needle) return true;
  const text = [haystack(group.main, title), ...group.lines.map((line) => haystack(line, ''))].join(' ');
  return needle.split(/\s+/).every((word) => text.includes(word));
}
