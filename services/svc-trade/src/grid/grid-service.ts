/**
 * Spot grid bot (CB-bots-02, CB-bots-10; J-copy-bots-otc-14 #2 to #5).
 *
 * Create, in this order, so a refusal writes nothing:
 * 1. the owner's bots verification level (blank refuses every bot), before any read;
 * 2. the request key, which fixes the bot id: the same key and body return the same bot, a different body conflicts;
 * 3. each field, refused by a code naming it; the owner's grid count range (blank refuses);
 * 4. the level plan, the mark, and the reserve (the investment) against free quote less every other reserve;
 * 5. the trading admission for `strategy.start` with business id `grid:<botId>`;
 * 6. the bot and its reserve in one transaction, under the owner's reserve lock;
 * 7. a buy on every level below the mark, each through the trade service's own place path as a delegated
 *    `algo.child` of the bot, clientOrderId `grid:<botId>:<level>:b<cycle>`. If any level fails, the placed levels
 *    are cancelled, the reserve is released and the bot reads initialization_failed.
 *
 * Quote only: the bot never needs base to start. A filled buy places a sell one level up for what the buy delivered
 * net of its base fee; a filled sell closes the pair, and its profit is the sell's quote less fees less the buy's quote
 * cost (fees from trade fills). The tick (`tickAll`) re-reads each open order from the trade service, so a crash at
 * any step is picked up by the next tick with the same clientOrderIds.
 *
 * Range pause: while the mark is outside the bounds no new buy is placed; open orders stay and may still fill.
 *
 * Nothing here moves value: every hold, fill and release is the trade service's order path through the ledger recipes.
 */
import { createHash } from 'node:crypto';
import { formatAmount, parseAmount, type Amount } from '@intafaced/ledger-client';
import type { Principal } from '@intafaced/auth';
import { assertBotVerification, type BotVerificationPolicy } from '../algo/bots-verification.js';
import { captureAlgoPlaceGrant, principalFromAlgoGrant } from '../algo/durable-principal.js';
import type { PlaceOrderInput } from '../spot/trade-service.js';
import type { FillRecord, Market, OrderRecord } from '../spot/types.js';
import { GridError } from './errors.js';
import { levelsBelowMark, markInRange, planGrid, type GridLevelPlan } from './plan.js';
import type { GridPolicy } from './policy.js';
import type { GridStore } from './store.js';
import {
  gridBusinessId,
  gridClientOrderId,
  gridReserveKey,
  type GridBot,
  type GridOrder,
  type GridReserve,
  type GridStatus,
} from './types.js';

export interface GridPorts {
  readonly store: GridStore;
  readonly policy: GridPolicy;
  readonly verification: () => BotVerificationPolicy;
  marketBySymbol(symbol: string): Promise<Market | null>;
  /** Best bid and ask of the book, as the matching depth read answers them. */
  depth(marketId: string): Promise<{ bids: ReadonlyArray<readonly [string, string]>; asks: ReadonlyArray<readonly [string, string]> }>;
  /** The owner's free spot balance of one asset (ledger available rows). */
  freeBalance(userId: string, asset: string): Promise<Amount>;
  /** What the owner's copy follows still reserve of one asset (copy/follow-store.ts sumUnusedReserves). */
  copyUnusedReserves(userId: string, asset: string): Promise<Amount>;
  /** The trading admission of the bot as a `strategy.start` operation. */
  admitStart(principal: Principal, businessId: string, payload: unknown): Promise<unknown>;
  /** The trade service's place path for one level, a delegated `algo.child` of `grid:<botId>`. */
  placeLevel(principal: Principal, input: PlaceOrderInput, botId: string): Promise<OrderRecord>;
  findOrder(orderId: string): Promise<OrderRecord | null>;
  cancelOrder(principal: Principal, orderId: string): Promise<unknown>;
  fillsForOrder(principal: Principal, orderId: string): Promise<FillRecord[]>;
  now?: () => Date;
}

export interface GridCreateInput {
  readonly clientRequestId: string;
  readonly symbol: string;
  readonly lowerPrice?: string | null;
  readonly upperPrice?: string | null;
  readonly gridCount?: number | null;
  readonly investment?: string | null;
}

export interface GridLevelView {
  readonly index: number;
  readonly price: string;
  readonly qty: string;
  readonly hold: string;
  /** The open order on this level, if any: a buy of this level, or the sell of the pair opened one level below. */
  readonly openOrder: { readonly side: 'buy' | 'sell'; readonly orderId: string; readonly clientOrderId: string } | null;
}

export interface GridBotView {
  readonly botId: string;
  readonly symbol: string;
  readonly baseAsset: string;
  readonly quoteAsset: string;
  readonly lowerPrice: string;
  readonly upperPrice: string;
  readonly gridCount: number;
  readonly investment: string;
  readonly status: GridStatus;
  readonly statusReason: string | null;
  readonly reserve: { readonly key: string; readonly asset: string; readonly amount: string; readonly releasedAt: string | null } | null;
  readonly levels: readonly GridLevelView[];
  readonly orders: ReadonlyArray<{
    readonly clientOrderId: string;
    readonly orderId: string;
    readonly levelIndex: number;
    readonly side: 'buy' | 'sell';
    readonly cycle: number;
    readonly price: string;
    readonly qty: string;
    readonly holdAmount: string;
    readonly status: GridOrder['status'];
    readonly pairProfit: string | null;
  }>;
  /** The sum of closed pairs' profit net of fees. "0" before any pair closes. */
  readonly gridProfit: string;
  readonly closedPairs: number;
  readonly createdAt: string;
}

export interface GridPresetsView {
  /** Null: no backtest source is set, so no preset and no APR exists. */
  readonly source: null;
  readonly presets: readonly [];
}

const REQUEST_KEY = /^[A-Za-z0-9:._-]{8,120}$/;
/** A tick placement is a fresh, short-lived authority from the stored claims; every level is still admitted live. */
const TICK_AUTHORITY_MS = 60_000;

/** The bot id for one request: the same owner and key always give the same UUID-shaped id. */
export function gridBotIdFor(userId: string, clientRequestId: string): string {
  if (!REQUEST_KEY.test(clientRequestId)) {
    throw new GridError('clientRequestId must be 8 to 120 letters, digits or : . _ -', 'trade.grid_request_key_invalid');
  }
  const hex = createHash('sha256').update(`bots.grid\0${userId}\0${clientRequestId}`).digest('hex');
  const variant = ((parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function positiveAmount(raw: string | null | undefined, code: GridError['code'], label: string): Amount {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (value === '') throw new GridError(`${label} is required`, code, { field: label });
  let amount: Amount;
  try {
    amount = parseAmount(value);
  } catch {
    throw new GridError(`${label} must be a decimal number`, code, { field: label });
  }
  if (amount <= 0n) throw new GridError(`${label} must be above zero`, code, { field: label });
  return amount;
}

function requestHash(input: GridCreateInput): string {
  const body = [input.symbol, input.lowerPrice ?? '', input.upperPrice ?? '', String(input.gridCount ?? ''), input.investment ?? ''];
  return createHash('sha256').update(body.join('\0')).digest('hex');
}

/** Mid of the best bid and ask. Either side empty means there is no mark to grid around. */
export function markOf(depth: Awaited<ReturnType<GridPorts['depth']>>): Amount | null {
  const bid = depth.bids[0]?.[0];
  const ask = depth.asks[0]?.[0];
  if (!bid || !ask) return null;
  return (parseAmount(bid) + parseAmount(ask)) / 2n;
}

const floorTo = (value: Amount, step: Amount): Amount => (step > 0n ? (value / step) * step : value);
const TERMINAL: ReadonlySet<OrderRecord['status']> = new Set(['filled', 'cancelled', 'rejected', 'expired']);

export class GridService {
  constructor(private readonly ports: GridPorts) {}

  private now(): Date {
    return this.ports.now?.() ?? new Date();
  }

  presets(): GridPresetsView {
    // No backtest source exists (policy.ts): never a sample range, never an APR.
    return { source: this.ports.policy.presetSource, presets: [] };
  }

  async create(principal: Principal, input: GridCreateInput): Promise<GridBotView> {
    assertBotVerification(this.ports.verification(), principal.tier);
    const botId = gridBotIdFor(principal.userId, input.clientRequestId);
    const hash = requestHash(input);
    const already = await this.ports.store.findBot(botId);
    if (already) return this.sameRequest(already, hash);

    const lower = positiveAmount(input.lowerPrice, 'trade.grid_lower_price_required', 'Lower price');
    const upper = positiveAmount(input.upperPrice, 'trade.grid_upper_price_required', 'Upper price');
    if (!(lower < upper)) throw new GridError('Lower price must be below upper price', 'trade.grid_bounds_inverted');
    const investment = positiveAmount(input.investment, 'trade.grid_investment_required', 'Investment');
    const count = input.gridCount;
    if (count === null || count === undefined) throw new GridError('Grids is required', 'trade.grid_count_required', { field: 'Grids' });
    const range = this.ports.policy.countRange;
    if (!range) throw new GridError('The platform has not set how many grids a bot may use', 'trade.grid_count_range_not_set');
    if (!Number.isInteger(count) || count < range.min || count > range.max) {
      throw new GridError(`Grids must be from ${range.min} to ${range.max}`, 'trade.grid_count_out_of_range', {
        field: 'Grids',
        min: String(range.min),
        max: String(range.max),
      });
    }

    const market = await this.ports.marketBySymbol(input.symbol);
    if (!market) throw new GridError(`Market ${input.symbol} not found`, 'trade.grid_market_not_found');
    if (market.kind !== 'spot' || market.paper || market.status !== 'active') {
      throw new GridError(`${market.symbol} is not an open spot market`, 'trade.grid_market_not_spot');
    }
    const plan = planGrid({ lower, upper, count, investment, market });
    const mark = markOf(await this.ports.depth(market.id));
    if (mark === null) throw new GridError(`${market.symbol} has no bid and ask to place a grid around`, 'trade.grid_mark_unavailable');

    const asset = market.quoteAsset;
    const free = await this.ports.freeBalance(principal.userId, asset);
    const copyUnused = await this.ports.copyUnusedReserves(principal.userId, asset);
    const fits = (gridUnused: Amount) => {
      const left = free - copyUnused - gridUnused;
      if (investment > left) {
        throw new GridError(
          `Investment ${formatAmount(investment)} ${asset} is more than the ${formatAmount(left > 0n ? left : 0n)} ${asset} free`,
          'trade.grid_reserve_exceeds_balance',
          {
            asset,
            free: formatAmount(left > 0n ? left : 0n),
          },
        );
      }
    };
    // A quick refusal before admission; the same check runs again under the reserve lock in the save.
    fits(await this.ports.store.sumUnusedReserves(principal.userId, asset));

    const grant = captureAlgoPlaceGrant(principal);
    await this.ports.admitStart(principal, gridBusinessId(botId), {
      botId,
      symbol: market.symbol,
      lowerPrice: formatAmount(lower),
      upperPrice: formatAmount(upper),
      gridCount: count,
      investment: formatAmount(investment),
    });

    const at = this.now();
    const bot: GridBot = {
      botId,
      userId: principal.userId,
      clientRequestId: input.clientRequestId,
      requestHash: hash,
      marketId: market.id,
      symbol: market.symbol,
      baseAsset: market.baseAsset,
      quoteAsset: asset,
      lowerPrice: lower,
      upperPrice: upper,
      gridCount: count,
      investment,
      levels: plan.levels,
      status: markInRange(lower, upper, mark) ? 'running' : 'paused_range',
      statusReason: null,
      placeGrant: grant,
      createdAt: at,
      updatedAt: at,
    };
    const reserve: GridReserve = {
      reserveKey: gridReserveKey(botId),
      botId,
      userId: principal.userId,
      asset,
      amount: investment,
      heldAt: at,
      releasedAt: null,
    };
    const saved = await this.ports.store.createWithReserve(bot, reserve, async (gridUnused) => fits(gridUnused));
    if (!saved.created) return this.sameRequest(saved.bot, hash);

    if (bot.status === 'running') {
      try {
        await this.placeMissingBuys(principal, bot, market, mark, []);
      } catch (error) {
        await this.failInitialization(principal, bot, error);
      }
    }
    return this.view(botId);
  }

  private async sameRequest(bot: GridBot, hash: string): Promise<GridBotView> {
    if (bot.requestHash !== hash) {
      throw new GridError('This request key already made a different grid bot', 'trade.grid_request_conflict');
    }
    return this.view(bot.botId);
  }

  private async failInitialization(principal: Principal, bot: GridBot, error: unknown): Promise<never> {
    const reason = (error as { code?: string })?.code ?? 'trade.grid_initialization_failed';
    for (const order of await this.ports.store.listOrders(bot.botId)) {
      if (order.status !== 'open') continue;
      try {
        await this.ports.cancelOrder(principal, order.orderId);
        await this.ports.store.closeOrder(order.clientOrderId, 'cancelled', null, this.now());
      } catch {
        // Left open in the row; the stopped-bot sweep in tickAll cancels it again.
      }
    }
    await this.ports.store.setStatus(bot.botId, 'initialization_failed', reason, this.now());
    await this.ports.store.releaseReserve(bot.botId, this.now());
    throw new GridError('The grid could not place its levels; nothing is left running', 'trade.grid_initialization_failed', { reason });
  }

  /** One buy per level strictly below the mark that has no open order, never on the top level (it has no level above). */
  private async placeMissingBuys(
    principal: Principal,
    bot: GridBot,
    market: Market,
    mark: Amount,
    orders: readonly GridOrder[],
  ): Promise<void> {
    const plan = { slice: bot.investment / BigInt(bot.gridCount), levels: bot.levels };
    for (const level of levelsBelowMark(plan, mark)) {
      if (level.index === bot.gridCount - 1) continue;
      const atLevel = orders.filter((o) => o.levelIndex === level.index);
      if (atLevel.some((o) => o.status === 'open')) continue;
      const cycle = atLevel.filter((o) => o.side === 'buy').length;
      await this.placeAndRecord(principal, bot, market, level, 'buy', cycle, level.price, level.qty);
    }
  }

  private async placeAndRecord(
    principal: Principal,
    bot: GridBot,
    market: Market,
    level: GridLevelPlan,
    side: 'buy' | 'sell',
    cycle: number,
    price: Amount,
    qty: Amount,
  ): Promise<GridOrder> {
    const clientOrderId = gridClientOrderId(bot.botId, level.index, side, cycle);
    const placed = await this.ports.placeLevel(
      principal,
      { marketId: market.id, side, type: 'limit', tif: 'GTC', price, qty, clientOrderId },
      bot.botId,
    );
    return this.ports.store.saveOrder({
      clientOrderId,
      botId: bot.botId,
      levelIndex: level.index,
      side,
      cycle,
      orderId: placed.id,
      price,
      qty,
      holdAmount: placed.holdAmount,
      status: 'open',
      pairProfit: null,
      placedAt: this.now(),
      closedAt: null,
    });
  }

  async get(principal: Principal, botId: string): Promise<GridBotView> {
    const bot = await this.ports.store.findBot(botId);
    if (!bot || bot.userId !== principal.userId) throw new GridError('Grid bot not found', 'trade.grid_not_found');
    return this.view(botId);
  }

  async list(principal: Principal): Promise<GridBotView[]> {
    const bots = await this.ports.store.listBots(principal.userId);
    return Promise.all(bots.map((b) => this.view(b.botId)));
  }

  /** Stop: cancel every open level order, release the reserve. Base already bought stays in the owner's balance. */
  async stop(principal: Principal, botId: string): Promise<GridBotView> {
    const bot = await this.ports.store.findBot(botId);
    if (!bot || bot.userId !== principal.userId) throw new GridError('Grid bot not found', 'trade.grid_not_found');
    if (bot.status === 'stopped' || bot.status === 'initialization_failed') return this.view(botId);
    await this.ports.store.setStatus(botId, 'stopped', 'owner_stop', this.now());
    await this.cancelOpen(principal, bot);
    await this.ports.store.releaseReserve(botId, this.now());
    return this.view(botId);
  }

  private async cancelOpen(principal: Principal, bot: GridBot): Promise<void> {
    for (const order of await this.ports.store.listOrders(bot.botId)) {
      if (order.status !== 'open') continue;
      await this.ports.cancelOrder(principal, order.orderId);
      await this.ports.store.closeOrder(order.clientOrderId, 'cancelled', null, this.now());
    }
  }

  /** One pass over every live bot. A failing bot is recorded on its row and does not stop the others. */
  async tickAll(): Promise<void> {
    for (const bot of await this.ports.store.listLiveBots()) {
      try {
        await this.tick(bot);
      } catch (error) {
        const reason = (error as { code?: string })?.code ?? 'trade.grid_tick_failed';
        await this.ports.store.setStatus(bot.botId, bot.status, reason, this.now());
      }
    }
  }

  async tick(bot: GridBot): Promise<void> {
    const now = this.now();
    const principal = principalFromAlgoGrant({
      userId: bot.userId,
      grant: bot.placeGrant,
      expiresAt: new Date(now.getTime() + TICK_AUTHORITY_MS),
      now,
    });
    const market = await this.ports.marketBySymbol(bot.symbol);
    if (!market) throw new GridError(`Market ${bot.symbol} not found`, 'trade.grid_market_not_found');

    for (const order of await this.ports.store.listOrders(bot.botId)) {
      if (order.status === 'open') await this.settleOrder(principal, bot, market, order);
    }

    const mark = markOf(await this.ports.depth(market.id));
    if (mark === null) return;
    if (!markInRange(bot.lowerPrice, bot.upperPrice, mark)) {
      if (bot.status !== 'paused_range') await this.ports.store.setStatus(bot.botId, 'paused_range', 'mark_outside_range', this.now());
      return;
    }
    if (bot.status !== 'running') await this.ports.store.setStatus(bot.botId, 'running', null, this.now());
    await this.placeMissingBuys(principal, bot, market, mark, await this.ports.store.listOrders(bot.botId));
  }

  /** Read one open level order back from the trade service and act on a terminal one. */
  private async settleOrder(principal: Principal, bot: GridBot, market: Market, order: GridOrder): Promise<void> {
    const record = await this.ports.findOrder(order.orderId);
    if (!record || !TERMINAL.has(record.status)) return;
    if (record.filledQty === 0n) {
      await this.ports.store.closeOrder(order.clientOrderId, 'cancelled', null, this.now());
      return;
    }
    const fills = await this.ports.fillsForOrder(principal, order.orderId);
    if (order.side === 'buy') {
      // Sell first, then close the buy: a crash between them re-places the same clientOrderId, which is the same order.
      const baseFee = fills.filter((f) => f.feeAsset === market.baseAsset).reduce((a, f) => a + f.feeAmount, 0n);
      const qty = floorTo(record.filledQty - baseFee, market.lotSize);
      const above = bot.levels[order.levelIndex + 1];
      if (above && qty > 0n && qty >= market.minQty) {
        await this.placeAndRecord(principal, bot, market, bot.levels[order.levelIndex]!, 'sell', order.cycle, above.price, qty);
      }
      await this.ports.store.closeOrder(order.clientOrderId, 'filled', null, this.now());
      return;
    }
    const buy = (await this.ports.store.listOrders(bot.botId)).find(
      (o) => o.levelIndex === order.levelIndex && o.side === 'buy' && o.cycle === order.cycle,
    );
    const profit = buy ? await this.pairProfit(principal, market, buy, fills) : null;
    await this.ports.store.closeOrder(order.clientOrderId, 'filled', profit, this.now());
  }

  /**
   * Quote received by the sell net of its quote fee, less the quote the buy spent and its quote fee. Null when a leg's
   * fee was taken in a third asset: that profit cannot be stated in the quote asset without a price, so it is not guessed.
   */
  private async pairProfit(principal: Principal, market: Market, buy: GridOrder, sellFills: FillRecord[]): Promise<Amount | null> {
    const buyFills = await this.ports.fillsForOrder(principal, buy.orderId);
    const known = (f: FillRecord) => f.feeAmount === 0n || f.feeAsset === market.baseAsset || f.feeAsset === market.quoteAsset;
    if (![...buyFills, ...sellFills].every(known)) return null;
    const quoteFee = (fills: FillRecord[]) => fills.filter((f) => f.feeAsset === market.quoteAsset).reduce((a, f) => a + f.feeAmount, 0n);
    const quote = (fills: FillRecord[]) => fills.reduce((a, f) => a + f.quoteAmount, 0n);
    return quote(sellFills) - quoteFee(sellFills) - (quote(buyFills) + quoteFee(buyFills));
  }

  private async view(botId: string): Promise<GridBotView> {
    const bot = await this.ports.store.findBot(botId);
    if (!bot) throw new GridError('Grid bot not found', 'trade.grid_not_found');
    const orders = await this.ports.store.listOrders(botId);
    const reserve = await this.ports.store.getReserve(botId);
    const closed = orders.filter((o) => o.side === 'sell' && o.status === 'filled' && o.pairProfit !== null);
    const openAt = (index: number) => {
      const o = orders.find((x) => x.status === 'open' && (x.side === 'buy' ? x.levelIndex === index : x.levelIndex + 1 === index));
      return o ? { side: o.side, orderId: o.orderId, clientOrderId: o.clientOrderId } : null;
    };
    return {
      botId,
      symbol: bot.symbol,
      baseAsset: bot.baseAsset,
      quoteAsset: bot.quoteAsset,
      lowerPrice: formatAmount(bot.lowerPrice),
      upperPrice: formatAmount(bot.upperPrice),
      gridCount: bot.gridCount,
      investment: formatAmount(bot.investment),
      status: bot.status,
      statusReason: bot.statusReason,
      reserve: reserve
        ? {
            key: reserve.reserveKey,
            asset: reserve.asset,
            amount: formatAmount(reserve.amount),
            releasedAt: reserve.releasedAt?.toISOString() ?? null,
          }
        : null,
      levels: bot.levels.map((l) => ({
        index: l.index,
        price: formatAmount(l.price),
        qty: formatAmount(l.qty),
        hold: formatAmount(l.hold),
        openOrder: openAt(l.index),
      })),
      orders: orders.map((o) => ({
        clientOrderId: o.clientOrderId,
        orderId: o.orderId,
        levelIndex: o.levelIndex,
        side: o.side,
        cycle: o.cycle,
        price: formatAmount(o.price),
        qty: formatAmount(o.qty),
        holdAmount: formatAmount(o.holdAmount),
        status: o.status,
        pairProfit: o.pairProfit === null ? null : formatAmount(o.pairProfit),
      })),
      gridProfit: formatAmount(closed.reduce((a, o) => a + o.pairProfit!, 0n)),
      closedPairs: closed.length,
      createdAt: bot.createdAt.toISOString(),
    };
  }
}
