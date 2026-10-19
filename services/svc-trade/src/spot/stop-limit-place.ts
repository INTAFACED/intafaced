import type { Principal } from '@intafaced/auth';
import type { FastifyInstance } from 'fastify';
import { formatAmount, parseAmount, type Amount } from '@intafaced/ledger-client';
import { TradeError } from './types.js';
import { TradeService, type PlaceOrderInput } from './trade-service.js';
import type { EngineSubmitRequest } from './matching-client.js';
import { attachStashRelease, stashSet } from './stash-scope.js';

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
const stash = new Map<string, { stopPx: string | null }>();

export const STOP_PX_MISSING = 'missing_stop_price' as const;

function stashKey(rec: Record<string, unknown>): string {
  const client = rec.clientOrderId;
  if (typeof client === 'string' && client.length > 0) return client;
  return `__sl:${String(rec.symbol ?? '')}:${String(rec.side ?? '')}:${String(rec.type ?? '')}:${String(rec.amount ?? rec.qty ?? '')}:${String(rec.price ?? '')}`;
}

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

export function attachStopLimitStash(app: FastifyInstance): void {
  attachStashRelease(app);
  app.addHook('preValidation', (req, _reply, done) => {
    const body = req.body;
    if (body && typeof body === 'object') {
      const rec = body as Record<string, unknown>;
      if (wantsStopLimit(rec)) {
        const raw = rec.stopPx ?? rec.stopPrice;
        stashSet(req, stash, stashKey(rec), {
          stopPx: raw == null || raw === '' ? null : String(raw),
        });
      }
    }
    done();
  });
}

export function bindStopLimit(input: PlaceOrderInput): PlaceWithStopLimit {
  const extra = input as PlaceWithStopLimit;
  if (wantsStopLimit(extra as unknown as Record<string, unknown>)) {
    const placeType = extra.type === 'stop_limit' ? 'limit' : extra.type;
    return { ...extra, type: placeType, stopPx: readStopPx(extra) };
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
