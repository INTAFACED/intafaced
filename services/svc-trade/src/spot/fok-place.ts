import type { Principal } from '@intafaced/auth';
import { TradeError } from './types.js';
import { TradeService, type PlaceOrderInput } from './trade-service.js';
import { carriedPlacementBody } from './placement-extras.js';

/**
 * Place an FOK through the matching door that just landed.
 * Fill completely or cancel the whole. No leftover rest. Trade does not invent a fill.
 */

type PlaceWithFok = PlaceOrderInput & { tif?: string };

export const FOK_UNFILLABLE = 'fok_unfillable' as const;

function isFok(tif: unknown): boolean {
  return tif === 'FOK';
}

/** True when this request's own body asks for it. */
function stashedFor(body: Readonly<Record<string, unknown>> | null): boolean {
  return body !== null && (isFok(body.timeInForce) || isFok(body.tif));
}

export function bindFok(input: PlaceOrderInput): PlaceWithFok {
  const extra = input as PlaceWithFok;
  if (isFok(extra.tif)) return { ...extra, tif: 'FOK' };
  if (!stashedFor(carriedPlacementBody(extra))) return extra;
  return { ...extra, tif: 'FOK' };
}

export function withFokPlace(Base: typeof TradeService): typeof TradeService {
  return class FokPlace extends Base {
    override async placeOrder(principal: Principal, input: PlaceOrderInput): ReturnType<TradeService['placeOrder']> {
      const bound = bindFok(input);
      if (bound.tif === 'FOK' && bound.type === 'limit' && bound.price == null) {
        throw new TradeError('FOK limit requires a price; trade does not invent a fill', 'trade.invalid_tif');
      }
      const order = await super.placeOrder(principal, bound);
      if (bound.tif === 'FOK' && order.status === 'open') {
        return this.cancelOrder(principal, order.id);
      }
      return order;
    }

    override toEngineRequest(...args: unknown[]): ReturnType<TradeService['toEngineRequest']> {
      const req = super.toEngineRequest(...(args as Parameters<TradeService['toEngineRequest']>));
      const input = args[2] as PlaceWithFok | undefined;
      if (req.tif === 'FOK' || input?.tif === 'FOK') {
        return { ...req, tif: 'FOK' };
      }
      return req;
    }
  };
}
