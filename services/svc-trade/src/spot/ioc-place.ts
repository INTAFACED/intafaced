import type { Principal } from '@intafaced/auth';
import { parseAmount } from '@intafaced/ledger-client';
import { TradeError } from './types.js';
import { TradeService, type PlaceOrderInput } from './trade-service.js';
import type { EngineCancellation, EngineFill } from './matching-client.js';
import type { Market } from './types.js';
import { carriedPlacementBody } from './placement-extras.js';

/**
 * Place an IOC through the matching door that just landed.
 * Take what is there. Unfilled remainder cancels. Trade does not invent a leftover rest.
 */

type PlaceWithIoc = PlaceOrderInput & { tif?: string };

export const IOC_REMAINDER = 'ioc_remainder' as const;
export const MARKET_REMAINDER = 'market_remainder' as const;

function isIoc(tif: unknown): boolean {
  return tif === 'IOC';
}

/** True when this request's own body asks for it. */
function stashedFor(body: Readonly<Record<string, unknown>> | null): boolean {
  return body !== null && (isIoc(body.timeInForce) || isIoc(body.tif));
}

export function bindIoc(input: PlaceOrderInput): PlaceWithIoc {
  const extra = input as PlaceWithIoc;
  if (isIoc(extra.tif)) return { ...extra, tif: 'IOC' };
  if (!stashedFor(carriedPlacementBody(extra))) return extra;
  return { ...extra, tif: 'IOC' };
}

export function leftoverCancels(tif: unknown, resting: unknown): boolean {
  return isIoc(tif) && resting != null;
}

export function withIocPlace(Base: typeof TradeService): typeof TradeService {
  return class IocPlace extends Base {
    override async placeOrder(principal: Principal, input: PlaceOrderInput): ReturnType<TradeService['placeOrder']> {
      const bound = bindIoc(input);
      if (bound.tif === 'IOC' && bound.type === 'limit' && bound.price == null) {
        throw new TradeError('IOC limit requires a price; trade does not invent one', 'trade.invalid_tif');
      }
      const order = await super.placeOrder(principal, bound);
      if (bound.tif === 'IOC' && order.status === 'open') {
        return this.cancelOrder(principal, order.id);
      }
      return order;
    }

    override toEngineRequest(...args: unknown[]): ReturnType<TradeService['toEngineRequest']> {
      const req = super.toEngineRequest(...(args as Parameters<TradeService['toEngineRequest']>));
      const input = args[2] as PlaceWithIoc | undefined;
      if (req.tif === 'IOC' || input?.tif === 'IOC') {
        return { ...req, tif: 'IOC' };
      }
      return req;
    }

    override async settleOutcome(
      market: Market,
      fills: readonly EngineFill[],
      cancellations: readonly EngineCancellation[],
    ): ReturnType<TradeService['settleOutcome']> {
      const leftover: EngineCancellation[] = [];
      const rest: EngineCancellation[] = [];
      for (const c of cancellations) {
        if (c.reason === IOC_REMAINDER || c.reason === MARKET_REMAINDER) leftover.push(c);
        else rest.push(c);
      }
      await super.settleOutcome(market, fills, rest);
      for (const c of leftover) {
        // The engine's remainder says how much it executed first (#8560): an order another submission partly matched
        // may still have that fill on its way, and `finalize` then refuses; the engine's cancel event closes it later.
        try {
          await this.finalize(c.orderId, 'cancelled', c.reason, { engineLeftQty: parseAmount(c.remainingQty) });
        } catch (err) {
          if (!(err instanceof TradeError && err.code === 'trade.cancel_ahead_of_fill')) throw err;
        }
      }
    }
  };
}
