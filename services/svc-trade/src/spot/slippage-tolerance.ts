import { TradeError } from './types.js';
import { carriedPlacementBody } from './placement-extras.js';
import type { PlaceOrderInput } from './trade-service.js';

/**
 * Per-order slippage tolerance in basis points, for a market order.
 *
 * It rides on the create-order body as `maxSlippageBps` (an integer from 1 up to the owner cap). It may only
 * TIGHTEN the owner's `TRADE_MARKET_SLIPPAGE_CAP_BPS`: the protection price is the tighter of the two, so the hold
 * and the engine limit never exceed what the owner published. A value above the cap, a non-integer, or one on an
 * order that has no market protection is refused before any hold, never clamped or ignored.
 */
export function slippageToleranceFor(input: PlaceOrderInput, orderType: string, ownerCapBps: number | null): number | null {
  const raw = carriedPlacementBody(input)?.maxSlippageBps;
  if (raw === undefined || raw === null) return null;
  if (orderType !== 'market') {
    throw new TradeError('maxSlippageBps applies to market orders only', 'trade.slippage_tolerance_invalid');
  }
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1) {
    throw new TradeError('maxSlippageBps must be a whole number of basis points, at least 1', 'trade.slippage_tolerance_invalid');
  }
  // An unpublished owner cap is refused by the protection price itself; a tolerance never stands in for it.
  if (ownerCapBps != null && raw > ownerCapBps) {
    throw new TradeError(`maxSlippageBps ${raw} is looser than the owner cap ${ownerCapBps}`, 'trade.slippage_tolerance_invalid');
  }
  return raw;
}
