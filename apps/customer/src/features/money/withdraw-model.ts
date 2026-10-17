import { parseAmount } from '../../shared/money';

/** What the amount box holds, judged against what the person can use. Exact decimals only, nothing is rounded. */
export type AmountCheck = 'empty' | 'invalid' | 'zero' | 'tooMuch' | 'ok';

/**
 * Judges the typed amount against the available balance (both exact decimal strings). It never turns either into a
 * floating-point number. An unknown balance cannot be exceeded, so the check says `ok` for any positive amount then.
 */
export function checkAmount(input: string, available: string | null): AmountCheck {
  const typed = input.trim();
  if (!typed) return 'empty';
  let value: bigint;
  try {
    if (!/^\d+(\.\d+)?$/.test(typed)) return 'invalid';
    value = parseAmount(typed);
  } catch {
    return 'invalid';
  }
  if (value <= 0n) return 'zero';
  if (available === null) return 'ok';
  try {
    return value > parseAmount(available) ? 'tooMuch' : 'ok';
  } catch {
    return 'ok';
  }
}

/** A long address as its first six and last four characters, so a row stays readable. Short ones are shown whole. */
export function shortenAddress(address: string): string {
  const clean = address.trim();
  return clean.length <= 14 ? clean : `${clean.slice(0, 6)}…${clean.slice(-4)}`;
}

/** One saved address as the address book would return it. No read for it exists yet, so the page passes none. */
export interface SavedAddress {
  id: string;
  label: string;
  asset: string;
  network: string;
  address: string;
}
