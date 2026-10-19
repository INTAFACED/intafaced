import type { Principal } from '@intafaced/auth';
import { formatAmount, parseAmount, type Amount } from '@intafaced/ledger-client';
import { TradeError } from './types.js';
import { TradeService, type PlaceOrderInput } from './trade-service.js';
import type { EngineSubmitRequest } from './matching-client.js';
import { carriedPlacementBody } from './placement-extras.js';

/**
 * Place an iceberg through the matching door that landed in #3282.
 * Only the display qty is visible. Hidden remainder refills as display takes.
 * Trade does not invent a display.
 */

type PlaceWithIceberg = PlaceOrderInput & { iceberg?: boolean; displayQty?: Amount | null };

const FLAG = Symbol.for('intafaced.trade.icebergPlace');

export const ICEBERG_DISPLAY_MISSING = 'iceberg_display_missing' as const;
export const ICEBERG_DISPLAY_NOT_SMALLER = 'iceberg_display_not_smaller' as const;

function wantsIceberg(rec: Record<string, unknown>): boolean {
  return rec.iceberg === true || rec.displayQty !== undefined;
}

function readDisplay(raw: unknown): Amount | null {
  if (raw == null) return null;
  if (typeof raw === 'string' && raw.trim() === '') return null;
  try {
    const qty = typeof raw === 'string' || typeof raw === 'number' ? parseAmount(String(raw)) : (raw as Amount);
    return qty;
  } catch {
    return null;
  }
}

export function icebergDisplayRefuse(qty: Amount, displayQty: Amount | null): TradeError | null {
  if (displayQty === null || displayQty <= (0n as Amount)) {
    return new TradeError('iceberg requires a display qty; trade does not invent a display', 'trade.iceberg_display_missing');
  }
  if (displayQty >= qty) {
    return new TradeError(
      'iceberg display must be smaller than total; trade does not invent a display',
      'trade.iceberg_display_not_smaller',
    );
  }
  return null;
}

/** What this request's own body asks for; null when it asks for nothing. */
function stashedFor(body: Readonly<Record<string, unknown>> | null): { displayQty: string | null } | null {
  if (!body || !wantsIceberg(body)) return null;
  const display = body.displayQty;
  return { displayQty: display == null || display === '' ? null : String(display) };
}

export function bindIceberg(input: PlaceOrderInput): PlaceWithIceberg {
  const extra = input as PlaceWithIceberg;
  if (extra.iceberg === true || extra.displayQty !== undefined) {
    return { ...extra, iceberg: true, displayQty: extra.displayQty ?? null };
  }
  const hit = stashedFor(carriedPlacementBody(extra));
  if (!hit) return extra;
  return { ...extra, iceberg: true, displayQty: hit.displayQty == null ? null : parseAmount(hit.displayQty) };
}

export function installIcebergPlace(ctor: typeof TradeService): void {
  const proto = ctor.prototype as unknown as {
    placeOrder: (principal: Principal, input: PlaceOrderInput) => Promise<{ id: string; status: string }>;
    toEngineRequest: (...args: unknown[]) => EngineSubmitRequest;
    [FLAG]?: true;
  };
  if (proto[FLAG]) return;
  proto[FLAG] = true;

  const origPlace = proto.placeOrder;
  proto.placeOrder = async function (this: TradeService, principal: Principal, input: PlaceOrderInput) {
    const bound = bindIceberg(input);
    if (bound.iceberg === true || bound.displayQty !== undefined) {
      const refuse = icebergDisplayRefuse(bound.qty, bound.displayQty ?? null);
      if (refuse) throw refuse;
      if (bound.type === 'limit' && bound.price == null) {
        throw new TradeError('iceberg requires a limit price; trade does not invent a display', 'trade.invalid_tif');
      }
    }
    return origPlace.call(this, principal, bound);
  };

  const origToEngine = proto.toEngineRequest;
  proto.toEngineRequest = function (this: TradeService, ...args: unknown[]) {
    const req = origToEngine.apply(this, args);
    const input = args[2] as PlaceWithIceberg | undefined;
    if (input?.iceberg === true || input?.displayQty !== undefined) {
      return {
        ...req,
        iceberg: true,
        displayQty: input.displayQty == null ? null : formatAmount(input.displayQty),
      };
    }
    return req;
  };
}

installIcebergPlace(TradeService);
