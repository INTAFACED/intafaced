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
 *    `algo.child` of the bot, clientOrderId `grid:<botId>:<level>:b<cycle>`. If any level fails, the bot reads
 *    initialization_failed, the levels it placed are cancelled and then the reserve is released.
 *
 * A replay of the same key and body answers what the first call answered: a failed start refuses again, and a live bot
 * first places any level the first call did not reach (a crash after the save), under the same clientOrderIds.
 *
 * Quote only: the bot never needs base to start. A filled buy places a sell one level up for what the buy delivered
 * net of its base fee; a filled sell closes the pair, and its profit is the sell's quote less fees less the buy's quote
 * cost (fees from trade fills). The tick (`tickAll`) re-reads each open order from the trade service, so a crash at
 * any step is picked up by the next tick with the same clientOrderIds.
 *
 * Range pause: while the mark is outside the bounds no new buy is placed; open orders stay and may still fill.
 *
 * Stop and a failed start wind the bot down: every order it has open, and the next order id of each level (a place
 * that reached the engine but whose row was never saved), is cancelled; the reserve is released once none is left
 * open. A cancel that fails keeps the reserve held, and each tick tries the wind-down again. Status writes are
 * conditional on the status read, so a tick never brings back a bot that was stopped while it ran.
 *
 * A sell that ends part filled reads partial: its pair is not closed, it states no profit, and the base it did not sell
 * stays in the owner's balance.
 *
 * Nothing here moves value: every hold, fill and release is the trade service's order path through the ledger recipes.
 */
import { createHash } from 'node:crypto';
import { div, formatAmount, mul, parseAmount, type Amount } from '@intafaced/ledger-client';
import type { Principal } from '@intafaced/auth';
import type { StepUpCheck } from '@intafaced/contracts';
import { assertBotVerification, type BotVerificationPolicy } from '../algo/bots-verification.js';
import { captureAlgoPlaceGrant, principalFromAlgoGrant } from '../algo/durable-principal.js';
import type { PlaceOrderInput } from '../spot/trade-service.js';
import type { FillRecord, Market, OrderRecord } from '../spot/types.js';
import { GridError } from './errors.js';
import { orderIdFor } from '../spot/ids.js';
import { floorTo, levelsBelowMark, markInRange, planGrid, type GridLevelPlan } from './plan.js';
import type { GridPolicy } from './policy.js';
import type { GridStore } from './store.js';
import {
  gridBusinessId,
  gridClientOrderId,
  gridReserveKey,
  gridWithdrawalKey,
  type GridBot,
  type GridOrder,
  type GridReserve,
  type GridStatus,
  type GridWithdrawal,
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
  /** Every fill of one order (not a page), so fees and proceeds are summed whole. */
  fillsForOrder(principal: Principal, orderId: string): Promise<FillRecord[]>;
  /** Identity's step-up check (contracts step-up-check.ts). Its two codes reach the caller unchanged. */
  readonly stepUp: StepUpCheck;
  now?: () => Date;
}

export interface GridWithdrawInput {
  readonly botId: string;
  /** The person's own key for this withdrawal: a retry with the same key answers the same receipt. */
  readonly requestId: string;
  readonly asset: string;
  readonly amount?: string | null;
  /** The identity step-up approval the person confirmed for exactly these fields. */
  readonly stepUpApprovalId?: string | null;
}

/** A withdrawal's receipt: every figure a decimal string, each read from the stored withdrawal row. */
export interface GridWithdrawalView {
  readonly withdrawalId: string;
  readonly botId: string;
  readonly asset: string;
  readonly amount: string;
  readonly profitBefore: string;
  readonly profitAfter: string;
  readonly reserveBefore: string;
  readonly reserveAfter: string;
  readonly dailyCap: string;
  readonly capUsed: string;
  readonly capRemaining: string;
  readonly stepUpEventId: string;
  readonly appliedAt: string;
}

export const GRID_WITHDRAW_STEP_UP_SCOPE = 'trade.step_up.bots.grid.withdrawProfit' as const;

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
  /** The person's own request key, so a room that lost the reply can find the bot it asked for. */
  readonly clientRequestId: string;
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
  /** Profit the reserve still holds for the bot (reserve less investment): what may be withdrawn. "0" once released. */
  readonly withdrawableProfit: string;
  readonly closedPairs: number;
  /**
   * Grid APR, simple: grid profit over the investment, times 365 over the days running (actual elapsed time, ACT/365),
   * as a percent rounded down to 2 decimals. No figure before a whole day has run: extrapolating hours inflates it.
   */
  readonly gridApr: { readonly state: 'under_a_day'; readonly percent: null } | { readonly state: 'set'; readonly percent: string };
  readonly createdAt: string;
}

export interface GridPresetsView {
  /** Null: no backtest source is set, so no preset and no APR exists. */
  readonly source: null;
  readonly presets: readonly [];
}

/** What the wizard may offer this person: it is only answered once they pass the owner's bot verification level. */
export interface GridSetupView {
  /** The owner's allowed grid counts, or null while either end is blank (every create then refuses). */
  readonly countRange: { readonly min: number; readonly max: number } | null;
  /** The most each bound may sit from the market price, in basis points, or null while blank (every create refuses). */
  readonly boundsMaxDistanceBps: number | null;
}

const REQUEST_KEY = /^[A-Za-z0-9:._-]{8,120}$/;
/** The longest request id identity's step-up check accepts (`ID_MAX` in packages/contracts/src/step-up-check.ts). */
const STEP_UP_REQUEST_ID_MAX = 128;
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

const withdrawHash = (botId: string, asset: string, amount: Amount): string =>
  createHash('sha256')
    .update(['bots.grid.withdraw', botId, asset, formatAmount(amount)].join('\0'))
    .digest('hex');

const withdrawalView = (w: GridWithdrawal): GridWithdrawalView => ({
  withdrawalId: w.withdrawalId,
  botId: w.botId,
  asset: w.asset,
  amount: formatAmount(w.amount),
  profitBefore: formatAmount(w.profitBefore),
  profitAfter: formatAmount(w.profitAfter),
  reserveBefore: formatAmount(w.reserveBefore),
  reserveAfter: formatAmount(w.reserveAfter),
  dailyCap: formatAmount(w.dailyCap),
  capUsed: formatAmount(w.capUsed),
  capRemaining: formatAmount(w.capRemaining),
  stepUpEventId: w.stepUpEventId,
  appliedAt: w.appliedAt.toISOString(),
});

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

const TERMINAL: ReadonlySet<OrderRecord['status']> = new Set(['filled', 'cancelled', 'rejected', 'expired']);
const LIVE: readonly GridStatus[] = ['running', 'paused_range'];
const isLive = (status: GridStatus) => LIVE.includes(status);
/** Statuses a stop or a failed start may leave: a live bot, or one whose create is still placing. */
const STOPPABLE: readonly GridStatus[] = ['initializing', ...LIVE];
/** A create that has not finished placing after this long stopped part way; the tick takes the bot over. */
const INITIALIZING_STALE_MS = 120_000;
const DAY_MS = 86_400_000;
const HUNDREDTH = parseAmount('0.01');

/** Each bound within the owner's distance of the market price (CB-bots-02); a blank distance refuses every create. */
function assertBoundsInBand(bps: number | null, lower: Amount, upper: Amount, mark: Amount): void {
  if (bps === null) {
    throw new GridError('The platform has not set how far the bounds may be from the market price', 'trade.bots_grid_bounds_band_not_set');
  }
  const percent = formatAmount(div(parseAmount(String(bps)), parseAmount('100')));
  const floor = bps >= 10_000 ? 0n : (mark * BigInt(10_000 - bps)) / 10_000n;
  const ceiling = (mark * BigInt(10_000 + bps)) / 10_000n;
  const details = { maxDistancePercent: percent, mark: formatAmount(mark), min: formatAmount(floor), max: formatAmount(ceiling) };
  if (lower < floor) {
    throw new GridError(`Lower price must be within ${percent}% of the market price`, 'trade.bots_grid_bounds_out_of_band', {
      field: 'Lower price',
      ...details,
    });
  }
  if (upper > ceiling) {
    throw new GridError(`Upper price must be within ${percent}% of the market price`, 'trade.bots_grid_bounds_out_of_band', {
      field: 'Upper price',
      ...details,
    });
  }
}

/** Grid APR from the profit, the principal committed and the milliseconds running; see GridBotView.gridApr. */
export function gridApr(profit: Amount, invested: Amount, elapsedMs: number): GridBotView['gridApr'] {
  if (elapsedMs < DAY_MS) return { state: 'under_a_day', percent: null };
  const num = profit * 100n * 100n * 365n * BigInt(DAY_MS);
  const den = invested * BigInt(Math.floor(elapsedMs));
  // Rounded down: toward minus infinity, so a loss never reads smaller than it is.
  const hundredths = num / den - (num % den < 0n ? 1n : 0n);
  return { state: 'set', percent: formatAmount(hundredths * HUNDREDTH) };
}
const INITIALIZATION_FAILED = 'The grid could not place its levels; nothing is left running';

/** A level order id the bot may hold with no row of its own: the next buy of a level, or the sell of a bought pair. */
interface OrderSlot {
  readonly clientOrderId: string;
  readonly levelIndex: number;
  readonly side: 'buy' | 'sell';
  readonly cycle: number;
}

export class GridService {
  /** Bots this process is driving now, so a replay and the tick never place the same level order at once. */
  private readonly driving = new Set<string>();

  constructor(private readonly ports: GridPorts) {}

  private now(): Date {
    return this.ports.now?.() ?? new Date();
  }

  presets(): GridPresetsView {
    // No backtest source exists (policy.ts): never a sample range, never an APR.
    return { source: this.ports.policy.presetSource, presets: [] };
  }

  /** The wizard's first read: refuses below the owner's verification level (or a blank level), as create does. */
  setup(principal: Principal): GridSetupView {
    assertBotVerification(this.ports.verification(), principal.tier);
    return { countRange: this.ports.policy.countRange, boundsMaxDistanceBps: this.ports.policy.boundsMaxDistanceBps };
  }

  async create(principal: Principal, input: GridCreateInput): Promise<GridBotView> {
    assertBotVerification(this.ports.verification(), principal.tier);
    const botId = gridBotIdFor(principal.userId, input.clientRequestId);
    const hash = requestHash(input);
    const already = await this.ports.store.findBot(botId);
    if (already) return this.sameRequest(already, hash);

    const lower = positiveAmount(input.lowerPrice, 'trade.bots_grid_bounds_not_set', 'Lower price');
    const upper = positiveAmount(input.upperPrice, 'trade.bots_grid_bounds_not_set', 'Upper price');
    if (!(lower < upper)) throw new GridError('Lower price must be below upper price', 'trade.grid_bounds_inverted');
    const investment = positiveAmount(input.investment, 'trade.grid_investment_required', 'Investment');
    const count = input.gridCount;
    if (count === null || count === undefined) throw new GridError('Grids is required', 'trade.grid_count_required', { field: 'Grids' });
    const range = this.ports.policy.countRange;
    if (!range) throw new GridError('The platform has not set how many grids a bot may use', 'trade.grid_count_range_not_set');
    if (!Number.isInteger(count) || count < range.min || count > range.max) {
      throw new GridError(`Grids must be from ${range.min} to ${range.max}`, 'trade.bots_grid_count_out_of_range', {
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
    assertBoundsInBand(this.ports.policy.boundsMaxDistanceBps, lower, upper, mark);

    const asset = market.quoteAsset;
    // Free quote less every other reserve. The save runs this again under the owner's reserve lock, where a copy follow
    // or another grid create of the same asset waits its turn, so the balance and both reserve sums are read after them.
    const fits = async (gridUnused: Amount) => {
      const free = await this.ports.freeBalance(principal.userId, asset);
      const left = free - (await this.ports.copyUnusedReserves(principal.userId, asset)) - gridUnused;
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
    // A quick refusal before admission.
    await fits(await this.ports.store.sumUnusedReserves(principal.userId, asset));

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
      status: markInRange(lower, upper, mark) ? 'initializing' : 'paused_range',
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
    const saved = await this.ports.store.createWithReserve(bot, reserve, fits);
    if (!saved.created) return this.sameRequest(saved.bot, hash);

    if (bot.status === 'initializing') {
      // Driven by this create until it returns: neither a tick nor the stale takeover in this process places for it.
      this.driving.add(botId);
      try {
        try {
          await this.placeMissingBuys(principal, bot, market, mark, []);
        } catch (error) {
          await this.failInitialization(principal, bot, error);
        }
        // A stop that landed while the levels were placed wins: what was placed is cancelled. A bot another process
        // took over as stale is live and stays as it is.
        if (!(await this.ports.store.setStatus(botId, 'running', null, this.now(), ['initializing']))) {
          const after = await this.stored(botId);
          if (!isLive(after.status)) await this.windDown(principal, after);
        }
      } finally {
        this.driving.delete(botId);
      }
    }
    return this.view(await this.stored(botId));
  }

  private async stored(botId: string): Promise<GridBot> {
    const bot = await this.ports.store.findBot(botId);
    if (!bot) throw new GridError('Grid bot not found', 'trade.grid_not_found');
    return bot;
  }

  private async sameRequest(bot: GridBot, hash: string): Promise<GridBotView> {
    if (bot.requestHash !== hash) {
      throw new GridError('This request key already made a different grid bot', 'trade.grid_request_conflict');
    }
    if (bot.status === 'initialization_failed') {
      throw new GridError(INITIALIZATION_FAILED, 'trade.grid_initialization_failed', {
        reason: bot.statusReason ?? 'trade.grid_initialization_failed',
      });
    }
    // A bot still initializing is being placed by the first press (or the tick takes it over once stale): never twice.
    if (isLive(bot.status)) await this.tick(bot);
    return this.view(await this.stored(bot.botId));
  }

  /** Returns only when another process took the bot over as stale: it is live, and that tick places what is missing. */
  private async failInitialization(principal: Principal, bot: GridBot, error: unknown): Promise<void> {
    const reason = (error as { code?: string })?.code ?? 'trade.grid_initialization_failed';
    // The status first: no tick places for it from here, and a wind-down that cannot finish now is retried by the tick.
    // Only from initializing: a stop already stands, and a bot taken over is running.
    if (!(await this.ports.store.setStatus(bot.botId, 'initialization_failed', reason, this.now(), ['initializing']))) {
      if (isLive((await this.stored(bot.botId)).status)) return;
    }
    try {
      await this.windDown(principal, bot);
    } catch {
      // The reserve stays held; the tick's wind-down pass tries again.
    }
    throw new GridError(INITIALIZATION_FAILED, 'trade.grid_initialization_failed', { reason });
  }

  /** One buy per level strictly below the mark that has no open order, never on the top level (it has no level above). */
  private async placeMissingBuys(
    principal: Principal,
    bot: GridBot,
    market: Market,
    mark: Amount,
    orders: readonly GridOrder[],
  ): Promise<void> {
    for (const level of levelsBelowMark(bot.levels, mark)) {
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
    return this.view(bot);
  }

  /**
   * Withdraw grid profit (CB-bots-05), in this order, so a refusal writes nothing:
   * 1. the owner's bots verification level, the request key, the amount, and the owner's daily cap for the asset (an
   *    asset with no cap refuses `trade.bots_withdraw_cap_unset`), none of which reads a row;
   * 2. identity's step-up for exactly these fields, before any read or write: `identity.step_up_required` and
   *    `identity.step_up_unavailable` pass through unchanged, so identity down writes nothing;
   * 3. the bot is the caller's, its quote asset is the asset, and a withdrawal already stored under
   *    `bots.grid.withdraw:<botId>:<requestId>` is answered as stored (a different body conflicts);
   * 4. under the owner's reserve lock: over what is left of today's cap refuses `trade.bots_withdraw_cap_exceeded`;
   *    over the profit the reserve holds above the investment refuses `trade.bots_withdraw_exceeds_profit`; over the
   *    owner's free ledger balance of the asset refuses `trade.bots_withdraw_exceeds_balance`; otherwise the reserve row
   *    is lowered by the amount and the receipt row is written, together.
   * No ledger row is posted: the profit is already in the owner's balance, and the reserve is a limit row.
   */
  async withdrawProfit(principal: Principal, input: GridWithdrawInput): Promise<GridWithdrawalView> {
    assertBotVerification(this.ports.verification(), principal.tier);
    if (!REQUEST_KEY.test(input.requestId)) {
      throw new GridError('requestId must be 8 to 120 letters, digits or : . _ -', 'trade.grid_request_key_invalid');
    }
    const amount = positiveAmount(input.amount, 'trade.bots_withdraw_amount_invalid', 'Amount');
    const asset = input.asset;
    const cap = this.ports.policy.withdrawDailyCap.get(asset);
    if (cap === undefined) {
      throw new GridError(`The platform has not set a daily withdrawal cap for ${asset}`, 'trade.bots_withdraw_cap_unset', { asset });
    }
    const withdrawalId = gridWithdrawalKey(input.botId, input.requestId);
    // Identity's step-up takes a request id of at most 128 characters; refuse a longer key here, typed, not as a 500.
    if (withdrawalId.length > STEP_UP_REQUEST_ID_MAX) {
      throw new GridError('requestId is too long for this bot', 'trade.grid_request_key_invalid');
    }
    const stepUp = await this.ports.stepUp.require({
      scope: GRID_WITHDRAW_STEP_UP_SCOPE,
      userId: principal.userId,
      sessionId: principal.sid,
      approvalId: input.stepUpApprovalId,
      fields: { botId: input.botId, requestId: input.requestId, asset, amount: (input.amount ?? '').trim() },
      requestId: withdrawalId,
    });

    const bot = await this.ports.store.findBot(input.botId);
    if (!bot || bot.userId !== principal.userId) throw new GridError('Grid bot not found', 'trade.grid_not_found');
    if (bot.quoteAsset !== asset) {
      throw new GridError(`This bot's profit is in ${bot.quoteAsset}, not ${asset}`, 'trade.bots_withdraw_asset_mismatch', {
        asset: bot.quoteAsset,
      });
    }
    const hash = withdrawHash(bot.botId, asset, amount);
    const same = (w: GridWithdrawal): GridWithdrawalView => {
      if (w.requestHash !== hash) {
        throw new GridError('This request key already withdrew a different amount', 'trade.bots_withdraw_conflict');
      }
      return withdrawalView(w);
    };
    const stored = await this.ports.store.findWithdrawal(withdrawalId);
    if (stored) return same(stored);

    // The profit can be withdrawn only while the ledger still has it free: the bot's base or open holds are not.
    const free = await this.ports.freeBalance(principal.userId, asset);
    const at = this.now();
    const result = await this.ports.store.withdraw({ withdrawalId, botId: bot.botId, userId: principal.userId, asset, at }, (state) => {
      const reserve = state.reserve;
      if (!reserve || reserve.releasedAt !== null) {
        throw new GridError(
          'This bot has stopped and released its reserve; its profit is already free',
          'trade.bots_withdraw_reserve_released',
        );
      }
      const remaining = cap > state.usedToday ? cap - state.usedToday : 0n;
      if (amount > remaining) {
        throw new GridError(
          `That is more than today's withdrawal cap allows: ${formatAmount(remaining)} ${asset} left`,
          'trade.bots_withdraw_cap_exceeded',
          {
            cap: formatAmount(cap),
            used: formatAmount(state.usedToday),
            remaining: formatAmount(remaining),
          },
        );
      }
      const profit = reserve.amount > bot.investment ? reserve.amount - bot.investment : 0n;
      if (amount > profit) {
        throw new GridError(`That is more than the bot's profit: ${formatAmount(profit)} ${asset}`, 'trade.bots_withdraw_exceeds_profit', {
          available: formatAmount(profit),
        });
      }
      if (amount > free) {
        throw new GridError(
          `That is more than your free ${asset}: ${formatAmount(free > 0n ? free : 0n)} ${asset}`,
          'trade.bots_withdraw_exceeds_balance',
          { available: formatAmount(free > 0n ? free : 0n) },
        );
      }
      return {
        withdrawalId,
        botId: bot.botId,
        userId: principal.userId,
        requestId: input.requestId,
        requestHash: hash,
        asset,
        amount,
        profitBefore: profit,
        profitAfter: profit - amount,
        reserveBefore: reserve.amount,
        reserveAfter: reserve.amount - amount,
        dailyCap: cap,
        capUsed: state.usedToday + amount,
        capRemaining: remaining - amount,
        stepUpEventId: stepUp.stepUpEventId,
        appliedAt: at,
      };
    });
    return result.created ? withdrawalView(result.withdrawal) : same(result.withdrawal);
  }

  async list(principal: Principal): Promise<GridBotView[]> {
    const bots = await this.ports.store.listBots(principal.userId);
    return Promise.all(bots.map((b) => this.view(b)));
  }

  /**
   * Stop: nothing new is placed, every open level order is cancelled, then the reserve is released. Base already bought
   * stays in the owner's balance. A second stop, or a stop of a failed start, runs the wind-down again.
   */
  async stop(principal: Principal, botId: string): Promise<GridBotView> {
    const bot = await this.ports.store.findBot(botId);
    if (!bot || bot.userId !== principal.userId) throw new GridError('Grid bot not found', 'trade.grid_not_found');
    await this.ports.store.setStatus(botId, 'stopped', 'owner_stop', this.now(), STOPPABLE);
    await this.windDown(principal, bot);
    return this.view(await this.stored(botId));
  }

  /**
   * Cancel every order the bot has, or may have, open; release the reserve once none is left open. Besides the bot's
   * own open rows it reads back the next order id of each level, so a place that reached the engine but whose row was
   * never saved is found and cancelled too. A filled buy places no sell here: its base stays the owner's.
   */
  private async windDown(principal: Principal, bot: GridBot): Promise<void> {
    const orders = await this.ports.store.listOrders(bot.botId);
    let left = 0;
    for (const order of orders.filter((o) => o.status === 'open')) {
      try {
        if (!(await this.closeOne(principal, bot, order))) left += 1;
      } catch {
        left += 1;
      }
    }
    for (const slot of this.unsavedSlots(bot, orders)) {
      try {
        const record = await this.ports.findOrder(orderIdFor(bot.userId, bot.marketId, slot.clientOrderId));
        if (!record) continue;
        const order = await this.ports.store.saveOrder({
          ...slot,
          botId: bot.botId,
          orderId: record.id,
          price: record.price ?? 0n,
          qty: record.qty,
          holdAmount: record.holdAmount,
          status: 'open',
          pairProfit: null,
          placedAt: this.now(),
          closedAt: null,
        });
        if (order.status === 'open' && !(await this.closeOne(principal, bot, order))) left += 1;
      } catch {
        left += 1;
      }
    }
    if (left === 0) await this.ports.store.releaseReserve(bot.botId, this.now());
  }

  /** Cancel one open level order and record how it ended. False while the trade service still reports it open. */
  private async closeOne(principal: Principal, bot: GridBot, order: GridOrder): Promise<boolean> {
    let record = await this.ports.findOrder(order.orderId);
    if (!record) return true;
    if (!TERMINAL.has(record.status)) {
      await this.ports.cancelOrder(principal, order.orderId);
      record = await this.ports.findOrder(order.orderId);
    }
    if (!record || !TERMINAL.has(record.status)) return false;
    await this.settle(principal, bot, null, order, record);
    return true;
  }

  /** Each level's next buy, and the sell of each bought pair, that has no row. */
  private unsavedSlots(bot: GridBot, orders: readonly GridOrder[]): OrderSlot[] {
    const saved = new Set(orders.map((o) => o.clientOrderId));
    const slots: OrderSlot[] = [];
    for (const level of bot.levels) {
      if (level.index === bot.gridCount - 1) continue;
      const buys = orders.filter((o) => o.levelIndex === level.index && o.side === 'buy');
      slots.push({ clientOrderId: '', levelIndex: level.index, side: 'buy', cycle: buys.length });
      for (const buy of buys)
        if (buy.status !== 'cancelled') slots.push({ clientOrderId: '', levelIndex: level.index, side: 'sell', cycle: buy.cycle });
    }
    return slots
      .map((s) => ({ ...s, clientOrderId: gridClientOrderId(bot.botId, s.levelIndex, s.side, s.cycle) }))
      .filter((s) => !saved.has(s.clientOrderId));
  }

  private tickPrincipal(bot: GridBot): Principal {
    const now = this.now();
    return principalFromAlgoGrant({
      userId: bot.userId,
      grant: bot.placeGrant,
      expiresAt: new Date(now.getTime() + TICK_AUTHORITY_MS),
      now,
    });
  }

  /**
   * One pass over every live bot, then over every bot still winding down. A failing bot is recorded on its row (only
   * while its status is still the one read) and does not stop the others.
   */
  async tickAll(): Promise<void> {
    // A create that stopped part way (a crash, a lost connection): running from here, so this pass places what it missed.
    const stale = new Date(this.now().getTime() - INITIALIZING_STALE_MS);
    for (const bot of await this.ports.store.listStaleInitializing(stale)) {
      // A create in this process that is only slow still drives it.
      if (this.driving.has(bot.botId)) continue;
      await this.ports.store.setStatus(bot.botId, 'running', null, this.now(), ['initializing']);
    }
    for (const bot of await this.ports.store.listLiveBots()) {
      try {
        await this.tick(bot);
      } catch (error) {
        const reason = (error as { code?: string })?.code ?? 'trade.grid_tick_failed';
        await this.ports.store.setStatus(bot.botId, bot.status, reason, this.now(), [bot.status]);
      }
    }
    for (const bot of await this.ports.store.listWindingDown()) {
      try {
        await this.windDown(this.tickPrincipal(bot), bot);
      } catch {
        // The reserve stays held; the next pass tries again.
      }
    }
  }

  async tick(bot: GridBot): Promise<void> {
    // Already being driven in this process (the tick and a replay at once): that pass places what is missing.
    if (this.driving.has(bot.botId)) return;
    this.driving.add(bot.botId);
    const principal = this.tickPrincipal(bot);
    try {
      await this.drive(principal, bot);
    } finally {
      try {
        // A stop that landed while this tick ran: what the tick placed meanwhile is cancelled, as the stop cancelled the rest.
        const after = await this.ports.store.findBot(bot.botId);
        if (after && !isLive(after.status)) await this.windDown(principal, after);
      } finally {
        this.driving.delete(bot.botId);
      }
    }
  }

  private async drive(principal: Principal, bot: GridBot): Promise<void> {
    const market = await this.ports.marketBySymbol(bot.symbol);
    if (!market) throw new GridError(`Market ${bot.symbol} not found`, 'trade.grid_market_not_found');

    for (const order of await this.ports.store.listOrders(bot.botId)) {
      if (order.status !== 'open') continue;
      const record = await this.ports.findOrder(order.orderId);
      if (record && TERMINAL.has(record.status)) await this.settle(principal, bot, market, order, record);
    }

    const mark = markOf(await this.ports.depth(market.id));
    if (mark === null) return;
    if (!markInRange(bot.lowerPrice, bot.upperPrice, mark)) {
      if (bot.status !== 'paused_range') {
        await this.ports.store.setStatus(bot.botId, 'paused_range', 'mark_outside_range', this.now(), ['running']);
      }
      return;
    }
    if (bot.status !== 'running' && !(await this.ports.store.setStatus(bot.botId, 'running', null, this.now(), ['paused_range']))) {
      return;
    }
    await this.placeMissingBuys(principal, bot, market, mark, await this.ports.store.listOrders(bot.botId));
  }

  /**
   * Record how one level order the trade service reports terminal ended. With `market` (a live tick) a filled buy first
   * places its sell one level up; a crash between the two re-places the same clientOrderId, which is the same order.
   */
  private async settle(principal: Principal, bot: GridBot, market: Market | null, order: GridOrder, record: OrderRecord): Promise<void> {
    if (record.filledQty === 0n) {
      await this.ports.store.closeOrder(order.clientOrderId, 'cancelled', null, this.now());
      return;
    }
    const fills = await this.ports.fillsForOrder(principal, order.orderId);
    if (order.side === 'buy') {
      const above = bot.levels[order.levelIndex + 1];
      if (market && above) {
        const baseFee = fills.filter((f) => f.feeAsset === bot.baseAsset).reduce((a, f) => a + f.feeAmount, 0n);
        const qty = floorTo(record.filledQty - baseFee, market.lotSize);
        if (qty > 0n && qty >= market.minQty) {
          await this.placeAndRecord(principal, bot, market, bot.levels[order.levelIndex]!, 'sell', order.cycle, above.price, qty);
        }
      }
      await this.ports.store.closeOrder(order.clientOrderId, 'filled', null, this.now());
      return;
    }
    if (record.filledQty < record.qty) {
      await this.ports.store.closeOrder(order.clientOrderId, 'partial', null, this.now());
      return;
    }
    const buy = (await this.ports.store.listOrders(bot.botId)).find(
      (o) => o.levelIndex === order.levelIndex && o.side === 'buy' && o.cycle === order.cycle,
    );
    const profit = buy ? await this.pairProfit(principal, bot, buy, fills) : null;
    await this.ports.store.closeOrder(order.clientOrderId, 'filled', profit, this.now());
  }

  /**
   * Quote received by the sell net of its quote fee, less the quote the buy spent and its quote fee. Null when a leg's
   * fee was taken in a third asset: that profit cannot be stated in the quote asset without a price, so it is not guessed.
   */
  private async pairProfit(principal: Principal, bot: GridBot, buy: GridOrder, sellFills: FillRecord[]): Promise<Amount | null> {
    const buyFills = await this.ports.fillsForOrder(principal, buy.orderId);
    const known = (f: FillRecord) => f.feeAmount === 0n || f.feeAsset === bot.baseAsset || f.feeAsset === bot.quoteAsset;
    if (![...buyFills, ...sellFills].every(known)) return null;
    const fee = (fills: FillRecord[], asset: string) => fills.filter((f) => f.feeAsset === asset).reduce((a, f) => a + f.feeAmount, 0n);
    const quote = (fills: FillRecord[]) => fills.reduce((a, f) => a + f.quoteAmount, 0n);
    const base = (fills: FillRecord[]) => fills.reduce((a, f) => a + f.qty, 0n);
    // What the buy cost and what it delivered, each net of its fee. The sell is floored to the lot, so it may sell less
    // than the buy delivered: the pair is charged only the cost of the base it sold, and the rest stays the owner's.
    const bought = base(buyFills) - fee(buyFills, bot.baseAsset);
    const sold = base(sellFills) + fee(sellFills, bot.baseAsset);
    if (bought <= 0n || sold > bought) return null;
    const cost = div(mul(quote(buyFills) + fee(buyFills, bot.quoteAsset), sold, 'ceil'), bought, 'ceil');
    return quote(sellFills) - fee(sellFills, bot.quoteAsset) - cost;
  }

  /** What a withdrawal may take now: the profit the reserve holds above the investment, at most the free ledger balance. */
  private async withdrawable(bot: GridBot, reserve: GridReserve | null): Promise<Amount> {
    if (!reserve || reserve.releasedAt !== null || reserve.amount <= bot.investment) return 0n;
    const profit = reserve.amount - bot.investment;
    const free = await this.ports.freeBalance(bot.userId, bot.quoteAsset);
    return free <= 0n ? 0n : free < profit ? free : profit;
  }

  private async view(bot: GridBot): Promise<GridBotView> {
    const botId = bot.botId;
    const orders = await this.ports.store.listOrders(botId);
    const reserve = await this.ports.store.getReserve(botId);
    const closed = orders.filter((o) => o.side === 'sell' && o.status === 'filled' && o.pairProfit !== null);
    const gridProfit = closed.reduce((a, o) => a + o.pairProfit!, 0n);
    const openAt = (index: number) => {
      const o = orders.find((x) => x.status === 'open' && (x.side === 'buy' ? x.levelIndex === index : x.levelIndex + 1 === index));
      return o ? { side: o.side, orderId: o.orderId, clientOrderId: o.clientOrderId } : null;
    };
    return {
      botId,
      clientRequestId: bot.clientRequestId,
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
      gridProfit: formatAmount(gridProfit),
      withdrawableProfit: formatAmount(await this.withdrawable(bot, reserve)),
      closedPairs: closed.length,
      gridApr: gridApr(gridProfit, bot.investment, this.now().getTime() - bot.createdAt.getTime()),
      createdAt: bot.createdAt.toISOString(),
    };
  }
}
