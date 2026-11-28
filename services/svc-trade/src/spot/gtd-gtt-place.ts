import type { Principal } from '@intafaced/auth';
import { parseAmount } from '@intafaced/ledger-client';
import { TradeError } from './types.js';
import { TradeService, type PlaceOrderInput } from './trade-service.js';
import type { EngineCancellation, EngineFill } from './matching-client.js';
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

export function withGtdGttPlace(Base: typeof TradeService): typeof TradeService {
  return class GtdGttPlace extends Base {
    override async placeOrder(principal: Principal, input: PlaceOrderInput): ReturnType<TradeService['placeOrder']> {
      const bound = bindExpireAt(input);
      if (bound.tif === 'GTD' || bound.tif === 'GTT') {
        if (!bound.expireAt || bound.expireAt.length === 0) {
          throw new TradeError('GTD/GTT requires expireAt; the engine does not invent one', 'trade.missing_expire_at');
        }
      }
      return super.placeOrder(principal, bound);
    }

    override toEngineRequest(...args: unknown[]): ReturnType<TradeService['toEngineRequest']> {
      const req = super.toEngineRequest(...(args as Parameters<TradeService['toEngineRequest']>));
      const input = args[2] as PlaceWithExpire | undefined;
      if ((req.tif === 'GTD' || req.tif === 'GTT') && input?.expireAt) {
        return { ...req, expireAt: input.expireAt };
      }
      return req;
    }

    override async settleOutcome(
      market: Market,
      fills: readonly EngineFill[],
      cancellations: readonly EngineCancellation[],
    ): ReturnType<TradeService['settleOutcome']> {
      const expired: EngineCancellation[] = [];
      const rest: EngineCancellation[] = [];
      for (const c of cancellations) {
        if (c.reason === 'expired') expired.push(c);
        else rest.push(c);
      }
      await super.settleOutcome(market, fills, rest);
      for (const c of expired) {
        // The engine's remainder says how much it executed first (#8560): an order another submission partly matched
        // may still have that fill on its way, and `finalize` then refuses; the engine's cancel event closes it later.
        try {
          await this.finalize(c.orderId, 'expired', c.reason, { engineLeftQty: parseAmount(c.remainingQty) });
        } catch (err) {
          if (!(err instanceof TradeError && err.code === 'trade.cancel_ahead_of_fill')) throw err;
        }
      }
    }
  };
}
