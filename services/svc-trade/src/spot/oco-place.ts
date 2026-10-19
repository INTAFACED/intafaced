/**
 * Place a linked OCO with take-profit and stop-loss through matching (#3628).
 * One submit. Refuse if either sibling is missing. Trade does not invent a trigger.
 * Installed onto TradeService.prototype so trade-service.ts never moves.
 */
import type { Principal } from '@intafaced/auth';
import { ZERO, formatAmount, parseAmount, type Amount } from '@intafaced/ledger-client';
import { TradeError } from './types.js';
import { TradeService, type PlaceOrderInput } from './trade-service.js';
import type { EngineSubmitRequest } from './matching-client.js';
import { carriedPlacementBody } from './placement-extras.js';

export type OcoLeg = {
  readonly price?: string;
  readonly stopPrice: string;
};

export type PlaceWithOco = PlaceOrderInput & {
  oco?: boolean;
  takeProfit?: Amount | OcoLeg | string | null;
  stopLoss?: Amount | OcoLeg | string | null;
};

const FLAG = Symbol.for('intafaced.trade.ocoPlace');

function clientKey(rec: Readonly<Record<string, unknown>>): string | null {
  return typeof rec.clientOrderId === 'string' && rec.clientOrderId.length > 0 ? rec.clientOrderId : null;
}

function refuseIeee(field: string): never {
  throw new TradeError(`${field} is a JSON number — decimal string required`, 'trade.ieee_money');
}

function asLeg(raw: unknown): OcoLeg | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'number') refuseIeee('stopPrice');
  if (typeof raw === 'string') {
    const stopPrice = raw.trim();
    return stopPrice.length > 0 ? { stopPrice } : null;
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) return null;
  const rec = raw as Record<string, unknown>;
  if (typeof rec.stopPrice === 'number' || typeof rec.price === 'number') refuseIeee('stopPrice');
  const stop = typeof rec.stopPrice === 'string' ? rec.stopPrice : typeof rec.price === 'string' ? rec.price : '';
  if (stop.length === 0) return null;
  const leg: OcoLeg = { stopPrice: stop };
  if (typeof rec.price === 'string' && rec.price.length > 0) return { ...leg, price: rec.price };
  return leg;
}

function triggerOf(raw: unknown): Amount | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw === 'bigint') return raw <= ZERO ? null : (raw as Amount);
  const leg = asLeg(raw);
  if (!leg) return null;
  try {
    const qty = parseAmount(leg.stopPrice);
    if (qty <= ZERO) return null;
    return qty;
  } catch {
    return null;
  }
}

export function wantsOco(rec: { readonly oco?: boolean; readonly takeProfit?: unknown; readonly stopLoss?: unknown }): boolean {
  return rec.oco === true || rec.takeProfit !== undefined || rec.stopLoss !== undefined;
}

/** The legs this request's own body asks for, or null when it is not an OCO (a bracket carries its own legs). */
export function readOcoFromBody(rec: Readonly<Record<string, unknown>>): { takeProfit: OcoLeg; stopLoss: OcoLeg } | null {
  if (rec.bracket === true) return null;
  if (rec.takeProfit == null && rec.stopLoss == null && rec.oco == null) return null;
  if (!clientKey(rec)) {
    throw new TradeError('clientOrderId is required (1–64 chars) so a retry cannot open a second hold', 'trade.client_order_id_required');
  }
  return {
    takeProfit: asLeg(rec.takeProfit) ?? { stopPrice: '' },
    stopLoss: asLeg(rec.stopLoss) ?? { stopPrice: '' },
  };
}

export function bindOco(input: PlaceOrderInput): PlaceWithOco {
  const extra = input as PlaceWithOco;
  if (wantsOco(extra)) return extra;
  const body = carriedPlacementBody(extra);
  const stashed = body === null ? null : readOcoFromBody(body);
  if (!stashed) return extra;
  return { ...extra, oco: true, takeProfit: stashed.takeProfit, stopLoss: stashed.stopLoss };
}

export function takeProfitRefuse(takeProfit: Amount | null): TradeError | null {
  if (takeProfit !== null) return null;
  return new TradeError('an OCO take-profit is missing; trade does not invent a trigger', 'trade.missing_oco_trigger');
}

export function stopLossRefuse(stopLoss: Amount | null): TradeError | null {
  if (stopLoss !== null) return null;
  return new TradeError('an OCO stop-loss is missing; trade does not invent a trigger', 'trade.missing_oco_trigger');
}

/** The limit the caller put on the stop-loss leg (`stopLoss.price`), or null. Only a buy OCO uses it. */
export function stopLimitOf(raw: unknown): Amount | null {
  const leg = asLeg(raw);
  if (!leg || leg.price === undefined) return null;
  try {
    const limit = parseAmount(leg.price);
    return limit > ZERO ? limit : null;
  } catch {
    return null;
  }
}

/**
 * The quote price one hold must be sized at for a buy OCO. The take-profit buys below the market and the stop
 * buys at or above its trigger, so the worse leg is the stop's limit. Refuses a buy OCO that has no such limit
 * (a market stop has no worst price) or whose legs are out of order; trade never invents either price.
 */
export function buyHoldPrice(takeProfit: Amount, stopTrigger: Amount, stopLimit: Amount | null): Amount {
  if (stopLimit === null) {
    throw new TradeError(
      'a buy OCO needs a stop-loss limit price (stopLoss.price): the single hold is sized at the worst price the stop may pay',
      'trade.oco_stop_limit_required',
    );
  }
  if (takeProfit >= stopTrigger || stopLimit < stopTrigger) {
    throw new TradeError(
      'a buy OCO needs take-profit below the stop trigger, and the stop-loss limit at or above it',
      'trade.oco_price_order',
    );
  }
  return stopLimit;
}

export function installOcoPlace(ctor: typeof TradeService): void {
  const proto = ctor.prototype as unknown as {
    placeOrder: (principal: Principal, input: PlaceOrderInput) => Promise<{ id: string; status: string; rejectCode?: string }>;
    toEngineRequest: (...args: unknown[]) => EngineSubmitRequest;
    [FLAG]?: true;
  };
  if (proto[FLAG]) return;
  proto[FLAG] = true;

  const origPlace = proto.placeOrder;
  proto.placeOrder = async function (this: TradeService, principal: Principal, input: PlaceOrderInput) {
    const bound = bindOco(input);
    if (!wantsOco(bound)) return origPlace.call(this, principal, bound);
    const missingTp = takeProfitRefuse(triggerOf(bound.takeProfit));
    if (missingTp) throw missingTp;
    const missingSl = stopLossRefuse(triggerOf(bound.stopLoss));
    if (missingSl) throw missingSl;
    // A sell holds base once, whichever leg fills. A buy holds quote once, so it must be sized at the worse of
    // the two leg prices: the stop leg is a stop-limit and its limit is that worst price.
    if (bound.side === 'buy') {
      const worst = buyHoldPrice(triggerOf(bound.takeProfit)!, triggerOf(bound.stopLoss)!, stopLimitOf(bound.stopLoss));
      return origPlace.call(this, principal, { ...bound, price: worst });
    }
    return origPlace.call(this, principal, bound);
  };

  const origToEngine = proto.toEngineRequest;
  proto.toEngineRequest = function (this: TradeService, ...args: unknown[]) {
    const req = origToEngine.apply(this, args);
    const extra = args[2] as PlaceWithOco | undefined;
    if (!extra || !wantsOco(extra)) return req;
    const takeProfit = triggerOf(extra.takeProfit);
    const stopLoss = triggerOf(extra.stopLoss);
    const stopLossLimit = extra.side === 'buy' ? stopLimitOf(extra.stopLoss) : null;
    return {
      ...req,
      oco: true,
      takeProfit: takeProfit == null ? null : formatAmount(takeProfit),
      stopLoss: stopLoss == null ? null : formatAmount(stopLoss),
      ...(stopLossLimit === null ? {} : { stopLossLimit: formatAmount(stopLossLimit) }),
    } as EngineSubmitRequest;
  };
}

installOcoPlace(TradeService);
