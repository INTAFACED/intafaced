import { QUANT_QUOTA_RESOURCES, publicJurisdictionProcedure, quantQuotaSchema, router } from '@intafaced/contracts';
import { z } from 'zod';
import { toTrpc, accountField, type QuantCore } from './core.js';

export function quotaRoutes(core: QuantCore) {
  const { quota, accountOf, team } = core;
  return router({
    /**
     * The caller's plan (AL-limits-01): the profile that applies, and each resource's usage, counted from the stored
     * rows, against its limit. A blank limit reads null and the screen says "not set"; with no profile, every limit does.
     */
    get: publicJurisdictionProcedure('quant', 'fiat')
      .input(z.object({ ...accountField }).optional())
      .output(quantQuotaSchema)
      .query(async ({ input, ctx }) => {
        try {
          const accountId = accountOf(ctx, input?.accountId);
          const [applied, counts, collaborators] = await Promise.all([
            quota.applied(accountId),
            quota.counts(accountId),
            team.mostCollaborators(accountId),
          ]);
          const limits = applied ? await quota.limits(applied.name) : [];
          const used: Record<(typeof QUANT_QUOTA_RESOURCES)[number], bigint> = {
            strategies: counts.strategies,
            versions: counts.mostVersions,
            concurrent_runs: counts.running,
            paper_runs: counts.paperRuns,
            runs: counts.runs,
            // Nothing stores these yet: no log line is kept apart from its run's result and no notice is sent, so the
            // stored count is zero. Collaborators: the most any one of the account's strategies has.
            log_lines: 0n,
            storage: counts.storage,
            collaborators,
            notifications: 0n,
          };
          return {
            profile: applied?.name ?? null,
            source: applied?.source ?? null,
            resources: QUANT_QUOTA_RESOURCES.map((resource) => {
              const limit = limits.find((row) => row.resource === resource)?.limit ?? null;
              return { resource, used: used[resource].toString(), limit: limit === null ? null : limit.toString() };
            }),
            asOf: new Date().toISOString(),
          };
        } catch (err) {
          toTrpc(err);
        }
      }),
  });
}
