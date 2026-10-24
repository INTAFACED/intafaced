import type { Sql } from 'postgres';
import {
  catalogCopyInputSchema,
  catalogCopySchema,
  priceChoicesInputSchema,
  priceChoicesSchema,
  priceCreateInputSchema,
  priceIdInputSchema,
  pricedProductSchema,
  priceListInputSchema,
  priceListSchema,
  priceQuoteInputSchema,
  priceQuoteSchema,
  priceReplaceInputSchema,
  priceReplaceSchema,
  priceSchema,
  priceSetDefaultInputSchema,
  priceUsageSchema,
  productCreateInputSchema,
  productDeletedSchema,
  productGetInputSchema,
  productIdInputSchema,
  productImageFileSchema,
  productImageGetInputSchema,
  productImageRulesSchema,
  productImageSchema,
  productImageUploadInputSchema,
  productImportInputSchema,
  productImportSchema,
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
import { CatalogCopier } from './copy.js';
import { ProductImports } from './import.js';
import { ProductPrices } from './prices.js';
import { ProductCatalog } from './products.js';

export interface CatalogMountDeps {
  readonly sql: Sql;
  readonly imageRule: ProductImageRule;
}

/**
 * `merchantCatalog.*`: the business's product catalogue and its prices (M-catalogue-01, M-catalogue-02,
 * M-adv-payments-core-20, the import, test catalogue and copy of M-adv-payments-core-21). The business is the caller's own, resolved
 * from the signed principal and never taken from the request. Reads take the merchant read scope; writes take
 * `pay:write`, or `pay:onboard` for an active member of a verified business (`teamMemberWrite`), and then the role
 * table (`products.manage`). Without a database every procedure refuses `pay.merchant_ops_unavailable`.
 */
export function createMerchantCatalogRouter(deps: CatalogMountDeps | undefined) {
  const catalog = deps ? new ProductCatalog(deps.sql, deps.imageRule) : null;
  const prices = deps ? new ProductPrices(deps.sql) : null;
  const imports = deps ? new ProductImports(deps.sql) : null;
  const copier = deps ? new CatalogCopier(deps.sql) : null;
  const need = () => {
    if (!catalog || !prices || !imports || !copier || !deps) throw new MerchantOpsError('pay.merchant_ops_unavailable', 'unavailable');
    return { catalog, prices, imports, copier, sql: deps.sql };
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
        archive: write
          .input(productIdInputSchema)
          .output(productSchema)
          .mutation(({ ctx, input }) => wrapOps(async () => need().catalog.setStatus(await callerOf(ctx), input.productId, 'archived'))),
        unarchive: write
          .input(productIdInputSchema)
          .output(productSchema)
          .mutation(({ ctx, input }) => wrapOps(async () => need().catalog.setStatus(await callerOf(ctx), input.productId, 'active'))),
        delete: write
          .input(productIdInputSchema)
          .output(productDeletedSchema)
          .mutation(({ ctx, input }) => wrapOps(async () => need().catalog.delete(await callerOf(ctx), input.productId))),
        import: write
          .input(productImportInputSchema)
          .output(productImportSchema)
          .mutation(({ ctx, input }) => wrapOps(async () => need().imports.run(await callerOf(ctx), input))),
      }),
      prices: router({
        list: read
          .input(priceListInputSchema)
          .output(priceListSchema)
          .query(({ ctx, input }) => wrapOps(async () => need().prices.list(await callerOf(ctx), input))),
        create: write
          .input(priceCreateInputSchema)
          .output(z.object({ price: priceSchema, replayed: z.boolean() }).strict())
          .mutation(({ ctx, input }) => wrapOps(async () => need().prices.create(await callerOf(ctx), input))),
        setDefault: write
          .input(priceSetDefaultInputSchema)
          .output(priceSchema)
          .mutation(({ ctx, input }) => wrapOps(async () => need().prices.setDefault(await callerOf(ctx), input))),
        replace: write
          .input(priceReplaceInputSchema)
          .output(priceReplaceSchema)
          .mutation(({ ctx, input }) => wrapOps(async () => need().prices.replace(await callerOf(ctx), input))),
        get: read
          .input(priceIdInputSchema)
          .output(pricedProductSchema)
          .query(({ ctx, input }) => wrapOps(async () => need().prices.get(await callerOf(ctx), input.priceId))),
        usage: read
          .input(priceIdInputSchema)
          .output(priceUsageSchema)
          .query(({ ctx, input }) => wrapOps(async () => need().prices.usage(await callerOf(ctx), input.priceId))),
        choices: read
          .input(priceChoicesInputSchema)
          .output(priceChoicesSchema)
          .query(({ ctx, input }) => wrapOps(async () => need().prices.choices(await callerOf(ctx), input))),
        quote: read
          .input(priceQuoteInputSchema)
          .output(priceQuoteSchema)
          .query(({ ctx, input }) => wrapOps(async () => need().prices.quote(await callerOf(ctx), input))),
      }),
      copy: write
        .input(catalogCopyInputSchema)
        .output(catalogCopySchema)
        .mutation(({ ctx, input }) => wrapOps(async () => need().copier.copy(await callerOf(ctx), input))),
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
