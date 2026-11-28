import type { Principal } from '@intafaced/auth';
import { TradeError } from './types.js';
import { TradeService, type PlaceOrderInput } from './trade-service.js';
import type { EngineFill, EngineSubmitResult, EngineTriggerOutcome } from './matching-client.js';
import type { Market } from './types.js';

/**
 * Matching fillableQty/FOK stops at own rest (`self_trade`). Incoming that
 * would match the same account is refused. Resting stays. Trade does not
 * invent a self-fill or swallow FOK into a fill. Missing or empty accountIds
 * are not a self-trade. No owner STP mode.
 */

export const SELF_TRADE = 'self_trade' as const;

const SELF_TRADE_MESSAGE = 'incoming order would match the same account; trade does not invent a self-fill';

export function matchingSelfTradeRefuse(
  rejected: { readonly code: string; readonly message?: string } | null | undefined,
): TradeError | null {
  if (rejected?.code !== SELF_TRADE) return null;
  return new TradeError(SELF_TRADE_MESSAGE, 'trade.self_trade');
}

/** Same live account on a fill. Empty ids are missing — they still fill. */
export function matchingSelfFillRefuse(
  fills: ReadonlyArray<{ readonly makerAccountId?: string; readonly takerAccountId?: string }> | null | undefined,
): TradeError | null {
  if (fills == null) return null;
  for (const fill of fills) {
    const maker = fill.makerAccountId ?? '';
    const taker = fill.takerAccountId ?? '';
    if (maker.length > 0 && taker.length > 0 && maker === taker) {
      return new TradeError(SELF_TRADE_MESSAGE, 'trade.self_trade');
    }
  }
  return null;
}

function fillsFromTriggers(triggered: readonly EngineTriggerOutcome[] | null | undefined): EngineFill[] {
  if (triggered == null) return [];
  const out: EngineFill[] = [];
  for (const t of triggered) out.push(...t.fills);
  return out;
}

export function matchingSubmitSelfTradeRefuse(
  result:
    | {
        readonly rejected?: { readonly code: string; readonly message?: string } | null;
        readonly fills?: ReadonlyArray<{ readonly makerAccountId?: string; readonly takerAccountId?: string }> | null;
        readonly triggered?: readonly EngineTriggerOutcome[] | null;
      }
    | null
    | undefined,
): TradeError | null {
  if (result == null) return null;
  return (
    matchingSelfTradeRefuse(result.rejected) ??
    matchingSelfFillRefuse(result.fills) ??
    matchingSelfFillRefuse(fillsFromTriggers(result.triggered))
  );
}

function selfTradeRejectResult(): EngineSubmitResult {
  return {
    accepted: false,
    sequence: null,
    fills: [],
    resting: null,
    rejected: { code: SELF_TRADE, message: SELF_TRADE_MESSAGE },
    cancellations: [],
    triggered: [],
  };
}

export function withSelfTradePlace(Base: typeof TradeService): typeof TradeService {
  return class SelfTradePlace extends Base {
    override async placeOrder(principal: Principal, input: PlaceOrderInput): ReturnType<TradeService['placeOrder']> {
      const order = await super.placeOrder(principal, input);
      const refuse = matchingSelfTradeRefuse(order.rejectCode ? { code: order.rejectCode } : null);
      if (refuse) throw refuse;
      return order;
    }

    override async applySubmitResult(
      market: Market,
      orderId: string,
      result: EngineSubmitResult,
    ): ReturnType<TradeService['applySubmitResult']> {
      const fillRefuse = matchingSelfFillRefuse(result.fills) ?? matchingSelfFillRefuse(fillsFromTriggers(result.triggered));
      if (fillRefuse) {
        await super.applySubmitResult(market, orderId, selfTradeRejectResult());
        throw fillRefuse;
      }
      return super.applySubmitResult(market, orderId, result);
    }
  };
}
