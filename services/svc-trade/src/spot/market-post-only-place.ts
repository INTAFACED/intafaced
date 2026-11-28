import type { Principal } from '@intafaced/auth';
import { TradeError } from './types.js';
import { TradeService, type PlaceOrderInput } from './trade-service.js';
import type { EngineSubmitResult } from './matching-client.js';
import type { Market } from './types.js';

/**
 * Matching operator post-only of one market (`market_post_only`).
 * Non-post-only submits refuse. Post-only that would take still refuses
 * (existing PO law). Cancel stays. Trade does not swallow the refuse as a fill.
 */

export const MARKET_POST_ONLY = 'market_post_only' as const;

const MARKET_POST_ONLY_MESSAGE = 'market is post-only — non-post-only submits are refused; trade does not swallow this as a fill';

export function matchingMarketPostOnlyRefuse(
  rejected: { readonly code: string; readonly message?: string } | null | undefined,
): TradeError | null {
  if (rejected?.code !== MARKET_POST_ONLY) return null;
  return new TradeError(
    rejected.message && rejected.message.length > 0 ? rejected.message : MARKET_POST_ONLY_MESSAGE,
    'trade.market_post_only',
  );
}

export function matchingSubmitMarketPostOnlyRefuse(
  result:
    | {
        readonly rejected?: { readonly code: string; readonly message?: string } | null;
      }
    | null
    | undefined,
): TradeError | null {
  if (result == null) return null;
  return matchingMarketPostOnlyRefuse(result.rejected);
}

function postOnlyRejectResult(): EngineSubmitResult {
  return {
    accepted: false,
    sequence: null,
    fills: [],
    resting: null,
    rejected: { code: MARKET_POST_ONLY, message: MARKET_POST_ONLY_MESSAGE },
    cancellations: [],
    triggered: [],
  };
}

export function withMarketPostOnlyPlace(Base: typeof TradeService): typeof TradeService {
  return class MarketPostOnlyPlace extends Base {
    override async placeOrder(principal: Principal, input: PlaceOrderInput): ReturnType<TradeService['placeOrder']> {
      const order = await super.placeOrder(principal, input);
      const refuse = matchingMarketPostOnlyRefuse(order.rejectCode ? { code: order.rejectCode } : null);
      if (refuse) throw refuse;
      return order;
    }

    override async applySubmitResult(
      market: Market,
      orderId: string,
      result: EngineSubmitResult,
    ): ReturnType<TradeService['applySubmitResult']> {
      const refuse = matchingSubmitMarketPostOnlyRefuse(result);
      if (refuse) {
        await super.applySubmitResult(market, orderId, postOnlyRejectResult());
        throw refuse;
      }
      return super.applySubmitResult(market, orderId, result);
    }
  };
}
