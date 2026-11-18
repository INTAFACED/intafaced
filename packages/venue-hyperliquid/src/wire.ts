import { compare, div, formatAmount, mul, parseAmount, SCALE, ZERO, type Amount } from '@intafaced/ledger-client/money';

/**
 * Hyperliquid's number rules, on scaled bigints. Never a float.
 *
 * Prices and sizes cross the wire as decimal strings with no trailing zeros
 * (`formatAmount` is already that form, the same as the SDK's `float_to_wire`
 * output). A value the venue would refuse is refused here, before the wallet
 * is asked; nothing is rounded to fit:
 *
 *   · size: at most `szDecimals` decimal places;
 *   · price: an integer price is always allowed; otherwise at most 5
 *     significant figures and at most `MAX_DECIMALS - szDecimals` decimal
 *     places, where MAX_DECIMALS is 6 on perpetuals and 8 on spot
 *     (Hyperliquid docs, "Tick and lot size").
 */

export const PERP_MAX_DECIMALS = 6;
export const SPOT_MAX_DECIMALS = 8;
export const MAX_PRICE_SIG_FIGS = 5;

export function decimalPlaces(value: Amount): number {
  const s = formatAmount(value);
  const dot = s.indexOf('.');
  return dot === -1 ? 0 : s.length - dot - 1;
}

/** Significant figures of a decimal string: leading zeros dropped, the canonical form has no trailing fraction zeros. */
export function significantFigures(value: Amount): number {
  const digits = formatAmount(value).replace('-', '').replace('.', '').replace(/^0+/, '');
  return digits.length;
}

export function toWire(value: Amount): string {
  return formatAmount(value);
}

/** `null` when the size is valid; otherwise why not. */
export function sizeProblem(size: Amount, szDecimals: number): string | null {
  if (compare(size, ZERO) <= 0) return 'the size must be positive';
  const dp = decimalPlaces(size);
  if (dp > szDecimals) return `size ${toWire(size)} has ${dp} decimal places; this market takes at most ${szDecimals}`;
  return null;
}

/** `null` when the price is valid; otherwise why not. */
export function priceProblem(price: Amount, szDecimals: number, kind: 'spot' | 'perpetual'): string | null {
  if (compare(price, ZERO) <= 0) return 'the price must be positive';
  const dp = decimalPlaces(price);
  if (dp === 0) return null;
  const maxDp = (kind === 'spot' ? SPOT_MAX_DECIMALS : PERP_MAX_DECIMALS) - szDecimals;
  if (dp > maxDp) return `price ${toWire(price)} has ${dp} decimal places; this market takes at most ${Math.max(maxDp, 0)}`;
  const sig = significantFigures(price);
  if (sig > MAX_PRICE_SIG_FIGS)
    return `price ${toWire(price)} has ${sig} significant figures; the venue takes at most ${MAX_PRICE_SIG_FIGS} (or a whole number)`;
  return null;
}

/** 10^-n as an Amount. */
export function unit(decimals: number): Amount {
  return parseAmount(decimals <= 0 ? '1' : `0.${'0'.repeat(decimals - 1)}1`);
}

const TEN = parseAmount('10');
const HUNDRED = parseAmount('100');
const TEN_THOUSAND = parseAmount('10000');

/**
 * Basis points (scaled) to Hyperliquid's builder `f`: an integer in tenths of a
 * basis point. `null` when the fee is finer than a tenth of a basis point.
 */
export function bpsToTenths(bps: Amount): number | null {
  const tenths = mul(bps, TEN);
  if (tenths % SCALE !== 0n) return null;
  const n = tenths / SCALE;
  if (n > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return Number(n);
}

/** Tenths of a basis point (the venue's integer) to scaled bps. Exact: 10 divides the scale. */
export function tenthsToBps(tenths: number): Amount {
  if (!Number.isSafeInteger(tenths) || tenths < 0) throw new Error(`a builder fee in tenths of a bp must be a whole number, got ${tenths}`);
  return (BigInt(tenths) * SCALE) / 10n;
}

/** Scaled bps to the percent string `approveBuilderFee` takes (`1` bp → `"0.01%"`). */
export function bpsToPercentString(bps: Amount): string {
  return `${formatAmount(div(bps, HUNDRED, 'floor'))}%`;
}

/** A venue fee rate given as a fraction (`"0.00035"`) to scaled bps (`3.5`). */
export function rateToBps(rate: string): Amount {
  return mul(parseAmount(rate), TEN_THOUSAND);
}
