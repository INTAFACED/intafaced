import type { Principal } from '@intafaced/auth';
import { TradeError } from './types.js';
import { TradeService, type PlaceOrderInput } from './trade-service.js';
import type { EngineSubmitResult } from './matching-client.js';
import type { Market } from './types.js';

/**
 * Matching operator reduce-only of one market (`market_reduce_only`).
 * Opens and increases refuse. Reduce-only, close, and cancel stay.
 * Trade does not swallow the refuse as a fill.
 */

export const MARKET_REDUCE_ONLY = 'market_reduce_only' as const;

const MARKET_REDUCE_ONLY_MESSAGE =
  'market is reduce-only — submits that would open or increase are refused; trade does not swallow this as a fill';

export function matchingMarketReduceOnlyRefuse(
  rejected: { readonly code: string; readonly message?: string } | null | undefined,
): TradeError | null {
  if (rejected?.code !== MARKET_REDUCE_ONLY) return null;
  return new TradeError(
    rejected.message && rejected.message.length > 0 ? rejected.message : MARKET_REDUCE_ONLY_MESSAGE,
    'trade.market_reduce_only',
  );
}

export function matchingSubmitMarketReduceOnlyRefuse(
  result:
    | {
        readonly rejected?: { readonly code: string; readonly message?: string } | null;
      }
    | null
    | undefined,
): TradeError | null {
  if (result == null) return null;
  return matchingMarketReduceOnlyRefuse(result.rejected);
}

function reduceOnlyRejectResult(): EngineSubmitResult {
  return {
    accepted: false,
    sequence: null,
    fills: [],
    resting: null,
    rejected: { code: MARKET_REDUCE_ONLY, message: MARKET_REDUCE_ONLY_MESSAGE },
    cancellations: [],
    triggered: [],
  };
}

export function withMarketReduceOnlyPlace(Base: typeof TradeService): typeof TradeService {
  return class MarketReduceOnlyPlace extends Base {
    override async placeOrder(principal: Principal, input: PlaceOrderInput): ReturnType<TradeService['placeOrder']> {
      const order = await super.placeOrder(principal, input);
      const refuse = matchingMarketReduceOnlyRefuse(order.rejectCode ? { code: order.rejectCode } : null);
      if (refuse) throw refuse;
      return order;
    }

    override async applySubmitResult(
      market: Market,
      orderId: string,
      result: EngineSubmitResult,
    ): ReturnType<TradeService['applySubmitResult']> {
      const refuse = matchingSubmitMarketReduceOnlyRefuse(result);
      if (refuse) {
        await super.applySubmitResult(market, orderId, reduceOnlyRejectResult());
        throw refuse;
      }
      return super.applySubmitResult(market, orderId, result);
    }
  };
}
