import type { Amount } from '@intafaced/ledger-client/money';
import type { AsOf, UserVenueAccount, UserVenueOrderRecord, VenueOrderStatus } from '@intafaced/venue-contracts';
import type { StoredVenueAction } from './prepared-action-store.js';

/**
 * A person's venue order history (J-cex-spot-06 #1, #7, #10): the venue's own record of the account's orders, filtered by
 * side, state, market and the day placed, a page at a time, newest first. Every order and state is the venue's; nothing
 * here is ours but the filtering and the amend trail, which is our record of the amendments the venue accepted.
 *
 * A filter that can't be used is refused in words with `trade.invalid_filter` (400), and a cursor that names no order in
 * this history with `trade.invalid_cursor` (400): another person's order id is never a cursor, so a page never hints it
 * exists.
 */

export const HISTORY_STATES: readonly VenueOrderStatus[] = ['open', 'partially_filled', 'filled', 'canceled', 'rejected'];
/** The page sizes the history serves; the first is the default. */
export const HISTORY_PAGE_SIZES: readonly number[] = [20, 50, 100];

export interface VenueHistoryQuery {
  readonly side: 'buy' | 'sell' | null;
  readonly status: VenueOrderStatus | null;
  readonly symbol: string | null;
  /** Placed at or after this time. */
  readonly from: Date | null;
  /** Placed before this time. */
  readonly to: Date | null;
  readonly limit: number;
  /** The venue client order id of the last order on the page before. */
  readonly before: string | null;
}

export interface VenueHistoryPage {
  readonly orders: readonly UserVenueOrderRecord[];
  /** Pass it as `before` for the next page; null on the last page. */
  readonly next: string | null;
  readonly asOf: Date;
}

export class VenueHistoryQueryError extends Error {
  constructor(
    message: string,
    readonly code: 'trade.invalid_filter' | 'trade.invalid_cursor',
  ) {
    super(message);
    this.name = 'VenueHistoryQueryError';
  }
}

const refuse = (words: string): never => {
  throw new VenueHistoryQueryError(words, 'trade.invalid_filter');
};

function time(raw: string | undefined, name: string): Date | null {
  if (raw === undefined || raw === '') return null;
  const at = new Date(raw);
  if (!/^\d{4}-\d\d-\d\dT/.test(raw) || Number.isNaN(at.getTime())) refuse(`${name} “${raw}” isn’t a time we can read`);
  return at;
}

/** The query as the address sends it, checked. Every word of a refusal is for the person. */
export function parseHistoryQuery(raw: Record<string, string | undefined>): VenueHistoryQuery {
  const side = raw.side === undefined || raw.side === '' ? null : raw.side;
  if (side !== null && side !== 'buy' && side !== 'sell') refuse(`side “${side}” isn’t a choice we know: buy or sell`);
  const status = raw.status === undefined || raw.status === '' ? null : raw.status;
  if (status !== null && !HISTORY_STATES.includes(status as VenueOrderStatus))
    refuse(`state “${status}” isn’t a choice we know: ${HISTORY_STATES.join(', ')}`);
  const symbol = raw.symbol === undefined || raw.symbol === '' ? null : raw.symbol;
  if (symbol !== null && !/^[A-Za-z0-9]{1,20}-[A-Za-z0-9]{1,20}$/.test(symbol)) refuse(`market “${symbol}” isn’t one we know`);
  const from = time(raw.from, 'from');
  const to = time(raw.to, 'to');
  if (from && to && from.getTime() >= to.getTime()) refuse('the start of the dates must come before their end');
  let limit = HISTORY_PAGE_SIZES[0]!;
  if (raw.limit !== undefined && raw.limit !== '') {
    const n = /^\d{1,4}$/.test(raw.limit) ? Number(raw.limit) : NaN;
    if (!HISTORY_PAGE_SIZES.includes(n)) refuse(`a page holds ${HISTORY_PAGE_SIZES.join(', ')} orders, not “${raw.limit}”`);
    limit = n;
  }
  const before = raw.before === undefined || raw.before === '' ? null : raw.before.toLowerCase();
  return { side: side as VenueHistoryQuery['side'], status: status as VenueOrderStatus | null, symbol, from, to, limit, before };
}

/** One page of the venue's history under the query. The venue's list is newest placed first. */
export function historyPage(read: AsOf<readonly UserVenueOrderRecord[]>, q: VenueHistoryQuery): VenueHistoryPage {
  const matching = read.value.filter(
    ({ order, placedAt }) =>
      (q.side === null || order.side === q.side) &&
      (q.status === null || order.status === q.status) &&
      (q.symbol === null || order.symbol === q.symbol) &&
      (q.from === null || placedAt.getTime() >= q.from.getTime()) &&
      (q.to === null || placedAt.getTime() < q.to.getTime()),
  );
  let start = 0;
  if (q.before !== null) {
    const at = matching.findIndex((r) => r.order.venueClientOrderId === q.before);
    if (at < 0) throw new VenueHistoryQueryError('that page marker names no order in this history', 'trade.invalid_cursor');
    start = at + 1;
  }
  const orders = matching.slice(start, start + q.limit);
  const last = orders[orders.length - 1];
  const more = start + q.limit < matching.length;
  // An order with no client id can't be a marker; the page ends there (none of ours is placed without one).
  const next = more && last?.order.venueClientOrderId ? last.order.venueClientOrderId : null;
  return { orders, next, asOf: read.asOf };
}

/** One amendment the venue accepted: the amount and price it left the order with, and when the venue recorded it. */
export interface VenueAmendment {
  readonly actionKey: string;
  readonly amount: Amount;
  readonly price: Amount;
  readonly recordedAt: Date;
}

/** The amend actions stored under this prefix (`amend:`, the customer app's key for one lowering of an order). */
export const AMEND_KEY_PREFIX = 'amend:';

/**
 * The amend trail of one order on one account, oldest first: each amend our door sent for it that the venue accepted,
 * at the venue's own time for the answer. One still waiting for the venue's answer, or refused, is not an amendment.
 */
export function amendTrail(rows: readonly StoredVenueAction[], account: UserVenueAccount, venueClientOrderId: string): VenueAmendment[] {
  const cloid = venueClientOrderId.toLowerCase();
  const out: VenueAmendment[] = [];
  for (const row of rows) {
    const { intent, account: on } = row.prepared;
    if (intent.kind !== 'amend_order' || intent.venueClientOrderId.toLowerCase() !== cloid) continue;
    if (on.venueId !== account.venueId || on.owner.toLowerCase() !== account.owner || (on.subAccount ?? null) !== account.subAccount)
      continue;
    const outcome = row.lastOutcome;
    if (!row.signature || !outcome || !outcome.definite || !outcome.accepted) continue;
    out.push({ actionKey: row.businessKey, amount: intent.amount, price: intent.price, recordedAt: outcome.asOf });
  }
  return out.sort((a, b) => a.recordedAt.getTime() - b.recordedAt.getTime());
}
