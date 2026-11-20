import { formatAmount, parseAmount, type Amount } from '@intafaced/ledger-client';
import type { Sql } from 'postgres';
import { z } from 'zod';
import type { GridLevelPlan } from './plan.js';

/**
 * The venue grid's own rows (venue-grid.ts; drizzle/20261120090000_venue_grid_bots.sql). Nothing here is a balance: the
 * person's coins, their locks and every fill are the venue's record, read from it. A bot row says what the bot is and
 * which venue account it trades; an order row names one venue order by its business key, and keeps what the bot read
 * of it from the venue (its state, what it filled, the fees the venue charged), so the pair it closes can be shown.
 */

/**
 * signing: made, waiting for the person's wallet to sign the grid agent permission; nothing placed.
 * initializing: the permission is on the venue and the first buys are being placed.
 * running / paused_range: as the grid on our book (types.ts); paused_range places no new buy.
 * stopped: the person stopped it, or the platform halted it; `statusReason` says which. Nothing new is placed.
 */
export type VenueGridStatus = 'signing' | 'initializing' | 'running' | 'paused_range' | 'stopped';

export interface VenueGridBot {
  readonly botId: string;
  readonly userId: string;
  readonly clientRequestId: string;
  readonly requestHash: string;
  readonly venueId: string;
  /** The person's own venue account (their wallet): the only account the bot's orders rest on. */
  readonly owner: string;
  /** The grid agent key's address, which the person's wallet approves on that account. */
  readonly agentAddress: string;
  readonly region: string;
  readonly symbol: string;
  readonly baseAsset: string;
  readonly quoteAsset: string;
  readonly lowerPrice: Amount;
  readonly upperPrice: Amount;
  readonly gridCount: number;
  /** The bot's cap: the most of the quote its open buys may hold together. Checked before the agent key signs a level. */
  readonly investment: Amount;
  readonly levels: readonly GridLevelPlan[];
  readonly status: VenueGridStatus;
  readonly statusReason: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export type VenueGridOrderStatus = 'open' | 'filled' | 'partial' | 'cancelled' | 'refused';

export interface VenueGridOrder {
  /** `grid:<botId>:<level>:b<cycle>` or `:s<cycle>`: the door's business key, so the venue's client order id derives from it. */
  readonly orderKey: string;
  readonly botId: string;
  readonly levelIndex: number;
  readonly side: 'buy' | 'sell';
  readonly cycle: number;
  readonly price: Amount;
  readonly qty: Amount;
  readonly status: VenueGridOrderStatus;
  /** What the venue reports filled, net of nothing. */
  readonly filled: Amount;
  /** The fees the venue charged on this order's fills, each in its fee asset: its own and our builder fee. */
  readonly venueFee: Amount;
  readonly builderFee: Amount;
  readonly feeAsset: string | null;
  /** On a filled sell: its quote less fees, less the cost of the base it sold from the buy below it (fees included). */
  readonly pairProfit: Amount | null;
  readonly placedAt: Date;
  readonly closedAt: Date | null;
}

/** One status move: to `status` (with its reason) at `at`, only from one of `from`. */
export interface StatusMove {
  readonly botId: string;
  readonly status: VenueGridStatus;
  readonly reason: string | null;
  readonly at: Date;
  readonly from: readonly VenueGridStatus[];
}

export interface VenueGridStore {
  /** Saves `bot` unless its id exists; answers the stored one. */
  insertOnce(bot: VenueGridBot): Promise<{ bot: VenueGridBot; created: boolean }>;
  find(botId: string): Promise<VenueGridBot | null>;
  listForUser(userId: string): Promise<readonly VenueGridBot[]>;
  /** Every bot that may still have something to do: signing excluded (it waits for the person), stopped excluded. */
  live(): Promise<readonly VenueGridBot[]>;
  /** Moves the status only from one of `from`; false when the bot was in another. */
  setStatus(move: StatusMove): Promise<boolean>;
  orders(botId: string): Promise<readonly VenueGridOrder[]>;
  /** Writes the order row unless its key exists; answers the stored one. */
  insertOrder(order: VenueGridOrder): Promise<VenueGridOrder>;
  updateOrder(order: VenueGridOrder): Promise<void>;
}

export class InMemoryVenueGridStore implements VenueGridStore {
  private readonly bots = new Map<string, VenueGridBot>();
  private readonly rows = new Map<string, VenueGridOrder>();

  async insertOnce(bot: VenueGridBot) {
    const had = this.bots.get(bot.botId);
    if (had) return { bot: had, created: false };
    this.bots.set(bot.botId, bot);
    return { bot, created: true };
  }
  async find(botId: string) {
    return this.bots.get(botId) ?? null;
  }
  async listForUser(userId: string) {
    return [...this.bots.values()].filter((b) => b.userId === userId).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }
  async live() {
    return [...this.bots.values()].filter((b) => b.status !== 'signing' && b.status !== 'stopped');
  }
  async setStatus({ botId, status, reason, at, from }: StatusMove) {
    const bot = this.bots.get(botId);
    if (!bot || !from.includes(bot.status)) return false;
    this.bots.set(botId, { ...bot, status, statusReason: reason, updatedAt: at });
    return true;
  }
  async orders(botId: string) {
    return [...this.rows.values()].filter((o) => o.botId === botId).sort((a, b) => a.placedAt.getTime() - b.placedAt.getTime());
  }
  async insertOrder(order: VenueGridOrder) {
    const had = this.rows.get(order.orderKey);
    if (had) return had;
    this.rows.set(order.orderKey, order);
    return order;
  }
  async updateOrder(order: VenueGridOrder) {
    this.rows.set(order.orderKey, order);
  }
}

const STATUS = z.enum(['signing', 'initializing', 'running', 'paused_range', 'stopped']);
const ORDER_STATUS = z.enum(['open', 'filled', 'partial', 'cancelled', 'refused']);
const LEVEL = z.object({ index: z.number().int(), price: z.string(), qty: z.string(), hold: z.string() });
const when = z.union([z.date(), z.string()]).transform((d) => (d instanceof Date ? d : new Date(d)));

/** A `trade.venue_grid_bots` row as it is read, checked here so a column that changed fails at the read. */
const BotRow = z.object({
  bot_id: z.string(),
  user_id: z.string(),
  client_request_id: z.string(),
  request_hash: z.string(),
  venue_id: z.string(),
  owner: z.string(),
  agent_address: z.string(),
  region: z.string(),
  symbol: z.string(),
  base_asset: z.string(),
  quote_asset: z.string(),
  lower_price: z.string(),
  upper_price: z.string(),
  grid_count: z.number().int(),
  investment: z.string(),
  // jsonb comes back parsed, or as its text when the driver is not told it is json.
  levels: z.union([z.array(LEVEL), z.string().transform((text) => z.array(LEVEL).parse(JSON.parse(text)))]),
  status: STATUS,
  status_reason: z.string().nullable(),
  created_at: when,
  updated_at: when,
});
type BotRow = z.infer<typeof BotRow>;

/** A `trade.venue_grid_orders` row as it is read. */
const OrderRow = z.object({
  order_key: z.string(),
  bot_id: z.string(),
  level_index: z.number().int(),
  side: z.enum(['buy', 'sell']),
  cycle: z.number().int(),
  price: z.string(),
  qty: z.string(),
  status: ORDER_STATUS,
  filled: z.string(),
  venue_fee: z.string(),
  builder_fee: z.string(),
  fee_asset: z.string().nullable(),
  pair_profit: z.string().nullable(),
  placed_at: when,
  closed_at: when.nullable(),
});
type OrderRow = z.infer<typeof OrderRow>;

const BOT_COLUMNS = `bot_id, user_id, client_request_id, request_hash, venue_id, owner, agent_address, region, symbol, base_asset,
  quote_asset, lower_price::text AS lower_price, upper_price::text AS upper_price, grid_count, investment::text AS investment,
  levels, status, status_reason, created_at, updated_at`;
const ORDER_COLUMNS = `order_key, bot_id, level_index, side, cycle, price::text AS price, qty::text AS qty, status,
  filled::text AS filled, venue_fee::text AS venue_fee, builder_fee::text AS builder_fee, fee_asset,
  pair_profit::text AS pair_profit, placed_at, closed_at`;

function botOf(r: BotRow): VenueGridBot {
  return {
    botId: r.bot_id,
    userId: r.user_id,
    clientRequestId: r.client_request_id,
    requestHash: r.request_hash,
    venueId: r.venue_id,
    owner: r.owner,
    agentAddress: r.agent_address,
    region: r.region,
    symbol: r.symbol,
    baseAsset: r.base_asset,
    quoteAsset: r.quote_asset,
    lowerPrice: parseAmount(r.lower_price),
    upperPrice: parseAmount(r.upper_price),
    gridCount: r.grid_count,
    investment: parseAmount(r.investment),
    levels: r.levels.map((l) => ({ index: l.index, price: parseAmount(l.price), qty: parseAmount(l.qty), hold: parseAmount(l.hold) })),
    status: r.status,
    statusReason: r.status_reason,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function orderOf(r: OrderRow): VenueGridOrder {
  return {
    orderKey: r.order_key,
    botId: r.bot_id,
    levelIndex: r.level_index,
    side: r.side,
    cycle: r.cycle,
    price: parseAmount(r.price),
    qty: parseAmount(r.qty),
    status: r.status,
    filled: parseAmount(r.filled),
    venueFee: parseAmount(r.venue_fee),
    builderFee: parseAmount(r.builder_fee),
    feeAsset: r.fee_asset,
    pairProfit: r.pair_profit === null ? null : parseAmount(r.pair_profit),
    placedAt: r.placed_at,
    closedAt: r.closed_at,
  };
}

/** `trade.venue_grid_bots` and `trade.venue_grid_orders`. */
export class SqlVenueGridStore implements VenueGridStore {
  constructor(private readonly sql: Sql) {}

  async insertOnce(b: VenueGridBot) {
    const levels = b.levels.map((l) => ({
      index: l.index,
      price: formatAmount(l.price),
      qty: formatAmount(l.qty),
      hold: formatAmount(l.hold),
    }));
    // bot_id is derived from (user_id, client_request_id) (gridBotIdFor), so both keys name the same row: no target.
    const inserted = await this.sql`
      INSERT INTO trade.venue_grid_bots (bot_id, user_id, client_request_id, request_hash, venue_id, owner, agent_address, region,
        symbol, base_asset, quote_asset, lower_price, upper_price, grid_count, investment, levels, status, status_reason,
        created_at, updated_at)
      VALUES (${b.botId}, ${b.userId}, ${b.clientRequestId}, ${b.requestHash}, ${b.venueId}, ${b.owner}, ${b.agentAddress},
        ${b.region}, ${b.symbol}, ${b.baseAsset}, ${b.quoteAsset}, ${formatAmount(b.lowerPrice)}, ${formatAmount(b.upperPrice)},
        ${b.gridCount}, ${formatAmount(b.investment)}, ${this.sql.json(levels)}, ${b.status}, ${b.statusReason}, ${b.createdAt},
        ${b.updatedAt})
      ON CONFLICT DO NOTHING
      RETURNING bot_id`;
    const stored = await this.find(b.botId);
    if (!stored) throw new Error(`venue grid ${b.botId} was not stored`);
    return { bot: stored, created: inserted.length === 1 };
  }

  async find(botId: string) {
    const [row] = BotRow.array().parse(
      await this.sql`SELECT ${this.sql.unsafe(BOT_COLUMNS)} FROM trade.venue_grid_bots WHERE bot_id = ${botId}`,
    );
    return row ? botOf(row) : null;
  }

  async listForUser(userId: string) {
    const rows = BotRow.array().parse(
      await this.sql`SELECT ${this.sql.unsafe(BOT_COLUMNS)} FROM trade.venue_grid_bots WHERE user_id = ${userId} ORDER BY created_at DESC`,
    );
    return rows.map(botOf);
  }

  async live() {
    const rows = BotRow.array().parse(
      await this
        .sql`SELECT ${this.sql.unsafe(BOT_COLUMNS)} FROM trade.venue_grid_bots WHERE status IN ('initializing', 'running', 'paused_range')`,
    );
    return rows.map(botOf);
  }

  async setStatus({ botId, status, reason, at, from }: StatusMove) {
    const moved = await this.sql`
      UPDATE trade.venue_grid_bots SET status = ${status}, status_reason = ${reason}, updated_at = ${at}
      WHERE bot_id = ${botId} AND status = ANY(${this.sql.array([...from])})`;
    return moved.count === 1;
  }

  async orders(botId: string) {
    const rows = OrderRow.array().parse(
      await this
        .sql`SELECT ${this.sql.unsafe(ORDER_COLUMNS)} FROM trade.venue_grid_orders WHERE bot_id = ${botId} ORDER BY placed_at, order_key`,
    );
    return rows.map(orderOf);
  }

  async insertOrder(o: VenueGridOrder) {
    // order_key is derived from (bot_id, level_index, side, cycle) (gridClientOrderId), so both keys name the same row.
    await this.sql`
      INSERT INTO trade.venue_grid_orders (order_key, bot_id, level_index, side, cycle, price, qty, status, filled, venue_fee,
        builder_fee, fee_asset, pair_profit, placed_at, closed_at)
      VALUES (${o.orderKey}, ${o.botId}, ${o.levelIndex}, ${o.side}, ${o.cycle}, ${formatAmount(o.price)}, ${formatAmount(o.qty)},
        ${o.status}, ${formatAmount(o.filled)}, ${formatAmount(o.venueFee)}, ${formatAmount(o.builderFee)}, ${o.feeAsset},
        ${o.pairProfit === null ? null : formatAmount(o.pairProfit)}, ${o.placedAt}, ${o.closedAt})
      ON CONFLICT DO NOTHING`;
    const [row] = OrderRow.array().parse(
      await this.sql`SELECT ${this.sql.unsafe(ORDER_COLUMNS)} FROM trade.venue_grid_orders WHERE order_key = ${o.orderKey}`,
    );
    if (!row) throw new Error(`venue grid order ${o.orderKey} was not stored`);
    return orderOf(row);
  }

  async updateOrder(o: VenueGridOrder) {
    await this.sql`
      UPDATE trade.venue_grid_orders SET status = ${o.status}, filled = ${formatAmount(o.filled)},
        venue_fee = ${formatAmount(o.venueFee)}, builder_fee = ${formatAmount(o.builderFee)}, fee_asset = ${o.feeAsset},
        pair_profit = ${o.pairProfit === null ? null : formatAmount(o.pairProfit)}, closed_at = ${o.closedAt}
      WHERE order_key = ${o.orderKey}`;
  }
}
