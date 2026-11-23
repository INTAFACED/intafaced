import { z } from 'zod';
import {
  priceReplaceSchema,
  priceSchema,
  catalogCopySchema,
  productDeletedSchema,
  productImageSchema,
  productImportSchema,
  productSchema,
  type PriceCreateInput,
  type PricedProduct,
  type PriceReplaceInput,
  type ProductCreateInput,
} from '@intafaced/contracts/merchant-catalog';
import { productAvailabilitySchema, storeSchema, type SaleChannel, type StoreCreateInput } from '@intafaced/contracts/merchant-stores';
import type { ApiResult } from '../../../../shared/api';
import type { PortalTools } from '../api-tools';
import './refusals';
import {
  PAY_MERCHANT_CATALOG_PRODUCTS_GET,
  PAY_MERCHANT_CATALOG_IMAGES_RULES,
  PAY_MERCHANT_CATALOG_IMAGES_GET,
  PAY_MERCHANT_CATALOG_PRICES_LIST,
  PAY_MERCHANT_CATALOG_PRICES_USAGE,
  PAY_MERCHANT_CATALOG_PRICES_GET,
  PAY_MERCHANT_CATALOG_AVAILABILITY_GET,
  PAY_MERCHANT_CATALOG_PRODUCTS_LIST,
  PAY_MERCHANT_CATALOG_PRICES_QUOTE,
  PAY_MERCHANT_CATALOG_PRICES_CHOICES,
} from '@intafaced/contracts/pay-merchant-catalog-procedures';
import { PAY_MERCHANT_STORES_LIST } from '@intafaced/contracts/pay-merchant-stores-procedures';
import { type ProcedureOutput } from '@intafaced/contracts/procedure';

// The product catalogue and its prices (J-merchant-03 steps 1 to 6, M-catalogue-01 and -02, M-adv-payments-core-20 and -21): svc-pay `merchantCatalog.*`, parsed with the
// service's own schemas. The business is the signed-in person's own; the service resolves it and checks the role.

type CatalogMode = 'live' | 'test';

/** How many pages of 100 the link price picker reads: a business's newest 1,000 one-time prices. */
export const LINK_PRICE_PAGES = 10;

const created = z.object({ product: productSchema, replayed: z.boolean() }).strict();
const priceCreated = z.object({ price: priceSchema, replayed: z.boolean() }).strict();
const storeCreated = z.object({ store: storeSchema, replayed: z.boolean() }).strict();

export const catalogApi = ({ mutate, queryRecord, listRecord }: PortalTools) => ({
  /** One catalogue's products: live, or test when `mode` says so. */
  products: (status: string, cursor: string | undefined, signal?: AbortSignal, mode: CatalogMode = 'live') =>
    listRecord(
      PAY_MERCHANT_CATALOG_PRODUCTS_LIST,
      { ...(mode === 'test' ? { mode } : {}), ...(status ? { status } : {}), ...(cursor ? { cursor } : {}) },
      signal,
    ),
  product: (productId: string, signal?: AbortSignal) => queryRecord(PAY_MERCHANT_CATALOG_PRODUCTS_GET, { productId }, signal),
  createProduct: (input: ProductCreateInput) => mutate('merchantCatalog.products.create', input, created),
  productImageRules: (signal?: AbortSignal) => queryRecord(PAY_MERCHANT_CATALOG_IMAGES_RULES, {}, signal),
  uploadProductImage: (input: { requestId: string; contentType: string; dataBase64: string }) =>
    mutate('merchantCatalog.images.upload', input, productImageSchema),
  productImage: (imageId: string, signal?: AbortSignal) => queryRecord(PAY_MERCHANT_CATALOG_IMAGES_GET, { imageId }, signal),
  prices: (productId: string, cursor: string | undefined, signal?: AbortSignal) =>
    listRecord(PAY_MERCHANT_CATALOG_PRICES_LIST, { productId, ...(cursor ? { cursor } : {}) }, signal),
  createPrice: (input: PriceCreateInput) => mutate('merchantCatalog.prices.create', input, priceCreated),
  setDefaultPrice: (input: { productId: string; priceId: string }) => mutate('merchantCatalog.prices.setDefault', input, priceSchema),
  quotePrice: (input: { priceId: string; amount?: string; storeId?: string; channel?: SaleChannel }, signal?: AbortSignal) =>
    queryRecord(PAY_MERCHANT_CATALOG_PRICES_QUOTE, input, signal),
  archiveProduct: (productId: string) => mutate('merchantCatalog.products.archive', { productId }, productSchema),
  unarchiveProduct: (productId: string) => mutate('merchantCatalog.products.unarchive', { productId }, productSchema),
  deleteProduct: (productId: string) => mutate('merchantCatalog.products.delete', { productId }, productDeletedSchema),
  replacePrice: (input: PriceReplaceInput) => mutate('merchantCatalog.prices.replace', input, priceReplaceSchema),
  priceUsage: (priceId: string, signal?: AbortSignal) => queryRecord(PAY_MERCHANT_CATALOG_PRICES_USAGE, { priceId }, signal),
  pricedProduct: (priceId: string, signal?: AbortSignal) => queryRecord(PAY_MERCHANT_CATALOG_PRICES_GET, { priceId }, signal),
  /** A dry run (`commit: false`) checks the file and writes nothing; a commit writes all of it or none. */
  importProducts: (input: { csv: string; commit: boolean; mode?: CatalogMode }) =>
    mutate('merchantCatalog.products.import', input, productImportSchema),
  /** Copy every active product of one catalogue that has no copy in the other, with its active prices. */
  copyCatalog: (from: CatalogMode, to: CatalogMode) => mutate('merchantCatalog.copy', { from, to }, catalogCopySchema),
  /** Active monthly fixed prices with one asset and amount: the ones a subscription on a mandate with those terms can start on. */
  monthlyPriceChoices: (assetId: string, amount: string, signal?: AbortSignal) =>
    queryRecord(PAY_MERCHANT_CATALOG_PRICES_CHOICES, { billing: 'monthly', kind: 'fixed', assetId, amount, limit: 100 }, signal),
  /**
   * Active one-time fixed prices of active products: the ones a payment link can sell (M-catalogue-03). Every page up to
   * `LINK_PRICE_PAGES` of 100, newest first; `more` says older ones were left out.
   */
  async linkPriceChoices(signal?: AbortSignal) {
    const items: PricedProduct[] = [];
    let cursor: string | null = null;
    for (let read = 0; read < LINK_PRICE_PAGES; read += 1) {
      const page: ApiResult<ProcedureOutput<typeof PAY_MERCHANT_CATALOG_PRICES_CHOICES>> = await queryRecord(
        PAY_MERCHANT_CATALOG_PRICES_CHOICES,
        { billing: 'one_time', kind: 'fixed', limit: 100, ...(cursor ? { cursor } : {}) },
        signal,
      );
      if (!page.ok) return page;
      items.push(...page.data.items);
      cursor = page.data.nextCursor;
      if (!cursor) return { ok: true as const, data: { items, more: false } };
    }
    return { ok: true as const, data: { items, more: true } };
  },
  /** The business's stores (M-adv-org-access-05): open ones, or archived ones when `status` says so. */
  stores: (status: string, cursor: string | undefined, signal?: AbortSignal) =>
    listRecord(PAY_MERCHANT_STORES_LIST, { ...(status ? { status } : {}), ...(cursor ? { cursor } : {}) }, signal),
  createStore: (input: StoreCreateInput) => mutate('merchantStores.create', input, storeCreated),
  archiveStore: (storeId: string) => mutate('merchantStores.archive', { storeId }, storeSchema),
  reopenStore: (storeId: string) => mutate('merchantStores.reopen', { storeId }, storeSchema),
  /** Where one product is sold: every store of the business, each channel on or off. */
  availability: (productId: string, signal?: AbortSignal) => queryRecord(PAY_MERCHANT_CATALOG_AVAILABILITY_GET, { productId }, signal),
  setAvailability: (input: { productId: string; storeId: string; channel: SaleChannel; sold: boolean }) =>
    mutate('merchantCatalog.availability.set', input, productAvailabilitySchema),
});
