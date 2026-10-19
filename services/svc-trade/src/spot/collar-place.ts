import type { Principal } from '@intafaced/auth';
import type { FastifyInstance } from 'fastify';
import { formatAmount, parseAmount, ZERO, type Amount } from '@intafaced/ledger-client';
import { TradeError } from './types.js';
import { TradeService, type PlaceOrderInput } from './trade-service.js';
import type { EngineSubmitRequest, EngineSubmitResult } from './matching-client.js';
import type { Market } from './types.js';
import { attachStashRelease, stashSet } from './stash-scope.js';

/**
 * Place a price collar through the matching door that landed in #3410.
 * Caller min/max decimal strings. Submit outside the band refuses.
 * Missing band when collar is requested refuses. Trade does not invent last or mid.
 */

type PlaceWithCollar = PlaceOrderInput & {
  collar?: boolean | null;
  min?: Amount | null;
  max?: Amount | null;
};

const FLAG = Symbol.for('intafaced.trade.collarPlace');
const stash = new Map<string, { collar: boolean | null; min: string | null; max: string | null }>();

export const COLLAR_MISSING = 'missing_collar' as const;
export const COLLAR_OUTSIDE = 'outside_collar' as const;

const MISSING_MESSAGE = 'collar requires caller min and max; trade does not invent last or mid';
const OUTSIDE_MESSAGE = 'submit price is outside the caller collar; trade does not invent last or mid';

function stashKey(rec: Record<string, unknown>): string {
  const client = rec.clientOrderId;
  if (typeof client === 'string' && client.length > 0) return client;
  return `__col:${String(rec.symbol ?? '')}:${String(rec.side ?? '')}:${String(rec.type ?? '')}:${String(rec.amount ?? rec.qty ?? '')}:${String(rec.price ?? '')}`;
}

function wantsCollar(rec: Record<string, unknown>): boolean {
  return rec.collar !== undefined || rec.min !== undefined || rec.max !== undefined;
}

function flagFromRaw(value: unknown): boolean | null {
  if (value === true) return true;
  if (value == null) return null;
  return Boolean(value);
}

function readBound(raw: unknown): Amount | null {
  if (raw == null) return null;
  if (typeof raw === 'string' && raw.trim() === '') return null;
  try {
    const qty = typeof raw === 'string' || typeof raw === 'number' ? parseAmount(String(raw)) : (raw as Amount);
    if (qty <= ZERO) return null;
    return qty;
  } catch {
    return null;
  }
}

/** Caller collar. Missing, null, or false is not set. */
export function readCollar(order: { readonly collar?: boolean | null }): boolean {
  return order.collar === true;
}

/** Caller min. Null/zero/negative is missing — never last or mid. */
export function readMin(order: { readonly min?: Amount | null }): Amount | null {
  if (order.min === undefined || order.min === null || order.min <= ZERO) return null;
  return order.min;
}

/** Caller max. Null/zero/negative is missing — never last or mid. */
export function readMax(order: { readonly max?: Amount | null }): Amount | null {
  if (order.max === undefined || order.max === null || order.max <= ZERO) return null;
  return order.max;
}

export function missingCollarRefuse(min: Amount | null, max: Amount | null): TradeError | null {
  if (min !== null && max !== null) return null;
  return new TradeError(MISSING_MESSAGE, 'trade.missing_collar');
}

export function outsideCollarRefuse(price: Amount | null, min: Amount, max: Amount): TradeError | null {
  if (price === null || price < min || price > max) {
    return new TradeError(OUTSIDE_MESSAGE, 'trade.outside_collar');
  }
  return null;
}

export function collarIntentRefuse(order: {
  readonly collar?: boolean | null;
  readonly min?: Amount | null;
  readonly max?: Amount | null;
  readonly price?: Amount | null;
}): TradeError | null {
  if (!readCollar(order)) return null;
  const min = readMin(order);
  const max = readMax(order);
  if (min === null || max === null) return missingCollarRefuse(min, max);
  return outsideCollarRefuse(order.price ?? null, min, max);
}

export function matchingCollarRefuse(rejected: { readonly code: string; readonly message?: string } | null | undefined): TradeError | null {
  if (rejected?.code === COLLAR_MISSING) {
    return new TradeError(rejected.message && rejected.message.length > 0 ? rejected.message : MISSING_MESSAGE, 'trade.missing_collar');
  }
  if (rejected?.code === COLLAR_OUTSIDE) {
    return new TradeError(rejected.message && rejected.message.length > 0 ? rejected.message : OUTSIDE_MESSAGE, 'trade.outside_collar');
  }
  return null;
}

export function matchingSubmitCollarRefuse(
  result:
    | {
        readonly rejected?: { readonly code: string; readonly message?: string } | null;
      }
    | null
    | undefined,
): TradeError | null {
  if (result == null) return null;
  return matchingCollarRefuse(result.rejected);
}

function collarRejectResult(code: typeof COLLAR_MISSING | typeof COLLAR_OUTSIDE, message: string): EngineSubmitResult {
  return {
    accepted: false,
    sequence: null,
    fills: [],
    resting: null,
    rejected: { code, message },
    cancellations: [],
    triggered: [],
  };
}

export function attachCollarStash(app: FastifyInstance): void {
  attachStashRelease(app);
  app.addHook('preValidation', (req, _reply, done) => {
    const body = req.body;
    if (body && typeof body === 'object') {
      const rec = body as Record<string, unknown>;
      if (wantsCollar(rec)) {
        stashSet(req, stash, stashKey(rec), {
          collar: rec.collar === undefined ? null : flagFromRaw(rec.collar),
          min: rec.min == null || rec.min === '' ? null : String(rec.min),
          max: rec.max == null || rec.max === '' ? null : String(rec.max),
        });
      }
    }
    done();
  });
}

export function bindCollar(input: PlaceOrderInput): PlaceWithCollar {
  const extra = input as PlaceWithCollar;
  if (wantsCollar(extra as unknown as Record<string, unknown>)) {
    return { ...extra, collar: extra.collar ?? null, min: extra.min ?? null, max: extra.max ?? null };
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
    collar: hit.collar,
    min: hit.min == null ? null : parseAmount(hit.min),
    max: hit.max == null ? null : parseAmount(hit.max),
  };
}

export function installCollarPlace(ctor: typeof TradeService): void {
  const proto = ctor.prototype as unknown as {
    placeOrder: (principal: Principal, input: PlaceOrderInput) => Promise<{ id: string; status: string; rejectCode?: string | null }>;
    applySubmitResult: (market: Market, orderId: string, result: EngineSubmitResult) => Promise<void>;
    toEngineRequest: (...args: unknown[]) => EngineSubmitRequest;
    [FLAG]?: true;
  };
  if (proto[FLAG]) return;
  proto[FLAG] = true;

  const origPlace = proto.placeOrder;
  proto.placeOrder = async function (this: TradeService, principal: Principal, input: PlaceOrderInput) {
    const bound = bindCollar(input);
    const local = collarIntentRefuse(bound);
    if (local) throw local;
    const order = await origPlace.call(this, principal, bound);
    const refuse = matchingCollarRefuse(order.rejectCode ? { code: order.rejectCode } : null);
    if (refuse) throw refuse;
    return order;
  };

  if (typeof proto.applySubmitResult === 'function') {
    const origApply = proto.applySubmitResult;
    proto.applySubmitResult = async function (this: TradeService, market: Market, orderId: string, result: EngineSubmitResult) {
      const refuse = matchingSubmitCollarRefuse(result);
      if (refuse) {
        const code = result.rejected?.code === COLLAR_MISSING ? COLLAR_MISSING : COLLAR_OUTSIDE;
        await origApply.call(this, market, orderId, collarRejectResult(code, refuse.message));
        throw refuse;
      }
      return origApply.call(this, market, orderId, result);
    };
  }

  const origToEngine = proto.toEngineRequest;
  proto.toEngineRequest = function (this: TradeService, ...args: unknown[]) {
    const req = origToEngine.apply(this, args);
    const input = args[2] as PlaceWithCollar | undefined;
    if (!input || !readCollar(input)) return req;
    const min = readMin(input);
    const max = readMax(input);
    return {
      ...req,
      collar: true,
      ...(min !== null ? { min: formatAmount(min) } : {}),
      ...(max !== null ? { max: formatAmount(max) } : {}),
    };
  };
}

installCollarPlace(TradeService);
