import { z } from 'zod';
import { router, publicProcedure } from '@intafaced/contracts';
import { regionNotice } from './region-notice.js';

/**
 * `bank.safety.regionNotice` (BK-safe-01, J-bank-18 #1). Public and outside the jurisdiction gate on purpose: it is the
 * one bank read a person in a blocked region can make, and it only says why the other doors refuse. It reads the region
 * the edge stamped on the request, never one the caller names.
 */
export function createSafetyRouter(options: { blockedRegionNotice: () => string | undefined }) {
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
  });
}
