import type { Principal } from '@intafaced/auth';
import { TradeError } from './types.js';
import { TradeService, type PlaceOrderInput } from './trade-service.js';
import type { EngineSubmitResult } from './matching-client.js';
import type { Market } from './types.js';

/**
 * Matching operator prelaunch of one market (`market_prelaunch`).
 * Public submits refuse until OPEN. Cancel of nothing is a no-op.
 * Distinct from halt: `open` does not clear halt; `resume` does not clear prelaunch.
 * Trade does not swallow the refuse as a fill.
 */

export const MARKET_PRELAUNCH = 'market_prelaunch' as const;

const MARKET_PRELAUNCH_MESSAGE = 'market is prelaunch — public submits are refused until open; trade does not swallow this as a fill';

export function matchingMarketPrelaunchRefuse(
  rejected: { readonly code: string; readonly message?: string } | null | undefined,
): TradeError | null {
  if (rejected?.code !== MARKET_PRELAUNCH) return null;
  return new TradeError(
    rejected.message && rejected.message.length > 0 ? rejected.message : MARKET_PRELAUNCH_MESSAGE,
    'trade.market_prelaunch',
  );
}

export function matchingSubmitMarketPrelaunchRefuse(
  result:
    | {
        readonly rejected?: { readonly code: string; readonly message?: string } | null;
      }
    | null
    | undefined,
): TradeError | null {
  if (result == null) return null;
  return matchingMarketPrelaunchRefuse(result.rejected);
}

function prelaunchRejectResult(): EngineSubmitResult {
  return {
    accepted: false,
    sequence: null,
    fills: [],
    resting: null,
    rejected: { code: MARKET_PRELAUNCH, message: MARKET_PRELAUNCH_MESSAGE },
    cancellations: [],
    triggered: [],
  };
}

export function withMarketPrelaunchPlace(Base: typeof TradeService): typeof TradeService {
  return class MarketPrelaunchPlace extends Base {
    override async placeOrder(principal: Principal, input: PlaceOrderInput): ReturnType<TradeService['placeOrder']> {
      const order = await super.placeOrder(principal, input);
      const refuse = matchingMarketPrelaunchRefuse(order.rejectCode ? { code: order.rejectCode } : null);
      if (refuse) throw refuse;
      return order;
    }

    override async applySubmitResult(
      market: Market,
      orderId: string,
      result: EngineSubmitResult,
    ): ReturnType<TradeService['applySubmitResult']> {
      const refuse = matchingSubmitMarketPrelaunchRefuse(result);
      if (refuse) {
        await super.applySubmitResult(market, orderId, prelaunchRejectResult());
        throw refuse;
      }
      return super.applySubmitResult(market, orderId, result);
    }
  };
}
