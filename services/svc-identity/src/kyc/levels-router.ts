import { z } from 'zod';
import { isRegionResolved } from '@intafaced/config';
import { router, scopedProcedure } from '@intafaced/contracts';
import { kycLevelsDescribeOutputSchema } from '@intafaced/contracts/identity-kyc-levels';
import type { KycTier } from '@intafaced/config';
import { describeLevels, type KycLadderSettings } from './levels.js';

/**
 * `kyc.levels.describe` (I-kyc-compliance-04/05): the caller's own ladder. The held level comes from the same function
 * the token issuer uses (`kycTier`), so the page and the token never disagree about where the caller stands. No input:
 * a caller reads only their own ladder, for the region the edge stamped on this request.
 */
export function createKycLevelsRouter(deps: { kycTier: (userId: string) => Promise<KycTier>; settings: KycLadderSettings }) {
  return router({
    describe: scopedProcedure('identity:read')
      .input(z.object({}).strict().optional())
      .output(kycLevelsDescribeOutputSchema)
      .query(async ({ ctx }) =>
        describeLevels({
          held: await deps.kycTier(ctx.principal.userId),
          region: ctx.region,
          regionResolved: isRegionResolved(ctx.region),
          settings: deps.settings,
        }),
      ),
  });
}
