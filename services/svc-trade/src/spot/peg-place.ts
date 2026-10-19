import type { Principal } from '@intafaced/auth';
import type { FastifyInstance } from 'fastify';
import { TradeError } from './types.js';
import { TradeService, type PlaceOrderInput } from './trade-service.js';
import type { EngineSubmitRequest } from './matching-client.js';
import { attachStashRelease, stashSet } from './stash-scope.js';

/**
 * Place peg / midpoint / relative through the matching door that landed in #3318.
 * Unsupported intent refuses rather than becoming a silent limit.
 * Missing or false is a normal place. Trade does not invent a mid.
 */

type PlaceWithPeg = PlaceOrderInput & {
  peg?: boolean | null;
  midpoint?: boolean | null;
  relative?: boolean | null;
};

const FLAG = Symbol.for('intafaced.trade.pegPlace');
const stash = new Map<string, { peg: boolean | null; midpoint: boolean | null; relative: boolean | null }>();

export const PEG_UNSUPPORTED = 'peg_unsupported' as const;
export const MIDPOINT_UNSUPPORTED = 'midpoint_unsupported' as const;
export const RELATIVE_UNSUPPORTED = 'relative_unsupported' as const;

function stashKey(rec: Record<string, unknown>): string {
  const client = rec.clientOrderId;
  if (typeof client === 'string' && client.length > 0) return client;
  return `__peg:${String(rec.symbol ?? '')}:${String(rec.side ?? '')}:${String(rec.type ?? '')}:${String(rec.amount ?? rec.qty ?? '')}:${String(rec.price ?? '')}`;
}

function wantsPegIntent(rec: Record<string, unknown>): boolean {
  return rec.peg !== undefined || rec.midpoint !== undefined || rec.relative !== undefined;
}

function flagFromRaw(value: unknown): boolean | null {
  if (value === true) return true;
  if (value == null) return null;
  return Boolean(value);
}

/** Caller peg. Missing, null, or false is not set. */
export function readPeg(order: { readonly peg?: boolean | null }): boolean {
  return order.peg === true;
}

export function readMidpoint(order: { readonly midpoint?: boolean | null }): boolean {
  return order.midpoint === true;
}

export function readRelative(order: { readonly relative?: boolean | null }): boolean {
  return order.relative === true;
}

export function pegRefuse(peg: boolean): TradeError | null {
  if (!peg) return null;
  return new TradeError('pegged orders are unsupported; trade does not invent a reference price', 'trade.peg_unsupported');
}

export function midpointRefuse(midpoint: boolean): TradeError | null {
  if (!midpoint) return null;
  return new TradeError('midpoint orders are unsupported; trade does not invent a mid', 'trade.midpoint_unsupported');
}

export function relativeRefuse(relative: boolean): TradeError | null {
  if (!relative) return null;
  return new TradeError('relative orders are unsupported; trade does not invent a reference price', 'trade.relative_unsupported');
}

/** Matching's peg then midpoint then relative. Trade wraps those codes. */
export function pegIntentRefuse(order: {
  readonly peg?: boolean | null;
  readonly midpoint?: boolean | null;
  readonly relative?: boolean | null;
}): TradeError | null {
  return pegRefuse(readPeg(order)) ?? midpointRefuse(readMidpoint(order)) ?? relativeRefuse(readRelative(order));
}

export function attachPegStash(app: FastifyInstance): void {
  attachStashRelease(app);
  app.addHook('preValidation', (req, _reply, done) => {
    const body = req.body;
    if (body && typeof body === 'object') {
      const rec = body as Record<string, unknown>;
      if (wantsPegIntent(rec)) {
        stashSet(req, stash, stashKey(rec), {
          peg: rec.peg === undefined ? null : flagFromRaw(rec.peg),
          midpoint: rec.midpoint === undefined ? null : flagFromRaw(rec.midpoint),
          relative: rec.relative === undefined ? null : flagFromRaw(rec.relative),
        });
      }
    }
    done();
  });
}

export function bindPeg(input: PlaceOrderInput): PlaceWithPeg {
  const extra = input as PlaceWithPeg;
  if (wantsPegIntent(extra as unknown as Record<string, unknown>)) {
    return {
      ...extra,
      peg: extra.peg ?? null,
      midpoint: extra.midpoint ?? null,
      relative: extra.relative ?? null,
    };
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
  return { ...extra, peg: hit.peg, midpoint: hit.midpoint, relative: hit.relative };
}

export function installPegPlace(ctor: typeof TradeService): void {
  const proto = ctor.prototype as unknown as {
    placeOrder: (principal: Principal, input: PlaceOrderInput) => Promise<{ id: string; status: string }>;
    toEngineRequest: (...args: unknown[]) => EngineSubmitRequest;
    [FLAG]?: true;
  };
  if (proto[FLAG]) return;
  proto[FLAG] = true;

  const origPlace = proto.placeOrder;
  proto.placeOrder = async function (this: TradeService, principal: Principal, input: PlaceOrderInput) {
    const bound = bindPeg(input);
    const refuse = pegIntentRefuse(bound);
    if (refuse) throw refuse;
    return origPlace.call(this, principal, bound);
  };

  const origToEngine = proto.toEngineRequest;
  proto.toEngineRequest = function (this: TradeService, ...args: unknown[]) {
    const req = origToEngine.apply(this, args);
    const input = args[2] as PlaceWithPeg | undefined;
    if (!input) return req;
    const peg = readPeg(input);
    const midpoint = readMidpoint(input);
    const relative = readRelative(input);
    if (!peg && !midpoint && !relative) return req;
    return {
      ...req,
      ...(peg ? { peg: true } : {}),
      ...(midpoint ? { midpoint: true } : {}),
      ...(relative ? { relative: true } : {}),
    };
  };
}

installPegPlace(TradeService);
