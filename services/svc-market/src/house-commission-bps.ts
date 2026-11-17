import { z } from 'zod';

/**
 * House commission bps from env. Blank / whitespace is unset — never 0.
 * Explicit `"0"` is an owner rate, not silence. `z.coerce.number()` would turn `" "` into 0.
 */
export const marketHouseCommissionBpsSchema = z.preprocess((v) => {
  if (v === undefined || v === null) return undefined;
  if (typeof v === 'string' && v.trim() === '') return undefined;
  return v;
}, z.coerce.number().int().min(0).max(9_999).optional());
