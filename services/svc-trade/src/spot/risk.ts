import { isScheduleOpen, nextScheduleTransition } from '@intafaced/contracts';
import { formatAmount, mul, mulBps, type Amount } from '@intafaced/ledger-client';
import { assertDatedFuturesTradable } from '../futures/dated-futures.js';
import { FUTURES_DISABLED, readTradePlanes } from '../futures/plane-capabilities.js';
import { assertFxHolidayNamedDegrade, assertFxSeparateFromSpot } from './fx-product.js';
import { assertKnownAssetClass, requireTradingSchedule } from './instrument-enums.js';
import { TradeError, type Market, type OrderSide, type OrderType } from './types.js';

/**
 * RISK CHECKS — §5.2 step 1, and the reason step 2 can be trusted.
 *
 * Pure functions of (market, request). No I/O, no clock, no database. That is
 * not decoration: these run BEFORE any value moves, and a check that needed a
 * network call would be a check that can be skipped by a timeout.
 *
 * What is checked here, and why each one is a money question rather than a
 * validation nicety:
 *
 *   · market status  — a halted market must not accept new holds, because the
 *                      funds would sit locked behind a book nobody is matching.
 *   · lot / tick     — the engine matches on exact bigint equality of price
 *                      levels. An off-grid price makes a level nobody else can
 *                      ever meet, so the order rests forever holding funds.
 *   · size limits    — the floor keeps a fill's quote amount above one wei (the
 *                      ledger refuses to post a movement of nothing); the
 *                      ceiling is the per-order blast radius.
 *   · min notional   — same floor, expressed the way a trader thinks about it.
 */

/** Order types this PR accepts. */
const SUPPORTED_TYPES: ReadonlySet<string> = new Set<OrderType>(['market', 'limit']);

export interface TradableOptions {
  /**
   * MAY THIS CALL SITE PUT AN ORDER ON A FUTURES BOOK?
   *
   * Mirrors `TRADE_FUTURES_ENABLED`, and defaults to `false` so the permissive
   * reading is never the one you get by leaving an argument off — the same
   * property `bestFromDepth`'s depth requirement has, for the same reason.
   *
   * That one has since gone further, and the reason is worth carrying here: its
   * argument is now MANDATORY rather than safely defaulted, because a safe
   * default was not enough once the question changed from "is this level worth
   * anything" to "is it worth anything next to the position it is pricing". A
   * default cannot answer the second question, and defaulting it to "no position
   * in scope" was worth 190,000 USDT.
   */
  readonly futuresEnabled?: boolean;
  /**
   * Live options settlement-asset law stamped (`TRADE_OPTIONS_SETTLEMENT_ASSET_LAW`).
   * Paper options ignore this. Live options with empty law refuse
   * `trade.unsettled_asset_class_listing` — never invent the asset.
   */
  readonly optionsSettlementLawStamped?: boolean;
  /**
   * Place/open clock for dated futures expiry. Omitted → structural checks
   * only (expiry/fixing present). Callers that have a clock must pass it so
   * a lapsed dated contract cannot trade as a perp.
   */
  readonly now?: Date;
}

/**
 * MAY THIS MARKET TAKE AN ORDER AT ALL?
 *
 * ── The futures arm, and why it used to be a flat refusal ────────────────────
 *
 * This function refused every non-spot market outright, and that refusal was
 * load-bearing far outside its own file. `futures/mark-from-depth.ts` said so in
 * its own header: the size-blind mid "is not exploitable on `main` today only
 * because `assertTradable` refuses non-spot on the order path, so futures books
 * are always empty. That is a different file's accident, not a control."
 *
 * It is no longer the only thing standing there. `c7dfb5e4` and `cc90c2f4` made
 * both the internal-depth mid and the venue mid size-aware
 * (`bestLevelIsQuotable` / `DEFAULT_MIN_BEST_LEVEL_NOTIONAL`), and `c7dfb5e4`
 * armed the deviation breaker against a stored `accepted_mark`. So a futures book
 * that can be filled with two dust orders no longer mints a payout-grade mark,
 * and the accident this refusal was standing in for has a real control behind it.
 *
 * ── Off is an answer, not an outage ─────────────────────────────────────────
 *
 * `futuresEnabled` false refuses with `trade.futures_disabled` — its own code, a
 * 403, and a message that names the market and the switch. It is deliberately
 * NOT `trade.market_kind_unsupported`: that code means "this service will never
 * serve that kind", which was true and is now a deployment setting, and a CCXT
 * client that drops the symbol on a `BadSymbol` would go on dropping it after an
 * operator turns futures on.
 *
 * `#883`/`#950` drew the line this sits on: a refusal with exactly one legal
 * answer is an outage rather than a decision gate. This one has a legal answer on
 * both settings — off, the market is listed, quotable, readable and closed to new
 * orders; on, it trades. Nothing about the flag being off stops the service
 * booting, stops spot, or stops a cancellation.
 *
 * ── What permitting an order does NOT unlock ────────────────────────────────
 *
 * It says nothing about leverage. A futures order is funded by the same `holdFor`
 * as a spot order — quote for buys, base for sells, in full — so this arm creates
 * no margin position and picks no risk parameter. Leverage and margin defaults
 * beyond `DIRECTION` §1's are owner-only (`DIRECTION` §8 item 8), and the margin
 * path stays where it is, in `futures/position-service.ts`, behind its own
 * already-named profit source.
 *
 * Paper European options are orderable (full-collateral paper engine). Live
 * options still refuse: empty settlement law → `trade.unsettled_asset_class_listing`
 * (never invent the asset); law stamped but live engine not this surface →
 * `trade.market_kind_unsupported`.
 */
export function assertTradable(market: Market, options: TradableOptions = {}): void {
  // Enum authority first (D-S-05 / D26-P1-T9) — see instrument-enums.ts.
  assertKnownAssetClass(market);
  if (market.kind === 'futures') {
    const published = readTradePlanes(process.env).futures;
    const futuresOn = options.futuresEnabled !== undefined ? options.futuresEnabled === true : published.enabled;
    if (!futuresOn) {
      throw new TradeError(
        `${market.symbol} is a futures market and futures trading is not enabled on this deployment (TRADE_FUTURES_ENABLED)`,
        published.reason ?? FUTURES_DISABLED,
      );
    }
    assertDatedFuturesTradable(market, { now: options.now });
  } else if (market.kind === 'options') {
    if (market.paper === true) {
      // paper engine — listed European drills, no ledger, no invented settlement asset
    } else if (options.optionsSettlementLawStamped !== true) {
      throw new TradeError(
        `${market.symbol} is a live options market and settlement asset law is unpublished — refuse rather than invent the settlement asset`,
        'trade.unsettled_asset_class_listing',
      );
    } else {
      throw new TradeError(
        `${market.symbol} is a live options market — paper engine only; live settlement is unpublished`,
        'trade.market_kind_unsupported',
      );
    }
  } else if (market.kind !== 'spot') {
    throw new TradeError(
      `${market.symbol} is a ${market.kind} market — this service serves trade.spot only`,
      'trade.market_kind_unsupported',
    );
  }
  if (market.status !== 'active') {
    throw new TradeError(`${market.symbol} is ${market.status}, not accepting orders`, 'trade.market_not_tradable');
  }
}

/**
 * Unknown `asset_class` refuses with the permitted set named.
 *
 * Rows arrive as a bare cast of the Postgres enum (`rows.ts`). A migration that
 * widens the DB enum without updating `ASSET_CLASSES` must not fund an order
 * under a class the instrument model has never defined.
 */
export { assertKnownAssetClass } from './instrument-enums.js';

/**
 * SPOT-SHAPED SURFACES REFUSE NON-SPOT BY NAME, NOT BY OMISSION.
 *
 * Convert and TWAP are not the order path with a different button on it. Convert
 * walks book depth and calls the result a price the user can take; TWAP slices a
 * parent over a duration and re-prices each child. Neither has been reasoned
 * about, let alone tested, against a market whose position is a margin row rather
 * than a base-asset balance.
 *
 * Before `assertTradable` grew its futures arm, those two were spot-only for free
 * — they inherited the flat kind refusal. Turning futures on for the order path
 * would have silently turned it on for them too, which is exactly the shape of
 * accident this subsystem keeps producing: a control that was really a side effect
 * of somebody else's guard. So they now say it themselves, and their refusal
 * survives whatever the deployment flag says.
 */
export function assertSpotSurface(market: Market, surface: string): void {
  if (market.kind !== 'spot') {
    throw new TradeError(`${market.symbol} is a ${market.kind} market — ${surface} serves spot only`, 'trade.market_kind_unsupported');
  }
  // FX listings are kind=spot in the row. Convert/TWAP must not inherit that.
  assertFxSeparateFromSpot(market, surface);
}

/**
 * PRODUCTION FOREX / COMMODITY WITHOUT SETTLEMENT LAW MUST NOT TAKE A HOLD.
 *
 * Re-export of D26-P1-T7 / `socket.forex-settlement` place-path seal.
 * listMarket refuses NEW active non-paper listings; seeds stay active in DB —
 * without this gate, open-session place/convert/TWAP would hold against an
 * unfundable rail. Never invents settlement asset (P0-05 / D8).
 */
export { assertSettlementRails } from './forex-settlement.js';

/**
 * Is the venue open at this instant?
 *
 * A separate check from `assertTradable` because it asks a different question.
 * `status` is a property of the listing — an operator halted it, or it was
 * never launched. The schedule is a property of the *venue*: a forex pair is
 * permanently `active` and shut every weekend, and a commodity closes daily.
 * Nothing checked this before, so a Saturday EUR/USD order was accepted, funded
 * and rested into a book that could not fill it until Monday — the user's money
 * held for two days against an order that was never live.
 *
 * `at` is a parameter rather than a call to `new Date()` so this file keeps the
 * property the header claims: pure functions of (market, request), no ambient
 * clock. A check that reads a global clock cannot be tested at a boundary, and
 * every interesting case here IS a boundary.
 */
export function assertMarketOpen(market: Market, at: Date): void {
  // Unknown key → trade.unknown_schedule (instrument-enums). Session shut →
  // trade.market_closed. Distinct codes so bots do not retry Monday on drift.
  const schedule = requireTradingSchedule(market);
  // FX holiday / unpublished calendar — named, never silent-zero or fail-OPEN.
  assertFxHolidayNamedDegrade(market, at, schedule);

  if (isScheduleOpen(schedule, at)) return;

  const next = nextScheduleTransition(schedule, at);
  throw new TradeError(
    next?.open
      ? `${market.symbol} is closed — the ${market.assetClass} session reopens at ${next.at.toISOString()}`
      : `${market.symbol} is closed`,
    'trade.market_closed',
  );
}

/**
 * SOCKET §13 — stop and take-profit orders.
 *
 * The engine already matches `stop` and `stop_limit`, and the public contract
 * already carries `take_profit`. They are refused here because funding them
 * honestly is not solved: a stop BUY has no price until it triggers, possibly
 * days later, so either it is funded at submission against a price nobody can
 * predict, or it reaches the engine unfunded — and an unfunded order in the
 * book is the one thing this whole design exists to prevent. The fix is a
 * trigger-time funding callback from the engine, which is a change to
 * svc-matching's contract and therefore its own PR (§15.2).
 */
export function requireSupportedType(type: string): OrderType {
  if (!SUPPORTED_TYPES.has(type)) {
    throw new TradeError(`order type "${type}" is not accepted on spot markets yet`, 'trade.order_type_unsupported');
  }
  return type as OrderType;
}

/** Quantity must sit exactly on the lot grid and inside the market's bounds. */
export function assertQty(market: Market, qty: Amount): void {
  if (qty <= 0n) {
    throw new TradeError('quantity must be strictly positive', 'trade.invalid_qty');
  }
  if (qty % market.lotSize !== 0n) {
    throw new TradeError(`quantity must be a multiple of the ${formatAmount(market.lotSize)} lot size`, 'trade.invalid_qty');
  }
  if (qty < market.minQty) {
    throw new TradeError(`quantity is below the ${formatAmount(market.minQty)} minimum`, 'trade.invalid_qty');
  }
  if (market.maxQty !== null && qty > market.maxQty) {
    throw new TradeError(`quantity is above the ${formatAmount(market.maxQty)} maximum`, 'trade.invalid_qty');
  }
}

/** Price must sit exactly on the tick grid. */
export function assertPrice(market: Market, price: Amount): void {
  if (price <= 0n) {
    throw new TradeError('price must be strictly positive', 'trade.invalid_price');
  }
  if (price % market.tickSize !== 0n) {
    throw new TradeError(`price must be a multiple of the ${formatAmount(market.tickSize)} tick size`, 'trade.invalid_price');
  }
}

/**
 * Order value must clear the market's floor.
 *
 * Floored, matching how a fill's quote amount is computed. Checking with a
 * different rounding mode to the one that settles would let an order pass here
 * and produce a sub-minimum fill.
 */
export function assertNotional(market: Market, price: Amount, qty: Amount): void {
  const notional = mul(price, qty, 'floor');
  if (notional < market.minNotional) {
    throw new TradeError(
      `order value ${formatAmount(notional)} ${market.quoteAsset} is below the ${formatAmount(market.minNotional)} minimum`,
      'trade.below_min_notional',
    );
  }
}

/**
 * THE HOLD.
 *
 * "quote for buys, base for sells" (§5.2 step 2). For a buy the amount is
 * rounded UP: a hold that is a wei short is a fill the ledger will refuse at
 * settlement time, and a refused settlement is a match the engine has already
 * printed and the book has already moved on from.
 *
 * The ceiling is safe against the other direction too. Every fill's quote
 * amount is FLOORED (`mul(price, qty, 'floor')`), and a floored sum of parts
 * can never exceed the ceiling of the whole, so a partially filled order can
 * never consume more hold than it was given. The leftover wei is released with
 * the remainder when the order reaches a terminal state — it is not left behind
 * (see `releasableHold` in trade-service.ts).
 */
export function holdFor(market: Market, side: OrderSide, price: Amount, qty: Amount): { assetId: string; amount: Amount } {
  return side === 'buy' ? { assetId: market.quoteAsset, amount: mul(price, qty, 'ceil') } : { assetId: market.baseAsset, amount: qty };
}

/**
 * The price a market BUY is funded and submitted at.
 *
 * A market order carries no price, so there is no honest amount to hold for it
 * until one is chosen. The choice is the best ask plus a slippage cap, rounded
 * UP to the tick grid, and the order is then sent to the engine as a marketable
 * IOC *limit* at exactly this price. The engine therefore cannot fill it above
 * what was held — the funding invariant survives even if the book moves between
 * this read and the submission, because a book that moved up simply fills less.
 *
 * A market SELL holds base quantity, which is known exactly, but it still
 * needs a price floor. `sellProtectionPriceFor` is that floor: best bid minus
 * the same owner cap, rounded up onto the tick so the engine cannot print
 * worse than the cap. No cap, or no bid, is a typed refusal — never an
 * unbounded market sell.
 */
/**
 * Owner market-buy hold cap. Blank / unset / non-integer / out of 1–5000
 * refuses — never invent 200 bps.
 */
export function requireMarketSlippageCapBps(slippageCapBps: number | null | undefined): number {
  if (slippageCapBps == null || !Number.isInteger(slippageCapBps) || slippageCapBps < 1 || slippageCapBps > 5000) {
    throw new TradeError(
      'TRADE_MARKET_SLIPPAGE_CAP_BPS is unset or not an integer 1–5000 — refuse rather than invent a market-buy hold',
      'trade.slippage_cap_unset',
    );
  }
  return slippageCapBps;
}

export function protectionPriceFor(market: Market, bestAsk: Amount | null, slippageCapBps: number | null | undefined): Amount {
  const cap = requireMarketSlippageCapBps(slippageCapBps);
  if (bestAsk === null || bestAsk <= 0n) {
    throw new TradeError(`${market.symbol} has no ask to price a market buy against — place a limit order`, 'trade.no_reference_price');
  }

  const capped = bestAsk + mulBps(bestAsk, cap, 'ceil');
  const remainder = capped % market.tickSize;
  return remainder === 0n ? capped : capped + (market.tickSize - remainder);
}

/**
 * The price a market SELL (and a flatten that would sell) may not print below.
 *
 * The owner cap is the same `TRADE_MARKET_SLIPPAGE_CAP_BPS` a market buy is
 * funded with. Unpublished is `trade.protection_unset`, not a null protection
 * price and not an orderable preview. No bid is `trade.no_reference_price`.
 * The deduction is floored and the result is rounded UP to the tick, so the
 * floor is never worse than bid minus the cap.
 */
export function sellProtectionPriceFor(market: Market, bestBid: Amount | null, slippageCapBps: number | null | undefined): Amount {
  if (slippageCapBps == null || !Number.isInteger(slippageCapBps) || slippageCapBps < 1 || slippageCapBps > 5000) {
    throw new TradeError(
      'market sell has no owner protection floor (TRADE_MARKET_SLIPPAGE_CAP_BPS unset) — refuse rather than send an unbounded sell',
      'trade.protection_unset',
    );
  }
  if (bestBid === null || bestBid <= 0n) {
    throw new TradeError(`${market.symbol} has no bid to floor a market sell against — place a limit order`, 'trade.no_reference_price');
  }
  const slipped = bestBid - mulBps(bestBid, slippageCapBps, 'floor');
  if (slipped <= 0n) {
    throw new TradeError(`${market.symbol} market-sell floor would be non-positive — place a limit order`, 'trade.protection_unset');
  }
  const remainder = slipped % market.tickSize;
  return remainder === 0n ? slipped : slipped + (market.tickSize - remainder);
}
