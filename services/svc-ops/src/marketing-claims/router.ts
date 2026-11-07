import { TRPCError } from '@trpc/server';
import {
  CLAIM_NOT_FOUND,
  claimPublishInputSchema,
  claimRecordInputSchema,
  claimWriteOutputSchema,
  claimsListOutputSchema,
  router,
  scopedProcedure,
} from '@intafaced/contracts';
import { OPS_IDEMPOTENCY_CONFLICT, OpsError } from '../codes.js';
import type { ClaimDesk } from './desk.js';

const guards = { module: 'core-ops' as const, plane: 'fiat' as const };

function deskError(err: unknown): never {
  if (err instanceof OpsError) {
    const code = err.code === CLAIM_NOT_FOUND ? 'NOT_FOUND' : err.code === OPS_IDEMPOTENCY_CONFLICT ? 'CONFLICT' : 'PRECONDITION_FAILED';
    throw new TRPCError({ code, message: `${err.code} — ${err.message}`, cause: err });
  }
  throw err;
}

/**
 * `claims.list` (`admin:read`): the marketing claims register, each claim with its evidence or its block.
 * `claims.record` and `claims.publish` (`admin:write`): record a claim, and publish it as a second founder. No storage
 * refuses `ops.claims_storage_unconfigured`.
 */
export function createClaimsRouter(desk: ClaimDesk) {
  return router({
    list: scopedProcedure('admin:read', guards)
      .output(claimsListOutputSchema)
      .query(async () => {
        try {
          return await desk.list();
        } catch (err) {
          return deskError(err);
        }
      }),
    record: scopedProcedure('admin:write', guards)
      .input(claimRecordInputSchema)
      .output(claimWriteOutputSchema)
      .mutation(async ({ ctx, input }) => {
        try {
          return await desk.record(ctx.principal.userId, input);
        } catch (err) {
          return deskError(err);
        }
      }),
    publish: scopedProcedure('admin:write', guards)
      .input(claimPublishInputSchema)
      .output(claimWriteOutputSchema)
      .mutation(async ({ ctx, input }) => {
        try {
          return await desk.publish(ctx.principal.userId, input);
        } catch (err) {
          return deskError(err);
        }
      }),
  });
}
