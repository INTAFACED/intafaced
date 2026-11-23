import type { Sql } from 'postgres';
import {
  catalogCopyInputSchema,
  catalogCopySchema,
  priceChoicesInputSchema,
  priceChoicesSchema,
  priceCreateInputSchema,
  priceQuoteInputSchema,
  priceQuoteSchema,
  priceReplaceInputSchema,
  priceReplaceSchema,
  priceSchema,
  priceSetDefaultInputSchema,
  productCreateInputSchema,
  productDeletedSchema,
  productIdInputSchema,
  productImageSchema,
  productImageUploadInputSchema,
  productImportInputSchema,
  productImportSchema,
  productListInputSchema,
  productListSchema,
  productSchema,
} from '@intafaced/contracts/merchant-catalog';
import {
  productAvailabilitySchema,
  productAvailabilitySetInputSchema,
  storeCreateInputSchema,
  storeIdInputSchema,
  storeListInputSchema,
  storeListSchema,
  storeSchema,
} from '@intafaced/contracts/merchant-stores';
import { anyScopeProcedure, router } from '@intafaced/contracts/trpc';
import { z } from 'zod';
import { MerchantOpsError, wrapOps } from '../merchant-ops/errors.js';
import { resolveMerchantCaller } from '../merchant-ops/roles.js';
import { ownMerchantRead } from '../own-merchant-read.js';
import { PAY_OR_ONBOARD, teamMemberCheck } from '../team-member-write.js';
import type { ProductImageRule } from './image-rules.js';
import { MerchantStores } from '../stores/stores.js';
import { ProductAvailabilities } from './availability.js';
import { CatalogCopier } from './copy.js';
import { ProductImports } from './import.js';
import { ProductPrices } from './prices.js';
import { ProductCatalog } from './products.js';
import {
  PAY_MERCHANT_CATALOG_PRODUCTS_GET,
  PAY_MERCHANT_CATALOG_IMAGES_RULES,
  PAY_MERCHANT_CATALOG_IMAGES_GET,
  PAY_MERCHANT_CATALOG_PRICES_LIST,
  PAY_MERCHANT_CATALOG_PRICES_USAGE,
  PAY_MERCHANT_CATALOG_PRICES_GET,
  PAY_MERCHANT_CATALOG_AVAILABILITY_GET,
} from '@intafaced/contracts/pay-merchant-catalog-procedures';
import { mountRecord } from '@intafaced/contracts/procedure-mount';
import { payRefusal } from '../record-refusal.js';

export interface CatalogMountDeps {
  readonly sql: Sql;
  readonly imageRule: ProductImageRule;
}

/**
 * `merchantCatalog.*`: the business's product catalogue and its prices (M-catalogue-01, M-catalogue-02,
 * M-adv-payments-core-20, the import, test catalogue, copy and availability of M-adv-payments-core-21) and its stores
 * (`merchantStores.*`, M-adv-org-access-05). The business is the caller's own, resolved
 * from the signed principal and never taken from the request. Reads take the merchant read scope; writes take
 * `pay:write`, or `pay:onboard` for an active member of a verified business (`teamMemberCheck`), and then the role
 * table (`products.manage`). Without a database every procedure refuses `pay.merchant_ops_unavailable`.
 */
export function createMerchantCatalogRouter(deps: CatalogMountDeps | undefined) {
  const catalog = deps ? new ProductCatalog(deps.sql, deps.imageRule) : null;
  const prices = deps ? new ProductPrices(deps.sql) : null;
  const imports = deps ? new ProductImports(deps.sql) : null;
  const copier = deps ? new CatalogCopier(deps.sql) : null;
  const availability = deps ? new ProductAvailabilities(deps.sql) : null;
  const stores = deps ? new MerchantStores(deps.sql) : null;
  const need = () => {
    if (!catalog || !prices || !imports || !copier || !availability || !stores || !deps)
      throw new MerchantOpsError('pay.merchant_ops_unavailable', 'unavailable');
    return { catalog, prices, imports, copier, availability, stores, sql: deps.sql };
  };
  const read = ownMerchantRead();
  const teamMember = teamMemberCheck(() => need().sql);
  const write = anyScopeProcedure(PAY_OR_ONBOARD, { module: 'pay', check: teamMember });
  const callerOf = (ctx: { principal: { userId: string; kid?: string | undefined; mfa?: boolean; sub_account?: string | undefined } }) =>
    resolveMerchantCaller(need().sql, ctx.principal);
  return router({
    merchantCatalog: router({
      products: router({
        list: read
          .input(productListInputSchema)
          .output(productListSchema)
          .query(({ ctx, input }) => wrapOps(async () => need().catalog.list(await callerOf(ctx), input))),
        get: mountRecord(
          PAY_MERCHANT_CATALOG_PRODUCTS_GET,
          ({ ctx, input }) => wrapOps(async () => need().catalog.get(await callerOf(ctx), input.productId)),
          payRefusal,
        ),
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
        list: mountRecord(
          PAY_MERCHANT_CATALOG_PRICES_LIST,
          ({ ctx, input }) => wrapOps(async () => need().prices.list(await callerOf(ctx), input)),
          payRefusal,
        ),
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
        get: mountRecord(
          PAY_MERCHANT_CATALOG_PRICES_GET,
          ({ ctx, input }) => wrapOps(async () => need().prices.get(await callerOf(ctx), input.priceId)),
          payRefusal,
        ),
        usage: mountRecord(
          PAY_MERCHANT_CATALOG_PRICES_USAGE,
          ({ ctx, input }) => wrapOps(async () => need().prices.usage(await callerOf(ctx), input.priceId)),
          payRefusal,
        ),
        choices: read
          .input(priceChoicesInputSchema)
          .output(priceChoicesSchema)
          .query(({ ctx, input }) => wrapOps(async () => need().prices.choices(await callerOf(ctx), input))),
        quote: read
          .input(priceQuoteInputSchema)
          .output(priceQuoteSchema)
          .query(({ ctx, input }) => wrapOps(async () => need().prices.quote(await callerOf(ctx), input))),
      }),
      availability: router({
        get: mountRecord(
          PAY_MERCHANT_CATALOG_AVAILABILITY_GET,
          ({ ctx, input }) => wrapOps(async () => need().availability.get(await callerOf(ctx), input.productId)),
          payRefusal,
        ),
        set: write
          .input(productAvailabilitySetInputSchema)
          .output(productAvailabilitySchema)
          .mutation(({ ctx, input }) => wrapOps(async () => need().availability.set(await callerOf(ctx), input))),
      }),
      copy: write
        .input(catalogCopyInputSchema)
        .output(catalogCopySchema)
        .mutation(({ ctx, input }) => wrapOps(async () => need().copier.copy(await callerOf(ctx), input))),
      images: router({
        rules: mountRecord(
          PAY_MERCHANT_CATALOG_IMAGES_RULES,
          ({ ctx }) => wrapOps(async () => need().catalog.imageRules(await callerOf(ctx))),
          payRefusal,
        ),
        upload: write
          .input(productImageUploadInputSchema)
          .output(productImageSchema)
          .mutation(({ ctx, input }) => wrapOps(async () => need().catalog.uploadImage(await callerOf(ctx), input))),
        get: mountRecord(
          PAY_MERCHANT_CATALOG_IMAGES_GET,
          ({ ctx, input }) => wrapOps(async () => need().catalog.image(await callerOf(ctx), input.imageId)),
          payRefusal,
        ),
      }),
    }),
    // M-adv-org-access-05: the business's stores, where its products are sold (`merchantCatalog.availability`).
    merchantStores: router({
      list: read
        .input(storeListInputSchema)
        .output(storeListSchema)
        .query(({ ctx, input }) => wrapOps(async () => need().stores.list(await callerOf(ctx), input))),
      create: write
        .input(storeCreateInputSchema)
        .output(z.object({ store: storeSchema, replayed: z.boolean() }).strict())
        .mutation(({ ctx, input }) => wrapOps(async () => need().stores.create(await callerOf(ctx), input))),
      archive: write
        .input(storeIdInputSchema)
        .output(storeSchema)
        .mutation(({ ctx, input }) => wrapOps(async () => need().stores.setStatus(await callerOf(ctx), input.storeId, 'archived'))),
      reopen: write
        .input(storeIdInputSchema)
        .output(storeSchema)
        .mutation(({ ctx, input }) => wrapOps(async () => need().stores.setStatus(await callerOf(ctx), input.storeId, 'active'))),
    }),
  });
}
