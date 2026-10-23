/**
 * A listed leader's public page (CB-copy-02, J-copy-bots-otc-01 #4): the operator-published listing, the metric
 * definitions the owner publishes, and the leader's own spot trades.
 *
 * Nothing here is computed into a score or a rank. A metric is shown only with the definition the owner published
 * for it; a metric with no definition, or one the service does not hold, is null with a named reason. The trade
 * table is the leader's real fills on live spot books, paired first-in first-out per market, so a row's entry,
 * close price and ROI come from fills and never from the listing. No order id, fill id or user id leaves this file.
 */

import { createHash } from 'node:crypto';
import { div, formatAmount, mul, parseAmount, sub, type Amount } from '@intafaced/ledger-client';
import type { Sql } from 'postgres';
import { CopyError } from './errors.js';
import { publishedCopyPageLimit, type CopyLeaderCustomerStatus, type LeaderDirectoryRow } from './leader-listing.js';

/** The metrics a lead page lists, in this order. */
export const COPY_LEADER_METRICS = ['publishedReturn', 'maximumDrawdown', 'winRate', 'sharpeRatio'] as const;
export type CopyLeaderMetric = (typeof COPY_LEADER_METRICS)[number];

/** Owner-published wording that says what each metric means. Unpublished: every metric reads "not set". */
export type CopyMetricDefinitions =
  | { readonly published: false }
  | { readonly published: true; readonly version: string; readonly definitions: Partial<Record<CopyLeaderMetric, string>> };

export const UNPUBLISHED_COPY_METRIC_DEFINITIONS: CopyMetricDefinitions = { published: false };

/** `TRADE_COPY_METRIC_DEFINITIONS`. Empty is unpublished. Invalid JSON fails boot rather than show a made-up meaning. */
export function parseCopyMetricDefinitionsJson(raw: string | null | undefined): CopyMetricDefinitions {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return UNPUBLISHED_COPY_METRIC_DEFINITIONS;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new Error('TRADE_COPY_METRIC_DEFINITIONS is not valid JSON');
  }
  if (!parsed || typeof parsed !== 'object') throw new Error('TRADE_COPY_METRIC_DEFINITIONS must be an object');
  const obj = parsed as Record<string, unknown>;
  if (obj.published === false) return UNPUBLISHED_COPY_METRIC_DEFINITIONS;
  if (obj.published !== true) throw new Error('TRADE_COPY_METRIC_DEFINITIONS.published must be true or false');
  if (typeof obj.version !== 'string' || !obj.version.trim()) throw new Error('TRADE_COPY_METRIC_DEFINITIONS.version is blank');
  const raws = obj.definitions;
  if (!raws || typeof raws !== 'object' || Array.isArray(raws)) {
    throw new Error('TRADE_COPY_METRIC_DEFINITIONS.definitions must be an object');
  }
  const definitions: Partial<Record<CopyLeaderMetric, string>> = {};
  for (const [key, text] of Object.entries(raws as Record<string, unknown>)) {
    if (!(COPY_LEADER_METRICS as readonly string[]).includes(key)) {
      throw new Error(`TRADE_COPY_METRIC_DEFINITIONS names an unknown metric: ${key}`);
    }
    if (typeof text !== 'string' || !text.trim()) throw new Error(`TRADE_COPY_METRIC_DEFINITIONS.${key} is blank`);
    definitions[key as CopyLeaderMetric] = text.trim();
  }
  return { published: true, version: obj.version.trim(), definitions };
}

export type LeaderMetric = {
  readonly key: CopyLeaderMetric;
  /** The published figure, or null. */
  readonly value: string | null;
  /** Why value is null: the owner has not defined the metric, the listing publishes no figure, or the service holds none. */
  readonly reason: 'definition_unpublished' | 'no_published_record' | 'not_held' | null;
  readonly definition: string | null;
};

export type LeaderProfile = {
  readonly leader: LeaderDirectoryRow;
  readonly status: CopyLeaderCustomerStatus;
  readonly definitionsVersion: string | null;
  readonly metrics: readonly LeaderMetric[];
};

/** The listing holds return and drawdown. Win rate and Sharpe ratio are held by no one yet, so they are never shown. */
function heldFigure(leader: LeaderDirectoryRow, key: CopyLeaderMetric): string | null | undefined {
  if (key === 'publishedReturn') return leader.publishedReturn.value;
  if (key === 'maximumDrawdown') return leader.maximumDrawdown.value;
  return undefined;
}

export function presentLeaderProfile(
  leader: LeaderDirectoryRow,
  status: CopyLeaderCustomerStatus,
  definitions: CopyMetricDefinitions,
): LeaderProfile {
  const metrics = COPY_LEADER_METRICS.map((key): LeaderMetric => {
    const definition = definitions.published === true ? (definitions.definitions[key] ?? null) : null;
    if (definition === null) return { key, value: null, reason: 'definition_unpublished', definition: null };
    const figure = heldFigure(leader, key);
    if (figure === undefined) return { key, value: null, reason: 'not_held', definition };
    if (figure === null) return { key, value: null, reason: 'no_published_record', definition };
    return { key, value: figure, reason: null, definition };
  });
  return {
    leader,
    status,
    definitionsVersion: definitions.published === true ? definitions.version : null,
    metrics,
  };
}

/** One of the leader's orders with its fills summed. */
export type LeaderOrderFills = {
  readonly orderId: string;
  readonly symbol: string;
  readonly side: 'buy' | 'sell';
  readonly qty: Amount;
  readonly quote: Amount;
  readonly firstAt: Date;
  readonly lastAt: Date;
  readonly takeProfit: Amount | null;
  readonly stopLoss: Amount | null;
};

export type LeaderTrade = {
  /** Unique per row, from the order that opened it (the sell, for a sell with no recorded buy); names no order. */
  readonly tradeId: string;
  readonly symbol: string;
  readonly state: 'open' | 'closed';
  readonly openedAt: string | null;
  readonly closedAt: string | null;
  /** Average buy price. Null when the base was bought before the leader's record starts. */
  readonly entryPrice: string | null;
  readonly qty: string;
  /** Quote paid at entry. Spot has no leverage, so the margin is the whole cost. */
  readonly margin: string | null;
  readonly takeProfit: string | null;
  readonly stopLoss: string | null;
  /** Average sell price of the part already closed. */
  readonly closePrice: string | null;
  readonly closedQty: string;
  /** (close - entry) / entry x 100 on the closed part. Null while nothing is closed or the entry is unknown. */
  readonly roiPercent: string | null;
};

type OpenLot = {
  orderId: string;
  symbol: string;
  openedAt: Date;
  qty: Amount;
  quote: Amount;
  left: Amount;
  closedQty: Amount;
  closedQuote: Amount;
  closedAt: Date | null;
  takeProfit: Amount | null;
  stopLoss: Amount | null;
};

const HUNDRED = parseAmount('100');

/**
 * Pairs buys and sells first-in first-out per market. Input oldest first. A sell that finds no open buy (base bought
 * before the record) becomes its own closed row with no entry. Output newest first, by when the row opened.
 */
export function pairLeaderTrades(orders: readonly LeaderOrderFills[]): LeaderTrade[] {
  const lots: OpenLot[] = [];
  const orphans: { row: LeaderTrade; at: Date }[] = [];
  for (const order of orders) {
    if (order.qty <= 0n) continue;
    if (order.side === 'buy') {
      lots.push({
        orderId: order.orderId,
        symbol: order.symbol,
        openedAt: order.firstAt,
        qty: order.qty,
        quote: order.quote,
        left: order.qty,
        closedQty: 0n,
        closedQuote: 0n,
        closedAt: null,
        takeProfit: order.takeProfit,
        stopLoss: order.stopLoss,
      });
      continue;
    }
    let remaining = order.qty;
    const sellPrice = div(order.quote, order.qty, 'floor');
    for (const lot of lots) {
      if (remaining <= 0n) break;
      if (lot.symbol !== order.symbol || lot.left <= 0n) continue;
      const take = lot.left < remaining ? lot.left : remaining;
      // The last slice of a sell takes what is left of its quote, so the slices add up to the sell exactly.
      const quotePart =
        take === remaining ? sub(order.quote, mul(sellPrice, order.qty - remaining, 'floor')) : mul(sellPrice, take, 'floor');
      lot.left -= take;
      lot.closedQty += take;
      lot.closedQuote += quotePart;
      lot.closedAt = order.lastAt;
      remaining -= take;
    }
    if (remaining > 0n) {
      orphans.push({
        at: order.firstAt,
        row: {
          tradeId: tradeIdOf(order.orderId),
          symbol: order.symbol,
          state: 'closed',
          openedAt: null,
          closedAt: order.lastAt.toISOString(),
          entryPrice: null,
          qty: formatAmount(remaining),
          margin: null,
          takeProfit: null,
          stopLoss: null,
          closePrice: formatAmount(sellPrice),
          closedQty: formatAmount(remaining),
          roiPercent: null,
        },
      });
    }
  }
  const rows = lots.map((lot) => {
    const entry = div(lot.quote, lot.qty, 'floor');
    const close = lot.closedQty > 0n ? div(lot.closedQuote, lot.closedQty, 'floor') : null;
    const roi = close !== null && entry > 0n ? div(mul(sub(close, entry), HUNDRED), entry, 'half-up') : null;
    return {
      at: lot.openedAt,
      row: {
        tradeId: tradeIdOf(lot.orderId),
        symbol: lot.symbol,
        state: lot.left > 0n ? 'open' : 'closed',
        openedAt: lot.openedAt.toISOString(),
        closedAt: lot.left > 0n || lot.closedAt === null ? null : lot.closedAt.toISOString(),
        entryPrice: formatAmount(entry),
        qty: formatAmount(lot.qty),
        margin: formatAmount(lot.quote),
        takeProfit: lot.takeProfit === null ? null : formatAmount(lot.takeProfit),
        stopLoss: lot.stopLoss === null ? null : formatAmount(lot.stopLoss),
        closePrice: close === null ? null : formatAmount(close),
        closedQty: formatAmount(lot.closedQty),
        roiPercent: roi === null ? null : formatAmount(roi),
      } satisfies LeaderTrade,
    };
  });
  return [...rows, ...orphans].sort((a, b) => compareNewestFirst(a.at, a.row.tradeId, b.at, b.row.tradeId)).map((item) => item.row);
}

/** A row id that is stable across reads but is not the order id, which stays inside the service. */
function tradeIdOf(orderId: string): string {
  return createHash('sha256').update(`copy-leader-trade:${orderId}`).digest('hex').slice(0, 24);
}

function compareNewestFirst(aAt: Date, aId: string, bAt: Date, bId: string): number {
  return bAt.getTime() - aAt.getTime() || (aId < bId ? 1 : aId > bId ? -1 : 0);
}

/** How many of the leader's most recent orders the table pairs. Older orders are outside the record shown. */
export const LEADER_TRADE_ORDERS_MAX = 2000;

export type LeaderTradesPage = { readonly trades: readonly LeaderTrade[]; readonly nextCursor: string | null };

/** Where the next page starts: just after this row in newest-first order. */
export type LeaderTradesCursor = { readonly at: Date; readonly tradeId: string } | null;

const CURSOR = /^(\d{1,15})\.([0-9a-f]{24})$/;

function rowAt(trade: LeaderTrade): Date {
  return new Date((trade.openedAt ?? trade.closedAt)!);
}

/**
 * The cursor names the last row a page showed (its time and order), not a position, so a trade the leader opens
 * between two pages lands on the first page and never shifts a row onto the next one twice.
 */
export function decodeLeaderTradesCursor(cursor: string | null | undefined): LeaderTradesCursor {
  if (cursor === undefined || cursor === null || cursor === '') return null;
  const match = CURSOR.exec(cursor);
  if (!match) throw new CopyError('leaderTrades cursor is not valid', 'trade.copy_leader_trades_cursor_invalid');
  return { at: new Date(Number(match[1])), tradeId: match[2]! };
}

export function pageLeaderTrades(trades: readonly LeaderTrade[], after: LeaderTradesCursor, limit: number): LeaderTradesPage {
  const rest =
    after === null ? trades : trades.filter((trade) => compareNewestFirst(rowAt(trade), trade.tradeId, after.at, after.tradeId) > 0);
  const page = rest.slice(0, limit);
  const last = page[page.length - 1];
  return {
    trades: page,
    nextCursor: rest.length > limit && last ? `${rowAt(last).getTime()}.${last.tradeId}` : null,
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The leader's most recent orders on live spot books, oldest first, each with its fills summed and its bracket. */
export async function readLeaderOrderFills(sql: Sql, leaderUserId: string): Promise<LeaderOrderFills[]> {
  if (!UUID.test(leaderUserId)) return [];
  const rows = await sql<
    Array<{
      order_id: string;
      symbol: string;
      side: 'buy' | 'sell';
      qty: string;
      quote: string;
      first_at: Date;
      last_at: Date;
      take_profit: string | null;
      stop_loss: string | null;
    }>
  >`
    SELECT o.order_id, o.symbol, o.side, o.qty, o.quote, o.first_at, o.last_at,
           b.take_profit::text AS take_profit, b.stop_loss::text AS stop_loss
      FROM (
        SELECT f.order_id, m.symbol, f.side::text AS side,
               sum(f.qty)::text AS qty, sum(f.quote_amount)::text AS quote,
               min(f.ts) AS first_at, max(f.ts) AS last_at
          FROM trade.fills f
          JOIN trade.markets m ON m.id = f.market_id
         WHERE f.user_id = ${leaderUserId}::uuid
           AND m.kind = 'spot'
           AND m.paper = false
         GROUP BY f.order_id, m.symbol, f.side
         ORDER BY min(f.ts) DESC, f.order_id DESC
         LIMIT ${LEADER_TRADE_ORDERS_MAX}
      ) o
      LEFT JOIN trade.order_bracket_intent b ON b.order_id = o.order_id
     ORDER BY o.first_at ASC, o.order_id ASC
  `;
  return rows
    .filter((row) => row.side === 'buy' || row.side === 'sell')
    .map((row) => ({
      orderId: row.order_id,
      symbol: row.symbol,
      side: row.side,
      qty: parseAmount(row.qty),
      quote: parseAmount(row.quote),
      firstAt: row.first_at instanceof Date ? row.first_at : new Date(row.first_at),
      lastAt: row.last_at instanceof Date ? row.last_at : new Date(row.last_at),
      takeProfit: row.take_profit === null ? null : parseAmount(row.take_profit),
      stopLoss: row.stop_loss === null ? null : parseAmount(row.stop_loss),
    }));
}

export function leaderTradesLimit(value: number | undefined | null): number {
  return publishedCopyPageLimit(value, 'trade.copy_leader_trades_limit_unset', 'leaderTrades');
}
