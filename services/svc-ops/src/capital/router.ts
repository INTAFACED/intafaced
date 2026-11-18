import { TRPCError } from '@trpc/server';
import {
  opsCapitalScenarioInputSchema,
  opsCapitalScenarioSchema,
  opsCapitalSnapshotSchema,
  opsCapitalThresholdSetInputSchema,
  opsCapitalThresholdSetOutputSchema,
  router,
  scopedProcedure,
} from '@intafaced/contracts';
import { OPS_IDEMPOTENCY_CONFLICT, OpsError } from '../codes.js';
import type { CapitalDesk } from './desk.js';

const guards = { module: 'core-ops' as const, plane: 'fiat' as const };

function deskError(err: unknown): never {
  if (err instanceof OpsError) {
    const code = err.code === OPS_IDEMPOTENCY_CONFLICT ? 'CONFLICT' : 'PRECONDITION_FAILED';
    throw new TRPCError({ code, message: `${err.code} — ${err.message}`, cause: err });
  }
  throw err;
}

/**
 * `capital.snapshot` (`admin:read`): the monitor, evaluated now. `capital.scenario` (`admin:read`): a counterparty default
 * against a fresh ledger read; it stores nothing. `capital.setThreshold` (`admin:write`): set or clear one asset's minimum
 * under a second founder's approval. No storage refuses `ops.capital.storage_unconfigured`.
 */
export function createCapitalRouter(desk: CapitalDesk) {
  return router({
    snapshot: scopedProcedure('admin:read', guards)
      .output(opsCapitalSnapshotSchema)
      .query(async () => {
        try {
          return await desk.snapshot();
        } catch (err) {
          return deskError(err);
        }
      }),
    scenario: scopedProcedure('admin:read', guards)
      .input(opsCapitalScenarioInputSchema)
      .output(opsCapitalScenarioSchema)
      .query(async ({ input }) => {
        try {
          return await desk.scenario(input);
        } catch (err) {
          return deskError(err);
        }
      }),
    setThreshold: scopedProcedure('admin:write', guards)
      .input(opsCapitalThresholdSetInputSchema)
      .output(opsCapitalThresholdSetOutputSchema)
      .mutation(async ({ ctx, input }) => {
        try {
          return await desk.setThreshold(ctx.principal.userId, input);
        } catch (err) {
          return deskError(err);
        }
      }),
  });
}
