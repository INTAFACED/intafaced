import type { Principal } from '@intafaced/auth';
import { formatAmount, parseAmount, type Amount } from '@intafaced/ledger-client';
import { TradeError } from './types.js';
import { TradeService, type PlaceOrderInput } from './trade-service.js';
import { MatchingNoBookError, type EngineSubmitRequest } from './matching-client.js';
import type { QuotedMarkSource } from '../futures/liquidation-tick.js';
import './oco-cancel.js';
import './bracket-place.js';
import { carriedPlacementBody } from './placement-extras.js';

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

export const TRAIL_MISSING = 'missing_trail' as const;
export const MARK_MISSING = 'missing_mark' as const;

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

/** What this request's own body asks for; null when it asks for nothing. */
function stashedFor(body: Readonly<Record<string, unknown>> | null): { trail: string | null; mark: string | null } | null {
  if (!body || !wantsTrailing(body)) return null;
  return {
    // A JSON number is float-derived; only a decimal string is a distance. Anything else stays missing and refuses.
    trail: typeof body.trail === 'string' && body.trail !== '' ? body.trail : null,
    mark: typeof body.mark === 'string' && body.mark !== '' ? body.mark : null,
  };
}

export function bindTrailingStop(input: PlaceOrderInput): PlaceWithTrail {
  const extra = input as PlaceWithTrail;
  if (wantsTrailing(extra as unknown as Record<string, unknown>)) {
    const placeType = extra.type === 'stop' ? 'limit' : extra.type;
    return { ...extra, type: placeType, trail: readTrail(extra), mark: readMark(extra) };
  }
  const hit = stashedFor(carriedPlacementBody(extra));
  if (!hit) return extra;
  return {
    ...extra,
    type: extra.type === 'stop' ? 'limit' : extra.type,
    trail: hit.trail == null ? null : parseAmount(hit.trail),
    mark: hit.mark == null ? null : parseAmount(hit.mark),
  };
}

async function serverMark(service: TradeService, source: QuotedMarkSource, input: PlaceWithTrail): Promise<Amount | null> {
  const market = await (
    service as unknown as { requireMarket(i: { symbol?: string; marketId?: string }): Promise<{ id: string }> }
  ).requireMarket(input);
  try {
    const quote = await source.quote({ marketId: market.id, at: new Date() });
    return quote ? quote.price : null;
  } catch (err) {
    // A market with no book yet has no mark; the customer is told so, not given a stand-in.
    if (err instanceof MatchingNoBookError) return null;
    throw err;
  }
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
    let bound = bindTrailingStop(input);
    if (bound.trail !== undefined) {
      const missingTrail = trailRefuse(bound.trail ?? null);
      if (missingTrail) throw missingTrail;
      const source = (this as unknown as { trailingMarkSource?: QuotedMarkSource }).trailingMarkSource;
      if (source) {
        // The mark is ours. Whatever the request carried is dropped, so a caller cannot choose where the stop starts.
        bound = { ...bound, mark: await serverMark(this, source, bound) };
      }
      const missingMark = markRefuse(bound.mark ?? null);
      if (missingMark) throw missingMark;
      if (bound.side === 'buy') {
        // A buy stop triggers as a market order at a price the hold cannot know yet; funding it is the next slice.
        throw new TradeError('trailing buy stops are not available yet; the funding hold is not built', 'trade.order_type_unsupported');
      }
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
