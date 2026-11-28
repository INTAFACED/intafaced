import type { Principal } from '@intafaced/auth';
import { TradeError } from './types.js';
import { TradeService, type PlaceOrderInput } from './trade-service.js';
import { carriedPlacementBody } from './placement-extras.js';

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

export const PEG_UNSUPPORTED = 'peg_unsupported' as const;
export const MIDPOINT_UNSUPPORTED = 'midpoint_unsupported' as const;
export const RELATIVE_UNSUPPORTED = 'relative_unsupported' as const;

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

/** What this request's own body asks for; null when it asks for nothing. */
function stashedFor(
  body: Readonly<Record<string, unknown>> | null,
): { peg: boolean | null; midpoint: boolean | null; relative: boolean | null } | null {
  if (!body || !wantsPegIntent(body)) return null;
  return {
    peg: body.peg === undefined ? null : flagFromRaw(body.peg),
    midpoint: body.midpoint === undefined ? null : flagFromRaw(body.midpoint),
    relative: body.relative === undefined ? null : flagFromRaw(body.relative),
  };
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
  const hit = stashedFor(carriedPlacementBody(extra));
  if (!hit) return extra;
  return { ...extra, peg: hit.peg, midpoint: hit.midpoint, relative: hit.relative };
}

export function withPegPlace(Base: typeof TradeService): typeof TradeService {
  return class PegPlace extends Base {
    override async placeOrder(principal: Principal, input: PlaceOrderInput): ReturnType<TradeService['placeOrder']> {
      const bound = bindPeg(input);
      const refuse = pegIntentRefuse(bound);
      if (refuse) throw refuse;
      return super.placeOrder(principal, bound);
    }

    override toEngineRequest(...args: unknown[]): ReturnType<TradeService['toEngineRequest']> {
      const req = super.toEngineRequest(...(args as Parameters<TradeService['toEngineRequest']>));
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
    }
  };
}
