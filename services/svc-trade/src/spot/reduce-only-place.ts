import type { Principal } from '@intafaced/auth';
import { TradeService, type PlaceOrderInput } from './trade-service.js';
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

export function withReduceOnlyPlace(Base: typeof TradeService): typeof TradeService {
  return class ReduceOnlyPlace extends Base {
    override async placeOrder(principal: Principal, input: PlaceOrderInput): ReturnType<TradeService['placeOrder']> {
      return super.placeOrder(principal, bindReduceOnly(input));
    }

    override toEngineRequest(...args: unknown[]): ReturnType<TradeService['toEngineRequest']> {
      const req = super.toEngineRequest(...(args as Parameters<TradeService['toEngineRequest']>));
      const input = args[2] as PlaceWithRo | undefined;
      if (input?.reduceOnly === true) {
        return { ...req, reduceOnly: true };
      }
      return req;
    }
  };
}
