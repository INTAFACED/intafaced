import type { Sql } from 'postgres';
import { formatAmount, parseAmount, type Amount } from '@intafaced/ledger-client';
import { parseAlgoPlaceGrant } from '../algo/durable-principal.js';
import type { GridLevelPlan } from './plan.js';
import type { GridBot, GridOrder, GridReserve, GridStatus } from './types.js';

export interface GridStore {
  findBot(botId: string): Promise<GridBot | null>;
  listBots(userId: string): Promise<GridBot[]>;
  /** Bots the tick drives: running or paused on range. */
  listLiveBots(): Promise<GridBot[]>;
  /**
   * Write the bot and its reserve together. `check` runs first, under the owner's reserve lock for the asset and inside
   * the same transaction, so two creates cannot both fit the same balance. A bot id already present writes nothing and
   * answers `created: false` with the stored bot.
   */
  createWithReserve(
    bot: GridBot,
    reserve: GridReserve,
    check: (unused: Amount) => Promise<void>,
  ): Promise<{ created: boolean; bot: GridBot }>;
  setStatus(botId: string, status: GridStatus, reason: string | null, at: Date): Promise<void>;
  getReserve(botId: string): Promise<GridReserve | null>;
  releaseReserve(botId: string, at: Date): Promise<void>;
  /** Unreleased grid reserves of one owner and asset, less what each bot's open buys already hold. */
  sumUnusedReserves(userId: string, asset: string): Promise<Amount>;
  /** Insert once by clientOrderId; a second save of the same key keeps the first row. */
  saveOrder(order: GridOrder): Promise<GridOrder>;
  closeOrder(clientOrderId: string, status: 'filled' | 'cancelled', pairProfit: Amount | null, at: Date): Promise<void>;
  listOrders(botId: string): Promise<GridOrder[]>;
}

/** Same advisory key copy follows lock (copy/follow-store.ts), so a grid create and a follow create serialise. */
export const reserveLockKey = (userId: string, asset: string): string => `copy.reserve:${userId}:${asset}`;

function unusedOf(reserve: GridReserve, orders: readonly GridOrder[]): Amount {
  const held = orders.filter((o) => o.side === 'buy' && o.status === 'open').reduce((acc, o) => acc + o.holdAmount, 0n);
  const unused = reserve.amount - held;
  return unused > 0n ? unused : 0n;
}

export class MemoryGridStore implements GridStore {
  private readonly bots = new Map<string, GridBot>();
  private readonly reserves = new Map<string, GridReserve>();
  private readonly orders = new Map<string, GridOrder>();

  async findBot(botId: string) {
    return this.bots.get(botId) ?? null;
  }
  async listBots(userId: string) {
    return [...this.bots.values()].filter((b) => b.userId === userId).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }
  async listLiveBots() {
    return [...this.bots.values()].filter((b) => b.status === 'running' || b.status === 'paused_range');
  }
  async createWithReserve(bot: GridBot, reserve: GridReserve, check: (unused: Amount) => Promise<void>) {
    const existing = this.bots.get(bot.botId);
    if (existing) return { created: false, bot: existing };
    await check(await this.sumUnusedReserves(bot.userId, reserve.asset));
    this.bots.set(bot.botId, bot);
    this.reserves.set(bot.botId, reserve);
    return { created: true, bot };
  }
  async setStatus(botId: string, status: GridStatus, reason: string | null, at: Date) {
    const bot = this.bots.get(botId);
    if (bot) this.bots.set(botId, { ...bot, status, statusReason: reason, updatedAt: at });
  }
  async getReserve(botId: string) {
    return this.reserves.get(botId) ?? null;
  }
  async releaseReserve(botId: string, at: Date) {
    const r = this.reserves.get(botId);
    if (r && r.releasedAt === null) this.reserves.set(botId, { ...r, releasedAt: at });
  }
  async sumUnusedReserves(userId: string, asset: string) {
    let total = 0n;
    for (const r of this.reserves.values()) {
      if (r.userId !== userId || r.asset !== asset || r.releasedAt !== null) continue;
      total += unusedOf(r, await this.listOrders(r.botId));
    }
    return total;
  }
  async saveOrder(order: GridOrder) {
    const existing = this.orders.get(order.clientOrderId);
    if (existing) return existing;
    this.orders.set(order.clientOrderId, order);
    return order;
  }
  async closeOrder(clientOrderId: string, status: 'filled' | 'cancelled', pairProfit: Amount | null, at: Date) {
    const o = this.orders.get(clientOrderId);
    if (o && o.status === 'open') this.orders.set(clientOrderId, { ...o, status, pairProfit, closedAt: at });
  }
  async listOrders(botId: string) {
    return [...this.orders.values()]
      .filter((o) => o.botId === botId)
      .sort((a, b) => a.levelIndex - b.levelIndex || a.cycle - b.cycle || a.side.localeCompare(b.side));
  }
}

interface BotRow {
  bot_id: string;
  user_id: string;
  client_request_id: string;
  request_hash: string;
  market_id: string;
  symbol: string;
  base_asset: string;
  quote_asset: string;
  lower_price: string;
  upper_price: string;
  grid_count: number;
  investment: string;
  levels: unknown;
  status: GridStatus;
  status_reason: string | null;
  place_grant: unknown;
  created_at: Date;
  updated_at: Date;
}

interface ReserveRow {
  reserve_key: string;
  bot_id: string;
  user_id: string;
  asset: string;
  amount: string;
  held_at: Date;
  released_at: Date | null;
}

interface OrderRow {
  client_order_id: string;
  bot_id: string;
  level_index: number;
  side: 'buy' | 'sell';
  cycle: number;
  order_id: string;
  price: string;
  qty: string;
  hold_amount: string;
  status: GridOrder['status'];
  pair_profit: string | null;
  placed_at: Date;
  closed_at: Date | null;
}

function levelsFromJson(botId: string, raw: unknown): GridLevelPlan[] {
  if (!Array.isArray(raw)) throw new Error(`grid bot ${botId} has no readable level plan`);
  return raw.map((l: { index: number; price: string; qty: string; hold: string }) => ({
    index: l.index,
    price: parseAmount(l.price),
    qty: parseAmount(l.qty),
    hold: parseAmount(l.hold),
  }));
}

const levelsToJson = (levels: readonly GridLevelPlan[]) =>
  levels.map((l) => ({ index: l.index, price: formatAmount(l.price), qty: formatAmount(l.qty), hold: formatAmount(l.hold) }));

function botFromRow(row: BotRow): GridBot {
  const grant = parseAlgoPlaceGrant(row.place_grant);
  if (!grant) throw new Error(`grid bot ${row.bot_id} has no readable place grant`);
  return {
    botId: row.bot_id,
    userId: row.user_id,
    clientRequestId: row.client_request_id,
    requestHash: row.request_hash,
    marketId: row.market_id,
    symbol: row.symbol,
    baseAsset: row.base_asset,
    quoteAsset: row.quote_asset,
    lowerPrice: parseAmount(row.lower_price),
    upperPrice: parseAmount(row.upper_price),
    gridCount: row.grid_count,
    investment: parseAmount(row.investment),
    levels: levelsFromJson(row.bot_id, row.levels),
    status: row.status,
    statusReason: row.status_reason,
    placeGrant: grant,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const reserveFromRow = (row: ReserveRow): GridReserve => ({
  reserveKey: row.reserve_key,
  botId: row.bot_id,
  userId: row.user_id,
  asset: row.asset,
  amount: parseAmount(row.amount),
  heldAt: row.held_at,
  releasedAt: row.released_at,
});

const orderFromRow = (row: OrderRow): GridOrder => ({
  clientOrderId: row.client_order_id,
  botId: row.bot_id,
  levelIndex: row.level_index,
  side: row.side,
  cycle: row.cycle,
  orderId: row.order_id,
  price: parseAmount(row.price),
  qty: parseAmount(row.qty),
  holdAmount: parseAmount(row.hold_amount),
  status: row.status,
  pairProfit: row.pair_profit === null ? null : parseAmount(row.pair_profit),
  placedAt: row.placed_at,
  closedAt: row.closed_at,
});

const BOT_COLUMNS = `bot_id, user_id, client_request_id, request_hash, market_id, symbol, base_asset, quote_asset,
  lower_price::text AS lower_price, upper_price::text AS upper_price, grid_count, investment::text AS investment,
  levels, status, status_reason, place_grant, created_at, updated_at`;

const ORDER_COLUMNS = `client_order_id, bot_id, level_index, side, cycle, order_id, price::text AS price, qty::text AS qty,
  hold_amount::text AS hold_amount, status, pair_profit::text AS pair_profit, placed_at, closed_at`;

export class SqlGridStore implements GridStore {
  constructor(private readonly sql: Sql) {}

  async findBot(botId: string) {
    const rows = await this.sql.unsafe<BotRow[]>(`SELECT ${BOT_COLUMNS} FROM grid_bots WHERE bot_id = $1`, [botId]);
    return rows[0] ? botFromRow(rows[0]) : null;
  }

  async listBots(userId: string) {
    const rows = await this.sql.unsafe<BotRow[]>(
      `SELECT ${BOT_COLUMNS} FROM grid_bots WHERE user_id = $1 ORDER BY created_at DESC, bot_id`,
      [userId],
    );
    return rows.map(botFromRow);
  }

  async listLiveBots() {
    const rows = await this.sql.unsafe<BotRow[]>(
      `SELECT ${BOT_COLUMNS} FROM grid_bots WHERE status IN ('running', 'paused_range') ORDER BY created_at, bot_id`,
    );
    return rows.map(botFromRow);
  }

  async createWithReserve(bot: GridBot, reserve: GridReserve, check: (unused: Amount) => Promise<void>) {
    return (await this.sql.begin(async (tx) => {
      const store = new SqlGridStore(tx as unknown as Sql);
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${reserveLockKey(bot.userId, reserve.asset)}, 0))`;
      const existing = await store.findBot(bot.botId);
      if (existing) return { created: false, bot: existing };
      await check(await store.sumUnusedReserves(bot.userId, reserve.asset));
      await tx`
        INSERT INTO grid_bots (bot_id, user_id, client_request_id, request_hash, market_id, symbol, base_asset, quote_asset,
                               lower_price, upper_price, grid_count, investment, levels, status, status_reason, place_grant,
                               created_at, updated_at)
        VALUES (${bot.botId}, ${bot.userId}, ${bot.clientRequestId}, ${bot.requestHash}, ${bot.marketId}, ${bot.symbol},
                ${bot.baseAsset}, ${bot.quoteAsset}, ${formatAmount(bot.lowerPrice)}, ${formatAmount(bot.upperPrice)},
                ${bot.gridCount}, ${formatAmount(bot.investment)}, ${tx.json(levelsToJson(bot.levels) as never)}, ${bot.status}, ${bot.statusReason},
                ${tx.json(bot.placeGrant as never)}, ${bot.createdAt}, ${bot.updatedAt})
      `;
      await tx`
        INSERT INTO grid_bot_reserves (reserve_key, bot_id, user_id, asset, amount, held_at, released_at)
        VALUES (${reserve.reserveKey}, ${reserve.botId}, ${reserve.userId}, ${reserve.asset}, ${formatAmount(reserve.amount)},
                ${reserve.heldAt}, NULL)
      `;
      return { created: true, bot };
    })) as { created: boolean; bot: GridBot };
  }

  async setStatus(botId: string, status: GridStatus, reason: string | null, at: Date) {
    await this.sql`UPDATE grid_bots SET status = ${status}, status_reason = ${reason}, updated_at = ${at} WHERE bot_id = ${botId}`;
  }

  async getReserve(botId: string) {
    const rows = await this.sql<ReserveRow[]>`
      SELECT reserve_key, bot_id, user_id, asset, amount::text AS amount, held_at, released_at
        FROM grid_bot_reserves WHERE bot_id = ${botId}`;
    return rows[0] ? reserveFromRow(rows[0]) : null;
  }

  async releaseReserve(botId: string, at: Date) {
    await this.sql`UPDATE grid_bot_reserves SET released_at = ${at} WHERE bot_id = ${botId} AND released_at IS NULL`;
  }

  async sumUnusedReserves(userId: string, asset: string) {
    const [row] = await this.sql<Array<{ total: string | null }>>`
      SELECT sum(greatest(r.amount - coalesce(h.held, 0), 0))::text AS total
        FROM grid_bot_reserves r
        LEFT JOIN (SELECT bot_id, sum(hold_amount) AS held FROM grid_bot_orders
                    WHERE side = 'buy' AND status = 'open' GROUP BY bot_id) h ON h.bot_id = r.bot_id
       WHERE r.user_id = ${userId} AND r.asset = ${asset} AND r.released_at IS NULL`;
    return row?.total ? parseAmount(row.total) : 0n;
  }

  async saveOrder(order: GridOrder) {
    await this.sql`
      INSERT INTO grid_bot_orders (client_order_id, bot_id, level_index, side, cycle, order_id, price, qty, hold_amount,
                                   status, pair_profit, placed_at, closed_at)
      VALUES (${order.clientOrderId}, ${order.botId}, ${order.levelIndex}, ${order.side}, ${order.cycle}, ${order.orderId},
              ${formatAmount(order.price)}, ${formatAmount(order.qty)}, ${formatAmount(order.holdAmount)}, ${order.status},
              ${order.pairProfit === null ? null : formatAmount(order.pairProfit)}, ${order.placedAt}, ${order.closedAt})
      ON CONFLICT (client_order_id) DO NOTHING`;
    const rows = await this.sql.unsafe<OrderRow[]>(`SELECT ${ORDER_COLUMNS} FROM grid_bot_orders WHERE client_order_id = $1`, [
      order.clientOrderId,
    ]);
    return orderFromRow(rows[0]!);
  }

  async closeOrder(clientOrderId: string, status: 'filled' | 'cancelled', pairProfit: Amount | null, at: Date) {
    await this.sql`
      UPDATE grid_bot_orders
         SET status = ${status}, pair_profit = ${pairProfit === null ? null : formatAmount(pairProfit)}, closed_at = ${at}
       WHERE client_order_id = ${clientOrderId} AND status = 'open'`;
  }

  async listOrders(botId: string) {
    const rows = await this.sql.unsafe<OrderRow[]>(
      `SELECT ${ORDER_COLUMNS} FROM grid_bot_orders WHERE bot_id = $1 ORDER BY level_index, cycle, side`,
      [botId],
    );
    return rows.map(orderFromRow);
  }
}
