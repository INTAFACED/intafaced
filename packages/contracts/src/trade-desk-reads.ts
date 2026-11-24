/**
 * svc-trade's public REST reads a trading desk shows (`/api/v1/...`), as the screen reads them. Browser-safe (zod only).
 */
import { z } from 'zod';
import { unsignedAmountSchema } from './wire-amount.js';

/** The owner's terms for paying a spot fee in the platform token: which token, and one unit of each fee asset in it. */
export const feeTokenTermsSchema = z.object({
  asset: z.string().min(1),
  perUnit: z.record(z.string(), unsignedAmountSchema),
});
/** `GET /fees/published`, read for its fee-token terms only. */
export const publishedFeeTokenSchema = z.object({ feeToken: feeTokenTermsSchema.nullable().optional() });

/** `GET /market-lifecycle/:symbol`: the market's lifecycle state. */
export const marketLifecycleSchema = z
  .object({ state: z.string(), effectiveAt: z.string().nullish(), evidenceRefs: z.array(z.string()).nullish() })
  .passthrough();
/** `GET /market-halt/:symbol`: whether the book or the venue is halted. */
export const marketHaltSchema = z
  .object({
    halted: z.boolean(),
    venueHalted: z.boolean(),
    // Informational: a time that is missing or not an ISO string reads as unknown, never as an unreadable halt.
    haltedSince: z.unknown().optional(),
    venueHaltedSince: z.unknown().optional(),
  })
  .passthrough();
/** `GET /trades/:symbol`: the tape, read for each trade's time only. */
export const tradeTapeTimesSchema = z.array(z.object({ timestamp: z.number() }).passthrough());
