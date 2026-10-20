/**
 * Voluntary close planner (trade.futures residual).
 *
 * PURE: position + external exit price → ledger recipe inputs for realized
 * PnL + full margin release. Does NOT invent marks, does NOT post, does NOT
 * mutate position rows. Job/REST supplies exit price + posts recipes + closes.
 *
 * Profit → futuresRealizeProfit (the clearing pot pays user available; owed while short)
 * Loss   → futuresRealizeLoss (margin first, optional insurance shortfall)
 * Flat   → margin release only
 */
import { formatAmount, parseAmount, recipes, type Amount, type PostRequest } from '@intafaced/ledger-client';
import { unrealizedPnl } from './liquidation-planner.js';

const SCALE = 10n ** 18n;

export interface ClosePosition {
  positionId: string;
  userId: string;
  side: 'long' | 'short';
  size: Amount;
  entryPrice: Amount;
  margin: Amount;
  marginAsset: string;
}

export interface ClosePlanInput {
  /**
   * Idempotency root for this close — `:profit` and `:loss` hang off it.
   *
   * ONE PER CLOSE, NOT ONE PER ATTEMPT. This used to read "unique close attempt
   * id", and `position-service.ts` obliged with a fresh `randomUUID()` on every
   * call — which made `futures.profit:${profitId}` unique per attempt and left
   * the ledger nothing to dedupe on, so concurrent and replayed closes each paid
   * the same realised profit over again. Build it with `closeIdFor(positionId)`.
   */
  closeId: string;
  position: ClosePosition;
  /** External exit mark — decimal string. Never invent. */
  exitPrice: string;
}

export type ClosePlan =
  | {
      close: true;
      exitPrice: Amount;
      realizedPnl: Amount;
      profit: Amount;
      loss: Amount;
      fromMargin: Amount;
      fromInsurance: Amount;
      residualRelease: Amount;
      recipes: PostRequest[];
      reason: 'profit' | 'loss' | 'flat';
    }
  | { close: false; reason: string };

export function planClose(input: ClosePlanInput): ClosePlan {
  const exit = parseAmount(input.exitPrice);
  if (exit <= 0n) {
    return { close: false, reason: 'invalid_exit' };
  }
  const { position } = input;
  if (position.size <= 0n) {
    return { close: false, reason: 'empty_position' };
  }
  if (position.margin < 0n) {
    return { close: false, reason: 'invalid_margin' };
  }

  const pnl = unrealizedPnl(position.side, position.size, position.entryPrice, exit);
  const posts: PostRequest[] = [];

  let profit = 0n;
  let loss = 0n;
  let fromMargin = 0n;
  let fromInsurance = 0n;
  let residualRelease = position.margin;
  let reason: 'profit' | 'loss' | 'flat' = 'flat';

  if (pnl > 0n) {
    reason = 'profit';
    profit = pnl;
    posts.push(
      recipes.futuresRealizeProfit({
        positionId: position.positionId,
        userId: position.userId,
        assetId: position.marginAsset,
        amount: profit,
        profitId: `${input.closeId}:profit`,
      }),
    );
  } else if (pnl < 0n) {
    reason = 'loss';
    loss = -pnl;
    fromMargin = loss >= position.margin ? position.margin : loss;
    fromInsurance = loss > position.margin ? loss - position.margin : 0n;
    residualRelease = position.margin - fromMargin;
    if (fromMargin > 0n || fromInsurance > 0n) {
      posts.push(
        recipes.futuresRealizeLoss({
          positionId: position.positionId,
          userId: position.userId,
          assetId: position.marginAsset,
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
        positionId: position.positionId,
        userId: position.userId,
        assetId: position.marginAsset,
        amount: residualRelease,
        sequence: 1,
      }),
    );
  }

  return {
    close: true,
    exitPrice: exit,
    realizedPnl: pnl,
    profit,
    loss,
    fromMargin,
    fromInsurance,
    residualRelease,
    recipes: posts,
    reason,
  };
}

export function summarizeClose(plan: ClosePlan): string {
  if (!plan.close) return `skip (${plan.reason})`;
  return `close ${plan.reason} pnl=${formatAmount(plan.realizedPnl)} release=${formatAmount(plan.residualRelease)} recipes=${plan.recipes.length}`;
}

/** Exposed for tests — notional helper if needed later. */
export function notionalAt(size: Amount, price: Amount): Amount {
  return (size * price) / SCALE;
}
