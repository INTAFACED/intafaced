import { parseAmount } from '../../shared/money';

/** What the amount box holds, judged against what the person can use. Exact decimals only, nothing is rounded. */
export type AmountCheck = 'empty' | 'invalid' | 'zero' | 'tooMuch' | 'unknown' | 'ok';

/**
 * Judges the typed amount against the available balance (both exact decimal strings). It never turns either into a
 * floating-point number. When the balance is missing or unreadable the amount cannot be judged, so the answer is `unknown`,
 * never `ok`.
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
  if (available === null) return 'unknown';
  try {
    return value > parseAmount(available) ? 'tooMuch' : 'ok';
  } catch {
    return 'unknown';
  }
}

/** A long address as its first six and last four characters, so a row stays readable. Short ones are shown whole. */
export function shortenAddress(address: string): string {
  const clean = address.trim();
  return clean.length <= 14 ? clean : `${clean.slice(0, 6)}…${clean.slice(-4)}`;
}

/** What a saved address says about its cooling-off, from the two fields the bank returns. Nothing is worked out from a default. */
export type Cooling = { state: 'ends' | 'ended'; at: string } | { state: 'unset' };

/**
 * `coolingOffEndsAt` is the bank's own time. When it is null the bank has not published a cooling-off window
 * (`coolingBlocker` is set), so no end is shown and none is guessed. `now` is passed in so the answer is testable.
 */
export function coolingOf(row: { coolingOffEndsAt: string | null }, now: number): Cooling {
  const end = row.coolingOffEndsAt === null ? Number.NaN : Date.parse(row.coolingOffEndsAt);
  if (row.coolingOffEndsAt === null || !Number.isFinite(end)) return { state: 'unset' };
  return { state: end > now ? 'ends' : 'ended', at: row.coolingOffEndsAt };
}

/**
 * The checks the bank makes on a new address-book entry, made here first so a mistyped entry is refused with its reason
 * before any call. The bank sends to EVM addresses only today (0x and 40 hex digits; the checksum is not checked), on
 * a network its asset list names; it checks the same rules again.
 */
export type EntryCheck = 'ok' | 'empty' | 'invalid';
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f]/;
export function checkAddress(input: string): EntryCheck {
  const value = input.trim();
  if (!value) return 'empty';
  return EVM_ADDRESS.test(value) ? 'ok' : 'invalid';
}
/** A label is 1 to 64 characters with no spaces at either end and no control characters, as the bank stores it. */
export function checkLabel(input: string): EntryCheck {
  if (!input.trim()) return 'empty';
  return input.trim() === input && input.length <= 64 && !CONTROL.test(input) ? 'ok' : 'invalid';
}
/** A memo or tag is optional; when given it follows the label's rule. */
export function checkTag(input: string): EntryCheck {
  if (input === '') return 'ok';
  return input.trim() === input && input.length <= 64 && !CONTROL.test(input) ? 'ok' : 'invalid';
}
