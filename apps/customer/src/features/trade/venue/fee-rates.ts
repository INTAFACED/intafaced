/**
 * A venue fee rate as the person reads it (J-cex-spot-10): a rate in bps (the venue's decimal string, as "3.5" or "-1")
 * written as an exact percent, a zero rate as "Zero fee", and a rate below zero as the venue's rebate, never a negative
 * fee. No float touches the rate: the decimal point moves two places in the string.
 */

/** "3.5" → "0.035", "100" → "1", "-1" → "-0.01": bps over 100, exact, trailing zeros dropped. */
export function bpsToPercent(bps: string): string {
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(bps.trim());
  if (!m) throw new Error(`not a rate in bps: ${bps}`);
  const [, sign, whole, frac = ''] = m;
  const digits = `${whole!.padStart(3, '0')}${frac}`;
  const point = digits.length - frac.length - 2;
  const int = digits.slice(0, point).replace(/^0+(?=\d)/, '');
  const dec = digits.slice(point).replace(/0+$/, '');
  const text = dec ? `${int}.${dec}` : int;
  return text === '0' ? '0' : `${sign}${text}`;
}

export type RateShown =
  { readonly kind: 'zero' } | { readonly kind: 'rebate'; readonly value: string } | { readonly kind: 'fee'; readonly value: string };

/** How a published rate reads: zero, the venue's rebate (its size, unsigned), or a fee. */
export function rateShown(bps: string): RateShown {
  const pct = bpsToPercent(bps);
  if (pct === '0') return { kind: 'zero' };
  return pct.startsWith('-') ? { kind: 'rebate', value: pct.slice(1) } : { kind: 'fee', value: pct };
}

/** A fill's fee amount as the venue charged it: zero, a rebate paid to the person (its size, unsigned), or a fee. */
export function feeShown(amount: string): RateShown {
  const t = amount.trim();
  if (/^-?0*(\.0*)?$/.test(t)) return { kind: 'zero' };
  return t.startsWith('-') ? { kind: 'rebate', value: t.slice(1) } : { kind: 'fee', value: t };
}
