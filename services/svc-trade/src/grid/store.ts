import type { Sql } from 'postgres';
import { formatAmount, parseAmount, type Amount } from '@intafaced/ledger-client';
import { parseAlgoPlaceGrant } from '../algo/durable-principal.js';
import type { GridLevelPlan } from './plan.js';
import type { GridBot, GridOrder, GridReserve, GridStatus, GridWithdrawal } from './types.js';

export interface GridStore {
  findBot(botId: string): Promise<GridBot | null>;
  listBots(userId: string): Promise<GridBot[]>;
  /** Bots the tick drives: running or paused on range. */
  listLiveBots(): Promise<GridBot[]>;
  /** Stopped or failed bots whose reserve is not released yet: an order of theirs may still be open. */
  listWindingDown(): Promise<GridBot[]>;
  /** Bots still initializing whose status was last written before `before`: a create that stopped part way. */
  listStaleInitializing(before: Date): Promise<GridBot[]>;
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
  /** Writes only while the bot's status is one of `from`, so a tick never undoes a stop. True when it wrote. */
  setStatus(botId: string, status: GridStatus, reason: string | null, at: Date, from: readonly GridStatus[]): Promise<boolean>;
  getReserve(botId: string): Promise<GridReserve | null>;
  releaseReserve(botId: string, at: Date): Promise<void>;
  /** Unreleased grid reserves of one owner and asset, less what each bot's open buys already hold. */
  sumUnusedReserves(userId: string, asset: string): Promise<Amount>;
  /** Insert once by clientOrderId; a second save of the same key keeps the first row. */
  saveOrder(order: GridOrder): Promise<GridOrder>;
  /**
   * Close an open order once. A filled sell's positive pair profit raises the bot's unreleased reserve by that profit in
   * the same write, so the profit stays guarded for the bot until it is withdrawn (CB-bots-05).
   */
  closeOrder(clientOrderId: string, status: ClosedStatus, pairProfit: Amount | null, at: Date): Promise<void>;
  listOrders(botId: string): Promise<GridOrder[]>;
  findWithdrawal(withdrawalId: string): Promise<GridWithdrawal | null>;
  /**
   * Under the owner's reserve lock for the asset, in one transaction: a withdrawal already stored under the key is
   * answered as it is (`created: false`); otherwise `decide` gets the bot's reserve and what the owner withdrew of the
   * asset in `at`'s UTC day, and either throws (nothing is written) or returns the withdrawal, which is stored while the
   * reserve row is lowered to its `reserveAfter`.
   */
  withdraw(
    key: { withdrawalId: string; botId: string; userId: string; asset: string; at: Date },
    decide: (state: { reserve: GridReserve | null; usedToday: Amount }) => GridWithdrawal,
  ): Promise<{ created: boolean; withdrawal: GridWithdrawal }>;
}

type ClosedStatus = Exclude<GridOrder['status'], 'open'>;
const WINDING_DOWN: readonly GridStatus[] = ['stopped', 'initialization_failed'];

/** Same advisory key copy follows lock (copy/follow-store.ts), so a grid create and a follow create serialise. */
export const reserveLockKey = (userId: string, asset: string): string => `copy.reserve:${userId}:${asset}`;

/** The UTC day of `at`: [start, end). */
export function utcDay(at: Date): { start: Date; end: Date } {
  const start = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
  return { start, end: new Date(start.getTime() + 86_400_000) };
}

function unusedOf(reserve: GridReserve, orders: readonly GridOrder[]): Amount {
  const held = orders.filter((o) => o.side === 'buy' && o.status === 'open').reduce((acc, o) => acc + o.holdAmount, 0n);
  const unused = reserve.amount - held;
  return unused > 0n ? unused : 0n;
}

export class MemoryGridStore implements GridStore {
  private readonly bots = new Map<string, GridBot>();
  private readonly reserves = new Map<string, GridReserve>();
  private readonly orders = new Map<string, GridOrder>();
  private readonly withdrawals = new Map<string, GridWithdrawal>();

  async findBot(botId: string) {
    return this.bots.get(botId) ?? null;
  }
  async listBots(userId: string) {
    return [...this.bots.values()].filter((b) => b.userId === userId).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }
  async listLiveBots() {
    return [...this.bots.values()].filter((b) => b.status === 'running' || b.status === 'paused_range');
  }
  async listStaleInitializing(before: Date) {
    return [...this.bots.values()].filter((b) => b.status === 'initializing' && b.updatedAt < before);
  }
  async listWindingDown() {
    return [...this.bots.values()].filter((b) => WINDING_DOWN.includes(b.status) && this.reserves.get(b.botId)?.releasedAt === null);
  }
  async createWithReserve(bot: GridBot, reserve: GridReserve, check: (unused: Amount) => Promise<void>) {
    const existing = this.bots.get(bot.botId);
    if (existing) return { created: false, bot: existing };
    await check(await this.sumUnusedReserves(bot.userId, reserve.asset));
    this.bots.set(bot.botId, bot);
    this.reserves.set(bot.botId, reserve);
    return { created: true, bot };
  }
  async setStatus(botId: string, status: GridStatus, reason: string | null, at: Date, from: readonly GridStatus[]) {
    const bot = this.bots.get(botId);
    if (!bot || !from.includes(bot.status)) return false;
    this.bots.set(botId, { ...bot, status, statusReason: reason, updatedAt: at });
    return true;
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
  async closeOrder(clientOrderId: string, status: ClosedStatus, pairProfit: Amount | null, at: Date) {
    const o = this.orders.get(clientOrderId);
    if (!o || o.status !== 'open') return;
    this.orders.set(clientOrderId, { ...o, status, pairProfit, closedAt: at });
    const r = this.reserves.get(o.botId);
    if (status === 'filled' && pairProfit !== null && pairProfit > 0n && r && r.releasedAt === null) {
      this.reserves.set(o.botId, { ...r, amount: r.amount + pairProfit });
    }
  }
  async findWithdrawal(withdrawalId: string) {
    return this.withdrawals.get(withdrawalId) ?? null;
  }
  async withdraw(
    key: { withdrawalId: string; botId: string; userId: string; asset: string; at: Date },
    decide: (state: { reserve: GridReserve | null; usedToday: Amount }) => GridWithdrawal,
  ) {
    const existing = this.withdrawals.get(key.withdrawalId);
    if (existing) return { created: false, withdrawal: existing };
    const day = utcDay(key.at);
    const usedToday = [...this.withdrawals.values()]
      .filter((w) => w.userId === key.userId && w.asset === key.asset && w.appliedAt >= day.start && w.appliedAt < day.end)
      .reduce((a, w) => a + w.amount, 0n);
    const reserve = this.reserves.get(key.botId) ?? null;
    const withdrawal = decide({ reserve, usedToday });
    this.withdrawals.set(withdrawal.withdrawalId, withdrawal);
    if (reserve) this.reserves.set(key.botId, { ...reserve, amount: withdrawal.reserveAfter });
    return { created: true, withdrawal };
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
  order_hold: string;
  status: GridOrder['status'];
  pair_profit: string | null;
  placed_at: Date;
  closed_at: Date | null;
}

interface WithdrawalRow {
  withdrawal_key: string;
  bot_id: string;
  user_id: string;
  request_id: string;
  request_hash: string;
  asset: string;
  amount: string;
  profit_before: string;
  profit_after: string;
  reserve_before: string;
  reserve_after: string;
  daily_cap: string;
  cap_withdrawn_today: string;
  cap_remaining: string;
  step_up_event_id: string;
  applied_at: Date;
}

const withdrawalFromRow = (row: WithdrawalRow): GridWithdrawal => ({
  withdrawalId: row.withdrawal_key,
  botId: row.bot_id,
  userId: row.user_id,
  requestId: row.request_id,
  requestHash: row.request_hash,
  asset: row.asset,
  amount: parseAmount(row.amount),
  profitBefore: parseAmount(row.profit_before),
  profitAfter: parseAmount(row.profit_after),
  reserveBefore: parseAmount(row.reserve_before),
  reserveAfter: parseAmount(row.reserve_after),
  dailyCap: parseAmount(row.daily_cap),
  capUsed: parseAmount(row.cap_withdrawn_today),
  capRemaining: parseAmount(row.cap_remaining),
  stepUpEventId: row.step_up_event_id,
  appliedAt: row.applied_at,
});

const WITHDRAWAL_COLUMNS = `withdrawal_key, bot_id, user_id, request_id, request_hash, asset, amount::text AS amount,
  profit_before::text AS profit_before, profit_after::text AS profit_after, reserve_before::text AS reserve_before,
  reserve_after::text AS reserve_after, daily_cap::text AS daily_cap, cap_withdrawn_today::text AS cap_withdrawn_today,
  cap_remaining::text AS cap_remaining, step_up_event_id, applied_at`;

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
  holdAmount: parseAmount(row.order_hold),
  status: row.status,
  pairProfit: row.pair_profit === null ? null : parseAmount(row.pair_profit),
  placedAt: row.placed_at,
  closedAt: row.closed_at,
});

const BOT_COLUMNS = `bot_id, user_id, client_request_id, request_hash, market_id, symbol, base_asset, quote_asset,
  lower_price::text AS lower_price, upper_price::text AS upper_price, grid_count, investment::text AS investment,
  levels, status, status_reason, place_grant, created_at, updated_at`;

const ORDER_COLUMNS = `client_order_id, bot_id, level_index, side, cycle, order_id, price::text AS price, qty::text AS qty,
  order_hold::text AS order_hold, status, pair_profit::text AS pair_profit, placed_at, closed_at`;

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

  async listStaleInitializing(before: Date) {
    const rows = await this.sql.unsafe<BotRow[]>(
      `SELECT ${BOT_COLUMNS} FROM grid_bots WHERE status = 'initializing' AND updated_at < $1 ORDER BY created_at, bot_id`,
      [before],
    );
    return rows.map(botFromRow);
  }

  async listWindingDown() {
    const rows = await this.sql.unsafe<BotRow[]>(
      `SELECT ${BOT_COLUMNS} FROM grid_bots
        WHERE status IN ('stopped', 'initialization_failed')
          AND bot_id IN (SELECT bot_id FROM grid_bot_reserves WHERE released_at IS NULL)
        ORDER BY created_at, bot_id`,
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

  async setStatus(botId: string, status: GridStatus, reason: string | null, at: Date, from: readonly GridStatus[]) {
    const rows = await this.sql`
      UPDATE grid_bots SET status = ${status}, status_reason = ${reason}, updated_at = ${at}
       WHERE bot_id = ${botId} AND status = ANY(${from as GridStatus[]}::text[])
      RETURNING bot_id`;
    return rows.length > 0;
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
        LEFT JOIN (SELECT bot_id, sum(order_hold) AS held FROM grid_bot_orders
                    WHERE side = 'buy' AND status = 'open' GROUP BY bot_id) h ON h.bot_id = r.bot_id
       WHERE r.user_id = ${userId} AND r.asset = ${asset} AND r.released_at IS NULL`;
    return row?.total ? parseAmount(row.total) : 0n;
  }

  async saveOrder(order: GridOrder) {
    await this.sql`
      INSERT INTO grid_bot_orders (client_order_id, bot_id, level_index, side, cycle, order_id, price, qty, order_hold,
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

  async closeOrder(clientOrderId: string, status: ClosedStatus, pairProfit: Amount | null, at: Date) {
    // One statement: the reserve grows only when this call is the one that closed the order.
    await this.sql`
      WITH closed AS (
        UPDATE grid_bot_orders
           SET status = ${status}, pair_profit = ${pairProfit === null ? null : formatAmount(pairProfit)}, closed_at = ${at}
         WHERE client_order_id = ${clientOrderId} AND status = 'open'
        RETURNING bot_id, status, pair_profit)
      UPDATE grid_bot_reserves r SET amount = r.amount + c.pair_profit
        FROM closed c
       WHERE r.bot_id = c.bot_id AND r.released_at IS NULL AND c.status = 'filled' AND c.pair_profit > 0`;
  }

  async findWithdrawal(withdrawalId: string) {
    const rows = await this.sql.unsafe<WithdrawalRow[]>(
      `SELECT ${WITHDRAWAL_COLUMNS} FROM grid_bot_withdrawals WHERE withdrawal_key = $1`,
      [withdrawalId],
    );
    return rows[0] ? withdrawalFromRow(rows[0]) : null;
  }

  async withdraw(
    key: { withdrawalId: string; botId: string; userId: string; asset: string; at: Date },
    decide: (state: { reserve: GridReserve | null; usedToday: Amount }) => GridWithdrawal,
  ) {
    return (await this.sql.begin(async (tx) => {
      const store = new SqlGridStore(tx as unknown as Sql);
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${reserveLockKey(key.userId, key.asset)}, 0))`;
      const existing = await store.findWithdrawal(key.withdrawalId);
      if (existing) return { created: false, withdrawal: existing };
      const reserves = await tx<ReserveRow[]>`
        SELECT reserve_key, bot_id, user_id, asset, amount::text AS amount, held_at, released_at
          FROM grid_bot_reserves WHERE bot_id = ${key.botId} FOR UPDATE`;
      const day = utcDay(key.at);
      const [used] = await tx<Array<{ total: string | null }>>`
        SELECT sum(amount)::text AS total FROM grid_bot_withdrawals
         WHERE user_id = ${key.userId} AND asset = ${key.asset} AND applied_at >= ${day.start} AND applied_at < ${day.end}`;
      const w = decide({
        reserve: reserves[0] ? reserveFromRow(reserves[0]) : null,
        usedToday: used?.total ? parseAmount(used.total) : 0n,
      });
      await tx`
        INSERT INTO grid_bot_withdrawals (withdrawal_key, bot_id, user_id, request_id, request_hash, asset, amount,
                                          profit_before, profit_after, reserve_before, reserve_after, daily_cap, cap_withdrawn_today,
                                          cap_remaining, step_up_event_id, applied_at)
        VALUES (${w.withdrawalId}, ${w.botId}, ${w.userId}, ${w.requestId}, ${w.requestHash}, ${w.asset}, ${formatAmount(w.amount)},
                ${formatAmount(w.profitBefore)}, ${formatAmount(w.profitAfter)}, ${formatAmount(w.reserveBefore)},
                ${formatAmount(w.reserveAfter)}, ${formatAmount(w.dailyCap)}, ${formatAmount(w.capUsed)},
                ${formatAmount(w.capRemaining)}, ${w.stepUpEventId}, ${w.appliedAt})`;
      const lowered = await tx`
        UPDATE grid_bot_reserves SET amount = ${formatAmount(w.reserveAfter)}
         WHERE bot_id = ${w.botId} AND released_at IS NULL AND amount = ${formatAmount(w.reserveBefore)}
        RETURNING bot_id`;
      if (lowered.length !== 1) throw new Error(`grid withdrawal ${w.withdrawalId}: the reserve changed under the lock`);
      return { created: true, withdrawal: w };
    })) as { created: boolean; withdrawal: GridWithdrawal };
  }

  async listOrders(botId: string) {
    const rows = await this.sql.unsafe<OrderRow[]>(
      `SELECT ${ORDER_COLUMNS} FROM grid_bot_orders WHERE bot_id = $1 ORDER BY level_index, cycle, side`,
      [botId],
    );
    return rows.map(orderFromRow);
  }
}
