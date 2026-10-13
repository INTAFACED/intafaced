/**
 * Convert settle — ledger-client recipes only (Doctrine §0.6).
 *
 * Principal house inventory at the **bound** quoted notional. Spread is
 * disclosed on the quote; fee bps stay 0 (no silent second markup). This is
 * not a book trade: matching is never called.
 *
 * Bound-but-not-settled convertExecute does not re-check expiry. Default
 * `now = new Date()` so that hitch is live without a trade-service recut.
 */

import { formatAmount, LedgerError, recipes, type LedgerClient, type PostRequest } from '@intafaced/ledger-client';
import { TradeError } from '../spot/types.js';
import { assertFirmConvertQuote, legsForConvert, type BoundConvertFill } from './quote.js';

export interface ConvertSettlePlan {
  readonly hold: PostRequest;
  /** Compensation for `hold` when the house cannot cover its leg. Key is fixed per order — one release, ever. */
  readonly holdRelease: PostRequest;
  readonly mmHold: PostRequest;
  readonly fill: PostRequest;
  readonly expiresAt: string;
}

export function planConvertSettle(input: {
  bound: BoundConvertFill;
  takerOrderId: string;
  makerOrderId: string;
  fillId: string;
  /** Tests inject. Default wall clock so convertExecute's bound path refuses expired quotes. */
  now?: Date;
}): ConvertSettlePlan {
  const now = input.now ?? new Date();
  const q = input.bound.quote;
  assertFirmConvertQuote(q);

  const expiresAt = Date.parse(q.expiresAt);
  if (!Number.isFinite(expiresAt)) {
    throw new TradeError('convert quote expiry is required — refuse rather than invent', 'trade.convert_expiry_missing');
  }
  if (now.getTime() > expiresAt) {
    throw new TradeError('convert quote expired — refuse rather than requote', 'trade.convert_quote_expired');
  }

  if (input.bound.fillNotional !== q.userNotional || input.bound.fillPrice !== q.avgPrice) {
    throw new TradeError(
      `convert price ${formatAmount(q.avgPrice)} is not the amount you accepted ${formatAmount(input.bound.fillPrice)}`,
      'trade.convert_price_moved',
    );
  }

  const legs = legsForConvert(q.side, q.baseAsset, q.quoteAsset, q.filledQty, q.userNotional);
  if (q.inAmount !== legs.inAmount || q.outAmount !== legs.outAmount || q.inAsset !== legs.inAsset || q.outAsset !== legs.outAsset) {
    throw new TradeError('convert quote amounts are required — refuse rather than invent', 'trade.convert_amounts_missing');
  }

  const takerPaysAsset = q.side === 'buy' ? q.quoteAsset : q.baseAsset;
  const takerPaysAmount = q.side === 'buy' ? input.bound.fillNotional : q.filledQty;
  const makerPaysAsset = q.side === 'buy' ? q.baseAsset : q.quoteAsset;
  const makerPaysAmount = q.side === 'buy' ? q.filledQty : input.bound.fillNotional;

  const takerHold = {
    orderId: input.takerOrderId,
    userId: q.userId,
    assetId: takerPaysAsset,
    amount: takerPaysAmount,
  };

  return {
    hold: recipes.orderHold(takerHold),
    holdRelease: recipes.orderHoldRelease({ ...takerHold, sequence: 0 }),
    mmHold: recipes.marketMakerOrderHold({
      orderId: input.makerOrderId,
      assetId: makerPaysAsset,
      amount: makerPaysAmount,
    }),
    fill: recipes.marketMakerMakerFill({
      fillId: input.fillId,
      takerId: q.userId,
      makerOrderId: input.makerOrderId,
      takerOrderId: input.takerOrderId,
      baseAsset: q.baseAsset,
      quoteAsset: q.quoteAsset,
      qty: q.filledQty,
      quoteAmount: input.bound.fillNotional,
      takerSide: q.side,
      makerFeeBps: 0,
      takerFeeBps: 0,
    }),
    expiresAt: q.expiresAt,
  };
}

/**
 * Customer hold first, then house inventory (#4676).
 *
 * A customer shortfall fails on the first post, before any house coins move,
 * so there is nothing to undo. A house shortfall releases the customer hold
 * (`order.release:<takerOrderId>:0`, the same release spot cancel uses) and
 * refuses `trade.convert_liquidity_unavailable`.
 *
 * The hold key `order.hold:<takerOrderId>` is booked forever, so after a
 * release a retry of the same quote would "re-hold" as a ledger no-op and
 * settle against nothing. The booked release is therefore the terminal marker:
 * the same quote is refused again, and the customer asks for a new quote.
 */
export async function postConvertSettle(ledger: LedgerClient, plan: ConvertSettlePlan, now?: Date): Promise<void> {
  if (now != null) {
    const expiresAt = Date.parse(plan.expiresAt);
    if (!Number.isFinite(expiresAt)) {
      throw new TradeError('convert quote expiry is required — refuse rather than invent', 'trade.convert_expiry_missing');
    }
    if (now.getTime() > expiresAt) {
      throw new TradeError('convert quote expired — refuse rather than requote', 'trade.convert_quote_expired');
    }
  }
  if ((await ledger.getTxByKey(plan.holdRelease.idempotencyKey)) != null) {
    throw liquidityUnavailable();
  }
  await ledger.post(plan.hold);
  try {
    await ledger.post(plan.mmHold);
  } catch (err) {
    // Only a definite house shortfall compensates. Any other failure (timeout,
    // unknown outcome) may have booked the house hold: do not release then.
    if (!(err instanceof LedgerError) || err.code !== 'ledger.insufficient_funds') throw err;
    await ledger.post(plan.holdRelease);
    throw liquidityUnavailable();
  }
  await ledger.post(plan.fill);
}

/** Ledger key of the customer hold (`recipes.orderHold`); settle.test.ts pins it to the plan. */
export function convertCustomerHoldKey(takerOrderId: string): string {
  return `order.hold:${takerOrderId}`;
}

function liquidityUnavailable(): TradeError {
  return new TradeError(
    'convert liquidity is unavailable right now — nothing was charged, request a new quote',
    'trade.convert_liquidity_unavailable',
  );
}
