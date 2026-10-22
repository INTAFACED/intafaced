/** `subAccounts.getFeatures` and `subAccounts.setFeatures`. Own sub-account, session only. */
import { z } from 'zod';
import { protectedProcedure, TRPCError } from '@intafaced/contracts';
import { SUB_ACCOUNT_KINDS } from '../auth/auth-service.js';
import { userCopy } from '../user-copy.js';
import { SUB_ACCOUNT_FEATURES, SubAccountFeatureError, type SubAccountFeatureService } from './sub-account-features.js';

const feature = z.enum(SUB_ACCOUNT_FEATURES);

function toTrpc(err: unknown): never {
  if (err instanceof TRPCError) throw err;
  if (err instanceof SubAccountFeatureError) {
    const code =
      err.code === 'identity.sub_account_features_delegated'
        ? 'FORBIDDEN'
        : err.code === 'identity.sub_account_not_found'
          ? 'NOT_FOUND'
          : 'PRECONDITION_FAILED';
    throw new TRPCError({ code, message: userCopy(err.code), cause: err });
  }
  throw err;
}

type Principal = { userId: string; kid?: string | null; sub_account?: string | null };
const actor = (p: Principal) => ({ userId: p.userId, apiKey: Boolean(p.kid), subAccount: Boolean(p.sub_account) });

export function createSubAccountFeatureProcedures(service: SubAccountFeatureService | undefined) {
  const required = (): SubAccountFeatureService => {
    if (!service) throw new SubAccountFeatureError('identity.sub_account_features_unset');
    return service;
  };
  return {
    getFeatures: protectedProcedure
      .input(z.object({ subAccountId: z.string().uuid() }).strict())
      .output(
        z.object({
          kind: z.enum(SUB_ACCOUNT_KINDS),
          frozen: z.boolean(),
          published: z.boolean(),
          features: z.array(z.object({ feature, offered: z.boolean(), enabled: z.boolean() })),
        }),
      )
      .query(async ({ ctx, input }) => {
        try {
          return await required().get({ ...actor(ctx.principal), subAccountId: input.subAccountId });
        } catch (err) {
          toTrpc(err);
        }
      }),
    setFeatures: protectedProcedure
      .input(z.object({ subAccountId: z.string().uuid(), feature, enabled: z.boolean() }).strict())
      .output(z.object({ feature, enabled: z.boolean(), changed: z.boolean() }))
      .mutation(async ({ ctx, input }) => {
        try {
          return await required().set({ ...actor(ctx.principal), ...input });
        } catch (err) {
          toTrpc(err);
        }
      }),
  };
}
