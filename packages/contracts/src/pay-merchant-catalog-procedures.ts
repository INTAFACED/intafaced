import { z } from 'zod';
import { defineProcedure } from './procedure.js';
import {
  pricedProductSchema,
  priceIdInputSchema,
  priceListInputSchema,
  priceListSchema,
  priceUsageSchema,
  productGetInputSchema,
  productIdInputSchema,
  productImageFileSchema,
  productImageGetInputSchema,
  productImageRulesSchema,
  productSchema,
  productCreateInputSchema,
  productImageUploadInputSchema,
  productImageSchema,
  priceCreateInputSchema,
  priceSchema,
  priceSetDefaultInputSchema,
  productDeletedSchema,
  priceReplaceInputSchema,
  priceReplaceSchema,
  productImportInputSchema,
  productImportSchema,
  catalogCopyInputSchema,
  catalogCopySchema,
} from './merchant-catalog.js';
import { productAvailabilitySchema, productAvailabilitySetInputSchema } from './merchant-stores.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-pay `merchantCatalog.*`, one record per call: svc-pay mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-pay', module: 'pay', transport: 'trpc' } as const;

export const PAY_MERCHANT_CATALOG_PRODUCTS_GET = defineProcedure({
  ...base,
  name: 'pay.merchantCatalog.products.get',
  kind: 'query',
  path: 'merchantCatalog.products.get',
  access: { caller: 'anyScope', scopes: ['pay:onboard', 'pay:read'], module: 'pay' },
  refusals: {},
  input: productGetInputSchema,
  output: productSchema,
  samples: [
    { verdict: 'accept', input: { productId: 'USDC' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const PAY_MERCHANT_CATALOG_IMAGES_RULES = defineProcedure({
  ...base,
  name: 'pay.merchantCatalog.images.rules',
  kind: 'query',
  path: 'merchantCatalog.images.rules',
  access: { caller: 'anyScope', scopes: ['pay:onboard', 'pay:read'], module: 'pay' },
  refusals: {},
  input: z.object({}).strict(),
  output: productImageRulesSchema,
  samples: [
    { verdict: 'accept', input: {} },
    { verdict: 'refuse', input: 42 },
  ],
});

export const PAY_MERCHANT_CATALOG_IMAGES_GET = defineProcedure({
  ...base,
  name: 'pay.merchantCatalog.images.get',
  kind: 'query',
  path: 'merchantCatalog.images.get',
  access: { caller: 'anyScope', scopes: ['pay:onboard', 'pay:read'], module: 'pay' },
  refusals: {},
  input: productImageGetInputSchema,
  output: productImageFileSchema,
  samples: [
    { verdict: 'accept', input: { imageId: '11111111-1111-4111-8111-111111111111' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const PAY_MERCHANT_CATALOG_PRICES_LIST = defineProcedure({
  ...base,
  name: 'pay.merchantCatalog.prices.list',
  kind: 'query',
  path: 'merchantCatalog.prices.list',
  access: { caller: 'anyScope', scopes: ['pay:onboard', 'pay:read'], module: 'pay' },
  refusals: {},
  input: priceListInputSchema,
  output: priceListSchema,
  samples: [
    { verdict: 'accept', input: { productId: 'USDC' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const PAY_MERCHANT_CATALOG_PRICES_USAGE = defineProcedure({
  ...base,
  name: 'pay.merchantCatalog.prices.usage',
  kind: 'query',
  path: 'merchantCatalog.prices.usage',
  access: { caller: 'anyScope', scopes: ['pay:onboard', 'pay:read'], module: 'pay' },
  refusals: {},
  input: priceIdInputSchema,
  output: priceUsageSchema,
  samples: [
    { verdict: 'accept', input: { priceId: '11111111-1111-4111-8111-111111111111' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const PAY_MERCHANT_CATALOG_PRICES_GET = defineProcedure({
  ...base,
  name: 'pay.merchantCatalog.prices.get',
  kind: 'query',
  path: 'merchantCatalog.prices.get',
  access: { caller: 'anyScope', scopes: ['pay:onboard', 'pay:read'], module: 'pay' },
  refusals: {},
  input: priceIdInputSchema,
  output: pricedProductSchema,
  samples: [
    { verdict: 'accept', input: { priceId: '11111111-1111-4111-8111-111111111111' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const PAY_MERCHANT_CATALOG_AVAILABILITY_GET = defineProcedure({
  ...base,
  name: 'pay.merchantCatalog.availability.get',
  kind: 'query',
  path: 'merchantCatalog.availability.get',
  access: { caller: 'anyScope', scopes: ['pay:onboard', 'pay:read'], module: 'pay' },
  refusals: {},
  input: productIdInputSchema,
  output: productAvailabilitySchema,
  samples: [
    { verdict: 'accept', input: { productId: '11111111-1111-4111-8111-111111111111' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const PAY_MERCHANT_CATALOG_PRODUCTS_CREATE = defineProcedure({
  ...base,
  name: 'pay.merchantCatalog.products.create',
  kind: 'mutation',
  path: 'merchantCatalog.products.create',
  access: { caller: 'anyScope', scopes: ['pay:write', 'pay:onboard'], module: 'pay', check: 'teamMember' },
  refusals: {},
  input: productCreateInputSchema,
  output: z.object({ product: productSchema, replayed: z.boolean() }).strict(),
  samples: [
    { verdict: 'accept', input: { requestId: '11111111-1111-4111-8111-111111111111', name: 'USDC', type: 'physical' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const PAY_MERCHANT_CATALOG_IMAGES_UPLOAD = defineProcedure({
  ...base,
  name: 'pay.merchantCatalog.images.upload',
  kind: 'mutation',
  path: 'merchantCatalog.images.upload',
  access: { caller: 'anyScope', scopes: ['pay:write', 'pay:onboard'], module: 'pay', check: 'teamMember' },
  refusals: {},
  input: productImageUploadInputSchema,
  output: productImageSchema,
  samples: [
    { verdict: 'accept', input: { requestId: '11111111-1111-4111-8111-111111111111', contentType: 'USDC', dataBase64: 'USDC' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const PAY_MERCHANT_CATALOG_PRICES_CREATE = defineProcedure({
  ...base,
  name: 'pay.merchantCatalog.prices.create',
  kind: 'mutation',
  path: 'merchantCatalog.prices.create',
  access: { caller: 'anyScope', scopes: ['pay:write', 'pay:onboard'], module: 'pay', check: 'teamMember' },
  refusals: {},
  input: priceCreateInputSchema,
  output: z.object({ price: priceSchema, replayed: z.boolean() }).strict(),
  samples: [
    {
      verdict: 'accept',
      input: {
        requestId: '11111111-1111-4111-8111-111111111111',
        productId: '11111111-1111-4111-8111-111111111111',
        billing: 'one_time',
        kind: 'fixed',
        assetId: 'USDC',
      },
    },
    { verdict: 'refuse', input: 42 },
  ],
});

export const PAY_MERCHANT_CATALOG_PRICES_SET_DEFAULT = defineProcedure({
  ...base,
  name: 'pay.merchantCatalog.prices.setDefault',
  kind: 'mutation',
  path: 'merchantCatalog.prices.setDefault',
  access: { caller: 'anyScope', scopes: ['pay:write', 'pay:onboard'], module: 'pay', check: 'teamMember' },
  refusals: {},
  input: priceSetDefaultInputSchema,
  output: priceSchema,
  samples: [
    { verdict: 'accept', input: { productId: '11111111-1111-4111-8111-111111111111', priceId: '11111111-1111-4111-8111-111111111111' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const PAY_MERCHANT_CATALOG_PRODUCTS_ARCHIVE = defineProcedure({
  ...base,
  name: 'pay.merchantCatalog.products.archive',
  kind: 'mutation',
  path: 'merchantCatalog.products.archive',
  access: { caller: 'anyScope', scopes: ['pay:write', 'pay:onboard'], module: 'pay', check: 'teamMember' },
  refusals: {},
  input: productIdInputSchema,
  output: productSchema,
  samples: [
    { verdict: 'accept', input: { productId: '11111111-1111-4111-8111-111111111111' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const PAY_MERCHANT_CATALOG_PRODUCTS_UNARCHIVE = defineProcedure({
  ...base,
  name: 'pay.merchantCatalog.products.unarchive',
  kind: 'mutation',
  path: 'merchantCatalog.products.unarchive',
  access: { caller: 'anyScope', scopes: ['pay:write', 'pay:onboard'], module: 'pay', check: 'teamMember' },
  refusals: {},
  input: productIdInputSchema,
  output: productSchema,
  samples: [
    { verdict: 'accept', input: { productId: '11111111-1111-4111-8111-111111111111' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const PAY_MERCHANT_CATALOG_PRODUCTS_DELETE = defineProcedure({
  ...base,
  name: 'pay.merchantCatalog.products.delete',
  kind: 'mutation',
  path: 'merchantCatalog.products.delete',
  access: { caller: 'anyScope', scopes: ['pay:write', 'pay:onboard'], module: 'pay', check: 'teamMember' },
  refusals: {},
  input: productIdInputSchema,
  output: productDeletedSchema,
  samples: [
    { verdict: 'accept', input: { productId: '11111111-1111-4111-8111-111111111111' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const PAY_MERCHANT_CATALOG_PRICES_REPLACE = defineProcedure({
  ...base,
  name: 'pay.merchantCatalog.prices.replace',
  kind: 'mutation',
  path: 'merchantCatalog.prices.replace',
  access: { caller: 'anyScope', scopes: ['pay:write', 'pay:onboard'], module: 'pay', check: 'teamMember' },
  refusals: {},
  input: priceReplaceInputSchema,
  output: priceReplaceSchema,
  samples: [
    {
      verdict: 'accept',
      input: {
        requestId: '11111111-1111-4111-8111-111111111111',
        productId: '11111111-1111-4111-8111-111111111111',
        billing: 'one_time',
        kind: 'fixed',
        assetId: 'USDC',
        priceId: '11111111-1111-4111-8111-111111111111',
      },
    },
    { verdict: 'refuse', input: 42 },
  ],
});

export const PAY_MERCHANT_CATALOG_PRODUCTS_IMPORT = defineProcedure({
  ...base,
  name: 'pay.merchantCatalog.products.import',
  kind: 'mutation',
  path: 'merchantCatalog.products.import',
  access: { caller: 'anyScope', scopes: ['pay:write', 'pay:onboard'], module: 'pay', check: 'teamMember' },
  refusals: {},
  input: productImportInputSchema,
  output: productImportSchema,
  samples: [
    { verdict: 'accept', input: { csv: 'USDC', commit: true } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const PAY_MERCHANT_CATALOG_COPY = defineProcedure({
  ...base,
  name: 'pay.merchantCatalog.copy',
  kind: 'mutation',
  path: 'merchantCatalog.copy',
  access: { caller: 'anyScope', scopes: ['pay:write', 'pay:onboard'], module: 'pay', check: 'teamMember' },
  refusals: {},
  input: catalogCopyInputSchema,
  checks: { catalog_copy_input_holds: { at: 'input', says: 'from and to must differ' } },
  output: catalogCopySchema,
  samples: [
    { verdict: 'accept', input: { from: 'test', to: 'live' } },
    { verdict: 'refuse', input: 42 },
    { verdict: 'refuse', by: 'catalog_copy_input_holds', input: { from: 'live', to: 'live' } },
  ],
});

export const PAY_MERCHANT_CATALOG_AVAILABILITY_SET = defineProcedure({
  ...base,
  name: 'pay.merchantCatalog.availability.set',
  kind: 'mutation',
  path: 'merchantCatalog.availability.set',
  access: { caller: 'anyScope', scopes: ['pay:write', 'pay:onboard'], module: 'pay', check: 'teamMember' },
  refusals: {},
  input: productAvailabilitySetInputSchema,
  output: productAvailabilitySchema,
  samples: [
    {
      verdict: 'accept',
      input: {
        productId: '11111111-1111-4111-8111-111111111111',
        storeId: '11111111-1111-4111-8111-111111111111',
        channel: 'online',
        sold: true,
      },
    },
    { verdict: 'refuse', input: 42 },
  ],
});
