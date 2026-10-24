import { z } from 'zod';
import {
  priceQuoteSchema,
  priceSchema,
  productImageFileSchema,
  productImageRulesSchema,
  productImageSchema,
  productSchema,
  type PriceCreateInput,
  type ProductCreateInput,
} from '@intafaced/contracts/merchant-catalog';
import type { PortalTools } from '../api-tools';
import './refusals';

// The product catalogue and its prices (J-merchant-03 steps 1 to 3, M-catalogue-01 and -02): svc-pay `merchantCatalog.*`, parsed with the
// service's own schemas. The business is the signed-in person's own; the service resolves it and checks the role.

const created = z.object({ product: productSchema, replayed: z.boolean() }).strict();
const priceCreated = z.object({ price: priceSchema, replayed: z.boolean() }).strict();

export const catalogApi = ({ query, mutate, list }: PortalTools) => ({
  products: (status: string, cursor: string | undefined, signal?: AbortSignal) =>
    list('merchantCatalog.products.list', productSchema, { ...(status ? { status } : {}), ...(cursor ? { cursor } : {}) }, signal),
  product: (productId: string, signal?: AbortSignal) => query('merchantCatalog.products.get', { productId }, productSchema, signal),
  createProduct: (input: ProductCreateInput) => mutate('merchantCatalog.products.create', input, created),
  productImageRules: (signal?: AbortSignal) => query('merchantCatalog.images.rules', {}, productImageRulesSchema, signal),
  uploadProductImage: (input: { requestId: string; contentType: string; dataBase64: string }) =>
    mutate('merchantCatalog.images.upload', input, productImageSchema),
  productImage: (imageId: string, signal?: AbortSignal) => query('merchantCatalog.images.get', { imageId }, productImageFileSchema, signal),
  prices: (productId: string, cursor: string | undefined, signal?: AbortSignal) =>
    list('merchantCatalog.prices.list', priceSchema, { productId, ...(cursor ? { cursor } : {}) }, signal),
  createPrice: (input: PriceCreateInput) => mutate('merchantCatalog.prices.create', input, priceCreated),
  setDefaultPrice: (input: { productId: string; priceId: string }) => mutate('merchantCatalog.prices.setDefault', input, priceSchema),
  quotePrice: (input: { priceId: string; amount?: string }, signal?: AbortSignal) =>
    query('merchantCatalog.prices.quote', input, priceQuoteSchema, signal),
});
