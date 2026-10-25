import { z } from 'zod';
import { UNRESOLVED_REGION, isRegionResolved } from '@intafaced/config';
import { router, scopedProcedure } from '@intafaced/contracts';
import { kycLevelsDescribeOutputSchema } from '@intafaced/contracts/identity-kyc-levels';
import type { KycTier } from '@intafaced/config';
import { describeLevels, type KycLadderSettings } from './levels.js';

/**
 * `kyc.levels.describe` (I-kyc-compliance-04/05): the caller's own ladder. The held level is `kycTier`, the function the
 * token issuer and `kyc.status` use, so the ladder and the status above it agree. A session signed before an approval or
 * an expiry still carries its old level until it refreshes; the features listed per level do not depend on it. No input:
 * a caller reads only their own ladder, for the region the edge stamped on this request (blank reads as unresolved).
 */
export function createKycLevelsRouter(deps: { kycTier: (userId: string) => Promise<KycTier>; settings: KycLadderSettings }) {
  return router({
    describe: scopedProcedure('identity:read')
      .input(z.object({}).strict().optional())
      .output(kycLevelsDescribeOutputSchema)
      .query(async ({ ctx }) => {
        const region = ctx.region?.trim() || UNRESOLVED_REGION;
        return describeLevels({
          held: await deps.kycTier(ctx.principal.userId),
          region,
          regionResolved: isRegionResolved(region),
          settings: deps.settings,
        });
      }),
  });
}
