import type { Principal } from '@intafaced/auth';
import type { FastifyInstance } from 'fastify';
import { TradeService, type PlaceOrderInput } from './trade-service.js';
import type { EngineSubmitRequest } from './matching-client.js';
import { claimOcoStash, stashOcoFromBody } from './oco-place.js';
import { stashBracketFromBody } from './bracket-place.js';
import { attachBoundClosePosition } from './close-position.js';
import { TradeError } from './types.js';
import { attachStashRelease, stashSet } from './stash-scope.js';

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

const FLAG = Symbol.for('intafaced.trade.reduceOnlyPlace');
const roByClient = new Map<string, true>();

function stashKey(rec: Record<string, unknown>): string {
  const client = rec.clientOrderId;
  if (typeof client === 'string' && client.length > 0) return client;
  return `__ro:${String(rec.symbol ?? '')}:${String(rec.side ?? '')}:${String(rec.type ?? '')}:${String(rec.amount ?? rec.qty ?? '')}:${String(rec.price ?? '')}`;
}

export function attachReduceOnlyStash(app: FastifyInstance): void {
  app.addHook('preValidation', (req, _reply, done) => {
    try {
      const body = req.body;
      if (body && typeof body === 'object') {
        const rec = body as Record<string, unknown>;
        if (rec.reduceOnly === true) {
          stashSet(req, roByClient, stashKey(rec), true);
          delete rec.reduceOnly;
        }
        stashBracketFromBody(rec);
        stashOcoFromBody(rec);
        claimOcoStash(req, rec);
      }
      done();
    } catch (err) {
      if (err instanceof TradeError) Object.assign(err, { statusCode: 400 });
      done(err as Error);
    }
  });
  attachStashRelease(app);
  attachBoundClosePosition(app);
}

export function bindReduceOnly(input: PlaceOrderInput): PlaceWithRo {
  const extra = input as PlaceWithRo;
  if (extra.reduceOnly === true) return extra;
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
  if (!roByClient.has(key)) return extra;
  roByClient.delete(key);
  return { ...extra, reduceOnly: true };
}

export function installReduceOnlyPlace(ctor: typeof TradeService): void {
  const proto = ctor.prototype as unknown as {
    placeOrder: (principal: Principal, input: PlaceOrderInput) => Promise<unknown>;
    toEngineRequest: (...args: unknown[]) => EngineSubmitRequest;
    [FLAG]?: true;
  };
  if (proto[FLAG]) return;
  proto[FLAG] = true;

  const origPlace = proto.placeOrder;
  proto.placeOrder = async function (this: TradeService, principal: Principal, input: PlaceOrderInput) {
    return origPlace.call(this, principal, bindReduceOnly(input));
  };

  const origToEngine = proto.toEngineRequest;
  proto.toEngineRequest = function (this: TradeService, ...args: unknown[]) {
    const req = origToEngine.apply(this, args);
    const input = args[2] as PlaceWithRo | undefined;
    if (input?.reduceOnly === true) {
      return { ...req, reduceOnly: true };
    }
    return req;
  };
}

installReduceOnlyPlace(TradeService);
