import type { CrmContact, CrmOpportunity } from '@intafaced/contracts';

/** Columns the enquiry list can be sorted by. `due` is the next action's due time. */
export type CrmSortKey = 'received' | 'due' | 'amount' | 'name';
export type CrmSortDirection = 'asc' | 'desc';
export type CrmSort = { key: CrmSortKey; direction: CrmSortDirection };

/** The server already returns newest first, so this is also "no re-ordering". */
export const DEFAULT_CRM_SORT: CrmSort = { key: 'received', direction: 'desc' };
/** The direction a column starts in when first chosen: newest, soonest, largest, A to Z. */
export const FIRST_DIRECTION: Record<CrmSortKey, CrmSortDirection> = { received: 'desc', due: 'asc', amount: 'desc', name: 'asc' };

/** A click on a header: a new column starts in its natural direction, the same column flips. */
export function nextSort(current: CrmSort, key: CrmSortKey): CrmSort {
  if (current.key !== key) return { key, direction: FIRST_DIRECTION[key] };
  return { key, direction: current.direction === 'asc' ? 'desc' : 'asc' };
}

export function ariaSort(current: CrmSort, key: CrmSortKey): 'ascending' | 'descending' | 'none' {
  if (current.key !== key) return 'none';
  return current.direction === 'asc' ? 'ascending' : 'descending';
}

/** Phone sort menu: one choice that sets both column and direction. */
export const SORT_PRESETS: Array<{ value: string; label: string; sort: CrmSort }> = [
  { value: 'received:desc', label: 'Newest first', sort: { key: 'received', direction: 'desc' } },
  { value: 'received:asc', label: 'Oldest first', sort: { key: 'received', direction: 'asc' } },
  { value: 'due:asc', label: 'Due soonest', sort: { key: 'due', direction: 'asc' } },
  { value: 'amount:desc', label: 'Amount, high to low', sort: { key: 'amount', direction: 'desc' } },
  { value: 'amount:asc', label: 'Amount, low to high', sort: { key: 'amount', direction: 'asc' } },
  { value: 'name:asc', label: 'Name, A to Z', sort: { key: 'name', direction: 'asc' } },
];
export const sortValue = (sort: CrmSort) => `${sort.key}:${sort.direction}`;

/** The investor's stated amount, or null (undecided, or any other audience). Indicative only, never a balance. */
export function indicativeAmountOf(item: CrmOpportunity): { amount: string; currency: string } | null {
  if (item.audience !== 'investor' || item.indicativeContribution.status !== 'stated') return null;
  return { amount: item.indicativeContribution.amount, currency: item.indicativeContribution.currency };
}

function grouped(value: string): string {
  const [whole = '0', fraction] = value.split('.');
  const digits = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return fraction === undefined ? digits : `${digits}.${fraction}`;
}

/** "€150,000", or "—" when there is no stated amount. Whole amounts have no decimals. */
export function formatIndicativeAmount(value: { amount: string; currency: string } | null): string {
  if (!value) return '—';
  try {
    // A decimal string keeps its exact digits where the browser supports it (it falls back to a number otherwise).
    return new Intl.NumberFormat('en-GB', {
      style: 'currency',
      currency: value.currency,
      minimumFractionDigits: 0,
      maximumFractionDigits: 2,
    }).format(value.amount as never);
  } catch {
    return `${grouped(value.amount)} ${value.currency}`;
  }
}

/** Compares two non-negative decimal strings exactly, without turning them into floating-point numbers. */
export function compareDecimal(a: string, b: string): number {
  const [wholeA = '0', fractionA = ''] = a.split('.');
  const [wholeB = '0', fractionB = ''] = b.split('.');
  if (wholeA.length !== wholeB.length) return wholeA.length < wholeB.length ? -1 : 1;
  if (wholeA !== wholeB) return wholeA < wholeB ? -1 : 1;
  const width = Math.max(fractionA.length, fractionB.length);
  const left = fractionA.padEnd(width, '0');
  const right = fractionB.padEnd(width, '0');
  return left === right ? 0 : left < right ? -1 : 1;
}

/**
 * Re-orders the rows already loaded on this page; it never asks the server. Rows with nothing to compare (no next action,
 * no stated amount) always go last, whichever way the column runs, and ties keep the order they arrived in. Amounts are
 * compared as plain numbers, so rows in different currencies are not converted.
 */
export function sortEnquiries(
  items: CrmOpportunity[],
  contacts: ReadonlyMap<string, Pick<CrmContact, 'name'>>,
  sort: CrmSort,
): CrmOpportunity[] {
  const sign = sort.direction === 'asc' ? 1 : -1;
  const order = new Map(items.map((item, index) => [item.id, index]));
  const compare = (a: CrmOpportunity, b: CrmOpportunity): number => {
    let missingA = false;
    let missingB = false;
    let result = 0;
    if (sort.key === 'received') result = Date.parse(a.createdAt) - Date.parse(b.createdAt);
    else if (sort.key === 'name') {
      result = (contacts.get(a.contactId)?.name ?? '').localeCompare(contacts.get(b.contactId)?.name ?? '', 'en-GB', {
        sensitivity: 'base',
      });
    } else if (sort.key === 'due') {
      missingA = !a.nextAction;
      missingB = !b.nextAction;
      if (a.nextAction && b.nextAction) result = Date.parse(a.nextAction.dueAt) - Date.parse(b.nextAction.dueAt);
    } else {
      const left = indicativeAmountOf(a);
      const right = indicativeAmountOf(b);
      missingA = !left;
      missingB = !right;
      if (left && right) result = compareDecimal(left.amount, right.amount);
    }
    if (missingA !== missingB) return missingA ? 1 : -1;
    if (result !== 0) return Math.sign(result) * sign;
    return (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0);
  };
  return [...items].sort(compare);
}
