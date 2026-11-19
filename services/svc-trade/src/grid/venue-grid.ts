import { createHash } from 'node:crypto';
import type { z } from 'zod';
import { venueGridSchema } from '@intafaced/contracts/trade-grid-procedures';
import { keccak256, toHex, type TypedDataDefinition } from 'viem';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { add, compare, div, formatAmount, mul, parseAmount, sub, ZERO, type Amount } from '@intafaced/ledger-client/money';
import { AuthError, type Principal } from '@intafaced/auth';
import { JurisdictionError } from '@intafaced/contracts';
import {
  encodeVenueWire,
  isTestVenue,
  VenueRefusalError,
  type PlaceUserOrderIntent,
  type PreparedVenueAction,
  type UserVenueAccount,
  type UserVenueFill,
  type UserVenueMarket,
  type VenueSignature,
  type VenueSubmitOutcome,
} from '@intafaced/venue-contracts';
import { assertBotVerification, type BotVerificationPolicy } from '../algo/bots-verification.js';
import { NO_PAUSES, botOrdersHalted, newBotPausedReason, type PauseSnapshot } from '../copy/platform-pauses.js';
import type { AccountFreezeRead } from '../quant/live-run/ports.js';
import { assertPlaceEligible } from '../spot/place-eligibility.js';
import { engineActor } from '../venue/protections.js';
import { UserVenueDoorError, type UserVenueDoor } from '../venue/user-venue-door.js';
import { GridError } from './errors.js';
import { assertBoundsInBand, checkGridFields, gridApr, gridBotIdFor, type GridCreateInput } from './grid-service.js';
import { floorTo, levelsBelowMark, markInRange, planGrid } from './plan.js';
import type { GridPolicy } from './policy.js';
import { gridClientOrderId } from './types.js';
import type { VenueGridBot, VenueGridOrder, VenueGridStatus, VenueGridStore } from './venue-grid-store.js';

/**
 * THE SPOT GRID BOT ON THE PERSON'S OWN VENUE ACCOUNT (J-copy-bots-otc-14; CB-bots-02, CB-bots-05, CB-bots-10).
 *
 * Money (J-copy-bots-otc-14 "Money"): INTAFACED holds and moves nothing. The person's coins stay on their own venue
 * account. Each level is one venue limit order on that account, placed under its own business key
 * (`grid:<botId>:<level>:b|s<cycle>`, from which the venue's client order id derives), signed by the grid agent key
 * INTAFACED derives for the person on that account and the person's wallet approves there (the agent permission). The
 * venue lets an agent key place and cancel orders and nothing else: it can never withdraw or approve. Before the key signs
 * a buy, our policy holds the bot to its cap, the investment: the quote every open buy of the bot holds, with this one,
 * never exceeds it. A sell is for the base its own buy received, never more. Each order holds only what the venue locks
 * for it. Grid profit is the sum of closed level pairs, each the sell's quote less the venue's fee and our builder fee,
 * less what the base it sold cost on the buy below it (its fees included), all read from the venue's fills. The ledger
 * posts nothing here: our builder fee on each fill is posted once by the builder-fee poster (builder-fee-poster.ts),
 * which reads the fills of every order our door stored.
 *
 * Crash points (whose funds are stranded? none, ever): an order row is written before its key signs; the door stores the
 * signed bytes before they are sent, and the next pass reads the venue's record by the key first and re-sends only those
 * bytes. Everything rests or fills on the person's own account, which their wallet controls; a stop cancels what is open.
 */

export const GRID_AGENT_NAME = 'grid-bots';
/** The grid agent permission's business key on one venue account. */
export const gridAgentKey = (owner: string, agentAddress: string) => `grid-agent:${owner.toLowerCase()}:${agentAddress.toLowerCase()}`;

const ADDRESS_RE = /^0x[0-9a-f]{40}$/;
const OPEN: ReadonlySet<string> = new Set(['pending', 'open', 'partially_filled']);
const LIVE: readonly VenueGridStatus[] = ['initializing', 'running', 'paused_range'];
const OUT_OF_RANGE = 'mark_outside_range';
export const WITHDRAW_REFUSED = "A bot's agent permission can't withdraw. Withdraw from the venue with your own wallet; nothing was moved.";

export interface VenueGridDeps {
  readonly door: UserVenueDoor;
  readonly store: VenueGridStore;
  readonly policy: GridPolicy;
  readonly verification: () => BotVerificationPolicy;
  /** The seed every venue agent key here derives from (TRADE_AGENT_KEY_SEED); blank refuses every venue grid. */
  readonly keySeed: string;
  /** The person's level, read from identity before each order the bot sends. */
  readonly liveTier: (userId: string) => Promise<Principal['tier']>;
  /** The person's own freeze, read before each order the bot sends (null: no order is sent). */
  readonly freeze: AccountFreezeRead | null;
  readonly platformPauses?: () => Promise<PauseSnapshot>;
  readonly now: () => Date;
}

/** A venue grid as the person reads it: its record's reply (`@intafaced/contracts/trade-grid-procedures`). */
export type VenueGridView = z.output<typeof venueGridSchema>;
type VenueGridNext = NonNullable<VenueGridView['next']>;
const NEXT_TYPED_DATA = venueGridSchema.shape.next.unwrap().shape.typedData;

const sameOwner = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

function requestHash(input: GridCreateInput & { owner: string }): string {
  const body = [
    'venue',
    input.owner.toLowerCase(),
    input.symbol,
    input.lowerPrice ?? '',
    input.upperPrice ?? '',
    String(input.gridCount ?? ''),
    input.investment ?? '',
  ];
  return createHash('sha256').update(body.join('\0')).digest('hex');
}

const sumOf = (xs: readonly Amount[]) => xs.reduce((a, b) => add(a, b), ZERO);

/**
 * One closed level pair's profit, from the venue's fills of its buy and its sell: the sell's quote less its fees in the
 * quote, less the share of the buy's cost (its quote and any fee charged in the quote) that the base sold is of the base
 * the buy received net of any fee charged in the base. The cost share is rounded up, so a profit is never overstated.
 */
export function pairProfit(
  market: Pick<UserVenueMarket, 'baseAsset' | 'quoteAsset'>,
  buy: readonly UserVenueFill[],
  sell: readonly UserVenueFill[],
): Amount {
  const fee = (fills: readonly UserVenueFill[], asset: string) =>
    sumOf(fills.filter((f) => f.feeAsset === asset).map((f) => add(f.venueFee, f.builderFee)));
  const quoteOf = (fills: readonly UserVenueFill[]) => sumOf(fills.map((f) => mul(f.price, f.amount, 'floor')));
  const received = sub(sumOf(buy.map((f) => f.amount)), fee(buy, market.baseAsset));
  const cost = add(quoteOf(buy), fee(buy, market.quoteAsset));
  const sold = add(sumOf(sell.map((f) => f.amount)), fee(sell, market.baseAsset));
  const share = compare(received, ZERO) > 0 ? div(mul(cost, sold, 'ceil'), received, 'ceil') : cost;
  return sub(sub(quoteOf(sell), fee(sell, market.quoteAsset)), share);
}

export class VenueGrid {
  /** Bots this process is driving now, so a create and the tick never place the same level at once. */
  private readonly driving = new Map<string, Promise<unknown>>();

  constructor(private readonly deps: VenueGridDeps) {}

  /** The grid agent key INTAFACED holds for one person's grids on one venue account. Derived, never stored. */
  gridKey(userId: string, owner: string): PrivateKeyAccount {
    if (this.deps.keySeed.trim() === '') {
      throw new GridError(
        'No key seed is set for the grid agent key (owner value blank), so no grid runs on the venue',
        'trade.bots_grid_agent_key_unset',
      );
    }
    return privateKeyToAccount(
      keccak256(toHex(`intafaced grid bot key\u0000${this.deps.keySeed}\u0000${userId}\u0000${owner.toLowerCase()}`)),
    );
  }

  private pauses(): Promise<PauseSnapshot> {
    return this.deps.platformPauses ? this.deps.platformPauses() : Promise.resolve(NO_PAUSES);
  }

  /** One bot at a time per process: a create, a signature, a stop and the tick for it run one after another. */
  private async locked<T>(botId: string, f: () => Promise<T>): Promise<T> {
    const before = this.driving.get(botId) ?? Promise.resolve();
    const run = before.then(f, f);
    const settled = run.catch(() => undefined);
    this.driving.set(botId, settled);
    try {
      return await run;
    } finally {
      if (this.driving.get(botId) === settled) this.driving.delete(botId);
    }
  }

  private async venueOf(owner: string) {
    const venue = await this.deps.door.venue();
    const account: UserVenueAccount = await this.deps.door.account(owner);
    return { venue, account };
  }

  private async market(owner: string, symbol: string): Promise<UserVenueMarket> {
    const { venue, account } = await this.venueOf(owner);
    const market = (await venue.markets(account)).value.find((m) => m.symbol === symbol);
    if (!market) throw new GridError(`Market ${symbol} not found on ${venue.venue.displayName}`, 'trade.grid_market_not_found');
    if (market.kind !== 'spot' || (market.status !== null && market.status !== 'trading')) {
      throw new GridError(`${symbol} is not an open spot market`, 'trade.grid_market_not_spot');
    }
    return market;
  }

  /** The mid of the venue's best bid and ask; null while either side is empty. */
  private async mark(symbol: string): Promise<Amount | null> {
    const venue = await this.deps.door.venue();
    const book = (await venue.book(symbol, 1)).value;
    const bid = book.bids[0]?.price;
    const ask = book.asks[0]?.price;
    return bid !== undefined && ask !== undefined ? div(add(bid, ask), parseAmount('2'), 'half-up') : null;
  }

  async create(principal: Principal, input: GridCreateInput & { owner?: string | null }, region: string): Promise<VenueGridView> {
    assertBotVerification(this.deps.verification(), principal.tier);
    const botId = gridBotIdFor(principal.userId, input.clientRequestId);
    const owner = typeof input.owner === 'string' ? input.owner.trim().toLowerCase() : '';
    const hash = requestHash({ ...input, owner });
    const already = await this.deps.store.find(botId);
    if (already) {
      if (already.requestHash !== hash)
        throw new GridError('This request key already made a different grid bot', 'trade.grid_request_conflict');
      return this.locked(botId, async () => this.view(principal, await this.advance(principal, already)));
    }
    const { lower, upper, investment, count } = checkGridFields(input, this.deps.policy);
    if (!ADDRESS_RE.test(owner)) {
      throw new GridError('Connect your wallet: the bot trades on your own venue account', 'trade.bots_grid_wallet_required', {
        field: 'Wallet',
      });
    }
    const market = await this.market(owner, input.symbol);
    const pausedWhy = newBotPausedReason(await this.pauses(), 'grid', market.symbol);
    if (pausedWhy) throw new GridError(pausedWhy, 'trade.bots_paused_by_platform');
    const plan = planGrid({
      lower,
      upper,
      count,
      investment,
      market: {
        tickSize: market.tickSize,
        lotSize: market.lotSize,
        minQty: market.lotSize,
        minNotional: market.minOrderNotional ?? ZERO,
        maxQty: market.maxOrderQty,
      },
    });
    const mark = await this.mark(market.symbol);
    if (mark === null) throw new GridError(`${market.symbol} has no bid and ask to place a grid around`, 'trade.grid_mark_unavailable');
    assertBoundsInBand(this.deps.policy.boundsMaxDistanceBps, lower, upper, mark);

    const { venue, account } = await this.venueOf(owner);
    // The bot's cap is the investment: it must be free on the person's own venue account now, as the venue reports it.
    let free: Amount;
    try {
      free = (await venue.balances(account)).value.find((b) => b.asset === market.quoteAsset)?.free ?? ZERO;
    } catch (err) {
      if (err instanceof VenueRefusalError) {
        throw new GridError(
          `${venue.venue.displayName} could not be read just now: ${err.refusal.detail}`,
          'trade.bots_grid_venue_unreadable',
        );
      }
      throw err;
    }
    if (compare(investment, free) > 0) {
      throw new GridError(
        `Investment ${formatAmount(investment)} ${market.quoteAsset} is more than the ${formatAmount(free)} ${market.quoteAsset} free on your ${venue.venue.displayName} account`,
        'trade.grid_reserve_exceeds_balance',
        { asset: market.quoteAsset, free: formatAmount(free) },
      );
    }
    // Every sell carries our builder fee: without the person's approval of it the venue would refuse each sell.
    await this.assertBuilderFeeApproved(account, market.symbol);

    const agent = this.gridKey(principal.userId, owner);
    const at = this.deps.now();
    const bot: VenueGridBot = {
      botId,
      userId: principal.userId,
      clientRequestId: input.clientRequestId,
      requestHash: hash,
      venueId: venue.venue.id,
      owner,
      agentAddress: agent.address.toLowerCase(),
      region,
      symbol: market.symbol,
      baseAsset: market.baseAsset,
      quoteAsset: market.quoteAsset,
      lowerPrice: lower,
      upperPrice: upper,
      gridCount: count,
      investment,
      levels: plan.levels,
      status: 'signing',
      statusReason: null,
      createdAt: at,
      updatedAt: at,
    };
    const saved = await this.deps.store.insertOnce(bot);
    if (!saved.created && saved.bot.requestHash !== hash) {
      throw new GridError('This request key already made a different grid bot', 'trade.grid_request_conflict');
    }
    return this.locked(botId, async () => this.view(principal, await this.advance(principal, saved.bot)));
  }

  private async assertBuilderFeeApproved(account: UserVenueAccount, symbol: string): Promise<void> {
    const venue = await this.deps.door.venue();
    const fee = await this.deps.door.builderFeeFor(symbol, 'sell', 'spot');
    const status = await this.deps.door.status();
    const builder = 'builder' in status ? status.builder : null;
    if (fee === null || !builder) {
      throw new GridError(
        'Our builder fee is not published, so a grid would have no sell it could place',
        'trade.bots_grid_builder_fee_unapproved',
      );
    }
    if (!fee.carries) return;
    const approved = (await venue.builderFeeApproval(account, builder.address)).value;
    if (compare(approved, fee.feeBps) < 0) {
      throw new GridError(
        `Approve our builder fee on your ${venue.venue.displayName} account first: every sell of the grid carries it`,
        'trade.bots_grid_builder_fee_unapproved',
        { feeBps: formatAmount(fee.feeBps) },
      );
    }
  }

  /** Whether the venue lists the bot's agent permission on the person's account now. */
  private async permitted(bot: VenueGridBot): Promise<boolean> {
    const { venue, account } = await this.venueOf(bot.owner);
    const listed = (await venue.agents(account)).value.find((a) => a.address.toLowerCase() === bot.agentAddress);
    return !!listed && (listed.validUntil === null || listed.validUntil.getTime() > this.deps.now().getTime());
  }

  /** A bot this service stored: read again after a write, so it is there unless its row was removed under it. */
  private async stored(botId: string): Promise<VenueGridBot> {
    const bot = await this.deps.store.find(botId);
    if (!bot) throw new GridError(`grid bot ${botId} not found`, 'trade.grid_not_found');
    return bot;
  }

  /** A signing bot starts once the venue lists its agent permission; a live one places what it is missing. */
  private async advance(principal: Principal, start: VenueGridBot): Promise<VenueGridBot> {
    let bot = start;
    if (bot.status === 'signing') {
      if (!(await this.permitted(bot))) return bot;
      if (
        await this.deps.store.setStatus({ botId: bot.botId, status: 'initializing', reason: null, at: this.deps.now(), from: ['signing'] })
      ) {
        bot = await this.stored(bot.botId);
      } else return await this.stored(bot.botId);
    }
    if (LIVE.includes(bot.status)) await this.step(bot, principal.tier);
    return await this.stored(bot.botId);
  }

  /** The person's wallet signed the grid agent permission: it is sent once under its key, then the bot starts. */
  async submitPermission(
    principal: Principal,
    sent: { botId: string; actionKey: string; signature: VenueSignature },
  ): Promise<VenueGridView> {
    const { actionKey, signature } = sent;
    const bot = await this.own(principal, sent.botId);
    if (actionKey !== gridAgentKey(bot.owner, bot.agentAddress)) {
      throw new GridError(`${JSON.stringify(actionKey)} is not this bot's agent permission`, 'trade.grid_not_found');
    }
    if (bot.status !== 'signing' && !(await this.permitted(bot))) {
      throw new GridError(`The bot is ${bot.status}; its agent permission is no longer asked for`, 'trade.bots_grid_not_signing');
    }
    if (this.deps.freeze && (await this.deps.freeze.frozen(bot.userId))) {
      throw new GridError('Your account is frozen, so no agent permission is sent', 'trade.bots_grid_not_signing');
    }
    const answer = await this.deps.door.submit(principal, actionKey, signature);
    if (answer.outcome.definite && !answer.outcome.accepted) {
      throw new GridError(`The venue refused the agent permission: ${answer.outcome.refusal.detail}`, 'trade.bots_grid_not_signing');
    }
    return this.locked(bot.botId, async () => this.view(principal, await this.advance(principal, await this.stored(bot.botId))));
  }

  private async own(principal: Principal, botIdRaw: string): Promise<VenueGridBot> {
    const bot = await this.deps.store.find(String(botIdRaw ?? '').trim());
    if (!bot || bot.userId !== principal.userId) throw new GridError('Grid bot not found', 'trade.grid_not_found');
    return bot;
  }

  async has(botId: string): Promise<boolean> {
    return (await this.deps.store.find(botId)) !== null;
  }

  async get(principal: Principal, botId: string): Promise<VenueGridView> {
    return this.view(principal, await this.own(principal, botId));
  }

  async list(principal: Principal): Promise<readonly VenueGridView[]> {
    const out: VenueGridView[] = [];
    for (const bot of await this.deps.store.listForUser(principal.userId)) out.push(await this.view(principal, bot, false));
    return out;
  }

  /** CB-bots-05 on the venue: a bot's agent permission can't withdraw, so nothing is asked of the venue and nothing moves. */
  async withdrawProfit(principal: Principal, botId: string): Promise<never> {
    await this.own(principal, botId);
    throw new GridError(WITHDRAW_REFUSED, 'trade.bots_grid_withdraw_not_permitted');
  }

  /** Stop: no new order; every open order of the bot is cancelled on the venue by its key. What filled stays the person's. */
  async stop(principal: Principal, botId: string): Promise<VenueGridView> {
    const bot = await this.own(principal, botId);
    return this.locked(bot.botId, async () => {
      const now = await this.stored(bot.botId);
      if (now.status === 'signing')
        await this.deps.store.setStatus({
          botId: bot.botId,
          status: 'stopped',
          reason: 'user_stop',
          at: this.deps.now(),
          from: ['signing'],
        });
      if (LIVE.includes(now.status)) {
        await this.deps.store.setStatus({ botId: bot.botId, status: 'stopped', reason: 'user_stop', at: this.deps.now(), from: LIVE });
        await this.cancelOpen(now, principal.tier);
      }
      return this.view(principal, await this.stored(bot.botId));
    });
  }

  /** Every live bot, once: read its orders from the venue, close pairs, place what is missing, pause out of range. */
  async tickAll(): Promise<void> {
    for (const bot of await this.deps.store.live()) {
      try {
        const tier = await this.deps.liveTier(bot.userId);
        await this.locked(bot.botId, async () => {
          const now = await this.deps.store.find(bot.botId);
          if (now && LIVE.includes(now.status)) await this.step(now, tier);
        });
      } catch (err) {
        process.stderr.write(
          `${JSON.stringify({ level: 'warn', msg: 'trade.venue_grid.tick_failed', bot: bot.botId, message: err instanceof Error ? err.message : String(err) })}\n`,
        );
      }
    }
  }

  // ── one pass ────────────────────────────────────────────────────────────────────────────────────────────────────

  private async step(bot0: VenueGridBot, tier: Principal['tier']): Promise<void> {
    let bot = bot0;
    const actor = engineActor(bot.userId, tier);
    await this.readOrders(bot, actor);
    // A symbol the platform halted stops the bot, with that reason; its open orders are cancelled.
    if (botOrdersHalted(await this.pauses(), bot.symbol)) {
      if (
        await this.deps.store.setStatus({ botId: bot.botId, status: 'stopped', reason: 'platform_halt', at: this.deps.now(), from: LIVE })
      )
        await this.cancelOpen(bot, tier);
      return;
    }
    const orders = await this.deps.store.orders(bot.botId);
    // Each filled buy with no sell yet: its sell one level up, for what the buy received, in range or not.
    for (const buy of orders.filter((o) => o.side === 'buy' && o.status === 'filled')) {
      if (orders.some((o) => o.side === 'sell' && o.levelIndex === buy.levelIndex && o.cycle === buy.cycle)) continue;
      const up = bot.levels[buy.levelIndex + 1];
      if (!up) continue;
      const received = await this.received(bot, buy);
      const market = await this.market(bot.owner, bot.symbol);
      const qty = floorTo(received, market.lotSize);
      if (compare(qty, ZERO) <= 0) continue;
      await this.place(bot, actor, { levelIndex: buy.levelIndex, side: 'sell', cycle: buy.cycle, price: up.price, qty });
    }
    const mark = await this.mark(bot.symbol);
    if (mark === null) return;
    const inRange = markInRange(bot.lowerPrice, bot.upperPrice, mark);
    const want: VenueGridStatus = inRange ? 'running' : 'paused_range';
    if (bot.status !== want) {
      await this.deps.store.setStatus({
        botId: bot.botId,
        status: want,
        reason: inRange ? null : OUT_OF_RANGE,
        at: this.deps.now(),
        from: LIVE,
      });
      bot = await this.stored(bot.botId);
    }
    // The range pause: no new buy while the mark is outside the bounds.
    if (!inRange) return;
    const after = await this.deps.store.orders(bot.botId);
    for (const level of levelsBelowMark(bot.levels, mark)) {
      if (level.index >= bot.gridCount - 1) continue;
      const mine = after.filter((o) => o.levelIndex === level.index);
      // A level is busy while its buy is open, or its bought pair's sell is not yet filled.
      const busy =
        mine.some((o) => o.status === 'open') ||
        mine.some(
          (b) =>
            b.side === 'buy' &&
            b.status === 'filled' &&
            !mine.some((s) => s.side === 'sell' && s.cycle === b.cycle && s.status === 'filled'),
        );
      if (busy) continue;
      const cycle = mine.filter((o) => o.side === 'buy').reduce((n, o) => Math.max(n, o.cycle + 1), 0);
      await this.place(bot, actor, { levelIndex: level.index, side: 'buy', cycle, price: level.price, qty: level.qty });
    }
    if (bot.status === 'initializing')
      await this.deps.store.setStatus({ botId: bot.botId, status: 'running', reason: null, at: this.deps.now(), from: ['initializing'] });
  }

  /** The venue's fills of one of the bot's orders, by the client order id its key derives. */
  private async fillsOf(bot: VenueGridBot, actor: Principal, orderKey: string): Promise<UserVenueFill[]> {
    const cloid = (await this.deps.door.stored(actor, orderKey))?.prepared.venueClientOrderId;
    if (!cloid) return [];
    const { venue, account } = await this.venueOf(bot.owner);
    const fills = (await venue.fills(account, bot.createdAt)).value;
    return fills.filter((f) => f.venueClientOrderId?.toLowerCase() === cloid.toLowerCase());
  }

  private async received(bot: VenueGridBot, buy: VenueGridOrder): Promise<Amount> {
    return buy.feeAsset === bot.baseAsset ? sub(buy.filled, add(buy.venueFee, buy.builderFee)) : buy.filled;
  }

  /** Each open order as the venue reports it now: filled, part filled, or ended; a closed sell's pair profit, from fills. */
  private async readOrders(bot: VenueGridBot, actor: Principal): Promise<void> {
    const market = await this.market(bot.owner, bot.symbol);
    const orders = await this.deps.store.orders(bot.botId);
    for (const o of orders.filter((x) => x.status === 'open')) {
      let read;
      try {
        read = await this.deps.door.orderByKey(actor, o.orderKey);
      } catch (err) {
        if (err instanceof UserVenueDoorError && err.code === 'trade.venue_action_unknown') continue;
        throw err;
      }
      if (read.state === 'refused') {
        await this.deps.store.updateOrder({ ...o, status: 'refused', closedAt: this.deps.now() });
        continue;
      }
      if (read.state !== 'accepted' || !read.order) continue;
      const v = read.order;
      if (OPEN.has(v.status)) {
        if (compare(v.filled, o.filled) !== 0) await this.deps.store.updateOrder({ ...o, filled: v.filled });
        continue;
      }
      const fills = await this.fillsOf(bot, actor, o.orderKey);
      const venueFee = sumOf(fills.map((f) => f.venueFee));
      const builderFee = sumOf(fills.map((f) => f.builderFee));
      const feeAsset = fills[0]?.feeAsset ?? null;
      const whole = v.status === 'filled';
      let profit: Amount | null = null;
      if (whole && o.side === 'sell') {
        const buyKey = gridClientOrderId(bot.botId, o.levelIndex, 'buy', o.cycle);
        profit = pairProfit(market, await this.fillsOf(bot, actor, buyKey), fills);
      }
      const status = whole ? 'filled' : compare(v.filled, ZERO) > 0 ? 'partial' : 'cancelled';
      await this.deps.store.updateOrder({
        ...o,
        status,
        filled: v.filled,
        venueFee,
        builderFee,
        feeAsset,
        pairProfit: profit,
        closedAt: this.deps.now(),
      });
    }
  }

  /**
   * One level order, written before the key signs. The bot's policy first: a buy only while the quote its open buys hold,
   * with this one, fits in its investment. A key already stored is sent again only as it was signed.
   */
  private async place(
    bot: VenueGridBot,
    actor: Principal,
    o: { levelIndex: number; side: 'buy' | 'sell'; cycle: number; price: Amount; qty: Amount },
  ): Promise<void> {
    const orderKey = gridClientOrderId(bot.botId, o.levelIndex, o.side, o.cycle);
    if (o.side === 'buy') {
      const open = (await this.deps.store.orders(bot.botId)).filter(
        (x) => x.side === 'buy' && x.status === 'open' && x.orderKey !== orderKey,
      );
      const held = sumOf(open.map((x) => mul(x.price, sub(x.qty, x.filled), 'ceil')));
      if (compare(add(held, mul(o.price, o.qty, 'ceil')), bot.investment) > 0) return;
    }
    if (!(await this.mayTrade(bot, actor.tier))) return;
    const row = await this.deps.store.insertOrder({
      orderKey,
      botId: bot.botId,
      levelIndex: o.levelIndex,
      side: o.side,
      cycle: o.cycle,
      price: o.price,
      qty: o.qty,
      status: 'open',
      filled: ZERO,
      venueFee: ZERO,
      builderFee: ZERO,
      feeAsset: null,
      pairProfit: null,
      placedAt: this.deps.now(),
      closedAt: null,
    });
    const intent: PlaceUserOrderIntent = {
      kind: 'place_order',
      symbol: bot.symbol,
      side: row.side,
      type: 'limit',
      amount: row.qty,
      price: row.price,
      timeInForce: 'GTC',
      reduceOnly: false,
      clientOrderKey: orderKey,
      builderFee: null,
    };
    const sent = await this.sendAsAgent(bot, actor, intent);
    if (sent === 'refused') await this.deps.store.updateOrder({ ...row, status: 'refused', closedAt: this.deps.now() });
  }

  /** The person's level, freeze and region, read again before each order (as an order they send themselves). */
  private async mayTrade(bot: VenueGridBot, tier: Principal['tier']): Promise<boolean> {
    if (!this.deps.freeze || (await this.deps.freeze.frozen(bot.userId))) return false;
    try {
      assertPlaceEligible({ tier, region: bot.region });
      return true;
    } catch (err) {
      if (err instanceof AuthError || err instanceof JurisdictionError) return false;
      throw err;
    }
  }

  private async cancelOpen(bot: VenueGridBot, tier: Principal['tier']): Promise<void> {
    const actor = engineActor(bot.userId, tier);
    for (const o of (await this.deps.store.orders(bot.botId)).filter((x) => x.status === 'open')) {
      await this.sendAsAgent(bot, actor, { kind: 'cancel_order', symbol: bot.symbol, clientOrderKey: o.orderKey });
    }
    await this.readOrders(bot, actor);
  }

  /** One action on the person's venue account signed by the grid key. `pending` when the venue has not answered definitely. */
  private async sendAsAgent(
    bot: VenueGridBot,
    actor: Principal,
    intent: PlaceUserOrderIntent | { kind: 'cancel_order'; symbol: string; clientOrderKey: string },
  ): Promise<'done' | 'refused' | 'pending'> {
    const signer = this.gridKey(bot.userId, bot.owner);
    if (signer.address.toLowerCase() !== bot.agentAddress)
      throw new Error(`the grid key of bot ${bot.botId} does not derive to its address`);
    const key = intent.kind === 'cancel_order' ? `${intent.clientOrderKey}:cancel` : intent.clientOrderKey;
    const stored = await this.deps.door.stored(actor, key);
    let answer: { actionKey: string; prepared: PreparedVenueAction; signed: boolean; lastOutcome: VenueSubmitOutcome | null };
    try {
      answer = stored
        ? { actionKey: stored.businessKey, prepared: stored.prepared, signed: stored.signature !== null, lastOutcome: stored.lastOutcome }
        : await this.deps.door.prepare(actor, {
            owner: bot.owner,
            signer: { role: 'agent', address: bot.agentAddress },
            intent,
            actionKey: key,
          });
    } catch (err) {
      if (err instanceof VenueRefusalError || err instanceof AuthError) return 'refused';
      throw err;
    }
    // The invariant: every action names the person's own account and the grid key, nothing else.
    if (
      !sameOwner(answer.prepared.account.owner, bot.owner) ||
      answer.prepared.account.subAccount !== null ||
      answer.prepared.signer.role !== 'agent'
    ) {
      throw new Error(`action ${key} was prepared outside bot ${bot.botId}'s account; nothing is signed`);
    }
    if (answer.signed && answer.lastOutcome?.definite) return answer.lastOutcome.accepted ? 'done' : 'refused';
    const signature = await signer.signTypedData(answer.prepared.typedData as TypedDataDefinition);
    let outcome: VenueSubmitOutcome;
    try {
      outcome = (
        await this.deps.door.submit(actor, answer.actionKey, { digest: answer.prepared.digest, signature, signedBy: bot.agentAddress })
      ).outcome;
    } catch (err) {
      if (err instanceof VenueRefusalError) return err.refusal.code === 'venue_down' ? 'pending' : 'refused';
      throw err;
    }
    if (!outcome.definite) return 'pending';
    return outcome.accepted ? 'done' : 'refused';
  }

  // ── the view ────────────────────────────────────────────────────────────────────────────────────────────────────

  private async view(principal: Principal, bot: VenueGridBot, withNext = true): Promise<VenueGridView> {
    const venue = await this.deps.door.venue();
    let next: VenueGridNext | null = null;
    if (bot.status === 'signing' && withNext) {
      const answer = await this.deps.door.prepare(principal, {
        owner: bot.owner,
        signer: { role: 'owner', address: bot.owner },
        intent: { kind: 'approve_agent', agentAddress: bot.agentAddress, agentName: GRID_AGENT_NAME, validUntil: null },
        actionKey: gridAgentKey(bot.owner, bot.agentAddress),
      });
      next = {
        actionKey: answer.actionKey,
        digest: answer.prepared.digest,
        // Read back through the record's own schema, so what the wallet is asked to sign is the shape the record names.
        typedData: NEXT_TYPED_DATA.parse(encodeVenueWire(answer.prepared.typedData)),
      };
    }
    const orders = await this.deps.store.orders(bot.botId);
    const pairs = orders.flatMap((o) => (o.side === 'sell' && o.status === 'filled' && o.pairProfit !== null ? [o.pairProfit] : []));
    const profit = sumOf(pairs);
    const fees = new Map<string, { venueFee: Amount; builderFee: Amount }>();
    for (const o of orders) {
      if (!o.feeAsset) continue;
      const f = fees.get(o.feeAsset) ?? { venueFee: ZERO, builderFee: ZERO };
      fees.set(o.feeAsset, { venueFee: add(f.venueFee, o.venueFee), builderFee: add(f.builderFee, o.builderFee) });
    }
    const openOn = (index: number) => {
      const buy = orders.find((o) => o.side === 'buy' && o.status === 'open' && o.levelIndex === index);
      const sell = orders.find((o) => o.side === 'sell' && o.status === 'open' && o.levelIndex + 1 === index);
      const o = buy ?? sell;
      return o ? { side: o.side, orderId: o.orderKey, clientOrderId: o.orderKey } : null;
    };
    return {
      botId: bot.botId,
      clientRequestId: bot.clientRequestId,
      symbol: bot.symbol,
      baseAsset: bot.baseAsset,
      quoteAsset: bot.quoteAsset,
      lowerPrice: formatAmount(bot.lowerPrice),
      upperPrice: formatAmount(bot.upperPrice),
      gridCount: bot.gridCount,
      investment: formatAmount(bot.investment),
      reinitCount: 0,
      status: bot.status,
      statusReason: bot.statusReason,
      reserve: null,
      levels: bot.levels.map((l) => ({
        index: l.index,
        price: formatAmount(l.price),
        qty: formatAmount(l.qty),
        hold: formatAmount(l.hold),
        openOrder: openOn(l.index),
      })),
      orders: orders.map((o) => ({
        clientOrderId: o.orderKey,
        orderId: o.orderKey,
        levelIndex: o.levelIndex,
        side: o.side,
        cycle: o.cycle,
        price: formatAmount(o.price),
        qty: formatAmount(o.qty),
        holdAmount: o.side === 'buy' ? formatAmount(mul(o.price, o.qty, 'ceil')) : formatAmount(o.qty),
        // A refused order is shown as cancelled: it never rested.
        status: o.status === 'refused' ? 'cancelled' : o.status,
        pairProfit: o.pairProfit === null ? null : formatAmount(o.pairProfit),
      })),
      gridProfit: formatAmount(profit),
      withdrawableProfit: '0',
      closedPairs: pairs.length,
      gridApr: gridApr(profit, bot.investment, this.deps.now().getTime() - bot.createdAt.getTime()),
      createdAt: bot.createdAt.toISOString(),
      venue: {
        id: bot.venueId,
        name: venue.venue.displayName,
        test: isTestVenue(venue.venue),
        owner: bot.owner,
        agentAddress: bot.agentAddress,
        agentName: GRID_AGENT_NAME,
      },
      next,
      fees: [...fees].map(([asset, f]) => ({ asset, venueFee: formatAmount(f.venueFee), builderFee: formatAmount(f.builderFee) })),
    };
  }
}
