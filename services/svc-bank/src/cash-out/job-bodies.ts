import { z } from 'zod';
import { PAYOUT_FAILURES, PAYOUT_RETURNS } from './payout-sim.js';

/** The banking partner's job bodies (`/internal/jobs/payout-sim/*`). Ids are the bank's own; the partner names none. */
export const payoutVerifyBody = z.object({ accountId: z.string().uuid() }).strict();

export const payoutPaidBody = z.object({ cashOutId: z.string().uuid() }).strict();

export const payoutFailedBody = z.object({ cashOutId: z.string().uuid(), reason: z.enum(PAYOUT_FAILURES) }).strict();

export const payoutReturnedBody = z
  .object({
    cashOutId: z.string().uuid(),
    /** What came back, in the asset that left (the partner converts back at its own rate). */
    amount: z.string().regex(/^\d+(\.\d{1,18})?$/),
    assetId: z.string().regex(/^[A-Z0-9]{1,16}$/),
    reason: z.enum(PAYOUT_RETURNS),
  })
  .strict();

/** The batch is the caller's to name: an omitted one refuses, never a borrowed default. */
export const redriveBody = z.object({ limit: z.number().int().min(1).max(1000) }).strict();
