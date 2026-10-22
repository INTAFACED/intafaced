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

import { formatAmount, recipes, type LedgerClient, type PostRequest } from '@intafaced/ledger-client';
import { TradeError } from '../spot/types.js';
import { assertFirmConvertQuote, legsForConvert, type BoundConvertFill } from './quote.js';

export interface ConvertSettlePlan {
  readonly hold: PostRequest;
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

  return {
    hold: recipes.orderHold({
      orderId: input.takerOrderId,
      userId: q.userId,
      assetId: takerPaysAsset,
      amount: takerPaysAmount,
    }),
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

/** House inventory first — a house shortfall must not strand a customer hold. */
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
  await ledger.post(plan.mmHold);
  await ledger.post(plan.hold);
  await ledger.post(plan.fill);
}
