import type { Sql } from 'postgres';
import { z } from 'zod';
import { ownAgentUsageLimitsInputSchema, ownAgentUsageLimitsSchema, router, scopedProcedure, TRPCError } from '@intafaced/contracts';
import { assertPersonSetsLimits } from '../spend/routes.js';
import { OwnAgentRefusal } from './catalog.js';
import type { OwnRunDeps } from './routes.js';
import { OwnUsageLimitsStore } from './usage-limits.js';

async function guard<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (!(err instanceof OwnAgentRefusal)) throw err;
    throw new TRPCError({ code: err.code === 'agents.own.not_found' ? 'NOT_FOUND' : 'BAD_REQUEST', message: err.code, cause: err });
  }
}

function depsOf(sql: Sql | undefined, run: OwnRunDeps | undefined): { sql: Sql; run: OwnRunDeps } {
  if (!sql || !run) throw new TRPCError({ code: 'SERVICE_UNAVAILABLE', message: 'agents.capability_unavailable' });
  return { sql, run };
}

/**
 * `own.usageLimits`: the soft alert and the monthly hard limit a person sets for one of their own agents (J-agents-02).
 * Reading them also publishes any of the person's alerts a fault left unpublished, so an alert recorded with a charge
 * reaches the bus without a timer.
 */
export function ownUsageLimitsRouter(sql: Sql | undefined, run: OwnRunDeps | undefined) {
  return router({
    get: scopedProcedure('agents:read', { module: 'agents', person: true })
      .input(z.object({ id: z.string().min(1).max(64) }))
      .output(ownAgentUsageLimitsSchema)
      .query(async ({ ctx, input }) => {
        assertPersonSetsLimits(ctx.principal);
        const deps = depsOf(sql, run);
        await deps.run.runtime.publishUsageAlerts(ctx.principal.userId).catch(() => undefined);
        const view = await guard(() => new OwnUsageLimitsStore(deps.sql).get(ctx.principal.userId, input.id));
        return { ...view, assetId: deps.run.feeAssetId };
      }),

    /** Blank clears one. The alert must sit below the hard limit; a bad amount refuses `agents.usage.limit_invalid`. */
    set: scopedProcedure('agents:read', { module: 'agents', person: true })
      .input(ownAgentUsageLimitsInputSchema)
      .output(ownAgentUsageLimitsSchema)
      .mutation(async ({ ctx, input }) => {
        assertPersonSetsLimits(ctx.principal);
        const deps = depsOf(sql, run);
        const { id, ...limits } = input;
        const view = await guard(() =>
          new OwnUsageLimitsStore(deps.sql).set(ctx.principal.userId, id, { ...limits, assetId: deps.run.feeAssetId }),
        );
        return { ...view, assetId: deps.run.feeAssetId };
      }),
  });
}
