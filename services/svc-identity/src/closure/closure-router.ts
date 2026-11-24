/**
 * `accountClosure.request`, `.cancel`, `.check`, `.status`. Own account, session only.
 * No operator cancel lives here.
 */
import { router, TRPCError } from '@intafaced/contracts/trpc';
import { userCopy } from '../user-copy.js';
import { AccountClosureService, ClosureError, type ClosureView } from './closure-service.js';
import {
  IDENTITY_ACCOUNT_CLOSURE_STATUS,
  IDENTITY_ACCOUNT_CLOSURE_CHECK,
  IDENTITY_ACCOUNT_CLOSURE_REQUEST,
  IDENTITY_ACCOUNT_CLOSURE_CANCEL,
} from '@intafaced/contracts/identity-account-closure-procedures';
import { mountRecord } from '@intafaced/contracts/procedure-mount';
import { codedRefusal } from '../record-refusal.js';

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
    request: mountRecord(
      IDENTITY_ACCOUNT_CLOSURE_REQUEST,
      async ({ ctx, input }) => {
        try {
          return await service().request({ ...actor(ctx.principal), ...input });
        } catch (err) {
          toTrpc(err);
        }
      },
      codedRefusal,
    ),
    cancel: mountRecord(
      IDENTITY_ACCOUNT_CLOSURE_CANCEL,
      async ({ ctx, input }) => {
        try {
          return await service().cancel({ ...actor(ctx.principal), stepUpApprovalId: input.stepUpApprovalId });
        } catch (err) {
          toTrpc(err);
        }
      },
      codedRefusal,
    ),
    check: mountRecord(
      IDENTITY_ACCOUNT_CLOSURE_CHECK,
      async ({ ctx }) => {
        try {
          return await service().check(actor(ctx.principal));
        } catch (err) {
          toTrpc(err);
        }
      },
      codedRefusal,
    ),
    status: mountRecord(
      IDENTITY_ACCOUNT_CLOSURE_STATUS,
      async ({ ctx }) => {
        try {
          if (ctx.principal.kid || ctx.principal.sub_account) throw new ClosureError('identity.close_delegated');
          const closureRow: ClosureView | null = await service().status(ctx.principal.userId);
          return { closure: closureRow };
        } catch (err) {
          toTrpc(err);
        }
      },
      codedRefusal,
    ),
  });
}
