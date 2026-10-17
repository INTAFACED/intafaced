/**
 * Decimal-string arithmetic for registry limits. Money never sits in a `number`:
 * amounts are unsigned decimal strings with at most 18 places (the same shape as
 * the wire contract) and are compared as scaled bigints.
 */
const SCALE = 18;
export const DECIMAL_RE = /^\d+(\.\d{1,18})?$/;

export function toScaled(value: string): bigint {
  if (!DECIMAL_RE.test(value)) throw new Error(`not an unsigned decimal string: ${value}`);
  const [whole, frac = ''] = value.split('.');
  return BigInt(whole!) * 10n ** BigInt(SCALE) + BigInt(frac.padEnd(SCALE, '0'));
}

/** Canonical text: no leading zeros, no trailing fractional zeros. */
export function canonicalDecimal(value: string): string {
  const scaled = toScaled(value);
  const whole = scaled / 10n ** BigInt(SCALE);
  const frac = (scaled % 10n ** BigInt(SCALE)).toString().padStart(SCALE, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : `${whole}`;
}

export function compareDecimal(a: string, b: string): -1 | 0 | 1 {
  const x = toScaled(a);
  const y = toScaled(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

export const isPositiveDecimal = (value: string): boolean => toScaled(value) > 0n;
