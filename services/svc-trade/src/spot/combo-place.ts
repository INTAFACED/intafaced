import type { Principal } from '@intafaced/auth';
import { ZERO, formatAmount, parseAmount, type Amount } from '@intafaced/ledger-client';
import { TradeError } from './types.js';
import { TradeService, type PlaceOrderInput } from './trade-service.js';
import type { EngineComboLeg, EngineSubmitRequest, EngineSubmitResult } from './matching-client.js';
import type { Market } from './types.js';
import { carriedPlacementBody } from './placement-extras.js';

/**
 * Combo take/fill as one instrument (mega H4 trade half).
 * Matching already matches/unwinds combo as one rest (#3796). Trade posts one
 * `orderHold` / `tradeFill` pair via ledger-client — never per-leg invented money.
 * Decimal strings on the matching wire. If legs would each take a hold: refuse.
 * Do not recut matching combo rest.
 */

export type ComboLegInput = {
  readonly name?: string | null;
  readonly ratio?: Amount | null;
  readonly strike?: Amount | null;
  readonly expiry?: string | null;
  readonly qty?: unknown;
  readonly amount?: unknown;
  readonly hold?: unknown;
  readonly side?: unknown;
  readonly price?: unknown;
  readonly notional?: unknown;
  readonly holdAmount?: unknown;
};

type PlaceWithCombo = PlaceOrderInput & {
  combo?: boolean | null;
  legs?: readonly ComboLegInput[] | null;
};

const FLAG = Symbol.for('intafaced.trade.comboPlace');

export const COMBO_LEGS_MISSING = 'missing_combo_legs' as const;
export const RATIO_MISSING = 'missing_ratio' as const;
export const COMBO_DISAGREES = 'combo_disagrees' as const;
export const COMBO_UNSUPPORTED = 'combo_unsupported' as const;

const MISSING_LEGS_MESSAGE = 'a combo requires named legs; trade does not invent a combo book';
const MISSING_RATIO_MESSAGE = 'a combo leg requires a ratio; trade does not invent a combo book';
const MISSING_STRIKE_MESSAGE = 'a combo leg requires a strike; trade does not invent a strike';
const MISSING_EXPIRY_MESSAGE = 'a combo leg requires an expiry; trade does not invent an expiry';
const DISAGREES_MESSAGE = 'a combo takes a resting combo with the same named legs and ratios; trade does not invent a match';
const UNSUPPORTED_MESSAGE = 'a combo is not independent option legs; trade does not rest two holds and call it a combo';
const DOUBLE_HOLD_MESSAGE = 'combo legs would each take a hold; trade posts one hold for the combo, not per-leg invented money';

const LEG_MONEY_KEYS = ['qty', 'amount', 'hold', 'side', 'price', 'notional', 'holdAmount'] as const;

function wantsCombo(rec: { readonly combo?: boolean | null; readonly legs?: unknown }): boolean {
  return rec.combo === true || rec.legs !== undefined;
}

function flagFromRaw(value: unknown): boolean | null {
  if (value === true) return true;
  if (value == null) return null;
  return Boolean(value);
}

function readSigned(raw: unknown): Amount | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw === 'string' && raw.trim() === '') return null;
  try {
    const qty = typeof raw === 'bigint' ? raw : parseAmount(String(raw));
    if (qty === ZERO) return null;
    return qty as Amount;
  } catch {
    return null;
  }
}

function readPositive(raw: unknown): Amount | null {
  const qty = readSigned(raw);
  if (qty === null || qty <= ZERO) return null;
  return qty;
}

function readExpiry(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  const expiry = String(raw).trim();
  return expiry.length === 0 ? null : expiry;
}

function readName(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  const name = String(raw).trim();
  return name.length === 0 ? null : name;
}

function asLegRecords(raw: unknown): readonly Record<string, unknown>[] | null {
  if (raw === undefined) return null;
  if (raw === null) return [];
  if (!Array.isArray(raw)) return [];
  return raw.map((leg) => (leg && typeof leg === 'object' && !Array.isArray(leg) ? (leg as Record<string, unknown>) : {}));
}

function parseLeg(rec: Record<string, unknown>): ComboLegInput {
  return {
    name: readName(rec.name),
    ratio: readSigned(rec.ratio),
    strike: readPositive(rec.strike),
    expiry: readExpiry(rec.expiry),
    ...(rec.qty !== undefined ? { qty: rec.qty } : {}),
    ...(rec.amount !== undefined ? { amount: rec.amount } : {}),
    ...(rec.hold !== undefined ? { hold: rec.hold } : {}),
    ...(rec.side !== undefined ? { side: rec.side } : {}),
    ...(rec.price !== undefined ? { price: rec.price } : {}),
    ...(rec.notional !== undefined ? { notional: rec.notional } : {}),
    ...(rec.holdAmount !== undefined ? { holdAmount: rec.holdAmount } : {}),
  };
}

function moneyPresent(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === 'string' && value.trim() === '') return false;
  if (typeof value === 'boolean') return value;
  return true;
}

/** Caller combo. Missing, null, or false is not set. */
export function readCombo(order: { readonly combo?: boolean | null }): boolean {
  return order.combo === true;
}

/** Caller legs. Missing is not a combo. */
export function readLegs(order: { readonly legs?: readonly ComboLegInput[] | null }): readonly ComboLegInput[] | null {
  if (order.legs === undefined) return null;
  if (order.legs === null) return [];
  return order.legs;
}

export function comboLegsRefuse(legs: readonly ComboLegInput[] | null | undefined): TradeError | null {
  if (legs == null || legs.length < 2) {
    return new TradeError(MISSING_LEGS_MESSAGE, 'trade.missing_combo_legs');
  }
  const seen = new Set<string>();
  for (const [index, leg] of legs.entries()) {
    const name = readName(leg.name);
    if (name === null) {
      return new TradeError(`combo leg ${index} is unnamed; trade does not invent a combo book`, 'trade.missing_combo_legs');
    }
    if (seen.has(name)) {
      return new TradeError(`combo leg ${name} is duplicated; trade does not silently merge legs`, 'trade.missing_combo_legs');
    }
    seen.add(name);
  }
  return null;
}

export function comboDoubleHoldRefuse(legs: readonly ComboLegInput[]): TradeError | null {
  for (const [index, leg] of legs.entries()) {
    const rec = leg as Record<string, unknown>;
    for (const key of LEG_MONEY_KEYS) {
      if (moneyPresent(rec[key])) {
        return new TradeError(`${DOUBLE_HOLD_MESSAGE} (leg ${index} ${key})`, 'trade.combo_double_hold');
      }
    }
  }
  return null;
}

export function comboIntentRefuse(order: {
  readonly combo?: boolean | null;
  readonly legs?: readonly ComboLegInput[] | null;
}): TradeError | null {
  if (!wantsCombo(order)) return null;
  const legs = readLegs(order);
  const missingLegs = comboLegsRefuse(legs);
  if (missingLegs) return missingLegs;
  const named = legs as readonly ComboLegInput[];
  const double = comboDoubleHoldRefuse(named);
  if (double) return double;
  for (const leg of named) {
    if (readSigned(leg.ratio) === null) return new TradeError(MISSING_RATIO_MESSAGE, 'trade.missing_ratio');
    if (readPositive(leg.strike) === null) return new TradeError(MISSING_STRIKE_MESSAGE, 'trade.missing_strike');
    if (readExpiry(leg.expiry) === null) return new TradeError(MISSING_EXPIRY_MESSAGE, 'trade.missing_expiry');
  }
  return null;
}

export function matchingComboRefuse(rejected: { readonly code: string; readonly message?: string } | null | undefined): TradeError | null {
  if (rejected?.code === COMBO_LEGS_MISSING) {
    return new TradeError(
      rejected.message && rejected.message.length > 0 ? rejected.message : MISSING_LEGS_MESSAGE,
      'trade.missing_combo_legs',
    );
  }
  if (rejected?.code === RATIO_MISSING) {
    return new TradeError(
      rejected.message && rejected.message.length > 0 ? rejected.message : MISSING_RATIO_MESSAGE,
      'trade.missing_ratio',
    );
  }
  if (rejected?.code === COMBO_DISAGREES) {
    return new TradeError(rejected.message && rejected.message.length > 0 ? rejected.message : DISAGREES_MESSAGE, 'trade.combo_disagrees');
  }
  if (rejected?.code === COMBO_UNSUPPORTED) {
    return new TradeError(
      rejected.message && rejected.message.length > 0 ? rejected.message : UNSUPPORTED_MESSAGE,
      'trade.combo_unsupported',
    );
  }
  return null;
}

export function matchingSubmitComboRefuse(
  result:
    | {
        readonly rejected?: { readonly code: string; readonly message?: string } | null;
      }
    | null
    | undefined,
): TradeError | null {
  if (result == null) return null;
  return matchingComboRefuse(result.rejected);
}

function comboRejectResult(code: string, message: string): EngineSubmitResult {
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

function wireLegs(legs: readonly ComboLegInput[]): EngineComboLeg[] {
  return legs.map((leg) => ({
    name: readName(leg.name),
    ratio: (() => {
      const ratio = readSigned(leg.ratio);
      return ratio === null ? null : formatAmount(ratio);
    })(),
    strike: (() => {
      const strike = readPositive(leg.strike);
      return strike === null ? null : formatAmount(strike);
    })(),
    expiry: readExpiry(leg.expiry),
  }));
}

/** What this request's own body asks for; null when it asks for nothing. */
function stashedFor(
  body: Readonly<Record<string, unknown>> | null,
): { combo: boolean | null; legs: readonly Record<string, unknown>[] | null } | null {
  if (!body || !wantsCombo(body)) return null;
  return {
    combo: body.combo === undefined ? null : flagFromRaw(body.combo),
    legs: body.legs === undefined ? null : asLegRecords(body.legs),
  };
}

export function bindCombo(input: PlaceOrderInput): PlaceWithCombo {
  const extra = input as PlaceWithCombo;
  if (wantsCombo(extra as unknown as Record<string, unknown>)) {
    const recs = extra.legs === undefined ? null : asLegRecords(extra.legs);
    return {
      ...extra,
      combo: extra.combo ?? null,
      legs: recs === null ? (extra.legs ?? null) : recs.map(parseLeg),
    };
  }
  const hit = stashedFor(carriedPlacementBody(extra));
  if (!hit) return extra;
  return {
    ...extra,
    combo: hit.combo,
    legs: hit.legs == null ? null : hit.legs.map(parseLeg),
  };
}

export function installComboPlace(ctor: typeof TradeService): void {
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
    const bound = bindCombo(input);
    const local = comboIntentRefuse(bound);
    if (local) throw local;
    const order = await origPlace.call(this, principal, bound);
    const refuse = matchingComboRefuse(order.rejectCode ? { code: order.rejectCode } : null);
    if (refuse) throw refuse;
    return order;
  };

  if (typeof proto.applySubmitResult === 'function') {
    const origApply = proto.applySubmitResult;
    proto.applySubmitResult = async function (this: TradeService, market: Market, orderId: string, result: EngineSubmitResult) {
      const refuse = matchingSubmitComboRefuse(result);
      if (refuse) {
        const code = result.rejected?.code ?? COMBO_DISAGREES;
        await origApply.call(this, market, orderId, comboRejectResult(code, refuse.message));
        throw refuse;
      }
      return origApply.call(this, market, orderId, result);
    };
  }

  const origToEngine = proto.toEngineRequest;
  proto.toEngineRequest = function (this: TradeService, ...args: unknown[]) {
    const req = origToEngine.apply(this, args);
    const input = args[2] as PlaceWithCombo | undefined;
    if (!input || !wantsCombo(input)) return req;
    // An explicit combo:false is the caller's no; legs alone must not turn it into a combo order.
    if (input.combo === false) return req;
    const legs = readLegs(input);
    return {
      ...req,
      combo: true,
      ...(legs !== null ? { legs: wireLegs(legs) } : {}),
    };
  };
}

installComboPlace(TradeService);
