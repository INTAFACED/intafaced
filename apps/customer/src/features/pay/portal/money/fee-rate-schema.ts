import { z } from 'zod';

// Mirrors packages/contracts/src/merchant-portal.ts `merchantEffectiveRateSchema` (#4919): fees ÷ gross for one asset over
// the requested window, rounded down to 6 decimal places by the service. Parsed tolerantly: unknown keys are ignored.
const signed = z.string().regex(/^-?\d+(\.\d{1,18})?$/);

export const effectiveRateSchema = z.object({
  assetCode: z.string().min(1).max(16),
  fees: signed,
  gross: signed,
  /** A fraction ("0.015" is 1.5%), at most 6 decimal places; null unless the status is exact or rounded. */
  rate: z
    .string()
    .regex(/^\d+(\.\d{1,6})?$/)
    .nullable(),
  /** exact lost nothing, rounded did, no_volume is a zero gross (not a rate of 0), refused is a negative input. */
  rateStatus: z.enum(['exact', 'rounded', 'no_volume', 'refused']),
});
export type EffectiveRate = z.infer<typeof effectiveRateSchema>;

/** The part of `merchantAnalytics.fees` this read uses. Older services do not send `rates`. */
export const feeRatesReadSchema = z.object({ rates: z.array(effectiveRateSchema).optional() });
