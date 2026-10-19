import type { Principal } from '@intafaced/auth';
import type { FastifyInstance } from 'fastify';
import { formatAmount, parseAmount, type Amount } from '@intafaced/ledger-client';
import { TradeError } from './types.js';
import { TradeService, type PlaceOrderInput } from './trade-service.js';
import type { EngineSubmitRequest } from './matching-client.js';
import './oco-cancel.js';
import './bracket-place.js';
import { attachStashRelease, stashSet } from './stash-scope.js';

/**
 * Place a trailing stop through the matching door that landed in #3294.
 * The stop walks with the mark.
 * Refuse if trail is missing. Trade does not invent a mark.
 */

type PlaceWithTrail = PlaceOrderInput & {
  type?: PlaceOrderInput['type'] | 'stop';
  trail?: Amount | null;
  mark?: Amount | null;
};

const FLAG = Symbol.for('intafaced.trade.trailingStopPlace');
const stash = new Map<string, { trail: string | null; mark: string | null }>();

export const TRAIL_MISSING = 'missing_trail' as const;
export const MARK_MISSING = 'missing_mark' as const;

function stashKey(rec: Record<string, unknown>): string {
  const client = rec.clientOrderId;
  if (typeof client === 'string' && client.length > 0) return client;
  return `__ts:${String(rec.symbol ?? '')}:${String(rec.side ?? '')}:${String(rec.type ?? '')}:${String(rec.amount ?? rec.qty ?? '')}:${String(rec.price ?? '')}`;
}

function wantsTrailing(rec: Record<string, unknown>): boolean {
  return rec.trail !== undefined;
}

function readTrail(rec: { readonly trail?: Amount | null }): Amount | null {
  if (rec.trail !== undefined) return rec.trail ?? null;
  return null;
}

function readMark(rec: { readonly mark?: Amount | null }): Amount | null {
  if (rec.mark !== undefined) return rec.mark ?? null;
  return null;
}

export function trailRefuse(trail: Amount | null): TradeError | null {
  if (trail === null || trail <= (0n as Amount)) {
    return new TradeError('a trailing stop requires a trail; trade does not invent a distance', 'trade.missing_trail');
  }
  return null;
}

export function markRefuse(mark: Amount | null): TradeError | null {
  if (mark === null || mark <= (0n as Amount)) {
    return new TradeError('a trailing stop walks with the mark; trade does not invent a mark', 'trade.missing_mark');
  }
  return null;
}

export function attachTrailingStopStash(app: FastifyInstance): void {
  attachStashRelease(app);
  app.addHook('preValidation', (req, _reply, done) => {
    const body = req.body;
    if (body && typeof body === 'object') {
      const rec = body as Record<string, unknown>;
      if (wantsTrailing(rec)) {
        stashSet(req, stash, stashKey(rec), {
          // A JSON number is float-derived; only a decimal string is a distance. Anything else stays missing and refuses.
          trail: typeof rec.trail === 'string' && rec.trail !== '' ? rec.trail : null,
          mark: typeof rec.mark === 'string' && rec.mark !== '' ? rec.mark : null,
        });
      }
    }
    done();
  });
}

export function bindTrailingStop(input: PlaceOrderInput): PlaceWithTrail {
  const extra = input as PlaceWithTrail;
  if (wantsTrailing(extra as unknown as Record<string, unknown>)) {
    const placeType = extra.type === 'stop' ? 'limit' : extra.type;
    return { ...extra, type: placeType, trail: readTrail(extra), mark: readMark(extra) };
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
    type: extra.type === 'stop' ? 'limit' : extra.type,
    trail: hit.trail == null ? null : parseAmount(hit.trail),
    mark: hit.mark == null ? null : parseAmount(hit.mark),
  };
}

export function installTrailingStopPlace(ctor: typeof TradeService): void {
  const proto = ctor.prototype as unknown as {
    placeOrder: (principal: Principal, input: PlaceOrderInput) => Promise<{ id: string; status: string }>;
    toEngineRequest: (...args: unknown[]) => EngineSubmitRequest;
    [FLAG]?: true;
  };
  if (proto[FLAG]) return;
  proto[FLAG] = true;

  const origPlace = proto.placeOrder;
  proto.placeOrder = async function (this: TradeService, principal: Principal, input: PlaceOrderInput) {
    const bound = bindTrailingStop(input);
    if (bound.trail !== undefined) {
      const missingTrail = trailRefuse(bound.trail ?? null);
      if (missingTrail) throw missingTrail;
      const missingMark = markRefuse(bound.mark ?? null);
      if (missingMark) throw missingMark;
    }
    return origPlace.call(this, principal, bound);
  };

  const origToEngine = proto.toEngineRequest;
  proto.toEngineRequest = function (this: TradeService, ...args: unknown[]) {
    const req = origToEngine.apply(this, args);
    const input = args[2] as PlaceWithTrail | undefined;
    if (input && input.trail !== undefined) {
      return {
        ...req,
        type: 'stop',
        price: null,
        trail: input.trail == null ? null : formatAmount(input.trail),
        mark: input.mark == null ? null : formatAmount(input.mark),
      };
    }
    return req;
  };
}

installTrailingStopPlace(TradeService);
