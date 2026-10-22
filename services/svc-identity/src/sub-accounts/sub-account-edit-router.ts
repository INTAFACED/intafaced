/**
 * `subAccounts.update`: edit the label and purpose of one own sub-account (RC-identity-14). Session only, step-up.
 * The id in the answer is always the id that was edited; it never changes.
 */
import { z } from 'zod';
import { scopedProcedure, TRPCError } from '@intafaced/contracts';
import { userCopy } from '../user-copy.js';
import { SubAccountEditError, type SubAccountEditService } from './sub-account-edit.js';

export function subAccountEditToTrpc(err: unknown): never {
  if (err instanceof TRPCError) throw err;
  if (err instanceof SubAccountEditError) {
    const code =
      err.code === 'identity.sub_account_edit_delegated'
        ? 'FORBIDDEN'
        : err.code === 'auth.not_found'
          ? 'NOT_FOUND'
          : err.code === 'identity.sub_account_label_invalid'
            ? 'BAD_REQUEST'
            : 'PRECONDITION_FAILED';
    throw new TRPCError({ code, message: `${userCopy(err.code)} [${err.code}]`, cause: err });
  }
  throw err;
}

type Principal = { userId: string; sid: string; kid?: string | null; sub_account?: string | null };

export function createSubAccountEditProcedures(service: SubAccountEditService | undefined) {
  return {
    update: scopedProcedure('identity:write')
      .input(
        z
          .object({
            subAccountId: z.string().uuid(),
            label: z.string().min(1).max(64).optional(),
            purpose: z.string().max(200).nullable().optional(),
            stepUpApprovalId: z.string().uuid(),
            clientRequestId: z.string().min(1).max(128),
          })
          .strict(),
      )
      .output(z.object({ id: z.string().uuid(), changed: z.boolean() }))
      .mutation(async ({ ctx, input }) => {
        const principal = ctx.principal as Principal;
        try {
          if (!service) throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'identity.sub_account_edit_unavailable' });
          return await service.update({
            userId: principal.userId,
            sessionId: principal.sid,
            apiKey: Boolean(principal.kid),
            subAccount: Boolean(principal.sub_account),
            ...input,
          });
        } catch (err) {
          subAccountEditToTrpc(err);
        }
      }),
  };
}
