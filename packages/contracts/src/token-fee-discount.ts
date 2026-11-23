/**
 * svc-token's fee discount, as a trader's screen reads it (J-cex-spot-10 #9): the person's stake and its discount
 * (`accessOf`), and the owner's published decay ladder (`feeDiscount.get`). Browser-safe (zod only).
 */
import { z } from 'zod';
import { unsignedAmountSchema } from './wire-amount.js';

/** `accessOf`: the person's stake and the discount it earns, in basis points. */
export const tokenAccessSchema = z.object({ staked: unsignedAmountSchema, feeDiscountBps: z.number().int().min(0).max(9999) });

/** `feeDiscount.get`: the decay ladder, or null while the owner has not published it. */
export const feeDiscountLadderSchema = z.object({
  schedule: z
    .object({ tiers: z.array(z.object({ minStake: unsignedAmountSchema, discountBps: z.number().int().min(0).max(9999) })) })
    .nullable(),
});
