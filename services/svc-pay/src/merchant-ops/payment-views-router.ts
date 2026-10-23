import type { Sql } from 'postgres';
import { z } from 'zod';
import { router, scopedProcedure } from '@intafaced/contracts';
import { ownMerchantRead } from '../own-merchant-read.js';
import { MerchantOpsError, wrapOps } from './errors.js';
import { PaymentViews } from './payment-views.js';
import { resolveMerchantCaller } from './roles.js';

/**
 * `paymentViews.*` (M-adv-payments-core-01, J-merchant-05 step 3).
 *
 * The spec names `payment.views.*` and `payment.unmask`. Those paths sit on
 * the acquiring `payment` router, which another slice is editing, and
 * `mergeRouters` rejects a second `payment` key. This namespace is the wire
 * path the payments list can call without that file.
 *
 * The merchant id always comes from the caller. A body cannot name a business.
 */

const viewFilters = z
  .object({
    status: z.enum(['created', 'authorized', 'captured', 'settled', 'refunded', 'disputed', 'failed']).optional(),
    search: z.string().optional(),
    assetId: z.string().optional(),
    from: z.string().optional(),
    to: z.string().optional(),
    linkId: z.string().optional(),
    amountMin: z.string().optional(),
    amountMax: z.string().optional(),
  })
  .strict();

const viewSort = z
  .object({
    field: z.enum(['createdAt', 'amount', 'status']),
    direction: z.enum(['asc', 'desc']),
  })
  .strict();

const viewRecord = z
  .object({
    id: z.string().uuid(),
    name: z.string(),
    visibility: z.enum(['private', 'shared']),
    filters: viewFilters,
    sort: viewSort,
    columns: z.array(z.string()),
    createdAt: z.string().datetime({ offset: true }),
    updatedAt: z.string().datetime({ offset: true }),
  })
  .strict();

const shopper = z
  .object({
    paymentId: z.string().uuid(),
    customerEmail: z.string().nullable(),
    customerName: z.string().nullable(),
    railRef: z.string().nullable(),
    canUnmask: z.boolean(),
  })
  .strict();

const revealed = shopper.omit({ canUnmask: true });

type CallerPrincipal = { userId: string; kid?: string | undefined; mfa?: boolean | undefined; sub_account?: string | undefined };

export function createPaymentViewsNamespaceRouter(deps: { readonly sql?: Sql | undefined }) {
  const read = ownMerchantRead();
  const write = scopedProcedure('pay:write', { module: 'pay' });
  const sqlOf = (): Sql => {
    if (!deps.sql) throw new MerchantOpsError('pay.merchant_ops_unavailable', 'unavailable');
    return deps.sql;
  };
  const views = () => new PaymentViews(sqlOf());
  const callerOf = (ctx: { principal: CallerPrincipal | null }) => {
    const principal = ctx.principal;
    if (!principal?.userId) throw new MerchantOpsError('pay.merchant_ops_not_merchant', 'forbidden');
    return resolveMerchantCaller(sqlOf(), principal);
  };

  return router({
    paymentViews: router({
      list: read
        .input(z.object({}).strict())
        .output(z.object({ items: z.array(viewRecord) }).strict())
        .query(({ ctx }) => wrapOps(async () => views().list(await callerOf(ctx)))),
      create: write
        .input(
          z
            .object({
              name: z.string().max(500),
              visibility: z.string().max(32),
              filters: z.unknown(),
              sort: z.unknown(),
              columns: z.unknown(),
            })
            .strict(),
        )
        .output(viewRecord)
        .mutation(({ ctx, input }) => wrapOps(async () => views().create(await callerOf(ctx), input))),
      update: write
        .input(
          z
            .object({
              viewId: z.string().max(80),
              name: z.string().max(500).optional(),
              filters: z.unknown(),
              sort: z.unknown(),
              columns: z.unknown(),
            })
            .strict(),
        )
        .output(viewRecord)
        .mutation(({ ctx, input }) => wrapOps(async () => views().update(await callerOf(ctx), input))),
      delete: write
        .input(z.object({ viewId: z.string().max(80) }).strict())
        .output(z.object({ deleted: z.literal(true) }).strict())
        .mutation(({ ctx, input }) => wrapOps(async () => views().delete(await callerOf(ctx), input.viewId))),
      shopper: read
        .input(z.object({ paymentId: z.string().max(80) }).strict())
        .output(shopper)
        .query(({ ctx, input }) => wrapOps(async () => views().shopper(await callerOf(ctx), input.paymentId))),
      unmask: read
        .input(z.object({ paymentId: z.string().max(80), reason: z.string().max(2000) }).strict())
        .output(revealed)
        .mutation(({ ctx, input }) => wrapOps(async () => views().unmask(await callerOf(ctx), input.paymentId, input.reason))),
    }),
  });
}
