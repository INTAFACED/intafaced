/**
 * Creation gate for `algo.createTwap`.
 *
 * Runs only before a new parent is stored. It does not reserve funds, does not
 * invent a price, and does not invent a volume curve. A replay of an existing
 * `clientAlgoId` never reaches this file, so a later balance change cannot
 * turn that replay into a refusal.
 *
 * The first slice is the cover, not the whole schedule. The quote or base
 * amount is `holdFor`, the same function child placement uses, so the two
 * cannot disagree. The fee is the taker fee `tradeFill` charges on that
 * quantity (`ratesForFill` + `mulBps`). On this venue the fee is taken from
 * the asset the child receives, so it is not added to the spend-asset hold.
 */
import { formatAmount, mul, mulBps, userAvailable, type Amount, type LedgerClient } from '@intafaced/ledger-client';
import type { Sql } from 'postgres';
import { queryTakerVolumeFromFills } from '../spot/candles.js';
import { TRADE_FEE_SCHEDULE_ENV, type OwnerFeeSchedule } from '../spot/fee-schedule.js';
import { ratesForFill } from '../spot/fees.js';
import type { RankPerksSource } from '../spot/rank-perks.js';
import { assertQty, holdFor, protectionPriceFor } from '../spot/risk.js';
import { TradeError, type Market, type OrderSide } from '../spot/types.js';
import type { Principal } from '@intafaced/auth';
import { assertBotVerification, type BotVerificationPolicy } from './bots-verification.js';
import { acceptableForAlgo, withinPriceBand, type AlgoMarkPolicy } from './mark-gate.js';
import { planTwapSlices } from './schedule.js';
import type { CreateTwapInput } from './types.js';
import { planPovSliceQty, planVwapSlices, vwapLookbackImmature } from './volume-plan.js';

export interface AlgoCreateGateInput {
  readonly sql: Sql;
  readonly ledger: LedgerClient;
  readonly perks: RankPerksSource;
  readonly feeSchedule: OwnerFeeSchedule;
  readonly slippageCapBps: number | null;
  readonly markPolicy: AlgoMarkPolicy;
  readonly now: Date;
  readonly userId: string;
  readonly market: Market;
  readonly input: CreateTwapInput;
  readonly bid: Amount;
  readonly ask: Amount;
  /** CB-bots-10 verification gate. Checked first; required (callers that mean no gate pass `{ mode: 'off' }`). */
  readonly verification: { readonly policy: BotVerificationPolicy; readonly tier: Principal['tier'] };
}

/** Spend-asset hold plus the child-fill fee for one slice. Both are exact amounts. */
export interface SliceCover {
  readonly sliceQty: Amount;
  readonly asset: string;
  readonly required: Amount;
  readonly fee: Amount;
  readonly feeAsset: string;
}

/**
 * The slice gate's mark policy has one key, `maxAgeSeconds`, supplied by
 * `DEFAULT_ALGO_MARK_POLICY`. This function does not substitute that constant.
 * A blank or non-integer value refuses and names the key.
 */
export function requireAlgoMarkPolicy(policy: AlgoMarkPolicy | null | undefined): asserts policy is AlgoMarkPolicy {
  const age = policy?.maxAgeSeconds;
  if (policy == null || typeof age !== 'number' || !Number.isInteger(age) || age < 0) {
    throw new TradeError(
      'AlgoMarkPolicy.maxAgeSeconds is unset — refuse rather than invent a mark age limit',
      'trade.algo_mark_policy_unset',
    );
  }
}

function assertReferenceUsable(market: Market, price: Amount, now: Date, policy: AlgoMarkPolicy): void {
  const check = acceptableForAlgo({ marketId: market.id, price, asOf: now, quality: 'mid' }, now, policy);
  if (check.ok) return;
  throw new TradeError(check.reason ?? `${market.symbol}: mark refused`, check.code ?? 'trade.algo_mark_unusable');
}

/** Opposing touch, the same side `bestOpposingPrice` hands to `withinPriceBand`. */
export function bandReference(side: OrderSide, bid: Amount, ask: Amount): Amount {
  return side === 'buy' ? ask : bid;
}

function assertPriceBand(input: CreateTwapInput, bid: Amount, ask: Amount): void {
  if (input.limitPrice == null) return;
  const reference = bandReference(input.side, bid, ask);
  if (withinPriceBand(input.side, reference, input.limitPrice)) return;
  throw new TradeError(
    `${input.symbol}: limit is outside the slice price band against reference ${formatAmount(reference)}`,
    'trade.algo_price_band',
  );
}

/** Random sizes keep one lot per slice at least; the smallest slice must still be an order the market takes. */
function assertRandomSlicesTradable(input: CreateTwapInput, market: Market): void {
  const slices = planTwapSlices({
    totalQty: input.totalQty,
    durationMs: input.durationMs,
    sliceIntervalMs: input.sliceIntervalMs,
    lotSize: market.lotSize,
    randomSeed: input.randomSeed ?? null,
  }).slices;
  assertSmallestSliceTradable(market, slices);
}

/** Refuse a plan whose smallest slice is below the market's minimum order quantity. */
export function assertSmallestSliceTradable(market: Market, slices: readonly Amount[]): void {
  const smallest = slices.reduce((min, q) => (q < min ? q : min), slices[0] ?? 0n);
  try {
    assertQty(market, smallest);
  } catch (err) {
    if (!(err instanceof TradeError)) throw err;
    throw new TradeError(
      `${market.symbol}: a slice of this plan is not an order the market takes: ${err.message}`,
      'trade.algo_invalid_qty',
    );
  }
}

function immature(symbol: string, why: string): never {
  throw new TradeError(`${symbol}: ${why}`, 'trade.algo_volume_immature');
}

function firstSliceQty(input: CreateTwapInput, lotSize: Amount, povVolume: Amount | null): Amount {
  const kind = input.kind ?? 'twap';
  if (kind === 'twap') {
    return planTwapSlices({
      totalQty: input.totalQty,
      durationMs: input.durationMs,
      sliceIntervalMs: input.sliceIntervalMs,
      lotSize,
      randomSeed: input.randomSeed ?? null,
    }).slices.reduce((max, q) => (q > max ? q : max), 0n);
  }
  if (kind === 'vwap') {
    if (vwapLookbackImmature(input.volumeProfile)) {
      immature(input.symbol, 'VWAP lookback has no observed volume — refuse rather than invent a curve');
    }
    return planVwapSlices({ totalQty: input.totalQty, volumes: input.volumeProfile!, lotSize }).slices[0]!;
  }
  if (povVolume == null || povVolume <= 0n) {
    immature(input.symbol, 'POV lookback has no recent traded volume — refuse rather than invent a tape');
  }
  const qty = planPovSliceQty({
    intervalVolume: povVolume,
    participationBps: input.participationBps ?? Number.NaN,
    remainingQty: input.totalQty,
    lotSize,
  });
  if (qty <= 0n) {
    immature(
      input.symbol,
      'POV lookback volume does not cover one lot at the participation rate — refuse rather than start a slice that cannot place',
    );
  }
  return qty;
}

/**
 * Hold and fee for one child of `qty` at the price child placement would fund.
 *
 * Limit children use the limit. A market buy uses `protectionPriceFor` (the
 * funding price `placeOrder` holds). A market sell holds base quantity; its
 * fee is priced at the bid, which is the touch a market sell would print against.
 * The fee asset is the asset the fill receives, matching `tradeFill`.
 */
export async function childSliceCover(input: {
  readonly market: Market;
  readonly side: OrderSide;
  readonly qty: Amount;
  readonly limitPrice: Amount | null;
  readonly bid: Amount;
  readonly ask: Amount;
  readonly slippageCapBps: number | null;
  readonly feeSchedule: OwnerFeeSchedule;
  readonly takerDiscountBps: number;
}): Promise<SliceCover> {
  if (input.feeSchedule.published !== true) {
    throw new TradeError(`${TRADE_FEE_SCHEDULE_ENV} is unpublished — refuse rather than invent a child fee`, 'trade.fee_schedule_blank');
  }
  const price = input.limitPrice ?? (input.side === 'buy' ? protectionPriceFor(input.market, input.ask, input.slippageCapBps) : input.bid);
  const hold = holdFor(input.market, input.side, input.side === 'buy' ? price : 0n, input.qty);
  const rates = ratesForFill(input.feeSchedule, 0, input.takerDiscountBps, 'spot', { symbol: input.market.symbol });
  const feePrice = input.limitPrice ?? price;
  const fee = input.side === 'buy' ? mulBps(input.qty, rates.takerFeeBps) : mulBps(mul(feePrice, input.qty, 'floor'), rates.takerFeeBps);
  return {
    sliceQty: input.qty,
    asset: hold.assetId,
    required: hold.amount,
    fee,
    feeAsset: input.side === 'buy' ? input.market.baseAsset : input.market.quoteAsset,
  };
}

function coverData(cover: SliceCover, available: Amount): Record<string, string> {
  return {
    asset: cover.asset,
    required: formatAmount(cover.required),
    available: formatAmount(available),
    fee: formatAmount(cover.fee),
    feeAsset: cover.feeAsset,
    sliceQty: formatAmount(cover.sliceQty),
  };
}

async function assertFirstSliceBalance(ledger: LedgerClient, userId: string, cover: SliceCover): Promise<void> {
  let available: Amount;
  try {
    available = (await ledger.balance(userAvailable(userId, cover.asset))).amount;
  } catch {
    throw new TradeError(
      `available ${cover.asset} could not be read — refuse rather than start a schedule`,
      'trade.algo_balance_unreadable',
      { asset: cover.asset },
    );
  }
  if (available < cover.required) {
    throw new TradeError(
      `${cover.asset} available ${formatAmount(available)} is short of ${formatAmount(cover.required)} for the first slice`,
      'trade.algo_insufficient_balance',
      coverData(cover, available),
    );
  }
}

/** Refuse a new schedule that cannot place its first slice. Reads a balance. Posts nothing. */
export async function gateAlgoCreate(ctx: AlgoCreateGateInput): Promise<void> {
  assertBotVerification(ctx.verification.policy, ctx.verification.tier);
  requireAlgoMarkPolicy(ctx.markPolicy);
  assertReferenceUsable(ctx.market, ctx.bid, ctx.now, ctx.markPolicy);
  assertReferenceUsable(ctx.market, ctx.ask, ctx.now, ctx.markPolicy);
  // A schedule with a trigger starts when the mark reaches it, so its band and its first slice's funding are read at
  // that price: a limit that cannot fill once triggered is refused now, and a buy is funded at the higher of ask and trigger.
  const trigger = ctx.input.triggerPrice ?? null;
  assertPriceBand(ctx.input, trigger ?? ctx.bid, trigger ?? ctx.ask);
  const bid = trigger !== null && trigger > ctx.bid ? trigger : ctx.bid;
  const ask = trigger !== null && trigger > ctx.ask ? trigger : ctx.ask;
  if ((ctx.input.kind ?? 'twap') === 'twap' && ctx.input.randomSeed != null) assertRandomSlicesTradable(ctx.input, ctx.market);

  let povVolume: Amount | null = null;
  if ((ctx.input.kind ?? 'twap') === 'pov') {
    const to = ctx.now;
    const from = new Date(to.getTime() - ctx.input.sliceIntervalMs);
    povVolume = await queryTakerVolumeFromFills(ctx.sql, { marketId: ctx.market.id, from, to });
  }

  const sliceQty = firstSliceQty(ctx.input, ctx.market.lotSize, povVolume);
  const perks = await ctx.perks.perksOf(ctx.userId);
  const cover = await childSliceCover({
    market: ctx.market,
    side: ctx.input.side,
    qty: sliceQty,
    limitPrice: ctx.input.limitPrice,
    bid,
    ask,
    slippageCapBps: ctx.slippageCapBps,
    feeSchedule: ctx.feeSchedule,
    takerDiscountBps: perks.feeDiscountBps,
  });
  await assertFirstSliceBalance(ctx.ledger, ctx.userId, cover);
}
