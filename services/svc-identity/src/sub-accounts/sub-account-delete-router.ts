/**
 * `subAccounts.deleteCheck` and `subAccounts.delete`. Own sub-account, session only.
 * The check reads the money services for this one sub-account; delete spends a step-up, re-reads, then revokes.
 */
import { z } from 'zod';
import { protectedProcedure, TRPCError } from '@intafaced/contracts';
import { userCopy } from '../user-copy.js';
import { SubAccountDeleteError, type SubAccountDeleteService } from './sub-account-delete.js';

const blocker = z.object({ code: z.string(), count: z.number().int() });
const balance = z.object({ assetId: z.string(), amount: z.string() });

export function subAccountDeleteToTrpc(err: unknown): never {
  if (err instanceof TRPCError) throw err;
  if (err instanceof SubAccountDeleteError) {
    const code =
      err.code === 'identity.sub_account_delete_delegated'
        ? 'FORBIDDEN'
        : err.code === 'identity.sub_account_not_found'
          ? 'NOT_FOUND'
          : err.code === 'identity.sub_account_delete_blocked' ||
              err.code === 'identity.sub_account_check_unavailable' ||
              err.code === 'identity.step_up_required' ||
              err.code === 'identity.step_up_expired' ||
              err.code === 'identity.step_up_used' ||
              err.code === 'identity.step_up_not_yours' ||
              err.code === 'identity.step_up_target'
            ? 'PRECONDITION_FAILED'
            : 'BAD_REQUEST';
    throw new TRPCError({ code, message: userCopy(err.code), cause: err });
  }
  throw err;
}

type Principal = { userId: string; sid: string; kid?: string | null; sub_account?: string | null };

function actor(principal: Principal) {
  return { userId: principal.userId, sessionId: principal.sid, apiKey: Boolean(principal.kid), subAccount: Boolean(principal.sub_account) };
}

export function createSubAccountDeleteProcedures(service: SubAccountDeleteService | undefined) {
  const required = (): SubAccountDeleteService => {
    if (!service) throw new SubAccountDeleteError('identity.sub_account_check_unavailable');
    return service;
  };
  return {
    deleteCheck: protectedProcedure
      .input(z.object({ subAccountId: z.string().uuid() }).strict())
      .output(z.object({ blockers: z.array(blocker), balances: z.array(balance) }))
      .query(async ({ ctx, input }) => {
        try {
          return await required().check({ ...actor(ctx.principal), subAccountId: input.subAccountId });
        } catch (err) {
          subAccountDeleteToTrpc(err);
        }
      }),
    delete: protectedProcedure
      .input(
        z
          .object({ subAccountId: z.string().uuid(), stepUpApprovalId: z.string().uuid(), clientRequestId: z.string().min(1).max(128) })
          .strict(),
      )
      .output(z.object({ deleted: z.literal(true), changed: z.boolean() }))
      .mutation(async ({ ctx, input }) => {
        try {
          return await required().delete({ ...actor(ctx.principal), ...input });
        } catch (err) {
          subAccountDeleteToTrpc(err);
        }
      }),
  };
}
