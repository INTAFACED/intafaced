import type { Sql } from 'postgres';
import {
  outsideFundsGetInputSchema,
  outsideFundsSchema,
  receivingWalletGetInputSchema,
  receivingWalletSavedSchema,
  receivingWalletSaveInputSchema,
  receivingWalletSchema,
  router,
} from '@intafaced/contracts';
import { MerchantOpsError, wrapOps } from '../merchant-ops/errors.js';
import { resolveMerchantCaller } from '../merchant-ops/roles.js';
import { ownMerchantRead } from '../own-merchant-read.js';
import { teamMemberWrite } from '../team-member-write.js';
import { ReceivingWallets } from './wallet.js';
import { outsideFundsOf } from './outside-funds.js';

export interface ReceivingWalletMountDeps {
  readonly sql: Sql;
}

/**
 * `merchantReceivingWallet.*` (J-merchant-04, launch money model): the business's own receiving wallet, whose addresses a
 * payer's crypto goes straight to. The business is the caller's own, resolved from the signed principal and never taken
 * from the request. Reads take the merchant read scope; a save takes `pay:write` (or `pay:onboard` for an active member of
 * a verified business) and then `profile.manage`. Without a database every procedure refuses `pay.merchant_ops_unavailable`.
 */
export function createReceivingWalletRouter(deps: ReceivingWalletMountDeps | undefined) {
  const wallets = deps ? new ReceivingWallets(deps.sql) : null;
  const need = () => {
    if (!wallets || !deps) throw new MerchantOpsError('pay.merchant_ops_unavailable', 'unavailable');
    return { wallets, sql: deps.sql };
  };
  const read = ownMerchantRead();
  const write = teamMemberWrite(() => need().sql);
  const callerOf = (ctx: { principal: { userId: string; kid?: string | undefined; mfa?: boolean; sub_account?: string | undefined } }) =>
    resolveMerchantCaller(need().sql, ctx.principal);
  return router({
    merchantReceivingWallet: router({
      get: read
        .input(receivingWalletGetInputSchema)
        .output(receivingWalletSchema)
        .query(({ ctx }) => wrapOps(async () => need().wallets.get(await callerOf(ctx)))),
      save: write
        .input(receivingWalletSaveInputSchema)
        .output(receivingWalletSavedSchema)
        .mutation(({ ctx, input }) => wrapOps(async () => need().wallets.save(await callerOf(ctx), input))),
      /** The business's money in its own wallet or with the partner, as the chain or the partner last reported it. */
      outsideFunds: read
        .input(outsideFundsGetInputSchema)
        .output(outsideFundsSchema)
        .query(({ ctx }) => wrapOps(async () => outsideFundsOf(need().sql, await callerOf(ctx)))),
    }),
  });
}
