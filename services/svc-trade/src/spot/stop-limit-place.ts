import type { Principal } from '@intafaced/auth';
import { formatAmount, parseAmount, type Amount } from '@intafaced/ledger-client';
import { TradeError } from './types.js';
import { TradeService, type PlaceOrderInput } from './trade-service.js';
import type { EngineSubmitRequest } from './matching-client.js';
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

const FLAG = Symbol.for('intafaced.trade.stopLimitPlace');

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

export function installStopLimitPlace(ctor: typeof TradeService): void {
  const proto = ctor.prototype as unknown as {
    placeOrder: (principal: Principal, input: PlaceOrderInput) => Promise<{ id: string; status: string }>;
    toEngineRequest: (...args: unknown[]) => EngineSubmitRequest;
    [FLAG]?: true;
  };
  if (proto[FLAG]) return;
  proto[FLAG] = true;

  const origPlace = proto.placeOrder;
  proto.placeOrder = async function (this: TradeService, principal: Principal, input: PlaceOrderInput) {
    const bound = bindStopLimit(input);
    if (bound.stopPx !== undefined || (input as PlaceWithStopLimit).type === 'stop_limit') {
      const refuse = stopPxRefuse(bound.stopPx ?? null);
      if (refuse) throw refuse;
      if (bound.price == null) {
        throw new TradeError('a stop-limit requires a limit price; trade does not invent a trigger', 'trade.missing_price');
      }
    }
    return origPlace.call(this, principal, bound);
  };

  const origToEngine = proto.toEngineRequest;
  proto.toEngineRequest = function (this: TradeService, ...args: unknown[]) {
    const req = origToEngine.apply(this, args);
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
  };
}

installStopLimitPlace(TradeService);
