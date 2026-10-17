import 'server-only';
import type { TradeCtx } from './edge';
import { tallyOrders, type MarketRowView } from './markets-model';
import type { Outcome } from './outcome';
import { readLifecycle, readMarkets, readOpenOrders, type AdminOrderRow, type LifecycleRow, type MarketRow } from './reads';

/**
 * Loads what the Health and Markets rooms share: the market list, the open orders and one lifecycle read per market,
 * all in parallel and bounded (at most LIFECYCLE_CAP markets, LIFECYCLE_PARALLEL at a time). A failing read becomes
 * that part's own Outcome; it never blanks the others.
 */

export const ORDER_READ_LIMIT = 500;
const LIFECYCLE_CAP = 60;
const LIFECYCLE_PARALLEL = 8;

async function pool<T, R>(items: readonly T[], width: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const lanes = Array.from({ length: Math.min(width, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await work(items[i] as T);
    }
  });
  await Promise.all(lanes);
  return out;
}

export interface MarketsBundle {
  readonly markets: Outcome<readonly MarketRow[]>;
  readonly orders: Outcome<readonly AdminOrderRow[]>;
  /** One per market; empty when the market list itself was not read. */
  readonly views: readonly MarketRowView[];
  /** True when more markets exist than lifecycles were read. */
  readonly lifecycleCapped: boolean;
}

export async function loadMarkets(ctx: TradeCtx): Promise<MarketsBundle> {
  const [markets, orders] = await Promise.all([readMarkets(ctx), readOpenOrders(ctx, ORDER_READ_LIMIT)]);
  if (markets.kind !== 'ok') return { markets, orders, views: [], lifecycleCapped: false };
  const rows = markets.data;
  const toRead = rows.slice(0, LIFECYCLE_CAP);
  const lifecycles = await pool(toRead, LIFECYCLE_PARALLEL, (m) => readLifecycle(ctx, m.symbol));
  const tally = orders.kind === 'ok' ? tallyOrders(orders.data) : null;
  const views = rows.map((market, i): MarketRowView => ({
    market,
    lifecycle: (lifecycles[i] as Outcome<LifecycleRow> | undefined) ?? null,
    orders: tally ? (tally.get(market.symbol) ?? { open: 0, seeded: 0, held: 0 }) : null,
  }));
  return { markets, orders, views, lifecycleCapped: rows.length > LIFECYCLE_CAP };
}
