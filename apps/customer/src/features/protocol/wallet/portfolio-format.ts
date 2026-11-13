import { formatUnits } from 'viem';
import { displayAmount } from '../../../shared/money';

/**
 * A USD decimal string from the service as dollars and cents, rounded half up to the cent: "1250.5" is "$1,250.50",
 * "-30" is "−$30.00". Exact decimal arithmetic on the string; never a JavaScript number.
 */
export function usdDisplay(text: string): string {
  const negative = text.startsWith('-');
  const [whole = '0', fraction = ''] = (negative ? text.slice(1) : text).split('.');
  const cents = BigInt(whole) * 100n + BigInt((fraction + '00').slice(0, 2)) + (Number(fraction[2] ?? '0') >= 5 ? 1n : 0n);
  const dollars = (cents / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const rest = (cents % 100n).toString().padStart(2, '0');
  return `${negative && cents > 0n ? '−' : ''}$${dollars}.${rest}`;
}

/** A base-unit amount as the token's own decimal, grouped, never rounded: 9850000001 at 6 decimals is "9,850.000001". */
export function tokenAmount(units: string, decimals: number): string {
  return displayAmount(formatUnits(BigInt(units), decimals));
}

/** A public address as 0x and 40 hex characters. */
export const ADDRESS_TEXT = /^0x[0-9a-fA-F]{40}$/;
