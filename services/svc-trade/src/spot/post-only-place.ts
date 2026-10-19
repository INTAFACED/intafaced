import type { Principal } from '@intafaced/auth';
import type { FastifyInstance } from 'fastify';
import { TradeError } from './types.js';
import { TradeService, type PlaceOrderInput } from './trade-service.js';
import type { EngineSubmitRequest } from './matching-client.js';
import { attachStashRelease, stashSet } from './stash-scope.js';

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

const FLAG = Symbol.for('intafaced.trade.postOnlyPlace');
const poByClient = new Map<string, true>();

function stashKey(rec: Record<string, unknown>): string {
  const client = rec.clientOrderId;
  if (typeof client === 'string' && client.length > 0) return client;
  return `__po:${String(rec.symbol ?? '')}:${String(rec.side ?? '')}:${String(rec.type ?? '')}:${String(rec.amount ?? rec.qty ?? '')}:${String(rec.price ?? '')}`;
}

export function attachPostOnlyStash(app: FastifyInstance): void {
  attachStashRelease(app);
  app.addHook('preValidation', (req, _reply, done) => {
    const body = req.body;
    if (body && typeof body === 'object') {
      const rec = body as Record<string, unknown>;
      if (rec.postOnly === true || rec.timeInForce === 'PO' || rec.tif === 'PO') {
        stashSet(req, poByClient, stashKey(rec), true);
        delete rec.postOnly;
      }
    }
    done();
  });
}

export function bindPostOnly(input: PlaceOrderInput): PlaceWithPo {
  const extra = input as PlaceWithPo;
  if (extra.tif === 'PO' || extra.postOnly === true) {
    return { ...extra, tif: 'PO' };
  }
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
  if (!poByClient.has(key)) return extra;
  poByClient.delete(key);
  return { ...extra, tif: 'PO' };
}

export function installPostOnlyPlace(ctor: typeof TradeService): void {
  const proto = ctor.prototype as unknown as {
    placeOrder: (principal: Principal, input: PlaceOrderInput) => Promise<unknown>;
    toEngineRequest: (...args: unknown[]) => EngineSubmitRequest;
    [FLAG]?: true;
  };
  if (proto[FLAG]) return;
  proto[FLAG] = true;

  const origPlace = proto.placeOrder;
  proto.placeOrder = async function (this: TradeService, principal: Principal, input: PlaceOrderInput) {
    const bound = bindPostOnly(input);
    if (bound.tif === 'PO' && (bound.type === 'market' || bound.price == null)) {
      throw new TradeError('post-only requires a limit price; trade does not invent one', 'trade.invalid_tif');
    }
    return origPlace.call(this, principal, bound);
  };

  const origToEngine = proto.toEngineRequest;
  proto.toEngineRequest = function (this: TradeService, ...args: unknown[]) {
    const req = origToEngine.apply(this, args);
    const input = args[2] as PlaceWithPo | undefined;
    if (req.tif === 'PO' || input?.tif === 'PO' || input?.postOnly === true) {
      return { ...req, tif: 'PO' };
    }
    return req;
  };
}

installPostOnlyPlace(TradeService);
