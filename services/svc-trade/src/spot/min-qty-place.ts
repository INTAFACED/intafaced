import type { Principal } from '@intafaced/auth';
import { formatAmount, parseAmount, ZERO, type Amount } from '@intafaced/ledger-client';
import { TradeError } from './types.js';
import { TradeService, type PlaceOrderInput } from './trade-service.js';
import { carriedPlacementBody } from './placement-extras.js';

/**
 * Place a min qty through the matching door that landed in #3305.
 * A fill below the floor does not occur.
 * Missing or zero is a normal place. Trade does not invent a minQty.
 */

type PlaceWithMinQty = PlaceOrderInput & {
  minQty?: Amount | null;
};

export const MIN_QTY_EXCEEDS = 'min_qty_exceeds_qty' as const;

function wantsMinQty(rec: Record<string, unknown>): boolean {
  return rec.minQty !== undefined;
}

/** Caller min qty. Missing, null, or zero is not set. */
export function readMinQty(order: { readonly minQty?: Amount | null }): Amount | null {
  if (order.minQty === undefined || order.minQty === null || order.minQty <= ZERO) return null;
  return order.minQty;
}

export function minQtyRefuse(qty: Amount, minQty: Amount | null): TradeError | null {
  if (minQty === null) return null;
  if (minQty > qty) {
    return new TradeError('minQty must not exceed remaining qty; trade does not invent a fill', 'trade.min_qty_exceeds_qty');
  }
  return null;
}

/** What this request's own body asks for; null when it asks for nothing. */
function stashedFor(body: Readonly<Record<string, unknown>> | null): { minQty: string | null } | null {
  if (!body || !wantsMinQty(body)) return null;
  return { minQty: body.minQty == null || body.minQty === '' ? null : String(body.minQty) };
}

export function bindMinQty(input: PlaceOrderInput): PlaceWithMinQty {
  const extra = input as PlaceWithMinQty;
  if (wantsMinQty(extra as unknown as Record<string, unknown>)) {
    return { ...extra, minQty: extra.minQty ?? null };
  }
  const hit = stashedFor(carriedPlacementBody(extra));
  if (!hit) return extra;
  return {
    ...extra,
    minQty: hit.minQty == null ? null : parseAmount(hit.minQty),
  };
}

export function withMinQtyPlace(Base: typeof TradeService): typeof TradeService {
  return class MinQtyPlace extends Base {
    override async placeOrder(principal: Principal, input: PlaceOrderInput): ReturnType<TradeService['placeOrder']> {
      const bound = bindMinQty(input);
      if (bound.minQty !== undefined) {
        const refuse = minQtyRefuse(bound.qty, readMinQty(bound));
        if (refuse) throw refuse;
      }
      return super.placeOrder(principal, bound);
    }

    override toEngineRequest(...args: unknown[]): ReturnType<TradeService['toEngineRequest']> {
      const req = super.toEngineRequest(...(args as Parameters<TradeService['toEngineRequest']>));
      const input = args[2] as PlaceWithMinQty | undefined;
      if (input && input.minQty !== undefined) {
        const floor = readMinQty(input);
        if (floor === null) return req;
        return { ...req, minQty: formatAmount(floor) };
      }
      return req;
    }
  };
}
