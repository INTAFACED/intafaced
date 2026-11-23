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
/** numeric(38,18) holds 20 digits before the point: the whole part stays below 10^20. */
const WHOLE_LIMIT = 10n ** 20n;

/** How `parseAmount` reads the string: refused (null), or whether it is below zero. */
function readAmount(value: string): { negative: boolean } | null {
  const m = AMOUNT.exec(value.trim());
  if (!m) return null;
  const [, sign, whole = '0', frac = ''] = m;
  if (frac.length > PLACES || BigInt(whole) >= WHOLE_LIMIT) return null;
  return { negative: sign === '-' && /[1-9]/.test(whole + frac) };
}

/** An amount of zero or more ("-0" is zero). */
export const unsignedAmountSchema = z.string().refine(
  (value) => {
    const read = readAmount(value);
    return read !== null && !read.negative;
  },
  { error: 'Expected an unsigned exact decimal string', abort: true },
);

/** An amount that may be below zero: a profit, a change. */
export const signedAmountSchema = z.string().refine((value) => readAmount(value) !== null, {
  error: 'Expected an exact decimal string',
  abort: true,
});
