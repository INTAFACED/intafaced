/**
 * Place a linked OCO with take-profit and stop-loss through matching (#3628).
 * One submit. Refuse if either sibling is missing. Trade does not invent a trigger.
 * Installed onto TradeService.prototype so trade-service.ts never moves.
 */
import type { Principal } from '@intafaced/auth';
import type { FastifyInstance } from 'fastify';
import { ZERO, formatAmount, parseAmount, type Amount } from '@intafaced/ledger-client';
import { TradeError } from './types.js';
import { TradeService, type PlaceOrderInput } from './trade-service.js';
import type { EngineSubmitRequest } from './matching-client.js';
import { attachStashRelease, stashClaim } from './stash-scope.js';

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
const ocoByClient = new Map<string, { takeProfit: OcoLeg; stopLoss: OcoLeg }>();

function clientKey(rec: Record<string, unknown>): string | null {
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

export function stashOcoFromBody(rec: Record<string, unknown>): void {
  if (rec.takeProfit == null && rec.stopLoss == null && rec.oco == null) return;
  const key = clientKey(rec);
  if (!key) {
    throw new TradeError('clientOrderId is required (1–64 chars) so a retry cannot open a second hold', 'trade.client_order_id_required');
  }
  const takeProfit = asLeg(rec.takeProfit);
  const stopLoss = asLeg(rec.stopLoss);
  delete rec.takeProfit;
  delete rec.stopLoss;
  delete rec.oco;
  ocoByClient.set(key, {
    takeProfit: takeProfit ?? { stopPrice: '' },
    stopLoss: stopLoss ?? { stopPrice: '' },
  });
}

/** Tie the entry stashOcoFromBody just wrote to this request, so a refused request releases it. */
export function claimOcoStash(req: object, rec: Record<string, unknown>): void {
  const key = clientKey(rec);
  if (key) stashClaim(req, ocoByClient, key);
}

export function bindOco(input: PlaceOrderInput): PlaceWithOco {
  const extra = input as PlaceWithOco;
  if (wantsOco(extra)) return extra;
  const key = extra.clientOrderId;
  if (!key) return extra;
  const stashed = ocoByClient.get(key);
  if (!stashed) return extra;
  ocoByClient.delete(key);
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

export function attachOcoStash(app: FastifyInstance): void {
  app.addHook('preValidation', (req, _reply, done) => {
    try {
      const body = req.body;
      if (body && typeof body === 'object') {
        stashOcoFromBody(body as Record<string, unknown>);
        claimOcoStash(req, body as Record<string, unknown>);
      }
      done();
    } catch (err) {
      if (err instanceof TradeError) Object.assign(err, { statusCode: 400 });
      done(err as Error);
    }
  });
  attachStashRelease(app);
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
    return origPlace.call(this, principal, bound);
  };

  const origToEngine = proto.toEngineRequest;
  proto.toEngineRequest = function (this: TradeService, ...args: unknown[]) {
    const req = origToEngine.apply(this, args);
    const extra = args[2] as PlaceWithOco | undefined;
    if (!extra || !wantsOco(extra)) return req;
    const takeProfit = triggerOf(extra.takeProfit);
    const stopLoss = triggerOf(extra.stopLoss);
    return {
      ...req,
      oco: true,
      takeProfit: takeProfit == null ? null : formatAmount(takeProfit),
      stopLoss: stopLoss == null ? null : formatAmount(stopLoss),
    } as EngineSubmitRequest;
  };
}

installOcoPlace(TradeService);
