import type { Principal } from '@intafaced/auth';
import { formatAmount, parseAmount, type Amount } from '@intafaced/ledger-client';
import { TradeError } from './types.js';
import { TradeService, type PlaceOrderInput } from './trade-service.js';
import { carriedPlacementBody } from './placement-extras.js';

/**
 * Place a stop-limit through the matching door that landed in #3288.
 * It does not live on the book until the stop prints.
 * Trade does not invent a trigger.
 */

type PlaceWithStopLimit = PlaceOrderInput & {
  type?: PlaceOrderInput['type'] | 'stop_limit';
  stopPx?: Amount | null;
  stopPrice?: Amount | null;
};

export const STOP_PX_MISSING = 'missing_stop_price' as const;

function wantsStopLimit(rec: Record<string, unknown>): boolean {
  return rec.type === 'stop_limit' || rec.stopPx !== undefined;
}

function readStopPx(rec: { readonly stopPx?: Amount | null; readonly stopPrice?: Amount | null }): Amount | null {
  if (rec.stopPx !== undefined) return rec.stopPx ?? null;
  if (rec.stopPrice !== undefined) return rec.stopPrice ?? null;
  return null;
}

export function stopPxRefuse(stopPx: Amount | null): TradeError | null {
  if (stopPx === null || stopPx <= (0n as Amount)) {
    return new TradeError('a stop-limit requires a stopPx; trade does not invent a trigger', 'trade.missing_stop_price');
  }
  return null;
}

/** What this request's own body asks for; null when it asks for nothing. */
function stashedFor(body: Readonly<Record<string, unknown>> | null): { stopPx: string | null } | null {
  if (!body || !wantsStopLimit(body)) return null;
  const raw = body.stopPx ?? body.stopPrice;
  return { stopPx: raw == null || raw === '' ? null : String(raw) };
}

export function bindStopLimit(input: PlaceOrderInput): PlaceWithStopLimit {
  const extra = input as PlaceWithStopLimit;
  if (wantsStopLimit(extra as unknown as Record<string, unknown>)) {
    const placeType = extra.type === 'stop_limit' ? 'limit' : extra.type;
    return { ...extra, type: placeType, stopPx: readStopPx(extra) };
  }
  const hit = stashedFor(carriedPlacementBody(extra));
  if (!hit) return extra;
  return {
    ...extra,
    type: extra.type === 'stop_limit' ? 'limit' : extra.type,
    stopPx: hit.stopPx == null ? null : parseAmount(hit.stopPx),
  };
}

export function withStopLimitPlace(Base: typeof TradeService): typeof TradeService {
  return class StopLimitPlace extends Base {
    override async placeOrder(principal: Principal, input: PlaceOrderInput): ReturnType<TradeService['placeOrder']> {
      const bound = bindStopLimit(input);
      if (bound.stopPx !== undefined || (input as PlaceWithStopLimit).type === 'stop_limit') {
        const refuse = stopPxRefuse(bound.stopPx ?? null);
        if (refuse) throw refuse;
        if (bound.price == null) {
          throw new TradeError('a stop-limit requires a limit price; trade does not invent a trigger', 'trade.missing_price');
        }
      }
      return super.placeOrder(principal, bound);
    }

    override toEngineRequest(...args: unknown[]): ReturnType<TradeService['toEngineRequest']> {
      const req = super.toEngineRequest(...(args as Parameters<TradeService['toEngineRequest']>));
      const input = args[2] as PlaceWithStopLimit | undefined;
      if (input && (input.stopPx !== undefined || input.type === 'stop_limit')) {
        const stopPx = input.stopPx == null ? null : formatAmount(input.stopPx);
        return {
          ...req,
          type: 'stop_limit',
          stopPx,
          stopPrice: stopPx,
        };
      }
      return req;
    }
  };
}
