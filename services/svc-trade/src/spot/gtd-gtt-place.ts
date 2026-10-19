import type { Principal } from '@intafaced/auth';
import { TradeError } from './types.js';
import { TradeService, type PlaceOrderInput } from './trade-service.js';
import type { EngineCancellation, EngineFill, EngineSubmitRequest } from './matching-client.js';
import type { Market } from './types.js';
import { carriedPlacementBody } from './placement-extras.js';

/**
 * Place a GTD/GTT through the matching clock that just landed.
 *
 * expireAt is the caller's instant. The engine does not invent one.
 * Matching refuse engine_clock_missing is a service refuse; the hold
 * already taken is released on that reject (existing finalize path).
 * A later `expired` cancellation releases through ledger-client
 * `orderHoldRelease` via finalize('expired').
 *
 * Installed onto TradeService.prototype so trade-service.ts never moves.
 */

type PlaceWithExpire = PlaceOrderInput & { expireAt?: string };

const FLAG = Symbol.for('intafaced.trade.gtdGttPlace');

/** The expiry this request's own body carries; the typed create schema does not pass it on. */
function expireFor(body: Readonly<Record<string, unknown>> | null): string | null {
  return body !== null && typeof body.expireAt === 'string' && body.expireAt.length > 0 ? body.expireAt : null;
}

export function bindExpireAt(input: PlaceOrderInput): PlaceWithExpire {
  const extra = input as PlaceWithExpire;
  if (extra.expireAt && extra.expireAt.length > 0) return extra;
  const stashed = expireFor(carriedPlacementBody(extra));
  if (!stashed) return extra;
  return { ...extra, expireAt: stashed };
}

export function installGtdGttPlace(ctor: typeof TradeService): void {
  const proto = ctor.prototype as unknown as {
    placeOrder: (principal: Principal, input: PlaceOrderInput) => Promise<unknown>;
    toEngineRequest: (...args: unknown[]) => EngineSubmitRequest;
    settleOutcome: (market: Market, fills: readonly EngineFill[], cancellations: readonly EngineCancellation[]) => Promise<void>;
    finalize: (orderId: string, status: 'cancelled' | 'filled' | 'expired' | 'rejected', reason?: string | null) => Promise<void>;
    [FLAG]?: true;
  };
  if (proto[FLAG]) return;
  proto[FLAG] = true;

  const origPlace = proto.placeOrder;
  proto.placeOrder = async function (this: TradeService, principal: Principal, input: PlaceOrderInput) {
    const bound = bindExpireAt(input);
    if (bound.tif === 'GTD' || bound.tif === 'GTT') {
      if (!bound.expireAt || bound.expireAt.length === 0) {
        throw new TradeError('GTD/GTT requires expireAt; the engine does not invent one', 'trade.missing_expire_at');
      }
    }
    return origPlace.call(this, principal, bound);
  };

  const origToEngine = proto.toEngineRequest;
  proto.toEngineRequest = function (this: TradeService, ...args: unknown[]) {
    const req = origToEngine.apply(this, args);
    const input = args[2] as PlaceWithExpire | undefined;
    if ((req.tif === 'GTD' || req.tif === 'GTT') && input?.expireAt) {
      return { ...req, expireAt: input.expireAt };
    }
    return req;
  };

  const origSettle = proto.settleOutcome;
  proto.settleOutcome = async function (
    this: TradeService,
    market: Market,
    fills: readonly EngineFill[],
    cancellations: readonly EngineCancellation[],
  ) {
    const expired: EngineCancellation[] = [];
    const rest: EngineCancellation[] = [];
    for (const c of cancellations) {
      if (c.reason === 'expired') expired.push(c);
      else rest.push(c);
    }
    await origSettle.call(this, market, fills, rest);
    for (const c of expired) {
      await proto.finalize.call(this, c.orderId, 'expired', c.reason);
    }
  };
}

installGtdGttPlace(TradeService);
