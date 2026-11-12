/**
 * Copied positions (CB-copy-09/10): each copied buy of one follow, with how much of it is still open.
 *
 * A position is one copied buy (`copy_placed_mirrors`, side buy) and holds the coin its fills left the follower, net of
 * a fee taken in the coin. Sells come off it in this order: first the follower's own closes of that position
 * (`copy_close_orders`, keyed on the copied buy's leader fill), then every sell that names no position, oldest
 * position first: the leader's copied sells and a flatten of the whole follow. A sell still on the book counts as
 * closing; a close whose order is not on the book yet counts as closing too (its outcome is not known). What is left
 * is floored to the market's lot, since less than one lot cannot be sold.
 *
 * Read only from this service's own spot tables. Never a book price, never a balance.
 */
import { div, formatAmount, parseAmount, type Amount } from '@intafaced/ledger-client';
import type { Sql } from 'postgres';
import { copyFlattenClientOrderId } from './follower-flatten-port.js';

export type CopiedPositionStatus = 'buying' | 'open' | 'closing' | 'closed';

export type CopiedBuy = {
  /** The follower's buy order id: the position's handle on the wire. */
  readonly orderId: string;
  readonly leaderFillId: string;
  readonly symbol: string;
  readonly marketId: string;
  readonly baseAsset: string;
  readonly lotSize: Amount;
  /** Coin the buy's fills left the follower. */
  readonly received: Amount;
  /** The buy order can still fill. */
  readonly live: boolean;
  readonly placedAt: Date;
  /** Gross base filled and quote paid across the buy's fills, and how many fills: the entry. Omitted → none. */
  readonly entryQty?: Amount;
  readonly entryCost?: Amount;
  readonly fills?: number;
};

/** One sell's effect: what it sold, and what it still holds on the book (or may yet sell). */
export type CopiedSell = { readonly sold: Amount; readonly pending: Amount };

export type CopiedPosition = {
  readonly orderId: string;
  readonly leaderFillId: string;
  readonly symbol: string;
  readonly marketId: string;
  readonly baseAsset: string;
  readonly lotSize: Amount;
  readonly bought: Amount;
  /** Sellable now: lot-floored, never below zero. */
  readonly open: Amount;
  readonly closing: Amount;
  readonly status: CopiedPositionStatus;
  readonly placedAt: Date;
  /** The buy's fills: base filled, quote paid and how many. Absent when the reader does not know them. */
  readonly entryQty?: Amount;
  readonly entryCost?: Amount;
  readonly fills?: number;
};

export type CopiedPositionInputs = {
  readonly buys: readonly CopiedBuy[];
  /** Closes of one position, by that position's leader fill id. */
  readonly targeted: ReadonlyMap<string, readonly CopiedSell[]>;
  /** Sells that name no position, by market symbol. */
  readonly untargeted: ReadonlyMap<string, readonly CopiedSell[]>;
};

/** Pure: the allocation the module comment describes. Newest position first. */
export function allocateCopiedPositions(input: CopiedPositionInputs): CopiedPosition[] {
  type Work = { buy: CopiedBuy; held: Amount; closing: Amount };
  const work: Work[] = input.buys.map((buy) => {
    let held = buy.received;
    let closing = 0n;
    for (const sell of input.targeted.get(buy.leaderFillId) ?? []) {
      held -= sell.sold;
      closing += sell.pending;
    }
    return { buy, held: held < 0n ? 0n : held, closing };
  });

  const oldestFirst = [...work].sort((a, b) => a.buy.placedAt.getTime() - b.buy.placedAt.getTime() || cmp(a.buy.orderId, b.buy.orderId));
  for (const [symbol, sells] of input.untargeted) {
    let sold = 0n;
    let pending = 0n;
    for (const sell of sells) {
      sold += sell.sold;
      pending += sell.pending;
    }
    for (const item of oldestFirst) {
      if (item.buy.symbol !== symbol) continue;
      const take = minAmount(sold, free(item));
      item.held -= take;
      sold -= take;
      const hold = minAmount(pending, free(item));
      item.closing += hold;
      pending -= hold;
    }
  }

  const out = work.map(({ buy, held, closing }): CopiedPosition => {
    const sellable = free({ held, closing });
    const open = floorToLot(sellable, buy.lotSize);
    const status: CopiedPositionStatus =
      buy.received === 0n && buy.live ? 'buying' : closing > 0n && held > 0n ? 'closing' : open > 0n ? 'open' : 'closed';
    return {
      orderId: buy.orderId,
      leaderFillId: buy.leaderFillId,
      symbol: buy.symbol,
      marketId: buy.marketId,
      baseAsset: buy.baseAsset,
      lotSize: buy.lotSize,
      bought: buy.received,
      open,
      closing: minAmount(closing, held),
      status,
      placedAt: buy.placedAt,
      ...(buy.entryQty === undefined || buy.entryCost === undefined || buy.fills === undefined
        ? {}
        : { entryQty: buy.entryQty, entryCost: buy.entryCost, fills: buy.fills }),
    };
  });
  return out.sort((a, b) => b.placedAt.getTime() - a.placedAt.getTime() || cmp(b.orderId, a.orderId));
}

/** Sellable copied coin in one market across a follow's open positions: the most a leader close may copy. */
export function sellableInMarket(positions: readonly CopiedPosition[], symbol: string): Amount {
  let total = 0n;
  for (const position of positions) if (position.symbol === symbol) total += position.open;
  return total;
}

export type ReadCopiedPositions = (input: { followId: string; followerId: string }) => Promise<CopiedPosition[]>;

const LIVE_ORDER = ['pending', 'open', 'recovery_required', 'hold_unknown'];

type BuyRow = {
  order_id: string;
  leader_fill_id: string;
  symbol: string;
  market_id: string;
  base_asset: string;
  lot_size: string;
  status: string;
  created_at: Date;
  received: string;
  entry_qty: string;
  entry_cost: string;
  fills: number;
};

type SellRow = { key: string; qty: string; filled_qty: string; status: string | null };

/** The SQL reader over this service's spot tables. */
export function sqlCopiedPositions(sql: Sql): ReadCopiedPositions {
  return async ({ followId, followerId }) => {
    const buys = await sql<BuyRow[]>`
      SELECT o.id::text AS order_id, pm.fill_id AS leader_fill_id, m.symbol, m.id::text AS market_id, m.base_asset,
             m.lot_size::text AS lot_size, o.status::text AS status, pm.created_at,
             coalesce(sum(CASE WHEN f.fee_asset = m.base_asset THEN f.qty - f.fee_amount ELSE f.qty END), 0)::text AS received,
             coalesce(sum(f.qty), 0)::text AS entry_qty, coalesce(sum(f.quote_amount), 0)::text AS entry_cost,
             count(f.id)::int AS fills
        FROM trade.copy_placed_mirrors pm
        INNER JOIN trade.orders o ON o.id::text = pm.order_id AND o.user_id = ${followerId}::uuid AND o.side = 'buy'
        INNER JOIN trade.markets m ON m.id = o.market_id
        LEFT JOIN trade.fills f ON f.order_id = o.id AND f.user_id = ${followerId}::uuid
       WHERE pm.follow_id = ${followId}
       GROUP BY o.id, pm.fill_id, m.symbol, m.id, m.base_asset, m.lot_size, o.status, pm.created_at
    `;
    const symbols = [...new Set(buys.map((row) => row.symbol))];
    const flattenIds = symbols.map((symbol) => copyFlattenClientOrderId(followId, symbol));

    const untargetedRows = await sql<SellRow[]>`
      SELECT m.symbol AS key, o.qty::text AS qty, o.filled_qty::text AS filled_qty, o.status::text AS status
        FROM trade.orders o
        INNER JOIN trade.markets m ON m.id = o.market_id
       WHERE o.user_id = ${followerId}::uuid
         AND o.side = 'sell'
         AND (o.id::text IN (SELECT pm.order_id FROM trade.copy_placed_mirrors pm WHERE pm.follow_id = ${followId})
              OR o.client_order_id IN ${sql(flattenIds.length > 0 ? flattenIds : [''])})
    `;
    const targetedRows = await sql<SellRow[]>`
      SELECT c.leader_fill_id AS key, c.qty::text AS qty, coalesce(o.filled_qty, 0)::text AS filled_qty, o.status::text AS status
        FROM trade.copy_close_orders c
        LEFT JOIN trade.orders o ON o.id = c.follower_order_id::uuid AND o.user_id = ${followerId}::uuid
       WHERE c.follow_id = ${followId}
    `;

    return allocateCopiedPositions({
      buys: buys.map((row) => ({
        orderId: row.order_id,
        leaderFillId: row.leader_fill_id,
        symbol: row.symbol,
        marketId: row.market_id,
        baseAsset: row.base_asset,
        lotSize: parseAmount(row.lot_size),
        received: parseAmount(row.received),
        live: LIVE_ORDER.includes(row.status),
        placedAt: row.created_at instanceof Date ? row.created_at : new Date(row.created_at),
        entryQty: parseAmount(row.entry_qty),
        entryCost: parseAmount(row.entry_cost),
        fills: Number(row.fills),
      })),
      targeted: groupSells(targetedRows),
      untargeted: groupSells(untargetedRows),
    });
  };
}

/** A sell row's effect. No order yet (`status` null): its whole quantity may still sell. */
export function sellEffect(row: { qty: string; filled_qty: string; status: string | null }): CopiedSell {
  const qty = parseAmount(row.qty);
  const filled = parseAmount(row.filled_qty);
  if (row.status === null) return { sold: 0n, pending: qty };
  return { sold: filled, pending: LIVE_ORDER.includes(row.status) ? qty - filled : 0n };
}

function groupSells(rows: readonly SellRow[]): Map<string, CopiedSell[]> {
  const out = new Map<string, CopiedSell[]>();
  for (const row of rows) {
    const list = out.get(row.key) ?? [];
    list.push(sellEffect(row));
    out.set(row.key, list);
  }
  return out;
}

function free(item: { held: Amount; closing: Amount }): Amount {
  const left = item.held - item.closing;
  return left < 0n ? 0n : left;
}

function floorToLot(qty: Amount, lot: Amount): Amount {
  if (lot <= 0n) return qty;
  return (qty / lot) * lot;
}

function minAmount(a: Amount, b: Amount): Amount {
  return a < b ? a : b;
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Wire form of one position row. */
export function copiedPositionWire(position: CopiedPosition) {
  return {
    positionId: position.orderId,
    market: position.symbol,
    bought: formatAmount(position.bought),
    open: formatAmount(position.open),
    closing: formatAmount(position.closing),
    status: position.status,
    placedAt: position.placedAt.toISOString(),
  };
}

/**
 * One market's copied position, by average entry (J-copy-bots-otc-06 #2; CB-copy-pro-share-01): every copied buy's fills
 * in that market, the average entry price (quote paid over base filled, so sells never move it) and what is open.
 * Funding is null: a spot position has no funding data, and the screen says "Not set". No fills, or any position in the
 * market whose fills are not known → average entry and fills null, never a guess from part of them.
 */
export function copiedMarketPositions(positions: readonly CopiedPosition[]) {
  const by = new Map<string, { fills: number; qty: Amount; cost: Amount; open: Amount; known: boolean }>();
  for (const p of positions) {
    const cur = by.get(p.symbol) ?? { fills: 0, qty: 0n, cost: 0n, open: 0n, known: true };
    if (p.entryQty === undefined || p.entryCost === undefined || p.fills === undefined) cur.known = false;
    else {
      cur.fills += p.fills;
      cur.qty += p.entryQty;
      cur.cost += p.entryCost;
    }
    cur.open += p.open;
    by.set(p.symbol, cur);
  }
  return [...by.entries()]
    .sort(([a], [b]) => cmp(a, b))
    .map(([market, m]) => ({
      market,
      fills: m.known ? m.fills : null,
      filled: m.known ? formatAmount(m.qty) : null,
      open: formatAmount(m.open),
      averageEntry: m.known && m.qty > 0n ? formatAmount(div(m.cost, m.qty, 'half-up')) : null,
      funding: null,
    }));
}
