/**
 * Money arithmetic and display for the templates. Amounts stay decimal strings; sums are scaled bigint. No
 * parseFloat, Number() or toFixed() on an amount. The display here is a stand-in until B4's formatter in
 * `packages/i18n` lands; it groups digits and places the symbol, nothing else.
 */
import { decimalsOf, fromScaled, toScaled } from '../../components/amount-input-logic.js';
import type { DecimalString, Money } from './types.js';

const DECIMAL = /^-?\d+(\.\d+)?$/;

/** True for a canonical decimal string ("12", "-0.50"). */
export function isDecimal(value: unknown): value is DecimalString {
  return typeof value === 'string' && DECIMAL.test(value);
}

function assertDecimal(value: unknown): asserts value is DecimalString {
  if (!isDecimal(value)) throw new TypeError(`Not a decimal string: ${String(value)}`);
}

/** Sum of decimal strings, exact, at the largest scale among them. */
export function sumDecimals(values: readonly DecimalString[]): DecimalString {
  values.forEach(assertDecimal);
  const scale = Math.max(0, ...values.map(decimalsOf));
  return fromScaled(
    values.reduce((acc, v) => acc + toScaled(v, scale), 0n),
    scale,
  );
}

/** a - b, exact. */
export function subtractDecimals(a: DecimalString, b: DecimalString): DecimalString {
  assertDecimal(a);
  assertDecimal(b);
  const scale = Math.max(decimalsOf(a), decimalsOf(b));
  return fromScaled(toScaled(a, scale) - toScaled(b, scale), scale);
}

function compare(a: DecimalString, b: DecimalString): number {
  const scale = Math.max(decimalsOf(a), decimalsOf(b));
  const d = toScaled(a, scale) - toScaled(b, scale);
  return d === 0n ? 0 : d > 0n ? 1 : -1;
}

export interface Part {
  label: string;
  value: DecimalString;
}

export type Reconciled =
  { ok: true; parts: readonly Part[] } | { ok: false; reason: 'parts-exceed-total' | 'negative-part' | 'mixed-assets' };

/**
 * A chart's parts must add up to the total it shows. Parts short of the total gain an "other"
 * part for the difference; parts over the total, or a negative part, can't be drawn honestly and are refused.
 */
export function reconcileParts(total: DecimalString, parts: readonly Part[], otherLabel = 'Other'): Reconciled {
  assertDecimal(total);
  if (parts.some((p) => compare(p.value, '0') < 0)) return { ok: false, reason: 'negative-part' };
  const sum = sumDecimals(parts.map((p) => p.value));
  const c = compare(sum, total);
  if (c > 0) return { ok: false, reason: 'parts-exceed-total' };
  if (c === 0) return { ok: true, parts };
  return { ok: true, parts: [...parts, { label: otherLabel, value: subtractDecimals(total, sum) }] };
}

/** Sum of Money in one asset; refuses to add different assets. */
export function sumMoney(items: readonly Money[]): Money | null {
  if (items.length === 0) return null;
  const asset = items[0]!.asset;
  if (items.some((m) => m.asset !== asset)) return null;
  return { value: sumDecimals(items.map((m) => m.value)), asset, test: items.some((m) => m.test) };
}

const SYMBOL: Readonly<Record<string, string>> = { GBP: '£', EUR: '€', USD: '$' };

/** Groups the integer part in threes. The decimals are shown exactly as given (the API sets precision). */
function group(int: string, separator: string): string {
  return int.replace(/\B(?=(\d{3})+(?!\d))/g, separator);
}

/** "1234.5" GBP -> "£1,234.5"; "0.25" BTC -> "0.25 BTC". A minus sign leads ("−£50.00"). */
export function formatMoney(money: Money, opts: { signed?: boolean } = {}): string {
  assertDecimal(money.value);
  const negative = money.value.startsWith('-');
  const [int = '0', frac] = (negative ? money.value.slice(1) : money.value).split('.');
  const digits = `${group(int, ',')}${frac !== undefined ? `.${frac}` : ''}`;
  const sign = negative ? '−' : opts.signed && compare(money.value, '0') > 0 ? '+' : '';
  const symbol = SYMBOL[money.asset];
  return symbol ? `${sign}${symbol}${digits}` : `${sign}${digits} ${money.asset}`;
}
