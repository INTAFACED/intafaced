import type { Sql } from 'postgres';
import {
  productCreateInputSchema,
  productGetInputSchema,
  productImageFileSchema,
  productImageGetInputSchema,
  productImageRulesSchema,
  productImageSchema,
  productImageUploadInputSchema,
  productListInputSchema,
  productListSchema,
  productSchema,
  router,
} from '@intafaced/contracts';
import { z } from 'zod';
import { MerchantOpsError, wrapOps } from '../merchant-ops/errors.js';
import { resolveMerchantCaller } from '../merchant-ops/roles.js';
import { ownMerchantRead } from '../own-merchant-read.js';
import { teamMemberWrite } from '../team-member-write.js';
import type { ProductImageRule } from './image-rules.js';
import { ProductCatalog } from './products.js';

export interface CatalogMountDeps {
  readonly sql: Sql;
  readonly imageRule: ProductImageRule;
}

/**
 * `merchantCatalog.*`: the business's product catalogue (M-catalogue-01). The business is the caller's own, resolved
 * from the signed principal and never taken from the request. Reads take the merchant read scope; writes take
 * `pay:write`, or `pay:onboard` for an active member of a verified business (`teamMemberWrite`), and then the role
 * table (`products.manage`). Without a database every procedure refuses `pay.merchant_ops_unavailable`.
 */
export function createMerchantCatalogRouter(deps: CatalogMountDeps | undefined) {
  const catalog = deps ? new ProductCatalog(deps.sql, deps.imageRule) : null;
  const need = () => {
    if (!catalog || !deps) throw new MerchantOpsError('pay.merchant_ops_unavailable', 'unavailable');
    return { catalog, sql: deps.sql };
  };
  const read = ownMerchantRead();
  const write = teamMemberWrite(() => need().sql);
  const callerOf = (ctx: { principal: { userId: string; kid?: string | undefined; mfa?: boolean; sub_account?: string | undefined } }) =>
    resolveMerchantCaller(need().sql, ctx.principal);
  return router({
    merchantCatalog: router({
      products: router({
        list: read
          .input(productListInputSchema)
          .output(productListSchema)
          .query(({ ctx, input }) => wrapOps(async () => need().catalog.list(await callerOf(ctx), input))),
        get: read
          .input(productGetInputSchema)
          .output(productSchema)
          .query(({ ctx, input }) => wrapOps(async () => need().catalog.get(await callerOf(ctx), input.productId))),
        create: write
          .input(productCreateInputSchema)
          .output(z.object({ product: productSchema, replayed: z.boolean() }).strict())
          .mutation(({ ctx, input }) => wrapOps(async () => need().catalog.create(await callerOf(ctx), input))),
      }),
      images: router({
        rules: read
          .input(z.object({}).strict())
          .output(productImageRulesSchema)
          .query(({ ctx }) => wrapOps(async () => need().catalog.imageRules(await callerOf(ctx)))),
        upload: write
          .input(productImageUploadInputSchema)
          .output(productImageSchema)
          .mutation(({ ctx, input }) => wrapOps(async () => need().catalog.uploadImage(await callerOf(ctx), input))),
        get: read
          .input(productImageGetInputSchema)
          .output(productImageFileSchema)
          .query(({ ctx, input }) => wrapOps(async () => need().catalog.image(await callerOf(ctx), input.imageId))),
      }),
    }),
  });
}
