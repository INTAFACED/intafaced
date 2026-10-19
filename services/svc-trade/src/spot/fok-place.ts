import type { Principal } from '@intafaced/auth';
import { TradeError } from './types.js';
import { TradeService, type PlaceOrderInput } from './trade-service.js';
import type { EngineSubmitRequest } from './matching-client.js';
import { carriedPlacementBody } from './placement-extras.js';

/**
 * Place an FOK through the matching door that just landed.
 * Fill completely or cancel the whole. No leftover rest. Trade does not invent a fill.
 */

type PlaceWithFok = PlaceOrderInput & { tif?: string };

const FLAG = Symbol.for('intafaced.trade.fokPlace');

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

export function installFokPlace(ctor: typeof TradeService): void {
  const proto = ctor.prototype as unknown as {
    placeOrder: (principal: Principal, input: PlaceOrderInput) => Promise<{ id: string; status: string }>;
    toEngineRequest: (...args: unknown[]) => EngineSubmitRequest;
    cancelOrder: (principal: Principal, orderId: string) => Promise<unknown>;
    [FLAG]?: true;
  };
  if (proto[FLAG]) return;
  proto[FLAG] = true;

  const origPlace = proto.placeOrder;
  proto.placeOrder = async function (this: TradeService, principal: Principal, input: PlaceOrderInput) {
    const bound = bindFok(input);
    if (bound.tif === 'FOK' && bound.type === 'limit' && bound.price == null) {
      throw new TradeError('FOK limit requires a price; trade does not invent a fill', 'trade.invalid_tif');
    }
    const order = await origPlace.call(this, principal, bound);
    if (bound.tif === 'FOK' && order.status === 'open') {
      return proto.cancelOrder.call(this, principal, order.id) as Promise<{ id: string; status: string }>;
    }
    return order;
  };

  const origToEngine = proto.toEngineRequest;
  proto.toEngineRequest = function (this: TradeService, ...args: unknown[]) {
    const req = origToEngine.apply(this, args);
    const input = args[2] as PlaceWithFok | undefined;
    if (req.tif === 'FOK' || input?.tif === 'FOK') {
      return { ...req, tif: 'FOK' };
    }
    return req;
  };
}

installFokPlace(TradeService);
