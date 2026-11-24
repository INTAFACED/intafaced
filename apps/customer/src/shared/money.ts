import { parseAmount, formatAmount } from '@intafaced/money-math';

/** A service's amount: the one wire schema in `@intafaced/contracts/wire-amount`, held to `parseAmount` by money.test.ts. */
export { unsignedAmountSchema as decimalSchema, signedAmountSchema as signedDecimalSchema } from '@intafaced/contracts/wire-amount';
export { parseAmount, formatAmount };

export function displayAmount(value: string | null | undefined, places?: number): string {
  if (value === undefined || value === null) return '—';
  parseAmount(value);
  const [whole = '0', fraction = ''] = value.split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  if (places === undefined) return fraction ? `${grouped}.${fraction}` : grouped;
  // Never silently round away a nonzero exact quantity to make it fit.
  const remainder = fraction.slice(places);
  if (/[1-9]/.test(remainder)) return `${grouped}.${fraction}`;
  return places ? `${grouped}.${fraction.slice(0, places).padEnd(places, '0')}` : grouped;
}
