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
} from './merchant-catalog.js';
import { productAvailabilitySchema } from './merchant-stores.js';

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
