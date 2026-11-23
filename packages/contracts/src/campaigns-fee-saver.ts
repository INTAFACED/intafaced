import { z } from 'zod';
import { id } from './campaigns-base.js';

// ── Fee-saver coupons at order time (CM-vouchers-coupons-02, J-campaigns-09 #2 #3) ────────────────────────────────────

/** The only service that asks for a fee-saver coupon: svc-trade, when it prices our builder fee on a venue order. */
export const FEE_SAVER_CALLERS = ['svc-trade'] as const;

/**
 * svc-trade asks for the caller's best fee-saver coupon on one order, by the order's own business key. `quote` names the
 * coupon that would be taken and writes nothing (the review sheet); `take` takes one use of it for this order, once: the
 * same order key again returns the same use, never a second; `read` returns the use already taken for this order, or
 * null (a replayed prepare). Campaigns posts nothing for a discount (ENGINE VC-9): svc-trade signs the lower builder fee
 * into the order and the venue charges it.
 */
export const feeSaverAskInputSchema = z
  .object({
    accountId: z.string().uuid(),
    orderKey: z.string().min(3).max(200),
    mode: z.enum(['quote', 'take', 'read']),
  })
  .strict();
export type FeeSaverAskInput = z.infer<typeof feeSaverAskInputSchema>;

export const feeSaverAnswerSchema = z.object({
  coupon: z
    .object({
      voucherId: id,
      code: z.string(),
      discountBps: z.number().int().min(1).max(10_000),
      /** The n-th order this coupon was taken on; null for a quote. */
      sequence: z.number().int().positive().nullable(),
    })
    .nullable(),
});
export type FeeSaverAnswer = z.infer<typeof feeSaverAnswerSchema>;
