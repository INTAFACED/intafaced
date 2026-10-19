import type { Principal } from '@intafaced/auth';
import { TradeService, type PlaceOrderInput } from './trade-service.js';
import type { EngineSubmitRequest } from './matching-client.js';
import { carriedPlacementBody } from './placement-extras.js';

/**
 * Place a reduce-only through the matching door that landed in #3237.
 *
 * Matching owns position (net fills on that book). Trade does not invent a mark.
 * Forward reduceOnly to matching. Matching refuse would_increase_position
 * rejects the place; the hold already taken is released on that reject
 * (existing finalize path).
 *
 * Installed onto TradeService.prototype so trade-service.ts never moves.
 * private-rest mapCreateOrderBody still throws on body.reduceOnly === true;
 * the stash deletes that field before the mapper runs.
 */

type PlaceWithRo = PlaceOrderInput & { reduceOnly?: boolean };

const FLAG = Symbol.for('intafaced.trade.reduceOnlyPlace');

/** True when this request's own body asks for it. */
function stashedFor(body: Readonly<Record<string, unknown>> | null): boolean {
  return body !== null && body.reduceOnly === true;
}

export function bindReduceOnly(input: PlaceOrderInput): PlaceWithRo {
  const extra = input as PlaceWithRo;
  if (extra.reduceOnly === true) return extra;
  if (!stashedFor(carriedPlacementBody(extra))) return extra;
  return { ...extra, reduceOnly: true };
}

export function installReduceOnlyPlace(ctor: typeof TradeService): void {
  const proto = ctor.prototype as unknown as {
    placeOrder: (principal: Principal, input: PlaceOrderInput) => Promise<unknown>;
    toEngineRequest: (...args: unknown[]) => EngineSubmitRequest;
    [FLAG]?: true;
  };
  if (proto[FLAG]) return;
  proto[FLAG] = true;

  const origPlace = proto.placeOrder;
  proto.placeOrder = async function (this: TradeService, principal: Principal, input: PlaceOrderInput) {
    return origPlace.call(this, principal, bindReduceOnly(input));
  };

  const origToEngine = proto.toEngineRequest;
  proto.toEngineRequest = function (this: TradeService, ...args: unknown[]) {
    const req = origToEngine.apply(this, args);
    const input = args[2] as PlaceWithRo | undefined;
    if (input?.reduceOnly === true) {
      return { ...req, reduceOnly: true };
    }
    return req;
  };
}

installReduceOnlyPlace(TradeService);
