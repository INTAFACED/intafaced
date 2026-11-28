import type { Principal } from '@intafaced/auth';
import { TradeError } from './types.js';
import { TradeService, type PlaceOrderInput } from './trade-service.js';
import { carriedPlacementBody } from './placement-extras.js';

/**
 * Place a post-only through the matching door already on main.
 *
 * Matching owns the book. Trade does not invent a price. Forward tif PO
 * (from tif PO or postOnly true) to matching. Matching refuse
 * post_only_would_cross rejects the place; the hold already taken is
 * released on that reject (existing finalize path).
 *
 * Market or missing price refuses trade.invalid_tif BEFORE origPlace
 * so no hold is taken and matching is not called.
 *
 * Installed onto TradeService.prototype so trade-service.ts never moves.
 * private-rest mapCreateOrderBody still throws on body.postOnly === true;
 * the stash deletes that field before the mapper runs. timeInForce stays.
 */

type PlaceWithPo = PlaceOrderInput & { postOnly?: boolean; price?: unknown };

/** True when this request's own body asks for it. */
function stashedFor(body: Readonly<Record<string, unknown>> | null): boolean {
  return body !== null && (body.postOnly === true || body.timeInForce === 'PO' || body.tif === 'PO');
}

export function bindPostOnly(input: PlaceOrderInput): PlaceWithPo {
  const extra = input as PlaceWithPo;
  if (extra.tif === 'PO' || extra.postOnly === true) {
    return { ...extra, tif: 'PO' };
  }
  if (!stashedFor(carriedPlacementBody(extra))) return extra;
  return { ...extra, tif: 'PO' };
}

export function withPostOnlyPlace(Base: typeof TradeService): typeof TradeService {
  return class PostOnlyPlace extends Base {
    override async placeOrder(principal: Principal, input: PlaceOrderInput): ReturnType<TradeService['placeOrder']> {
      const bound = bindPostOnly(input);
      if (bound.tif === 'PO' && (bound.type === 'market' || bound.price == null)) {
        throw new TradeError('post-only requires a limit price; trade does not invent one', 'trade.invalid_tif');
      }
      return super.placeOrder(principal, bound);
    }

    override toEngineRequest(...args: unknown[]): ReturnType<TradeService['toEngineRequest']> {
      const req = super.toEngineRequest(...(args as Parameters<TradeService['toEngineRequest']>));
      const input = args[2] as PlaceWithPo | undefined;
      if (req.tif === 'PO' || input?.tif === 'PO' || input?.postOnly === true) {
        return { ...req, tif: 'PO' };
      }
      return req;
    }
  };
}
