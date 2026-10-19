import type { Principal } from '@intafaced/auth';
import type { FastifyInstance } from 'fastify';
import { TradeError } from './types.js';
import { TradeService, type PlaceOrderInput } from './trade-service.js';
import type { EngineSubmitRequest } from './matching-client.js';
import { attachStashRelease, stashSet } from './stash-scope.js';

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
const stash = new Map<string, { aon: boolean | null }>();

export const AON_ICEBERG = 'aon_iceberg' as const;

function stashKey(rec: Record<string, unknown>): string {
  const client = rec.clientOrderId;
  if (typeof client === 'string' && client.length > 0) return client;
  return `__aon:${String(rec.symbol ?? '')}:${String(rec.side ?? '')}:${String(rec.type ?? '')}:${String(rec.amount ?? rec.qty ?? '')}:${String(rec.price ?? '')}`;
}

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

export function attachAonStash(app: FastifyInstance): void {
  attachStashRelease(app);
  app.addHook('preValidation', (req, _reply, done) => {
    const body = req.body;
    if (body && typeof body === 'object') {
      const rec = body as Record<string, unknown>;
      if (wantsAon(rec)) {
        stashSet(req, stash, stashKey(rec), { aon: rec.aon === true ? true : rec.aon == null ? null : Boolean(rec.aon) });
      }
    }
    done();
  });
}

export function bindAon(input: PlaceOrderInput): PlaceWithAon {
  const extra = input as PlaceWithAon;
  if (wantsAon(extra as unknown as Record<string, unknown>)) {
    return { ...extra, aon: extra.aon ?? null };
  }
  const rec = extra as unknown as Record<string, unknown>;
  const key = stashKey({
    clientOrderId: extra.clientOrderId,
    symbol: rec.symbol,
    side: extra.side,
    type: extra.type,
    amount: rec.amount,
    qty: rec.qty,
    price: extra.price,
  });
  const hit = stash.get(key);
  if (!hit) return extra;
  stash.delete(key);
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
