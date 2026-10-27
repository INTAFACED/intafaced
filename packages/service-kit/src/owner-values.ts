/**
 * Owner values: the prices, limits, caps and settings only the owner sets.
 *
 * A blank one stays blank. The env reads `''` as unset (never as zero), and the code path that needs it refuses with a
 * typed `<area>.<what>_unset` code before anything is written. The local test stack gives each one a labelled TEST
 * value in `tooling/profiles/test-owner-values/<service>.json`; production stays blank until the owner sets it.
 *
 *     SUPPORT_FORM_CAP: blankAsUnset(z.coerce.number().int().min(0)),
 *     const cap = requireSetting(env.SUPPORT_FORM_CAP, forms, 'support.form_cap_unset');
 */
import { z } from 'zod';
import type { RefusalDetails, Refusals } from './refusals.js';

/** An env value where blank (or only spaces) reads as unset; the inner schema never sees `''`. */
export function blankAsUnset<T extends z.ZodType>(schema: T) {
  return z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : v), schema.optional());
}

/**
 * The owner's value, or the family's refusal when it is unset. `null` and `undefined` are unset; `0` and `''` are
 * values the caller already parsed and are returned as they are.
 */
export function requireSetting<T, C extends string>(
  value: T | null | undefined,
  refusals: Refusals<C>,
  code: C,
  message?: string,
  details?: RefusalDetails,
): T {
  if (value === null || value === undefined) refusals.refuse(code, message ?? `${code}: the owner has not set this value`, details);
  return value;
}

/**
 * A row the caller may act on: it exists and the caller owns it. Someone else's row refuses with the same code as a
 * missing one, so a caller cannot learn which ids exist.
 */
export function requireOwned<R, C extends string>(
  row: R | null | undefined,
  ownerOf: (row: R) => string,
  caller: { readonly userId: string },
  refusals: Refusals<C>,
  notFound: C,
): R {
  if (row === null || row === undefined || ownerOf(row) !== caller.userId) refusals.refuse(notFound);
  return row;
}
