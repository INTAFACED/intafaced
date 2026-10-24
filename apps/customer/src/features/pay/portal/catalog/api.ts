import { z } from 'zod';
import {
  productImageFileSchema,
  productImageRulesSchema,
  productImageSchema,
  productSchema,
  type ProductCreateInput,
} from '@intafaced/contracts/merchant-catalog';
import type { PortalTools } from '../api-tools';
import './refusals';

// The product catalogue (J-merchant-03 steps 1 and 2, M-catalogue-01): svc-pay `merchantCatalog.*`, parsed with the
// service's own schemas. The business is the signed-in person's own; the service resolves it and checks the role.

const created = z.object({ product: productSchema, replayed: z.boolean() }).strict();

export const catalogApi = ({ query, mutate, list }: PortalTools) => ({
  products: (status: string, cursor: string | undefined, signal?: AbortSignal) =>
    list('merchantCatalog.products.list', productSchema, { ...(status ? { status } : {}), ...(cursor ? { cursor } : {}) }, signal),
  product: (productId: string, signal?: AbortSignal) => query('merchantCatalog.products.get', { productId }, productSchema, signal),
  createProduct: (input: ProductCreateInput) => mutate('merchantCatalog.products.create', input, created),
  productImageRules: (signal?: AbortSignal) => query('merchantCatalog.images.rules', {}, productImageRulesSchema, signal),
  uploadProductImage: (input: { requestId: string; contentType: string; dataBase64: string }) =>
    mutate('merchantCatalog.images.upload', input, productImageSchema),
  productImage: (imageId: string, signal?: AbortSignal) => query('merchantCatalog.images.get', { imageId }, productImageFileSchema, signal),
});
