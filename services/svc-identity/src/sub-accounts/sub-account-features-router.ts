/** `subAccounts.getFeatures` and `subAccounts.setFeatures`. Own sub-account, session only. */
import { TRPCError } from '@intafaced/contracts/trpc';
import { userCopy } from '../user-copy.js';
import { SubAccountFeatureError, type SubAccountFeatureService } from './sub-account-features.js';
import {
  IDENTITY_SUB_ACCOUNTS_GET_FEATURES,
  IDENTITY_SUB_ACCOUNTS_SET_FEATURES,
} from '@intafaced/contracts/identity-sub-accounts-procedures';
import { mountRecord } from '@intafaced/contracts/procedure-mount';
import { codedRefusal } from '../record-refusal.js';

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
    getFeatures: mountRecord(
      IDENTITY_SUB_ACCOUNTS_GET_FEATURES,
      async ({ ctx, input }) => {
        try {
          return await required().get({ ...actor(ctx.principal), subAccountId: input.subAccountId });
        } catch (err) {
          toTrpc(err);
        }
      },
      codedRefusal,
    ),
    setFeatures: mountRecord(
      IDENTITY_SUB_ACCOUNTS_SET_FEATURES,
      async ({ ctx, input }) => {
        try {
          return await required().set({ ...actor(ctx.principal), ...input });
        } catch (err) {
          toTrpc(err);
        }
      },
      codedRefusal,
    ),
  };
}
