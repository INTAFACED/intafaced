import type { Principal } from '@intafaced/auth';
import { TradeError } from './types.js';
import { TradeService, type PlaceOrderInput } from './trade-service.js';
import type { EngineSubmitResult } from './matching-client.js';
import type { Market } from './types.js';

/**
 * Matching operator halt of ALL markets (`venue_halted`). New submits refuse.
 * Resting stays. Cancel still works. Distinct from one-market `market_halted`.
 * Trade does not swallow the refuse as a fill.
 */

export const VENUE_HALTED = 'venue_halted' as const;

const VENUE_HALTED_MESSAGE = 'all markets are halted — new submits are refused; trade does not swallow this as a fill';

export function matchingVenueHaltedRefuse(
  rejected: { readonly code: string; readonly message?: string } | null | undefined,
): TradeError | null {
  if (rejected?.code !== VENUE_HALTED) return null;
  return new TradeError(rejected.message && rejected.message.length > 0 ? rejected.message : VENUE_HALTED_MESSAGE, 'trade.venue_halted');
}

export function matchingSubmitVenueHaltedRefuse(
  result:
    | {
        readonly rejected?: { readonly code: string; readonly message?: string } | null;
      }
    | null
    | undefined,
): TradeError | null {
  if (result == null) return null;
  return matchingVenueHaltedRefuse(result.rejected);
}

function venueHaltedRejectResult(): EngineSubmitResult {
  return {
    accepted: false,
    sequence: null,
    fills: [],
    resting: null,
    rejected: { code: VENUE_HALTED, message: VENUE_HALTED_MESSAGE },
    cancellations: [],
    triggered: [],
  };
}

export function withVenueHaltPlace(Base: typeof TradeService): typeof TradeService {
  return class VenueHaltPlace extends Base {
    override async placeOrder(principal: Principal, input: PlaceOrderInput): ReturnType<TradeService['placeOrder']> {
      const order = await super.placeOrder(principal, input);
      const refuse = matchingVenueHaltedRefuse(order.rejectCode ? { code: order.rejectCode } : null);
      if (refuse) throw refuse;
      return order;
    }

    override async applySubmitResult(
      market: Market,
      orderId: string,
      result: EngineSubmitResult,
    ): ReturnType<TradeService['applySubmitResult']> {
      const refuse = matchingSubmitVenueHaltedRefuse(result);
      if (refuse) {
        await super.applySubmitResult(market, orderId, venueHaltedRejectResult());
        throw refuse;
      }
      return super.applySubmitResult(market, orderId, result);
    }
  };
}
