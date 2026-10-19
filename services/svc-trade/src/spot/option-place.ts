import { requireScope, type Principal } from '@intafaced/auth';
import { formatAmount, parseAmount, type Amount } from '@intafaced/ledger-client';
import { TradeError, type AmendOrderOutcome, type OrderRecord } from './types.js';
import { TradeService, type AmendOrderInput, type PlaceOrderInput } from './trade-service.js';
import { installNativeQtyUpAmend } from './qty-up-amend.js';
import type { EngineAmendRequest, EngineCancellation, EngineFill, EngineSubmitRequest, MatchingClient } from './matching-client.js';
import type { Market } from './types.js';
import { carriedPlacementBody } from './placement-extras.js';

/**
 * Place an option through the matching door that landed in #3484.
 * Same strike and expiry. Refuse if strike or expiry is missing.
 * Exercise a long option at strike through that door.
 * Assign a short option when a long is exercised through that door.
 * Cover a short option after assignment through that door.
 * Expire a resting option at expiry through matching. Unfilled remainder leaves the book.
 * Cancel a resting option through matching. Unfilled remainder leaves the book.
 * Amend qty on a resting option through matching. Refuse if strike, expiry, or qty is missing.
 * Amend price on a resting option through matching. Refuse if strike, expiry, or price is missing.
 * Replace a resting option (price and qty together) through matching. Refuse if strike, expiry, price, or qty is missing.
 * Trade does not invent a mark or a clock.
 */

type PlaceWithOption = PlaceOrderInput & {
  type?: PlaceOrderInput['type'] | 'option';
  strike?: Amount | null;
  expiry?: string | null;
  exercise?: boolean;
  assign?: boolean;
  cover?: boolean;
  cancel?: boolean;
  now?: string | null;
};

type AmendWithOption = AmendOrderInput & {
  strike?: Amount | null;
  expiry?: string | null;
  mark?: Amount | string | null;
  amend?: boolean;
  replace?: boolean;
};

const FLAG = Symbol.for('intafaced.trade.optionPlace');
const AMEND_FLAG = Symbol.for('intafaced.trade.optionAmend');

export const STRIKE_MISSING = 'missing_strike' as const;
export const EXPIRY_MISSING = 'missing_expiry' as const;
export const QTY_MISSING = 'missing_qty' as const;
export const PRICE_MISSING = 'missing_price' as const;

function wantsOption(rec: Record<string, unknown>): boolean {
  return rec.type === 'option' || rec.strike !== undefined || rec.expiry !== undefined;
}

export function wantsExercise(rec: { readonly exercise?: boolean }): boolean {
  return rec.exercise === true;
}

export function wantsAssign(rec: { readonly assign?: boolean }): boolean {
  return rec.assign === true;
}

export function wantsCover(rec: { readonly cover?: boolean }): boolean {
  return rec.cover === true;
}

export function wantsCancel(rec: { readonly cancel?: boolean }): boolean {
  return rec.cancel === true;
}

export function wantsAmend(rec: { readonly amend?: boolean }): boolean {
  return rec.amend === true;
}

export function wantsReplace(rec: { readonly replace?: boolean }): boolean {
  return rec.replace === true;
}

function readStrike(rec: { readonly strike?: Amount | null }): Amount | null {
  if (rec.strike === undefined) return null;
  return rec.strike ?? null;
}

function readExpiry(rec: { readonly expiry?: string | null }): string | null {
  if (rec.expiry === undefined || rec.expiry === null) return null;
  const expiry = rec.expiry.trim();
  return expiry.length === 0 ? null : expiry;
}

/** Caller clock. Null/blank is omitted — never invent from mark or wall time. */
function readNow(rec: { readonly now?: string | Date | null }): string | null {
  if (rec.now === undefined || rec.now === null) return null;
  if (rec.now instanceof Date) {
    const ms = rec.now.getTime();
    return Number.isFinite(ms) ? rec.now.toISOString() : null;
  }
  const now = String(rec.now).trim();
  return now.length === 0 ? null : now;
}

export function strikeRefuse(strike: Amount | null): TradeError | null {
  if (strike === null || strike <= (0n as Amount)) {
    return new TradeError('an option requires a strike; trade does not invent a mark', 'trade.missing_strike');
  }
  return null;
}

export function expiryRefuse(expiry: string | null): TradeError | null {
  if (expiry === null || expiry.length === 0) {
    return new TradeError('an option requires an expiry; trade does not invent a mark', 'trade.missing_expiry');
  }
  return null;
}

export function qtyRefuse(qty: Amount | null | undefined): TradeError | null {
  if (qty === undefined || qty === null || qty <= (0n as Amount)) {
    return new TradeError('an option amend requires a qty; trade does not invent a mark', 'trade.missing_qty');
  }
  return null;
}

export function priceRefuse(price: Amount | null | undefined): TradeError | null {
  if (price === undefined || price === null || price <= (0n as Amount)) {
    return new TradeError('an option amend requires a price; trade does not invent a mark', 'trade.missing_price');
  }
  return null;
}

/** What this request's own body asks for; null when it asks for nothing. */
function stashedFor(body: Readonly<Record<string, unknown>> | null): {
  strike: string | null;
  expiry: string | null;
  exercise: boolean;
  assign: boolean;
  cover: boolean;
  cancel: boolean;
  amend: boolean;
  now: string | null;
} | null {
  if (!body) return null;
  if (!(
    wantsOption(body) ||
    body.exercise === true ||
    body.assign === true ||
    body.cover === true ||
    body.cancel === true ||
    body.amend === true ||
    body.now != null
  ))
    return null;
  return {
    strike: body.strike == null || body.strike === '' ? null : String(body.strike),
    expiry: body.expiry == null || body.expiry === '' ? null : String(body.expiry),
    exercise: body.exercise === true,
    assign: body.assign === true,
    cover: body.cover === true,
    cancel: body.cancel === true,
    amend: body.amend === true,
    now: body.now == null || body.now === '' ? null : String(body.now),
  };
}

export function bindOption(input: PlaceOrderInput): PlaceWithOption {
  const extra = input as PlaceWithOption;
  if (
    wantsOption(extra as unknown as Record<string, unknown>) ||
    extra.exercise === true ||
    extra.assign === true ||
    extra.cover === true ||
    extra.cancel === true
  ) {
    const placeType = extra.type === 'option' ? 'limit' : extra.type;
    return {
      ...extra,
      type: placeType,
      strike: readStrike(extra),
      expiry: readExpiry(extra),
      now: readNow(extra),
      ...(extra.exercise === true ? { exercise: true } : {}),
      ...(extra.assign === true ? { assign: true } : {}),
      ...(extra.cover === true ? { cover: true } : {}),
      ...(extra.cancel === true ? { cancel: true } : {}),
    };
  }
  if (extra.now != null) {
    return { ...extra, now: readNow(extra) };
  }
  const hit = stashedFor(carriedPlacementBody(extra));
  if (!hit) return extra;
  return {
    ...extra,
    type: extra.type === 'option' ? 'limit' : extra.type,
    strike: hit.strike == null ? null : parseAmount(hit.strike),
    expiry: hit.expiry,
    now: hit.now ?? null,
    ...(hit.exercise === true ? { exercise: true } : {}),
    ...(hit.assign === true ? { assign: true } : {}),
    ...(hit.cover === true ? { cover: true } : {}),
    ...(hit.cancel === true ? { cancel: true } : {}),
  };
}

function withNow(req: EngineSubmitRequest, now: string | null): EngineSubmitRequest {
  if (now == null) return req;
  return { ...req, now } as EngineSubmitRequest;
}

function isOptionAmend(extra: AmendWithOption): boolean {
  return extra.amend === true || extra.replace === true || extra.strike !== undefined || extra.expiry !== undefined;
}

export function installOptionPlace(ctor: typeof TradeService): void {
  const proto = ctor.prototype as unknown as {
    placeOrder: (principal: Principal, input: PlaceOrderInput) => Promise<{ id: string; status: string }>;
    toEngineRequest: (...args: unknown[]) => EngineSubmitRequest;
    settleOutcome: (market: Market, fills: readonly EngineFill[], cancellations: readonly EngineCancellation[]) => Promise<void>;
    finalize: (orderId: string, status: 'cancelled' | 'filled' | 'expired' | 'rejected', reason?: string | null) => Promise<void>;
    [FLAG]?: true;
  };
  if (proto[FLAG]) return;
  proto[FLAG] = true;

  const origPlace = proto.placeOrder;
  proto.placeOrder = async function (this: TradeService, principal: Principal, input: PlaceOrderInput) {
    const bound = bindOption(input);
    const assigning = bound.assign === true || (input as PlaceWithOption).assign === true;
    if (assigning) {
      const missingStrike = strikeRefuse(bound.strike ?? null);
      if (missingStrike) throw missingStrike;
      const missingExpiry = expiryRefuse(bound.expiry ?? null);
      if (missingExpiry) throw missingExpiry;
      const priced =
        bound.price == null && bound.strike != null && bound.strike > (0n as Amount)
          ? { ...bound, assign: true as const, exercise: true as const, price: bound.strike }
          : { ...bound, assign: true as const, exercise: true as const };
      return origPlace.call(this, principal, priced);
    }
    const covering = bound.cover === true || (input as PlaceWithOption).cover === true;
    if (covering) {
      const missingStrike = strikeRefuse(bound.strike ?? null);
      if (missingStrike) throw missingStrike;
      const missingExpiry = expiryRefuse(bound.expiry ?? null);
      if (missingExpiry) throw missingExpiry;
      const priced =
        bound.price == null && bound.strike != null && bound.strike > (0n as Amount)
          ? { ...bound, cover: true as const, price: bound.strike }
          : { ...bound, cover: true as const };
      return origPlace.call(this, principal, priced);
    }
    const exercising = bound.exercise === true || (input as PlaceWithOption).exercise === true;
    if (exercising) {
      const missingStrike = strikeRefuse(bound.strike ?? null);
      if (missingStrike) throw missingStrike;
      const missingExpiry = expiryRefuse(bound.expiry ?? null);
      if (missingExpiry) throw missingExpiry;
      const priced =
        bound.price == null && bound.strike != null && bound.strike > (0n as Amount)
          ? { ...bound, exercise: true as const, assign: true as const, price: bound.strike }
          : { ...bound, exercise: true as const, assign: true as const };
      return origPlace.call(this, principal, priced);
    }
    const cancelling = bound.cancel === true || (input as PlaceWithOption).cancel === true;
    if (cancelling) {
      const missingStrike = strikeRefuse(bound.strike ?? null);
      if (missingStrike) throw missingStrike;
      const missingExpiry = expiryRefuse(bound.expiry ?? null);
      if (missingExpiry) throw missingExpiry;
      const priced =
        bound.price == null && bound.strike != null && bound.strike > (0n as Amount)
          ? { ...bound, cancel: true as const, price: bound.strike }
          : { ...bound, cancel: true as const };
      return origPlace.call(this, principal, priced);
    }
    if (bound.strike !== undefined || bound.expiry !== undefined || (input as PlaceWithOption).type === 'option') {
      const missingStrike = strikeRefuse(bound.strike ?? null);
      if (missingStrike) throw missingStrike;
      const missingExpiry = expiryRefuse(bound.expiry ?? null);
      if (missingExpiry) throw missingExpiry;
      if (bound.price == null) {
        throw new TradeError('an option rests as a limit; trade does not invent a mark', 'trade.missing_price');
      }
    }
    return origPlace.call(this, principal, bound);
  };

  const origToEngine = proto.toEngineRequest;
  proto.toEngineRequest = function (this: TradeService, ...args: unknown[]) {
    const req = origToEngine.apply(this, args);
    const input = args[2] as PlaceWithOption | undefined;
    const now = input ? readNow(input) : null;
    if (input && input.cover === true) {
      const { mark: _mark, ...rest } = req as EngineSubmitRequest & { mark?: string | null };
      return withNow(
        {
          ...rest,
          cover: true,
          strike: input.strike == null ? null : formatAmount(input.strike),
          expiry: input.expiry ?? null,
        } as EngineSubmitRequest,
        now,
      );
    }
    if (input && (input.exercise === true || input.assign === true)) {
      const { mark: _mark, ...rest } = req as EngineSubmitRequest & { mark?: string | null };
      return withNow(
        {
          ...rest,
          exercise: true,
          assign: true,
          strike: input.strike == null ? null : formatAmount(input.strike),
          expiry: input.expiry ?? null,
        },
        now,
      );
    }
    if (input && input.cancel === true) {
      const { mark: _mark, ...rest } = req as EngineSubmitRequest & { mark?: string | null };
      return withNow(
        {
          ...rest,
          cancel: true,
          strike: input.strike == null ? null : formatAmount(input.strike),
          expiry: input.expiry ?? null,
        } as EngineSubmitRequest,
        now,
      );
    }
    if (input && (input.strike !== undefined || input.expiry !== undefined || input.type === 'option')) {
      const { mark: _mark, ...rest } = req as EngineSubmitRequest & { mark?: string | null };
      return withNow(
        {
          ...rest,
          type: 'option',
          strike: input.strike == null ? null : formatAmount(input.strike),
          expiry: input.expiry ?? null,
        },
        now,
      );
    }
    return withNow(req, now);
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

export function installOptionAmend(ctor: typeof TradeService): void {
  installNativeQtyUpAmend(ctor);
  const proto = ctor.prototype as unknown as {
    amendOrder: (principal: Principal, orderId: string, input: AmendOrderInput) => Promise<AmendOrderOutcome>;
    [AMEND_FLAG]?: true;
  };
  if (proto[AMEND_FLAG]) return;
  proto[AMEND_FLAG] = true;

  const origAmend = proto.amendOrder;
  proto.amendOrder = async function (this: TradeService, principal: Principal, orderId: string, input: AmendOrderInput) {
    const extra = input as AmendWithOption;
    if (!isOptionAmend(extra)) {
      return origAmend.call(this, principal, orderId, extra);
    }
    const missingStrike = strikeRefuse(readStrike(extra));
    if (missingStrike) throw missingStrike;
    const missingExpiry = expiryRefuse(readExpiry(extra));
    if (missingExpiry) throw missingExpiry;
    const priceGiven = extra.price !== undefined;
    const replacing = extra.replace === true || (priceGiven && extra.qty !== undefined);
    if (replacing || priceGiven) {
      const missingPrice = priceRefuse(extra.price);
      if (missingPrice) throw missingPrice;
    }
    if (replacing || extra.qty !== undefined || !priceGiven) {
      const missingQty = qtyRefuse(extra.qty);
      if (missingQty) throw missingQty;
    }

    const host = this as unknown as {
      matching: MatchingClient;
      findOrder: (id: string) => Promise<OrderRecord | null>;
      marketById: (id: string) => Promise<Market | null>;
      assertLifecycleAction: (market: Market, action: 'AMEND') => Promise<EngineAmendRequest['lifecycleProof']>;
      sql: (strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown>;
      amendOutcome: (
        order: OrderRecord,
        code: string,
        reasonCode: string | null,
        reconciliationRequired: boolean,
        idempotent: boolean,
        priority: string | null,
      ) => AmendOrderOutcome;
    };
    const origMatchingAmend = host.matching.amend.bind(host.matching);
    host.matching.amend = (marketId, oid, req) => {
      const { mark: _mark, ...rest } = req as EngineAmendRequest & { mark?: string | null };
      return origMatchingAmend(marketId, oid, {
        ...rest,
        ...(extra.qty !== undefined && extra.qty != null ? { qty: formatAmount(extra.qty) } : {}),
        ...(priceGiven ? { price: formatAmount(extra.price as Amount) } : {}),
        ...(replacing ? { replace: true } : {}),
        strike: extra.strike == null ? null : formatAmount(extra.strike),
        expiry: extra.expiry ?? null,
      } as EngineAmendRequest);
    };
    try {
      if (replacing || (priceGiven && extra.qty === undefined)) {
        requireScope(principal, 'trade:write');
        const order = await host.findOrder(orderId);
        if (!order || order.userId !== principal.userId) {
          throw new TradeError(`order ${orderId} not found`, 'trade.order_not_found');
        }
        const market = await host.marketById(order.marketId);
        if (!market) throw new TradeError(`market ${order.marketId} not found`, 'trade.market_not_found');
        const lifecycleProof = await host.assertLifecycleAction(market, 'AMEND');
        const listed = await host.matching.listOrders(order.marketId);
        const live = listed.orders.find((candidate) => candidate.orderId === order.id);
        if (!live) {
          return host.amendOutcome(order as OrderRecord, 'AMEND_UNKNOWN', 'AMEND_UNKNOWN', true, false, null);
        }
        const result = await host.matching.amend(order.marketId, order.id, {
          expectedVersion: live.version ?? 1,
          ...(priceGiven ? { price: formatAmount(extra.price as Amount) } : {}),
          ...(extra.qty !== undefined && extra.qty != null ? { qty: formatAmount(extra.qty) } : {}),
          lifecycleProof,
        } as EngineAmendRequest);
        if (!result.accepted) {
          const code = result.rejected?.code === 'version_mismatch' ? 'VERSION_MISMATCH' : 'ENGINE_REFUSED';
          return host.amendOutcome(order as OrderRecord, code, result.rejected?.code ?? 'refused', false, false, null);
        }
        const nextPrice = priceGiven ? formatAmount(extra.price as Amount) : formatAmount(order.price ?? (0n as Amount));
        const nextQty = extra.qty !== undefined && extra.qty != null ? formatAmount(extra.qty) : formatAmount(order.qty);
        await host.sql`
          UPDATE trade.orders
             SET price = ${nextPrice}::numeric,
                 qty = ${nextQty}::numeric,
                 updated_at = now()
           WHERE id = ${order.id}
        `;
        const settled = (await host.findOrder(orderId)) ?? order;
        return host.amendOutcome(settled as OrderRecord, 'AMENDED', null, false, false, result.priority);
      }
      const { price: _droppedPrice, ...withoutPrice } = extra;
      return await origAmend.call(this, principal, orderId, withoutPrice as AmendOrderInput);
    } finally {
      host.matching.amend = origMatchingAmend;
    }
  };
}

installOptionPlace(TradeService);
installOptionAmend(TradeService);
