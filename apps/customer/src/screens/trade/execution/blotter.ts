/**
 * The Child orders and fills table as data: orders and fills merged, sourced (scaled by id prefix; algo when a schedule the
 * service read back lists the order among its children, or else only by market, side and time, said as such; manual
 * otherwise), filtered, and written out as the CSV of exactly what is on screen. Pure and React-free.
 */
import type { Trade } from '@intafaced/exchange-contract/schemas';
import type { Order } from '../../../features/trade/trade-api';
import { dec } from '../../../data/decimal';
import { isLive, isScaledId, type Side } from './model';

export type Source = 'scaled' | 'algo' | 'manual';
export type RowState = 'open' | 'partial' | 'recovery' | 'filled' | 'cancelled' | 'expired' | 'rejected' | 'fill';

export interface AlgoWindow {
  symbol: string;
  side: Side;
  fromMs: number;
  toMs: number;
}

export interface BlotterRow {
  id: string;
  kind: 'order' | 'fill';
  time: number;
  symbol: string;
  side: Side;
  type: string;
  price: string | null;
  size: string;
  filled: string | null;
  avg: string | null;
  state: RowState;
  clientOrderId: string | null;
  /** The schedule whose children, as the service lists them, include this row's order; null for any other row. */
  parentId: string | null;
  source: Source;
  /** Algo only by market, side and time: no schedule read back lists this order. */
  byTime: boolean;
  /** Present on a still-working order, so the table can offer Cancel. */
  order: Order | null;
}

function stateOf(order: Order): RowState {
  if (order.status === 'open') {
    if (order.recoveryRequired) return 'recovery';
    return dec(order.filled)! > 0n ? 'partial' : 'open';
  }
  return order.status === 'closed' ? 'filled' : order.status === 'canceled' ? 'cancelled' : order.status;
}

/** A fill whose order is not listed carries no client id, so it counts as algo only when market, side and time fit a schedule. */
export function inAlgoWindow(row: { symbol: string; side: Side; time: number }, windows: readonly AlgoWindow[]): boolean {
  return windows.some((w) => w.symbol === row.symbol && w.side === row.side && row.time >= w.fromMs && row.time <= w.toMs);
}

/** The time span each known schedule could have placed children in (start, to its projected end plus one slice). */
export function algoWindows(
  parents: ReadonlyArray<{ symbol: string; side: Side; createdAt: string; projectedEndsAt: string; sliceIntervalMs: number }>,
): AlgoWindow[] {
  return parents.flatMap((p) => {
    const from = Date.parse(p.createdAt);
    const to = Date.parse(p.projectedEndsAt);
    return Number.isNaN(from) || Number.isNaN(to) ? [] : [{ symbol: p.symbol, side: p.side, fromMs: from, toMs: to + p.sliceIntervalMs }];
  });
}

/** Child order id to its schedule, from the children each schedule's own read lists (never from an id anyone can type). */
export function childParents(parents: ReadonlyArray<{ id: string; children?: ReadonlyArray<{ orderId: string }> | null }>) {
  const map = new Map<string, string>();
  for (const p of parents) for (const c of p.children ?? []) map.set(c.orderId, p.id);
  return map;
}

export function buildBlotter(
  open: readonly Order[],
  closed: readonly Order[],
  fills: readonly Trade[],
  windows: readonly AlgoWindow[],
  childOf: ReadonlyMap<string, string> = new Map(),
): BlotterRow[] {
  const seen = new Set<string>();
  const sourceOf = (
    clientOrderId: string | null,
    parentId: string | null,
    symbol: string,
    side: Side,
    time: number,
  ): { source: Source; byTime: boolean } => {
    if (isScaledId(clientOrderId)) return { source: 'scaled', byTime: false };
    if (parentId !== null) return { source: 'algo', byTime: false };
    if (inAlgoWindow({ symbol, side, time }, windows)) return { source: 'algo', byTime: true };
    return { source: 'manual', byTime: false };
  };
  const orders: BlotterRow[] = [];
  for (const order of [...open, ...closed]) {
    if (seen.has(order.id)) continue;
    seen.add(order.id);
    const parentId = childOf.get(order.id) ?? null;
    orders.push({
      id: `order:${order.id}`,
      kind: 'order',
      time: order.timestamp,
      symbol: order.symbol,
      side: order.side,
      type: order.type,
      price: order.price,
      size: order.amount,
      filled: order.filled,
      avg: order.average,
      state: stateOf(order),
      clientOrderId: order.clientOrderId,
      parentId,
      ...sourceOf(order.clientOrderId, parentId, order.symbol, order.side, order.timestamp),
      order: isLive(order) ? order : null,
    });
  }
  const byOrder = new Map(orders.map((row) => [row.id, row]));
  const fillRows: BlotterRow[] = fills.map((fill) => {
    const parent = fill.order ? byOrder.get(`order:${fill.order}`) : undefined;
    // A fill whose order fell out of the lists is still linked when its schedule lists that order.
    const parentId = parent?.parentId ?? (fill.order ? (childOf.get(fill.order) ?? null) : null);
    return {
      id: `fill:${fill.id}`,
      kind: 'fill',
      time: fill.timestamp,
      symbol: fill.symbol,
      side: fill.side,
      type: fill.type ?? 'fill',
      price: fill.price,
      size: fill.amount,
      filled: fill.amount,
      avg: fill.price,
      state: 'fill',
      clientOrderId: parent?.clientOrderId ?? null,
      parentId,
      ...(parent ? { source: parent.source, byTime: parent.byTime } : sourceOf(null, parentId, fill.symbol, fill.side, fill.timestamp)),
      order: null,
    };
  });
  return [...orders, ...fillRows].sort((a, b) => b.time - a.time);
}

export interface BlotterFilter {
  market: string;
  side: 'all' | Side;
  source: 'all' | Source;
  /** One schedule's children and their fills, or every row. */
  parent: 'all' | string;
}

export function filterBlotter(rows: readonly BlotterRow[], filter: BlotterFilter): BlotterRow[] {
  return rows.filter(
    (r) =>
      (filter.market === 'all' || r.symbol === filter.market) &&
      (filter.side === 'all' || r.side === filter.side) &&
      (filter.source === 'all' || r.source === filter.source) &&
      (filter.parent === 'all' || r.parentId === filter.parent),
  );
}

const CSV_HEAD = ['time_utc', 'kind', 'market', 'side', 'type', 'price', 'size', 'filled', 'avg', 'state', 'source', 'client_order_id'];

/** A text cell that starts with a formula character is prefixed so a spreadsheet reads it as text. */
function cell(value: string | null): string {
  const text = value ?? '';
  const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** CSV of exactly the rows given, amounts as the exact strings the service sent. */
export function blotterCsv(rows: readonly BlotterRow[]): string {
  const lines = rows.map((r) =>
    [
      new Date(r.time).toISOString(),
      r.kind,
      r.symbol,
      r.side,
      r.type,
      r.price,
      r.size,
      r.filled,
      r.avg,
      r.state,
      r.byTime ? 'algo_by_time' : r.source,
      r.clientOrderId,
    ]
      .map((v) => cell(v))
      .join(','),
  );
  return [CSV_HEAD.join(','), ...lines].join('\n');
}
