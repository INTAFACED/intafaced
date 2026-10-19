import type { Principal } from '@intafaced/auth';
import type { FastifyInstance } from 'fastify';
import { TradeError } from './types.js';
import { TradeService, type PlaceOrderInput } from './trade-service.js';
import type { EngineSubmitRequest } from './matching-client.js';
import { attachStashRelease, stashSet } from './stash-scope.js';

/**
 * Place an FOK through the matching door that just landed.
 * Fill completely or cancel the whole. No leftover rest. Trade does not invent a fill.
 */

type PlaceWithFok = PlaceOrderInput & { tif?: string };

const FLAG = Symbol.for('intafaced.trade.fokPlace');
const fokByClient = new Map<string, true>();

export const FOK_UNFILLABLE = 'fok_unfillable' as const;

function stashKey(rec: Record<string, unknown>): string {
  const client = rec.clientOrderId;
  if (typeof client === 'string' && client.length > 0) return client;
  return `__fok:${String(rec.symbol ?? '')}:${String(rec.side ?? '')}:${String(rec.type ?? '')}:${String(rec.amount ?? rec.qty ?? '')}:${String(rec.price ?? '')}`;
}

function isFok(tif: unknown): boolean {
  return tif === 'FOK';
}

export function attachFokStash(app: FastifyInstance): void {
  attachStashRelease(app);
  app.addHook('preValidation', (req, _reply, done) => {
    const body = req.body;
    if (body && typeof body === 'object') {
      const rec = body as Record<string, unknown>;
      if (isFok(rec.timeInForce) || isFok(rec.tif)) {
        stashSet(req, fokByClient, stashKey(rec), true);
      }
    }
    done();
  });
}

export function bindFok(input: PlaceOrderInput): PlaceWithFok {
  const extra = input as PlaceWithFok;
  if (isFok(extra.tif)) return { ...extra, tif: 'FOK' };
  const rec = extra as unknown as Record<string, unknown>;
  const key = stashKey({
    clientOrderId: extra.clientOrderId,
    symbol: rec.symbol,
    side: extra.side,
    type: extra.type,
    amount: rec.amount,
    qty: rec.qty,
    price: rec.price,
  });
  if (!fokByClient.has(key)) return extra;
  fokByClient.delete(key);
  return { ...extra, tif: 'FOK' };
}

export function installFokPlace(ctor: typeof TradeService): void {
  const proto = ctor.prototype as unknown as {
    placeOrder: (principal: Principal, input: PlaceOrderInput) => Promise<{ id: string; status: string }>;
    toEngineRequest: (...args: unknown[]) => EngineSubmitRequest;
    cancelOrder: (principal: Principal, orderId: string) => Promise<unknown>;
    [FLAG]?: true;
  };
  if (proto[FLAG]) return;
  proto[FLAG] = true;

  const origPlace = proto.placeOrder;
  proto.placeOrder = async function (this: TradeService, principal: Principal, input: PlaceOrderInput) {
    const bound = bindFok(input);
    if (bound.tif === 'FOK' && bound.type === 'limit' && bound.price == null) {
      throw new TradeError('FOK limit requires a price; trade does not invent a fill', 'trade.invalid_tif');
    }
    const order = await origPlace.call(this, principal, bound);
    if (bound.tif === 'FOK' && order.status === 'open') {
      return proto.cancelOrder.call(this, principal, order.id) as Promise<{ id: string; status: string }>;
    }
    return order;
  };

  const origToEngine = proto.toEngineRequest;
  proto.toEngineRequest = function (this: TradeService, ...args: unknown[]) {
    const req = origToEngine.apply(this, args);
    const input = args[2] as PlaceWithFok | undefined;
    if (req.tif === 'FOK' || input?.tif === 'FOK') {
      return { ...req, tif: 'FOK' };
    }
    return req;
  };
}

installFokPlace(TradeService);
