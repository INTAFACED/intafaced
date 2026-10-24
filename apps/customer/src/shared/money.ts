import { z } from 'zod';
import { parseAmount, formatAmount } from '@intafaced/money-math';

export const decimalSchema = z.string().refine(
  (value) => {
    try {
      return parseAmount(value) >= 0n;
    } catch {
      return false;
    }
  },
  { error: 'Expected an unsigned exact decimal string', abort: true },
);
export const signedDecimalSchema = z.string().refine(
  (value) => {
    try {
      parseAmount(value);
      return true;
    } catch {
      return false;
    }
  },
  { error: 'Expected an exact decimal string', abort: true },
);
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
