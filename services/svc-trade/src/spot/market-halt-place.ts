import type { Principal } from '@intafaced/auth';
import { TradeError } from './types.js';
import { TradeService, type PlaceOrderInput } from './trade-service.js';
import type { EngineSubmitResult } from './matching-client.js';
import type { Market } from './types.js';

/**
 * Matching operator halt of one market (`market_halted`). New submits refuse.
 * Resting stays. Cancel still works. Trade does not swallow the refuse as a fill.
 */

export const MARKET_HALTED = 'market_halted' as const;

const MARKET_HALTED_MESSAGE = 'market is halted — new submits are refused; trade does not swallow this as a fill';

export function matchingMarketHaltedRefuse(
  rejected: { readonly code: string; readonly message?: string } | null | undefined,
): TradeError | null {
  if (rejected?.code !== MARKET_HALTED) return null;
  return new TradeError(rejected.message && rejected.message.length > 0 ? rejected.message : MARKET_HALTED_MESSAGE, 'trade.market_halted');
}

export function matchingSubmitMarketHaltedRefuse(
  result:
    | {
        readonly rejected?: { readonly code: string; readonly message?: string } | null;
      }
    | null
    | undefined,
): TradeError | null {
  if (result == null) return null;
  return matchingMarketHaltedRefuse(result.rejected);
}

function haltedRejectResult(): EngineSubmitResult {
  return {
    accepted: false,
    sequence: null,
    fills: [],
    resting: null,
    rejected: { code: MARKET_HALTED, message: MARKET_HALTED_MESSAGE },
    cancellations: [],
    triggered: [],
  };
}

export function withMarketHaltPlace(Base: typeof TradeService): typeof TradeService {
  return class MarketHaltPlace extends Base {
    override async placeOrder(principal: Principal, input: PlaceOrderInput): ReturnType<TradeService['placeOrder']> {
      const order = await super.placeOrder(principal, input);
      const refuse = matchingMarketHaltedRefuse(order.rejectCode ? { code: order.rejectCode } : null);
      if (refuse) throw refuse;
      return order;
    }

    override async applySubmitResult(
      market: Market,
      orderId: string,
      result: EngineSubmitResult,
    ): ReturnType<TradeService['applySubmitResult']> {
      const refuse = matchingSubmitMarketHaltedRefuse(result);
      if (refuse) {
        await super.applySubmitResult(market, orderId, haltedRejectResult());
        throw refuse;
      }
      return super.applySubmitResult(market, orderId, result);
    }
  };
}
