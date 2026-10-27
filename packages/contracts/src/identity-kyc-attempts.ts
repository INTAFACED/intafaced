import { z } from 'zod';

/**
 * svc-identity `kyc.attempts.read` (I-kyc-compliance-10): where the caller stands against the owner's limit on rejected
 * verification requests. `limit` is null when the owner set none, and the page says no limit is set. At the cap a new
 * request is refused `kyc.attempts_exhausted` with `retryAfterSeconds`, and `lockedUntil` says when it opens again.
 */
export const kycAttemptsSchema = z.object({
  limit: z
    .object({
      maxDenials: z.number().int().min(1),
      windowHours: z.number().int().min(1),
      lockoutHours: z.number().int().min(1),
    })
    .nullable(),
  /** Rejected requests inside the window; null when no limit is set. */
  denialsInWindow: z.number().int().min(0).nullable(),
  lockedUntil: z.string().datetime({ offset: true }).nullable(),
});
export type KycAttempts = z.infer<typeof kycAttemptsSchema>;
