import { z } from 'zod';
import {
  BANK_SCAM_TRANSFER_CALLERS,
  bankScamTransferInputSchema,
  bankScamTransferSchema,
  router,
  publicProcedure,
  serviceProcedureFor,
} from '@intafaced/contracts';
import { regionNotice } from './region-notice.js';

/**
 * `bank.safety.regionNotice` (BK-safe-01, J-bank-18 #1). Public and outside the jurisdiction gate on purpose: it is the
 * one bank read a person in a blocked region can make, and it only says why the other doors refuse. It reads the region
 * the edge stamped on the request, never one the caller names.
 */
export function createSafetyRouter(options: {
  blockedRegionNotice: () => string | undefined;
  /** Whether the person sent this posted transfer (`PersonalPayService.sentBy`). */
  transferSent: (userId: string, transferId: string) => Promise<boolean>;
  guard: <T>(fn: () => Promise<T>) => Promise<T>;
}) {
  return router({
    regionNotice: publicProcedure
      .output(
        z
          .object({
            region: z.string(),
            blocked: z.boolean(),
            code: z.string().nullable(),
            restriction: z.string().nullable(),
            blockedBy: z.string().nullable(),
            wording: z.string().nullable(),
          })
          .strict(),
      )
      .query(({ ctx }) =>
        regionNotice({ region: ctx.region, kycTier: ctx.principal?.tier ?? 'none', wording: options.blockedRegionNotice() }),
      ),

    /**
     * Did this person send this transfer? Asked by svc-support for a scam report (BK-safe-02, J-bank-18 #3). Service-only:
     * `serviceProcedureFor` proves the caller is svc-support before the input is parsed. One boolean, nothing else
     * (`bank-scam-transfer.ts`). A read; a POST only because the caller signs the body.
     */
    transferSent: serviceProcedureFor(BANK_SCAM_TRANSFER_CALLERS)
      .input(bankScamTransferInputSchema)
      .output(bankScamTransferSchema)
      .mutation(({ input }) => options.guard(async () => ({ sent: await options.transferSent(input.userId, input.transferId) }))),
  });
}
