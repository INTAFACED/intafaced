import { QUANT_SANDBOX_LIMITS } from '@intafaced/contracts/quant-algo';
import { router } from '@intafaced/contracts/trpc';
import { toTrpc, type QuantCore, quantRefusal } from './core.js';
import { QUANT_LIMITS_GET } from '@intafaced/contracts/quant-limits-procedures';
import { mountRecord } from '@intafaced/contracts/procedure-mount';

export function limitsRoutes(core: QuantCore) {
  const { deps, quota, accountOf } = core;
  return router({
    /**
     * Every limit the caller's runs meet (J-algo-dev-12 #4), as the sandbox will apply it: the applied plan's sandbox
     * limits (null: not set, and then no run starts) and the two ceilings every plan shares.
     */
    get: mountRecord(
      QUANT_LIMITS_GET,
      async ({ input, ctx }) => {
        try {
          const accountId = accountOf(ctx, input?.accountId);
          const applied = await quota.applied(accountId);
          const rows = applied ? await quota.sandboxLimits(applied.name) : [];
          const ceiling = (value: number | undefined) => (typeof value === 'number' && Number.isInteger(value) ? String(value) : null);
          return {
            profile: applied?.name ?? null,
            source: applied?.source ?? null,
            sandbox: QUANT_SANDBOX_LIMITS.map((limit) => {
              const value = rows.find((row) => row.limit === limit)?.value ?? null;
              return { limit, value: value === null ? null : value.toString() };
            }),
            ceilings: { maxOps: ceiling(deps.limits.maxOps), maxSource: ceiling(deps.limits.maxSource) },
            asOf: new Date().toISOString(),
          };
        } catch (err) {
          toTrpc(err);
        }
      },
      quantRefusal,
    ),
  });
}
