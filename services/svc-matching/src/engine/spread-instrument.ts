/**
 * Spread instruments (CB-otc-16): owner-listed calendar and inter-coin spreads.
 *
 * A listing is owner data. Every field is required; a blank, zero or malformed field refuses with a typed code and
 * nothing is filled in. There are no sample listings: no listing is an empty registry.
 *
 * Spread price. For legs i with side sign s_i (+1 buy, -1 sell, from the spread buyer's point of view) and ratio r_i:
 *
 *     spread = s_0 * r_0 * P_0 + s_1 * r_1 * P_1
 *
 * so a spread price may be zero or negative. Calendar: `[far buy 1, near sell 1]` is far minus near.
 * Inter-coin 2:1: `[ETH buy 2, BTC sell 1]` is 2 x ETH minus BTC.
 *
 * Leg-price rule (one rule, no rounding). A spread fill prints at the maker's spread price S. Leg 0 is the anchor leg
 * and prints at the taker's caller-supplied anchor reference R (the engine does not invent a mark). Leg 1 is the
 * residual leg and prints at the one price that makes the identity above exact:
 *
 *     P_1 = (S - s_0 * r_0 * R) / (s_1 * r_1)
 *
 * The division must be exact at 18 decimals and P_1 must be positive, or the whole spread refuses. Listing checks
 * `tick / r_1` and `lot * r_i` are exact, and admission checks `r_0 * R / r_1` is exact, so an on-tick, on-lot order
 * never needs rounding. Leg quantities are `fill qty x r_i`, exact for the same reason.
 *
 * Pure: no I/O, no clock, no randomness. Amounts are scaled bigints; decimal strings only on the wire.
 */
import { MAX_AMOUNT, SCALE, ZERO, formatAmount, parseAmount, type Amount } from '@intafaced/ledger-client/money';
import type { OrderSide, RejectCode, RejectReason, SpreadInstrument, SpreadKind, SpreadLegDefinition, SpreadLegFill } from './types.js';

export const SPREAD_KINDS = ['calendar', 'inter_coin'] as const satisfies readonly SpreadKind[];

/** Exactly two legs: one anchor and one residual. More legs would need a second, owner-chosen pricing rule. */
export const SPREAD_LEG_COUNT = 2;

const MAX_ID = 128;

/** Listing input as it arrives: strings or blanks, never JSON numbers. */
export interface SpreadListingInput {
  readonly spreadId?: string | null;
  readonly kind?: string | null;
  readonly legs?: readonly SpreadLegInput[] | null;
  readonly tick?: string | null;
  readonly lot?: string | null;
}

export interface SpreadLegInput {
  readonly symbol?: string | null;
  readonly side?: string | null;
  readonly ratio?: string | null;
}

/** Decimal strings on the wire and on disk. */
export interface WireSpreadInstrument {
  readonly spreadId: string;
  readonly kind: SpreadKind;
  readonly legs: readonly { readonly symbol: string; readonly side: OrderSide; readonly ratio: string }[];
  readonly tick: string;
  readonly lot: string;
}

export type SpreadListingRead =
  { readonly ok: true; readonly instrument: SpreadInstrument } | { readonly ok: false; readonly rejected: RejectReason };

function refuse(code: RejectCode, message: string): RejectReason {
  return { code, message };
}

function fail(code: RejectCode, message: string): SpreadListingRead {
  return { ok: false, rejected: refuse(code, message) };
}

/** A positive decimal string, or null. Blank, zero, negative and malformed are all null — never a default. */
function readPositive(raw: string | null | undefined): Amount | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  let value: Amount;
  try {
    value = parseAmount(trimmed);
  } catch {
    return null;
  }
  return value > ZERO ? value : null;
}

function fits(value: Amount): boolean {
  return value <= MAX_AMOUNT && value >= -MAX_AMOUNT;
}

/** a x b at 18 decimals, or null when the product is not exact or does not fit. */
export function mulExact(a: Amount, b: Amount): Amount | null {
  const product = a * b;
  if (product % SCALE !== ZERO) return null;
  const value = product / SCALE;
  return fits(value) ? value : null;
}

/** a / b at 18 decimals, or null when the quotient is not exact, b is zero, or it does not fit. */
export function divExact(a: Amount, b: Amount): Amount | null {
  if (b === ZERO) return null;
  const numerator = a * SCALE;
  if (numerator % b !== ZERO) return null;
  const value = numerator / b;
  return fits(value) ? value : null;
}

function sign(side: OrderSide): Amount {
  return side === 'buy' ? 1n : -1n;
}

function opposite(side: OrderSide): OrderSide {
  return side === 'buy' ? 'sell' : 'buy';
}

/**
 * Read an owner listing. Every field is required; the first missing or invalid one refuses with its own code.
 */
export function readSpreadListing(input: SpreadListingInput): SpreadListingRead {
  const spreadId = typeof input.spreadId === 'string' ? input.spreadId.trim() : '';
  if (spreadId.length === 0 || spreadId.length > MAX_ID) {
    return fail('spread_id_missing', 'a spread listing needs an id; the engine does not invent one');
  }

  const kind = typeof input.kind === 'string' ? input.kind.trim() : '';
  if (!(SPREAD_KINDS as readonly string[]).includes(kind)) {
    return fail('spread_kind_unsupported', `spread kind must be one of ${SPREAD_KINDS.join(', ')}; the engine does not guess one`);
  }

  const rawLegs = input.legs;
  if (!Array.isArray(rawLegs) || rawLegs.length !== SPREAD_LEG_COUNT) {
    return fail('spread_legs_invalid', `a spread lists exactly ${SPREAD_LEG_COUNT} legs: an anchor leg and a residual leg`);
  }

  const legs: SpreadLegDefinition[] = [];
  for (const [index, leg] of rawLegs.entries()) {
    const symbol = typeof leg?.symbol === 'string' ? leg.symbol.trim() : '';
    if (symbol.length === 0 || symbol.length > MAX_ID) {
      return fail('spread_leg_symbol_missing', `spread leg ${index} has no symbol; the engine does not invent one`);
    }
    const side = typeof leg?.side === 'string' ? leg.side.trim() : '';
    if (side !== 'buy' && side !== 'sell') {
      return fail('spread_leg_side_missing', `spread leg ${index} needs side buy or sell; the engine does not invent one`);
    }
    const ratio = readPositive(leg?.ratio);
    if (ratio === null) {
      return fail('spread_ratio_missing', `spread leg ${index} needs a positive ratio; blank or zero is not 1`);
    }
    legs.push({ symbol, side, ratio });
  }

  const [anchor, residual] = legs as [SpreadLegDefinition, SpreadLegDefinition];
  if (anchor.symbol === residual.symbol) {
    return fail('spread_legs_invalid', 'spread legs must name two different symbols');
  }
  if (anchor.symbol === spreadId || residual.symbol === spreadId) {
    return fail('spread_legs_invalid', 'a spread leg cannot be the spread itself');
  }
  if (anchor.side === residual.side) {
    return fail('spread_legs_invalid', 'a spread buys one leg and sells the other');
  }
  if (kind === 'calendar' && anchor.ratio !== residual.ratio) {
    return fail('spread_legs_invalid', 'a calendar spread trades both legs at the same ratio');
  }

  const tick = readPositive(input.tick);
  if (tick === null) return fail('spread_tick_missing', 'a spread listing needs a positive tick; blank is not a default');
  const lot = readPositive(input.lot);
  if (lot === null) return fail('spread_lot_missing', 'a spread listing needs a positive lot; blank is not a default');

  for (const [index, leg] of legs.entries()) {
    if (mulExact(lot, leg.ratio) === null) {
      return fail('spread_size_inexact', `lot x ratio for leg ${index} is not exact at 18 decimals`);
    }
  }
  if (divExact(tick, residual.ratio) === null) {
    return fail('spread_size_inexact', 'tick / residual ratio is not exact at 18 decimals, so a residual leg price would need rounding');
  }

  return { ok: true, instrument: { spreadId, kind: kind as SpreadKind, legs, tick, lot } };
}

export function toWireSpread(instrument: SpreadInstrument): WireSpreadInstrument {
  return {
    spreadId: instrument.spreadId,
    kind: instrument.kind,
    legs: instrument.legs.map((leg) => ({ symbol: leg.symbol, side: leg.side, ratio: formatAmount(leg.ratio) })),
    tick: formatAmount(instrument.tick),
    lot: formatAmount(instrument.lot),
  };
}

export function fromWireSpread(wire: WireSpreadInstrument): SpreadInstrument {
  return {
    spreadId: wire.spreadId,
    kind: wire.kind,
    legs: wire.legs.map((leg) => ({ symbol: leg.symbol, side: leg.side, ratio: parseAmount(leg.ratio) })),
    tick: parseAmount(wire.tick),
    lot: parseAmount(wire.lot),
  };
}

/** One string per listing. Leg order is part of it: leg 0 is the anchor. */
export function spreadIdentity(instrument: SpreadInstrument): string {
  return JSON.stringify(toWireSpread(instrument));
}

/** The anchor reference is caller data. Missing, non-positive, or one that would force rounding refuses. */
export function spreadReferenceRefuse(instrument: SpreadInstrument, reference: Amount | null | undefined): RejectReason | null {
  if (reference === null || reference === undefined || reference <= ZERO) {
    return refuse('spread_reference_missing', 'a spread order needs an anchor leg reference price; the engine does not invent a mark');
  }
  const [anchor, residual] = instrument.legs as [SpreadLegDefinition, SpreadLegDefinition];
  const term = mulExact(anchor.ratio, reference);
  if (term === null || divExact(term, residual.ratio) === null) {
    return refuse(
      'spread_reference_missing',
      'the anchor reference is not exact at 18 decimals for this listing; the engine does not round it',
    );
  }
  return null;
}

/** [anchor price, residual price] for a spread price, or the refusal. Never rounds. */
export function spreadLegPrices(
  instrument: SpreadInstrument,
  reference: Amount,
  spreadPrice: Amount,
): { readonly ok: true; readonly prices: readonly [Amount, Amount] } | { readonly ok: false; readonly rejected: RejectReason } {
  const [anchor, residual] = instrument.legs as [SpreadLegDefinition, SpreadLegDefinition];
  const anchorTerm = mulExact(anchor.ratio, reference);
  if (anchorTerm === null) {
    return { ok: false, rejected: refuse('spread_leg_unfillable', `anchor leg ${anchor.symbol} cannot be priced exactly`) };
  }
  const residualPrice = divExact(spreadPrice - sign(anchor.side) * anchorTerm, sign(residual.side) * residual.ratio);
  if (residualPrice === null) {
    return { ok: false, rejected: refuse('spread_leg_unfillable', `residual leg ${residual.symbol} cannot be priced exactly`) };
  }
  if (residualPrice <= ZERO) {
    return {
      ok: false,
      rejected: refuse(
        'spread_leg_unfillable',
        `residual leg ${residual.symbol} would print at ${formatAmount(residualPrice)} for spread ${formatAmount(spreadPrice)}; the whole spread refuses`,
      ),
    };
  }
  const residualTerm = mulExact(residual.ratio, residualPrice);
  if (residualTerm === null || sign(anchor.side) * anchorTerm + sign(residual.side) * residualTerm !== spreadPrice) {
    return { ok: false, rejected: refuse('spread_leg_unfillable', 'leg prices do not sum to the spread price exactly') };
  }
  return { ok: true, prices: [reference, residualPrice] };
}

/**
 * Every leg of one spread fill, or the refusal. Quantities are `qty x ratio`; prices follow the leg-price rule.
 * `takerSide` is the taker's side on the spread; each leg carries the taker's side on that leg.
 */
export function spreadLegFills(
  instrument: SpreadInstrument,
  reference: Amount,
  spreadPrice: Amount,
  qty: Amount,
  takerSide: OrderSide,
): { readonly ok: true; readonly legs: readonly SpreadLegFill[] } | { readonly ok: false; readonly rejected: RejectReason } {
  const priced = spreadLegPrices(instrument, reference, spreadPrice);
  if (!priced.ok) return priced;
  const legs: SpreadLegFill[] = [];
  for (const [index, leg] of instrument.legs.entries()) {
    const legQty = mulExact(qty, leg.ratio);
    if (legQty === null || legQty <= ZERO) {
      return { ok: false, rejected: refuse('spread_leg_unfillable', `leg ${leg.symbol} qty is not exact at 18 decimals`) };
    }
    legs.push({
      symbol: leg.symbol,
      takerSide: takerSide === 'buy' ? leg.side : opposite(leg.side),
      qty: legQty,
      price: priced.prices[index] as Amount,
    });
  }
  return { ok: true, legs };
}
