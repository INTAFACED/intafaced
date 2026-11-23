import { QUANT_QUOTA_RESOURCES } from '@intafaced/contracts/quant-algo';
import { router } from '@intafaced/contracts/trpc';
import { toTrpc, type QuantCore, quantRefusal } from './core.js';
import { QUANT_TIER_LIST } from '@intafaced/contracts/quant-tier-procedures';
import { mountRecord } from '@intafaced/contracts/procedure-mount';

export function tierRoutes(core: QuantCore) {
  const { quota, accountOf } = core;
  return router({
    /**
     * The published compute tiers (RC-algo-dev-05): each tier's data freshness, priority class and the limits of its
     * profile, blank values null ("not set"), and the profile that applies to the caller. None published: an empty list.
     */
    list: mountRecord(
      QUANT_TIER_LIST,
      async ({ input, ctx }) => {
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
      },
      quantRefusal,
    ),
  });
}
