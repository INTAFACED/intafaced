import { QUANT_QUOTA_RESOURCES, publicJurisdictionProcedure, quantTierListSchema, router } from '@intafaced/contracts';
import { z } from 'zod';
import { toTrpc, accountField, type QuantCore } from './core.js';

export function tierRoutes(core: QuantCore) {
  const { quota, accountOf } = core;
  return router({
    /**
     * The published compute tiers (RC-algo-dev-05): each tier's data freshness, priority class and the limits of its
     * profile, blank values null ("not set"), and the profile that applies to the caller. None published: an empty list.
     */
    list: publicJurisdictionProcedure('quant', 'fiat')
      .input(z.object({ ...accountField }).optional())
      .output(quantTierListSchema)
      .query(async ({ input, ctx }) => {
        try {
          const accountId = accountOf(ctx, input?.accountId);
          const [applied, published] = await Promise.all([quota.applied(accountId), quota.tiers()]);
          const tiers = await Promise.all(
            published.map(async (tier) => {
              const rows = await quota.limits(tier.profile);
              return {
                profile: tier.profile,
                dataFreshnessSeconds: tier.dataFreshnessSeconds?.toString() ?? null,
                priorityClass: tier.priorityClass?.toString() ?? null,
                limits: QUANT_QUOTA_RESOURCES.map((resource) => {
                  const limit = rows.find((row) => row.resource === resource)?.limit ?? null;
                  return { resource, limit: limit === null ? null : limit.toString() };
                }),
                setAt: tier.setAt,
              };
            }),
          );
          return { current: applied ? { profile: applied.name, source: applied.source } : null, tiers };
        } catch (err) {
          toTrpc(err);
        }
      }),
  });
}
