import type { Sql } from 'postgres';
import {
  checkoutBrandingGetInputSchema,
  checkoutBrandingSaveInputSchema,
  checkoutBrandingSavedSchema,
  checkoutBrandingSchema,
  router,
} from '@intafaced/contracts';
import { MerchantOpsError, wrapOps } from '../merchant-ops/errors.js';
import { resolveMerchantCaller } from '../merchant-ops/roles.js';
import { ownMerchantRead } from '../own-merchant-read.js';
import { teamMemberWrite } from '../team-member-write.js';
import { CheckoutBrandings } from './branding.js';
import type { CheckoutLogoRule } from './logo-rules.js';

export interface CheckoutBrandingMountDeps {
  readonly sql: Sql;
  readonly logoRule: CheckoutLogoRule;
}

/**
 * `merchantCheckout.branding.*` (M-payments-core-08): the look of the business's hosted checkout. The business is the
 * caller's own, resolved from the signed principal and never taken from the request. Reads take the merchant read scope;
 * a save takes `pay:write` (or `pay:onboard` for an active member of a verified business) and then `profile.manage`.
 * Without a database both refuse `pay.merchant_ops_unavailable`.
 */
export function createCheckoutBrandingRouter(deps: CheckoutBrandingMountDeps | undefined) {
  const brandings = deps ? new CheckoutBrandings(deps.sql, deps.logoRule) : null;
  const need = () => {
    if (!brandings || !deps) throw new MerchantOpsError('pay.merchant_ops_unavailable', 'unavailable');
    return { brandings, sql: deps.sql };
  };
  const read = ownMerchantRead();
  const write = teamMemberWrite(() => need().sql);
  const callerOf = (ctx: { principal: { userId: string; kid?: string | undefined; mfa?: boolean; sub_account?: string | undefined } }) =>
    resolveMerchantCaller(need().sql, ctx.principal);
  return router({
    merchantCheckout: router({
      branding: router({
        get: read
          .input(checkoutBrandingGetInputSchema)
          .output(checkoutBrandingSchema)
          .query(({ ctx }) => wrapOps(async () => need().brandings.get(await callerOf(ctx)))),
        save: write
          .input(checkoutBrandingSaveInputSchema)
          .output(checkoutBrandingSavedSchema)
          .mutation(({ ctx, input }) => wrapOps(async () => need().brandings.save(await callerOf(ctx), input))),
      }),
    }),
  });
}
