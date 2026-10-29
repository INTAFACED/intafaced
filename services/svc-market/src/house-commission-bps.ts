import { z } from 'zod';

/**
 * House commission bps from env. Blank / whitespace is unset — never 0.
 * Explicit `"0"` is the owner free-cut. `z.coerce.number()` would turn `" "` into 0.
 */
export const marketHouseCommissionBpsSchema = z.preprocess((v) => {
  if (v === undefined || v === null) return undefined;
  if (typeof v === 'string' && v.trim() === '') return undefined;
  return v;
}, z.coerce.number().int().min(0).max(9_999).optional());

/**
 * The owner's refund window in whole seconds (J-more-catalogue-02 #4 to #6). NO DEFAULT. Blank / whitespace is unset:
 * a purchase is a direct sale as before, and a refund ask refuses `market.refund_policy_unset`. Never invent a window.
 * The upper bound is one year, a sanity bound on a typed value, not a policy.
 */
export const marketRefundWindowSecondsSchema = z.preprocess((v) => {
  if (v === undefined || v === null) return undefined;
  if (typeof v === 'string' && v.trim() === '') return undefined;
  return v;
}, z.coerce.number().int().min(1).max(31_536_000).optional());
