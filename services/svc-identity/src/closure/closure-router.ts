/**
 * `accountClosure.request`, `.cancel`, `.check`, `.status`. Own account, session only.
 * No operator cancel lives here.
 */
import { z } from 'zod';
import { protectedProcedure, router, TRPCError } from '@intafaced/contracts';
import { userCopy } from '../user-copy.js';
import { AccountClosureService, ClosureError, type ClosureView } from './closure-service.js';

const blocker = z.object({ code: z.string(), count: z.number().int() });
const balance = z.object({ assetId: z.string(), amount: z.string() });
const view = z.object({
  id: z.string().uuid(),
  status: z.enum(['requested', 'cancelled', 'blocked', 'closed']),
  requestedAt: z.string(),
  effectiveAt: z.string(),
  finalizedAt: z.string().nullable(),
  clientRequestId: z.string(),
  blockers: z.array(blocker),
});

function toTrpc(err: unknown): never {
  if (err instanceof TRPCError) throw err;
  if (err instanceof ClosureError) {
    const code =
      err.code === 'identity.close_delegated'
        ? 'FORBIDDEN'
        : err.code === 'identity.step_up_required' ||
            err.code === 'identity.step_up_expired' ||
            err.code === 'identity.step_up_used' ||
            err.code === 'identity.step_up_not_yours' ||
            err.code === 'identity.step_up_target' ||
            err.code === 'identity.close_disabled' ||
            err.code === 'identity.close_cooling_off_unset' ||
            err.code === 'identity.close_account_not_active' ||
            err.code === 'identity.close_founder_forbidden' ||
            err.code === 'identity.close_restricted' ||
            err.code === 'identity.close_blocked' ||
            err.code === 'identity.close_check_unavailable' ||
            err.code === 'identity.close_nothing_open'
          ? 'PRECONDITION_FAILED'
          : 'BAD_REQUEST';
    throw new TRPCError({ code, message: userCopy(err.code), cause: err });
  }
  throw err;
}

function actor(principal: { userId: string; sid: string; kid?: string | null; sub_account?: string | null }) {
  return {
    userId: principal.userId,
    sessionId: principal.sid,
    apiKey: Boolean(principal.kid),
    subAccount: Boolean(principal.sub_account),
  };
}

export function createAccountClosureRouter(closure: AccountClosureService | undefined) {
  const service = (): AccountClosureService => {
    if (!closure) throw new ClosureError('identity.close_disabled');
    return closure;
  };
  return router({
    request: protectedProcedure
      .input(z.object({ stepUpApprovalId: z.string().uuid(), clientRequestId: z.string().uuid() }).strict())
      .output(view)
      .mutation(async ({ ctx, input }) => {
        try {
          return await service().request({ ...actor(ctx.principal), ...input });
        } catch (err) {
          toTrpc(err);
        }
      }),
    cancel: protectedProcedure
      .input(z.object({ stepUpApprovalId: z.string().uuid() }).strict())
      .output(view)
      .mutation(async ({ ctx, input }) => {
        try {
          return await service().cancel({ ...actor(ctx.principal), stepUpApprovalId: input.stepUpApprovalId });
        } catch (err) {
          toTrpc(err);
        }
      }),
    check: protectedProcedure.output(z.object({ blockers: z.array(blocker), balances: z.array(balance) })).query(async ({ ctx }) => {
      try {
        return await service().check(actor(ctx.principal));
      } catch (err) {
        toTrpc(err);
      }
    }),
    status: protectedProcedure.output(z.object({ closure: view.nullable() })).query(async ({ ctx }) => {
      try {
        if (ctx.principal.kid || ctx.principal.sub_account) throw new ClosureError('identity.close_delegated');
        const closureRow: ClosureView | null = await service().status(ctx.principal.userId);
        return { closure: closureRow };
      } catch (err) {
        toTrpc(err);
      }
    }),
  });
}
