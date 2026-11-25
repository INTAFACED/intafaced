import { div, formatAmount, mul, parseAmount } from '@intafaced/money-math';
import type { ApiResult } from '../../../shared/api';
import type { VenueApi, VenueFill, VenueOrder } from '../venue-api';

/** Format a signed scaled-bigint amount cleanly, preserving a leading minus sign when negative. */
function formatSigned(value: bigint): string {
  return value < 0n ? `-${formatAmount(-value)}` : formatAmount(value);
}

/** A fill's total: its price times its size, exact (both are the venue's decimals). */
export function fillTotal(f: Pick<VenueFill, 'price' | 'amount'>): string {
  return formatAmount(mul(parseAmount(f.price), parseAmount(f.amount), 'half-up'));
}

/** One entry from the venue's order history: the order and when the venue recorded it placed. */
export interface VenueOrderHistoryEntry {
  order: VenueOrder;
  placedAt: string;
}

/**
 * Every order in the venue's order history for `owner`, newest placed first, paging with `before` up to `maxPages`.
 * A venue that publishes no order history (`not_offered`) falls back to its open orders, or an empty list when neither
 * is offered; any other failure is returned as a failure.
 */
export async function readAllVenueOrders(
  venue: Pick<VenueApi, 'orderHistory' | 'openOrders'>,
  owner: string,
  signal?: AbortSignal,
  maxPages = 10,
): Promise<ApiResult<VenueOrderHistoryEntry[]>> {
  const orders: VenueOrderHistoryEntry[] = [];
  let before: string | undefined;
  for (let page = 0; page < maxPages; page += 1) {
    const res = await venue.orderHistory(owner, { limit: '100', ...(before ? { before } : {}) }, signal);
    if (!res.ok) {
      if (page === 0 && /not_offered/.test(`${res.code ?? ''} ${res.message}`)) {
        const open = await venue.openOrders(owner, signal);
        if (!open.ok) {
          if (/not_offered/.test(`${open.code ?? ''} ${open.message}`)) return { ok: true, data: [] };
          return open;
        }
        return { ok: true, data: open.data.value.map((order) => ({ order, placedAt: open.data.asOf })) };
      }
      return res;
    }
    orders.push(...res.data.orders);
    if (!res.data.next) return { ok: true, data: orders };
    before = res.data.next;
  }
  return { ok: true, data: orders };
}

/** The venue fills of one order, newest first, with exact totals. A fill that names no order is a group of its own. */
export interface VenueFillGroup {
  readonly order: string | null;
  readonly fills: readonly VenueFill[];
  /** Sum of base amounts across fills in this order. */
  readonly amount: string;
  /** Sum of price × amount (quote totals) across fills in this order. */
  readonly total: string;
  /** Weighted average price (total / amount, half-up), or null when amount is zero. */
  readonly average: string | null;
  /** Common fee asset across fills, or null when fills paid fees in different assets. */
  readonly feeAsset: string | null;
  /** Sum of venue fees when all fills share one fee asset, else null (never sums across coins). */
  readonly venueFee: string | null;
  /** Sum of builder fees when all fills share one fee asset, else null. */
  readonly builderFee: string | null;
  /** Sum of realised PnL when every fill reported one and they share one fee asset, else null. */
  readonly realisedPnl: string | null;
}

/**
 * Activity's venue Trades tab (J-portfolio-03 #5), grouped by order: an order that filled in parts is one group with
 * all its fills. Groups are newest first by their newest fill, fills newest first inside a group. Every amount is exact.
 */
export function groupVenueFillsByOrder(rows: readonly VenueFill[]): VenueFillGroup[] {
  const newest = [...rows].sort((a, b) => Date.parse(b.filledAt) - Date.parse(a.filledAt) || b.fillId.localeCompare(a.fillId));
  const byOrder = new Map<string, VenueFill[]>();
  const groups: VenueFill[][] = [];
  for (const fill of newest) {
    const key = fill.venueClientOrderId ? fill.venueClientOrderId.toLowerCase() : null;
    const known = key ? byOrder.get(key) : undefined;
    if (known) {
      known.push(fill);
      continue;
    }
    const group = [fill];
    if (key) byOrder.set(key, group);
    groups.push(group);
  }
  return groups.map((fills) => {
    const first = fills[0]!;
    const amountUnits = fills.reduce((sum, fill) => sum + parseAmount(fill.amount), 0n);
    const totalUnits = fills.reduce((sum, fill) => sum + mul(parseAmount(fill.price), parseAmount(fill.amount), 'half-up'), 0n);
    const sameFeeAsset = fills.every((fill) => fill.feeAsset === first.feeAsset);
    const venueFee = sameFeeAsset ? formatSigned(fills.reduce((sum, fill) => sum + parseAmount(fill.venueFee), 0n)) : null;
    const builderFee = sameFeeAsset ? formatSigned(fills.reduce((sum, fill) => sum + parseAmount(fill.builderFee), 0n)) : null;
    const realisedPnl =
      sameFeeAsset && fills.every((fill) => fill.realisedPnl !== null)
        ? formatSigned(fills.reduce((sum, fill) => sum + parseAmount(fill.realisedPnl!), 0n))
        : null;
    return {
      order: first.venueClientOrderId,
      fills,
      amount: formatAmount(amountUnits),
      total: formatAmount(totalUnits),
      average: amountUnits > 0n ? formatAmount(div(totalUnits, amountUnits, 'half-up')) : null,
      feeAsset: sameFeeAsset ? first.feeAsset : null,
      venueFee,
      builderFee,
      realisedPnl,
    };
  });
}
