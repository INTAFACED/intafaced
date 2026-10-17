/**
 * Recent conversions panel state (TRMKT R3). The panel is parked until TRD-0857 lands a convert-history read.
 *
 * Why not read Activity: a real conversion reaches the customer's Activity as an `order_hold` line out (the paying
 * asset) plus a `trade` line in (the bought asset) with the same `orderId`. A zero-fee spot order has the same two
 * lines, so Activity cannot tell the two apart and any list built from it could show a spot order as a conversion.
 * So the panel names the blocker instead of guessing, and never says "No conversions yet" when it cannot see them.
 */
import type { ActivityFeed, Loadable } from './deps';

export type RecentPanelState = { kind: 'parked'; blocker: 'TRD-0857' };

/** What the panel shows when the ledger read worked (or has nothing): parked, whatever the feed holds. */
export function recentPanelState(_feed: Loadable<ActivityFeed>): RecentPanelState {
  return { kind: 'parked', blocker: 'TRD-0857' };
}
