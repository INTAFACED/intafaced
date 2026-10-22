/** `subAccounts.setSignIn` and `subAccounts.switchTo` (I-account-lifecycle-04). Session only. */
import { z } from 'zod';
import { scopedProcedure, TRPCError } from '@intafaced/contracts';
import { userCopy } from '../user-copy.js';
import { SubAccountSwitchError, type SubAccountSwitchService } from './sub-account-switch.js';

function toTrpc(err: unknown): never {
  if (err instanceof TRPCError) throw err;
  if (err instanceof SubAccountSwitchError) {
    const code =
      err.code === 'identity.sub_account_switch_delegated'
        ? 'FORBIDDEN'
        : err.code === 'auth.not_found'
          ? 'NOT_FOUND'
          : err.code === 'identity.client_request_id_invalid'
            ? 'BAD_REQUEST'
            : err.code === 'identity.sub_account_switch_too_soon'
              ? 'TOO_MANY_REQUESTS'
              : 'PRECONDITION_FAILED';
    throw new TRPCError({ code, message: `${userCopy(err.code)} [${err.code}]`, cause: err });
  }
  throw err;
}

type Principal = { userId: string; sid: string; mfa?: boolean; kid?: string | null; sub_account?: string | null };
const actor = (p: Principal) => ({
  userId: p.userId,
  sessionId: p.sid,
  apiKey: Boolean(p.kid),
  subAccount: Boolean(p.sub_account),
  mfa: p.mfa === true,
});

export function createSubAccountSwitchProcedures(service: SubAccountSwitchService | undefined) {
  const required = () => {
    if (!service) throw new SubAccountSwitchError('identity.sub_account_switch_unavailable');
    return service;
  };
  return {
    setSignIn: scopedProcedure('identity:write')
      .input(
        z
          .object({
            subAccountId: z.string().uuid(),
            enabled: z.boolean(),
            stepUpApprovalId: z.string().uuid(),
            clientRequestId: z.string().max(4096),
          })
          .strict(),
      )
      .output(z.object({ id: z.string().uuid(), signInEnabled: z.boolean(), changed: z.boolean() }))
      .mutation(async ({ ctx, input }) => {
        try {
          return await required().setSignIn({ ...actor(ctx.principal as Principal), ...input });
        } catch (err) {
          toTrpc(err);
        }
      }),
    switchTo: scopedProcedure('identity:write')
      .input(z.object({ subAccountId: z.string().uuid() }).strict())
      .output(z.object({ subAccountId: z.string().uuid(), accessToken: z.string(), expiresAt: z.string() }))
      .mutation(async ({ ctx, input }) => {
        try {
          return await required().switchTo({ ...actor(ctx.principal as Principal), subAccountId: input.subAccountId });
        } catch (err) {
          toTrpc(err);
        }
      }),
  };
}
