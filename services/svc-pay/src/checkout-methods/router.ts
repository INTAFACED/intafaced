import type { Sql } from 'postgres';
import {
  checkoutMethodOfferSchema,
  checkoutMethodsGetInputSchema,
  checkoutMethodsPreviewInputSchema,
  checkoutMethodsSaveInputSchema,
  checkoutMethodsSavedSchema,
  checkoutMethodsSchema,
  router,
} from '@intafaced/contracts';
import { MerchantOpsError, wrapOps } from '../merchant-ops/errors.js';
import { resolveMerchantCaller } from '../merchant-ops/roles.js';
import { ownMerchantRead } from '../own-merchant-read.js';
import { teamMemberWrite } from '../team-member-write.js';
import type { MethodRails } from './catalogue.js';
import { CheckoutMethodSettings } from './methods.js';

export interface CheckoutMethodsMountDeps {
  readonly sql: Sql;
  /** The platform's connected methods: the public checkout's rails and the countries their profiles declare. */
  readonly rails: () => MethodRails;
}

/**
 * `merchantCheckoutMethods.*` (M-adv-payments-core-11): which payment methods the business's hosted checkout offers, in
 * which order, and a preview of what a payer would be offered. The business is the caller's own, resolved from the
 * signed principal and never taken from the request. Reads take the merchant read scope; a save takes `pay:write` (or
 * `pay:onboard` for an active member of a verified business) and then `profile.manage`. Without a database every
 * procedure refuses `pay.merchant_ops_unavailable`.
 */
export function createCheckoutMethodsRouter(deps: CheckoutMethodsMountDeps | undefined) {
  const settings = deps ? new CheckoutMethodSettings(deps.sql, deps.rails) : null;
  const need = () => {
    if (!settings || !deps) throw new MerchantOpsError('pay.merchant_ops_unavailable', 'unavailable');
    return { settings, sql: deps.sql };
  };
  const read = ownMerchantRead();
  const write = teamMemberWrite(() => need().sql);
  const callerOf = (ctx: { principal: { userId: string; kid?: string | undefined; mfa?: boolean; sub_account?: string | undefined } }) =>
    resolveMerchantCaller(need().sql, ctx.principal);
  return router({
    merchantCheckoutMethods: router({
      get: read
        .input(checkoutMethodsGetInputSchema)
        .output(checkoutMethodsSchema)
        .query(({ ctx }) => wrapOps(async () => need().settings.get(await callerOf(ctx)))),
      preview: read
        .input(checkoutMethodsPreviewInputSchema)
        .output(checkoutMethodOfferSchema)
        .query(({ ctx, input }) => wrapOps(async () => need().settings.preview(await callerOf(ctx), input))),
      save: write
        .input(checkoutMethodsSaveInputSchema)
        .output(checkoutMethodsSavedSchema)
        .mutation(({ ctx, input }) => wrapOps(async () => need().settings.save(await callerOf(ctx), input))),
    }),
  });
}
