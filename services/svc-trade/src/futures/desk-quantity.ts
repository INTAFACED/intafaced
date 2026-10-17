/**
 * Proportional futures close.
 *
 * The slice's realised P&L is the full-close P&L minus the P&L the remainder
 * would still show at the same mark, both rounded by `unrealizedPnl` (truncation
 * toward zero, the same division a full close already posts). Any later split of
 * the remainder uses the same rule, so the pieces sum to the one-shot close.
 *
 * Margin uses the same truncation: the remainder keeps `margin * remainQty / size`,
 * and the slice is what is left. The two shares sum to the margin that was there.
 */
import { recipes, type Amount, type PostRequest } from '@intafaced/ledger-client';
import { unrealizedPnl } from './liquidation-planner.js';

export const CLOSE_QUANTITY_INVALID = 'trade.close_quantity_invalid' as const;
export const CLOSE_QUANTITY_EXCEEDS_SIZE = 'trade.close_quantity_exceeds_size' as const;
export const CLOSE_QUANTITY_LOT_STEP = 'trade.close_quantity_lot_step' as const;
export const LOT_SIZE_UNSET = 'trade.lot_size_unset' as const;
export const CLOSE_QUANTITY_MARGIN_DUST = 'trade.close_quantity_margin_dust' as const;

export type CloseQuantityCode =
  | typeof CLOSE_QUANTITY_INVALID
  | typeof CLOSE_QUANTITY_EXCEEDS_SIZE
  | typeof CLOSE_QUANTITY_LOT_STEP
  | typeof LOT_SIZE_UNSET
  | typeof CLOSE_QUANTITY_MARGIN_DUST;

export function checkCloseQuantity(input: {
  quantity: Amount;
  size: Amount;
  lotSize: Amount | null;
}): { ok: true } | { ok: false; code: CloseQuantityCode; reason: string } {
  if (input.lotSize == null || input.lotSize <= 0n) {
    return {
      ok: false,
      code: LOT_SIZE_UNSET,
      reason: 'lot size is unset on this market — refuse rather than invent a step',
    };
  }
  if (input.quantity <= 0n) {
    return {
      ok: false,
      code: CLOSE_QUANTITY_INVALID,
      reason: 'close quantity must be greater than zero',
    };
  }
  if (input.quantity > input.size) {
    return {
      ok: false,
      code: CLOSE_QUANTITY_EXCEEDS_SIZE,
      reason: 'close quantity is larger than the position',
    };
  }
  if (input.quantity % input.lotSize !== 0n) {
    return {
      ok: false,
      code: CLOSE_QUANTITY_LOT_STEP,
      reason: 'close quantity is off the market lot step',
    };
  }
  return { ok: true };
}

export interface ProportionalFigures {
  readonly realizedPnl: Amount;
  readonly remainQty: Amount;
  readonly remainMargin: Amount;
  readonly remainInitial: Amount;
  readonly marginSlice: Amount;
  readonly initialSlice: Amount;
}

/** Conserving split. Remainder gets the truncated share; the slice gets the dust. */
export function proportionalCloseFigures(input: {
  side: 'long' | 'short';
  size: Amount;
  closeQty: Amount;
  entryPrice: Amount;
  exitPrice: Amount;
  margin: Amount;
  marginInitial: Amount;
}): ProportionalFigures {
  const remainQty = (input.size - input.closeQty) as Amount;
  const pnlFull = unrealizedPnl(input.side, input.size, input.entryPrice, input.exitPrice);
  const pnlRemain = remainQty === 0n ? 0n : unrealizedPnl(input.side, remainQty, input.entryPrice, input.exitPrice);
  const realizedPnl = (pnlFull - pnlRemain) as Amount;
  const remainMargin = remainQty === 0n ? 0n : (((input.margin * remainQty) / input.size) as Amount);
  const remainInitial = remainQty === 0n ? 0n : (((input.marginInitial * remainQty) / input.size) as Amount);
  return {
    realizedPnl,
    remainQty,
    remainMargin,
    remainInitial,
    marginSlice: (input.margin - remainMargin) as Amount,
    initialSlice: (input.marginInitial - remainInitial) as Amount,
  };
}

export type ProportionalClosePlan =
  | {
      readonly close: true;
      readonly full: boolean;
      readonly figures: ProportionalFigures;
      readonly exitPrice: Amount;
      readonly realizedPnl: Amount;
      readonly profit: Amount;
      readonly loss: Amount;
      readonly fromMargin: Amount;
      readonly fromInsurance: Amount;
      readonly residualRelease: Amount;
      readonly recipes: PostRequest[];
    }
  | { readonly close: false; readonly code: CloseQuantityCode; readonly reason: string };

export function planProportionalClose(input: {
  closeId: string;
  positionId: string;
  userId: string;
  side: 'long' | 'short';
  size: Amount;
  closeQty: Amount;
  entryPrice: Amount;
  exitPrice: Amount;
  margin: Amount;
  marginInitial: Amount;
  marginAsset: string;
  releaseSequence: number;
}): ProportionalClosePlan {
  if (input.closeQty <= 0n || input.closeQty > input.size || input.size <= 0n) {
    return { close: false, code: CLOSE_QUANTITY_INVALID, reason: 'close quantity is not a slice of this position' };
  }
  if (input.exitPrice <= 0n) {
    return { close: false, code: CLOSE_QUANTITY_INVALID, reason: 'exit price must be greater than zero' };
  }
  const figures = proportionalCloseFigures(input);
  if (figures.remainQty > 0n && figures.remainInitial <= 0n) {
    return {
      close: false,
      code: CLOSE_QUANTITY_MARGIN_DUST,
      reason: 'the remainder would keep no initial margin — refuse rather than invent a stake',
    };
  }

  const pnl = figures.realizedPnl;
  const posts: PostRequest[] = [];
  let profit = 0n;
  let loss = 0n;
  let fromMargin = 0n;
  let fromInsurance = 0n;
  let residualRelease = figures.marginSlice;

  if (pnl > 0n) {
    profit = pnl;
    posts.push(
      recipes.futuresRealizeProfit({
        positionId: input.positionId,
        userId: input.userId,
        assetId: input.marginAsset,
        amount: profit,
        profitId: `${input.closeId}:profit`,
      }),
    );
  } else if (pnl < 0n) {
    loss = -pnl;
    fromMargin = loss >= figures.marginSlice ? figures.marginSlice : loss;
    fromInsurance = loss > figures.marginSlice ? loss - figures.marginSlice : 0n;
    residualRelease = figures.marginSlice - fromMargin;
    if (fromMargin > 0n || fromInsurance > 0n) {
      posts.push(
        recipes.futuresRealizeLoss({
          positionId: input.positionId,
          userId: input.userId,
          assetId: input.marginAsset,
          fromMargin,
          fromInsurance,
          lossId: `${input.closeId}:loss`,
        }),
      );
    }
  }

  if (residualRelease > 0n) {
    posts.push(
      recipes.futuresMarginRelease({
        positionId: input.positionId,
        userId: input.userId,
        assetId: input.marginAsset,
        amount: residualRelease,
        sequence: input.releaseSequence,
      }),
    );
  }

  return {
    close: true,
    full: figures.remainQty === 0n,
    figures,
    exitPrice: input.exitPrice,
    realizedPnl: pnl,
    profit,
    loss,
    fromMargin,
    fromInsurance,
    residualRelease,
    recipes: posts,
  };
}
