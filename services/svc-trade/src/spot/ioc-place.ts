import type { Principal } from '@intafaced/auth';
import { TradeError } from './types.js';
import { TradeService, type PlaceOrderInput } from './trade-service.js';
import type { EngineCancellation, EngineFill, EngineSubmitRequest } from './matching-client.js';
import type { Market } from './types.js';
import { carriedPlacementBody } from './placement-extras.js';

/**
 * Place an IOC through the matching door that just landed.
 * Take what is there. Unfilled remainder cancels. Trade does not invent a leftover rest.
 */

type PlaceWithIoc = PlaceOrderInput & { tif?: string };

const FLAG = Symbol.for('intafaced.trade.iocPlace');

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

export function installIocPlace(ctor: typeof TradeService): void {
  const proto = ctor.prototype as unknown as {
    placeOrder: (principal: Principal, input: PlaceOrderInput) => Promise<{ id: string; status: string }>;
    toEngineRequest: (...args: unknown[]) => EngineSubmitRequest;
    settleOutcome: (market: Market, fills: readonly EngineFill[], cancellations: readonly EngineCancellation[]) => Promise<void>;
    finalize: (orderId: string, status: 'cancelled' | 'filled' | 'expired' | 'rejected', reason?: string | null) => Promise<void>;
    cancelOrder: (principal: Principal, orderId: string) => Promise<unknown>;
    [FLAG]?: true;
  };
  if (proto[FLAG]) return;
  proto[FLAG] = true;

  const origPlace = proto.placeOrder;
  proto.placeOrder = async function (this: TradeService, principal: Principal, input: PlaceOrderInput) {
    const bound = bindIoc(input);
    if (bound.tif === 'IOC' && bound.type === 'limit' && bound.price == null) {
      throw new TradeError('IOC limit requires a price; trade does not invent one', 'trade.invalid_tif');
    }
    const order = await origPlace.call(this, principal, bound);
    if (bound.tif === 'IOC' && order.status === 'open') {
      return proto.cancelOrder.call(this, principal, order.id) as Promise<{ id: string; status: string }>;
    }
    return order;
  };

  const origToEngine = proto.toEngineRequest;
  proto.toEngineRequest = function (this: TradeService, ...args: unknown[]) {
    const req = origToEngine.apply(this, args);
    const input = args[2] as PlaceWithIoc | undefined;
    if (req.tif === 'IOC' || input?.tif === 'IOC') {
      return { ...req, tif: 'IOC' };
    }
    return req;
  };

  const origSettle = proto.settleOutcome;
  proto.settleOutcome = async function (
    this: TradeService,
    market: Market,
    fills: readonly EngineFill[],
    cancellations: readonly EngineCancellation[],
  ) {
    const leftover: EngineCancellation[] = [];
    const rest: EngineCancellation[] = [];
    for (const c of cancellations) {
      if (c.reason === IOC_REMAINDER || c.reason === MARKET_REMAINDER) leftover.push(c);
      else rest.push(c);
    }
    await origSettle.call(this, market, fills, rest);
    for (const c of leftover) {
      await proto.finalize.call(this, c.orderId, 'cancelled', c.reason);
    }
  };
}

installIocPlace(TradeService);
