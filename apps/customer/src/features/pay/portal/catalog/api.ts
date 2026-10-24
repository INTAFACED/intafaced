import { z } from 'zod';
import {
  priceChoicesSchema,
  pricedProductSchema,
  priceQuoteSchema,
  priceReplaceSchema,
  priceSchema,
  priceUsageSchema,
  catalogCopySchema,
  productDeletedSchema,
  productImageFileSchema,
  productImageRulesSchema,
  productImageSchema,
  productImportSchema,
  productSchema,
  type PriceCreateInput,
  type PriceReplaceInput,
  type ProductCreateInput,
} from '@intafaced/contracts/merchant-catalog';
import { productAvailabilitySchema, storeSchema, type SaleChannel, type StoreCreateInput } from '@intafaced/contracts/merchant-stores';
import type { PortalTools } from '../api-tools';
import './refusals';

// The product catalogue and its prices (J-merchant-03 steps 1 to 6, M-catalogue-01 and -02, M-adv-payments-core-20 and -21): svc-pay `merchantCatalog.*`, parsed with the
// service's own schemas. The business is the signed-in person's own; the service resolves it and checks the role.

type CatalogMode = 'live' | 'test';

const created = z.object({ product: productSchema, replayed: z.boolean() }).strict();
const priceCreated = z.object({ price: priceSchema, replayed: z.boolean() }).strict();
const storeCreated = z.object({ store: storeSchema, replayed: z.boolean() }).strict();

export const catalogApi = ({ query, mutate, list }: PortalTools) => ({
  /** One catalogue's products: live, or test when `mode` says so. */
  products: (status: string, cursor: string | undefined, signal?: AbortSignal, mode: CatalogMode = 'live') =>
    list(
      'merchantCatalog.products.list',
      productSchema,
      { ...(mode === 'test' ? { mode } : {}), ...(status ? { status } : {}), ...(cursor ? { cursor } : {}) },
      signal,
    ),
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
  quotePrice: (input: { priceId: string; amount?: string; storeId?: string; channel?: SaleChannel }, signal?: AbortSignal) =>
    query('merchantCatalog.prices.quote', input, priceQuoteSchema, signal),
  archiveProduct: (productId: string) => mutate('merchantCatalog.products.archive', { productId }, productSchema),
  unarchiveProduct: (productId: string) => mutate('merchantCatalog.products.unarchive', { productId }, productSchema),
  deleteProduct: (productId: string) => mutate('merchantCatalog.products.delete', { productId }, productDeletedSchema),
  replacePrice: (input: PriceReplaceInput) => mutate('merchantCatalog.prices.replace', input, priceReplaceSchema),
  priceUsage: (priceId: string, signal?: AbortSignal) => query('merchantCatalog.prices.usage', { priceId }, priceUsageSchema, signal),
  pricedProduct: (priceId: string, signal?: AbortSignal) => query('merchantCatalog.prices.get', { priceId }, pricedProductSchema, signal),
  /** A dry run (`commit: false`) checks the file and writes nothing; a commit writes all of it or none. */
  importProducts: (input: { csv: string; commit: boolean; mode?: CatalogMode }) =>
    mutate('merchantCatalog.products.import', input, productImportSchema),
  /** Copy every active product of one catalogue that has no copy in the other, with its active prices. */
  copyCatalog: (from: CatalogMode, to: CatalogMode) => mutate('merchantCatalog.copy', { from, to }, catalogCopySchema),
  /** Active monthly fixed prices with one asset and amount: the ones a subscription on a mandate with those terms can start on. */
  monthlyPriceChoices: (assetId: string, amount: string, signal?: AbortSignal) =>
    query('merchantCatalog.prices.choices', { billing: 'monthly', kind: 'fixed', assetId, amount, limit: 100 }, priceChoicesSchema, signal),
  /** The business's stores (M-adv-org-access-05): open ones, or archived ones when `status` says so. */
  stores: (status: string, cursor: string | undefined, signal?: AbortSignal) =>
    list('merchantStores.list', storeSchema, { ...(status ? { status } : {}), ...(cursor ? { cursor } : {}) }, signal),
  createStore: (input: StoreCreateInput) => mutate('merchantStores.create', input, storeCreated),
  archiveStore: (storeId: string) => mutate('merchantStores.archive', { storeId }, storeSchema),
  reopenStore: (storeId: string) => mutate('merchantStores.reopen', { storeId }, storeSchema),
  /** Where one product is sold: every store of the business, each channel on or off. */
  availability: (productId: string, signal?: AbortSignal) =>
    query('merchantCatalog.availability.get', { productId }, productAvailabilitySchema, signal),
  setAvailability: (input: { productId: string; storeId: string; channel: SaleChannel; sold: boolean }) =>
    mutate('merchantCatalog.availability.set', input, productAvailabilitySchema),
});
