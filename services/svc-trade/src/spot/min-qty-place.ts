import type { Principal } from '@intafaced/auth';
import type { FastifyInstance } from 'fastify';
import { formatAmount, parseAmount, ZERO, type Amount } from '@intafaced/ledger-client';
import { TradeError } from './types.js';
import { TradeService, type PlaceOrderInput } from './trade-service.js';
import type { EngineSubmitRequest } from './matching-client.js';
import { attachStashRelease, stashSet } from './stash-scope.js';

/**
 * Place a min qty through the matching door that landed in #3305.
 * A fill below the floor does not occur.
 * Missing or zero is a normal place. Trade does not invent a minQty.
 */

type PlaceWithMinQty = PlaceOrderInput & {
  minQty?: Amount | null;
};

const FLAG = Symbol.for('intafaced.trade.minQtyPlace');
const stash = new Map<string, { minQty: string | null }>();

export const MIN_QTY_EXCEEDS = 'min_qty_exceeds_qty' as const;

function stashKey(rec: Record<string, unknown>): string {
  const client = rec.clientOrderId;
  if (typeof client === 'string' && client.length > 0) return client;
  return `__mq:${String(rec.symbol ?? '')}:${String(rec.side ?? '')}:${String(rec.type ?? '')}:${String(rec.amount ?? rec.qty ?? '')}:${String(rec.price ?? '')}`;
}

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

export function attachMinQtyStash(app: FastifyInstance): void {
  attachStashRelease(app);
  app.addHook('preValidation', (req, _reply, done) => {
    const body = req.body;
    if (body && typeof body === 'object') {
      const rec = body as Record<string, unknown>;
      if (wantsMinQty(rec)) {
        stashSet(req, stash, stashKey(rec), {
          minQty: rec.minQty == null || rec.minQty === '' ? null : String(rec.minQty),
        });
      }
    }
    done();
  });
}

export function bindMinQty(input: PlaceOrderInput): PlaceWithMinQty {
  const extra = input as PlaceWithMinQty;
  if (wantsMinQty(extra as unknown as Record<string, unknown>)) {
    return { ...extra, minQty: extra.minQty ?? null };
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
  return {
    ...extra,
    minQty: hit.minQty == null ? null : parseAmount(hit.minQty),
  };
}

export function installMinQtyPlace(ctor: typeof TradeService): void {
  const proto = ctor.prototype as unknown as {
    placeOrder: (principal: Principal, input: PlaceOrderInput) => Promise<{ id: string; status: string }>;
    toEngineRequest: (...args: unknown[]) => EngineSubmitRequest;
    [FLAG]?: true;
  };
  if (proto[FLAG]) return;
  proto[FLAG] = true;

  const origPlace = proto.placeOrder;
  proto.placeOrder = async function (this: TradeService, principal: Principal, input: PlaceOrderInput) {
    const bound = bindMinQty(input);
    if (bound.minQty !== undefined) {
      const refuse = minQtyRefuse(bound.qty, readMinQty(bound));
      if (refuse) throw refuse;
    }
    return origPlace.call(this, principal, bound);
  };

  const origToEngine = proto.toEngineRequest;
  proto.toEngineRequest = function (this: TradeService, ...args: unknown[]) {
    const req = origToEngine.apply(this, args);
    const input = args[2] as PlaceWithMinQty | undefined;
    if (input && input.minQty !== undefined) {
      const floor = readMinQty(input);
      if (floor === null) return req;
      return { ...req, minQty: formatAmount(floor) };
    }
    return req;
  };
}

installMinQtyPlace(TradeService);
