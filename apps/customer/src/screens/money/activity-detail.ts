import { groupActivity, type ActivityGroup } from './activity-view';
import type { ActivityItem } from './deps';

/** The id in the address, as the person arrived with it. A broken escape leaves the text as it was. */
export function idFromPath(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/** The row for an address: either the row's own id, or the id of any one of its ledger lines. */
export function findGroup(items: readonly ActivityItem[], id: string): ActivityGroup | null {
  if (!id) return null;
  const { groups } = groupActivity(items);
  return groups.find((group) => group.id === id) ?? groups.find((group) => group.lines.some((line) => line.id === id)) ?? null;
}

/** The address of a row's own page. */
export const detailHref = (group: Pick<ActivityGroup, 'id'>): string => `/money/activity/${encodeURIComponent(group.id)}`;

/** How far back the page will look by itself before it says it cannot find the transaction. */
export const DETAIL_MAX_PAGES = 30;

/**
 * The order every part of a row belongs to, so the person can see why the parts are one group. Only lines of one order
 * are grouped (`groupActivity`), so a row with more than one part shares an order; anything else gives null.
 */
export function sharedOrder(lines: readonly Pick<ActivityItem, 'orderId'>[]): string | null {
  const order = lines[0]?.orderId;
  return order && lines.every((line) => line.orderId === order) ? order : null;
}
