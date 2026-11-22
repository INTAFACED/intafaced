import { TRPCError } from '@trpc/server';
import { router } from '@intafaced/contracts/trpc';
import { OPS_IDEMPOTENCY_CONFLICT, OpsError } from '../codes.js';
import type { CapitalDesk } from './desk.js';
import { OPS_CAPITAL_SNAPSHOT, OPS_CAPITAL_SCENARIO, OPS_CAPITAL_SET_THRESHOLD } from '@intafaced/contracts/ops-capital-procedures';
import { mountRecord } from '@intafaced/contracts/procedure-mount';
import { opsRefusal } from '../record-refusal.js';

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
    snapshot: mountRecord(
      OPS_CAPITAL_SNAPSHOT,
      async () => {
        try {
          return await desk.snapshot();
        } catch (err) {
          return deskError(err);
        }
      },
      opsRefusal,
    ),
    scenario: mountRecord(
      OPS_CAPITAL_SCENARIO,
      async ({ input }) => {
        try {
          return await desk.scenario(input);
        } catch (err) {
          return deskError(err);
        }
      },
      opsRefusal,
    ),
    setThreshold: mountRecord(
      OPS_CAPITAL_SET_THRESHOLD,
      async ({ ctx, input }) => {
        try {
          return await desk.setThreshold(ctx.principal.userId, input);
        } catch (err) {
          return deskError(err);
        }
      },
      opsRefusal,
    ),
  });
}
