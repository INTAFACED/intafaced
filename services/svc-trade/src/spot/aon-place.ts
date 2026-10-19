import type { Principal } from '@intafaced/auth';
import { TradeError } from './types.js';
import { TradeService, type PlaceOrderInput } from './trade-service.js';
import type { EngineSubmitRequest } from './matching-client.js';
import { carriedPlacementBody } from './placement-extras.js';

/**
 * Place all-or-none through the matching door that landed in #3312.
 * Fill remaining in one sweep or do not stub.
 * Missing or false is a normal place. Trade does not invent AON.
 */

type PlaceWithAon = PlaceOrderInput & {
  aon?: boolean | null;
  iceberg?: boolean;
  displayQty?: unknown;
};

const FLAG = Symbol.for('intafaced.trade.aonPlace');

export const AON_ICEBERG = 'aon_iceberg' as const;

function wantsAon(rec: Record<string, unknown>): boolean {
  return rec.aon !== undefined;
}

function wantsIceberg(rec: { readonly iceberg?: boolean; readonly displayQty?: unknown }): boolean {
  return rec.iceberg === true || rec.displayQty !== undefined;
}

/** Caller AON. Missing, null, or false is not set. */
export function readAon(order: { readonly aon?: boolean | null }): boolean {
  return order.aon === true;
}

export function aonIcebergRefuse(aon: boolean, iceberg: boolean): TradeError | null {
  if (!aon || !iceberg) return null;
  return new TradeError('all-or-none cannot hide a stub behind a display; trade does not invent a fill', 'trade.aon_iceberg');
}

/** What this request's own body asks for; null when it asks for nothing. */
function stashedFor(body: Readonly<Record<string, unknown>> | null): { aon: boolean | null } | null {
  if (!body || !wantsAon(body)) return null;
  return { aon: body.aon === true ? true : body.aon == null ? null : Boolean(body.aon) };
}

export function bindAon(input: PlaceOrderInput): PlaceWithAon {
  const extra = input as PlaceWithAon;
  if (wantsAon(extra as unknown as Record<string, unknown>)) {
    return { ...extra, aon: extra.aon ?? null };
  }
  const hit = stashedFor(carriedPlacementBody(extra));
  if (!hit) return extra;
  return { ...extra, aon: hit.aon };
}

export function installAonPlace(ctor: typeof TradeService): void {
  const proto = ctor.prototype as unknown as {
    placeOrder: (principal: Principal, input: PlaceOrderInput) => Promise<{ id: string; status: string }>;
    toEngineRequest: (...args: unknown[]) => EngineSubmitRequest;
    [FLAG]?: true;
  };
  if (proto[FLAG]) return;
  proto[FLAG] = true;

  const origPlace = proto.placeOrder;
  proto.placeOrder = async function (this: TradeService, principal: Principal, input: PlaceOrderInput) {
    const bound = bindAon(input);
    if (readAon(bound)) {
      const refuse = aonIcebergRefuse(true, wantsIceberg(bound));
      if (refuse) throw refuse;
    }
    return origPlace.call(this, principal, bound);
  };

  const origToEngine = proto.toEngineRequest;
  proto.toEngineRequest = function (this: TradeService, ...args: unknown[]) {
    const req = origToEngine.apply(this, args);
    const input = args[2] as PlaceWithAon | undefined;
    if (input && readAon(input)) {
      return { ...req, aon: true };
    }
    return req;
  };
}

installAonPlace(TradeService);
