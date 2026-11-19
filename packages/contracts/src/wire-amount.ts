/**
 * An amount as a service answers it: an exact decimal string the ledger's column holds (numeric(38,18)). The rule is
 * `parseAmount`'s in `@intafaced/ledger-client/money`: surrounding spaces are dropped, an optional minus, digits, and at
 * most 18 places after the point; its magnitude fits the column. The schema checks and keeps the string as it came.
 *
 * Browser-safe (zod only), so a reply schema here is the one the service's callers read. `apps/customer`'s
 * `decimalSchema` and `signedDecimalSchema` are these two, and its `shared/money.test.ts` holds them to `parseAmount`.
 */
import { z } from 'zod';

const AMOUNT = /^(-)?(\d+)(?:\.(\d+))?$/;
const PLACES = 18;
/** 20 nines before the point and 18 after, in units of 10^-18: `MAX_AMOUNT` in ledger-client. */
const MAX_SCALED = 10n ** 38n - 1n;

/** The amount's scaled value, or null when `parseAmount` would refuse it. */
function scaled(value: string): bigint | null {
  const m = AMOUNT.exec(value.trim());
  if (!m) return null;
  const [, sign, whole = '0', frac = ''] = m;
  if (frac.length > PLACES) return null;
  const magnitude = BigInt(whole) * 10n ** BigInt(PLACES) + BigInt(frac.padEnd(PLACES, '0') || '0');
  if (magnitude > MAX_SCALED) return null;
  return sign === '-' ? -magnitude : magnitude;
}

/** An amount of zero or more ("-0" is zero). */
export const unsignedAmountSchema = z.string().refine(
  (value) => {
    const v = scaled(value);
    return v !== null && v >= 0n;
  },
  { error: 'Expected an unsigned exact decimal string', abort: true },
);

/** An amount that may be below zero: a profit, a change. */
export const signedAmountSchema = z.string().refine((value) => scaled(value) !== null, {
  error: 'Expected an exact decimal string',
  abort: true,
});
