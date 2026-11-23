import { z } from 'zod';
import {
  priceChoicesSchema,
  priceQuoteSchema,
  productSchema,
  type PriceCreateInput,
  type PricedProduct,
  type PriceReplaceInput,
  type ProductCreateInput,
} from '@intafaced/contracts/merchant-catalog';
import { storeSchema, type SaleChannel, type StoreCreateInput } from '@intafaced/contracts/merchant-stores';
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
  PAY_MERCHANT_CATALOG_PRODUCTS_CREATE,
  PAY_MERCHANT_CATALOG_IMAGES_UPLOAD,
  PAY_MERCHANT_CATALOG_PRICES_CREATE,
  PAY_MERCHANT_CATALOG_PRICES_SET_DEFAULT,
  PAY_MERCHANT_CATALOG_PRODUCTS_ARCHIVE,
  PAY_MERCHANT_CATALOG_PRODUCTS_UNARCHIVE,
  PAY_MERCHANT_CATALOG_PRODUCTS_DELETE,
  PAY_MERCHANT_CATALOG_PRICES_REPLACE,
  PAY_MERCHANT_CATALOG_PRODUCTS_IMPORT,
  PAY_MERCHANT_CATALOG_COPY,
  PAY_MERCHANT_CATALOG_AVAILABILITY_SET,
} from '@intafaced/contracts/pay-merchant-catalog-procedures';
import { PAY_MERCHANT_STORES_ARCHIVE, PAY_MERCHANT_STORES_REOPEN } from '@intafaced/contracts/pay-merchant-stores-procedures';

// The product catalogue and its prices (J-merchant-03 steps 1 to 6, M-catalogue-01 and -02, M-adv-payments-core-20 and -21): svc-pay `merchantCatalog.*`, parsed with the
// service's own schemas. The business is the signed-in person's own; the service resolves it and checks the role.

type CatalogMode = 'live' | 'test';

/** How many pages of 100 the link price picker reads: a business's newest 1,000 one-time prices. */
export const LINK_PRICE_PAGES = 10;

const storeCreated = z.object({ store: storeSchema, replayed: z.boolean() }).strict();

export const catalogApi = ({ query, mutate, list, queryRecord, listRecord, mutateRecord }: PortalTools) => ({
  /** One catalogue's products: live, or test when `mode` says so. */
  products: (status: string, cursor: string | undefined, signal?: AbortSignal, mode: CatalogMode = 'live') =>
    list(
      'merchantCatalog.products.list',
      productSchema,
      { ...(mode === 'test' ? { mode } : {}), ...(status ? { status } : {}), ...(cursor ? { cursor } : {}) },
      signal,
    ),
  product: (productId: string, signal?: AbortSignal) => queryRecord(PAY_MERCHANT_CATALOG_PRODUCTS_GET, { productId }, signal),
  createProduct: (input: ProductCreateInput) => mutateRecord(PAY_MERCHANT_CATALOG_PRODUCTS_CREATE, input),
  productImageRules: (signal?: AbortSignal) => queryRecord(PAY_MERCHANT_CATALOG_IMAGES_RULES, {}, signal),
  uploadProductImage: (input: { requestId: string; contentType: string; dataBase64: string }) =>
    mutateRecord(PAY_MERCHANT_CATALOG_IMAGES_UPLOAD, input),
  productImage: (imageId: string, signal?: AbortSignal) => queryRecord(PAY_MERCHANT_CATALOG_IMAGES_GET, { imageId }, signal),
  prices: (productId: string, cursor: string | undefined, signal?: AbortSignal) =>
    listRecord(PAY_MERCHANT_CATALOG_PRICES_LIST, { productId, ...(cursor ? { cursor } : {}) }, signal),
  createPrice: (input: PriceCreateInput) => mutateRecord(PAY_MERCHANT_CATALOG_PRICES_CREATE, input),
  setDefaultPrice: (input: { productId: string; priceId: string }) => mutateRecord(PAY_MERCHANT_CATALOG_PRICES_SET_DEFAULT, input),
  quotePrice: (input: { priceId: string; amount?: string; storeId?: string; channel?: SaleChannel }, signal?: AbortSignal) =>
    query('merchantCatalog.prices.quote', input, priceQuoteSchema, signal),
  archiveProduct: (productId: string) => mutateRecord(PAY_MERCHANT_CATALOG_PRODUCTS_ARCHIVE, { productId }),
  unarchiveProduct: (productId: string) => mutateRecord(PAY_MERCHANT_CATALOG_PRODUCTS_UNARCHIVE, { productId }),
  deleteProduct: (productId: string) => mutateRecord(PAY_MERCHANT_CATALOG_PRODUCTS_DELETE, { productId }),
  replacePrice: (input: PriceReplaceInput) => mutateRecord(PAY_MERCHANT_CATALOG_PRICES_REPLACE, input),
  priceUsage: (priceId: string, signal?: AbortSignal) => queryRecord(PAY_MERCHANT_CATALOG_PRICES_USAGE, { priceId }, signal),
  pricedProduct: (priceId: string, signal?: AbortSignal) => queryRecord(PAY_MERCHANT_CATALOG_PRICES_GET, { priceId }, signal),
  /** A dry run (`commit: false`) checks the file and writes nothing; a commit writes all of it or none. */
  importProducts: (input: { csv: string; commit: boolean; mode?: CatalogMode }) =>
    mutateRecord(PAY_MERCHANT_CATALOG_PRODUCTS_IMPORT, input),
  /** Copy every active product of one catalogue that has no copy in the other, with its active prices. */
  copyCatalog: (from: CatalogMode, to: CatalogMode) => mutateRecord(PAY_MERCHANT_CATALOG_COPY, { from, to }),
  /** Active monthly fixed prices with one asset and amount: the ones a subscription on a mandate with those terms can start on. */
  monthlyPriceChoices: (assetId: string, amount: string, signal?: AbortSignal) =>
    query('merchantCatalog.prices.choices', { billing: 'monthly', kind: 'fixed', assetId, amount, limit: 100 }, priceChoicesSchema, signal),
  /**
   * Active one-time fixed prices of active products: the ones a payment link can sell (M-catalogue-03). Every page up to
   * `LINK_PRICE_PAGES` of 100, newest first; `more` says older ones were left out.
   */
  async linkPriceChoices(signal?: AbortSignal) {
    const items: PricedProduct[] = [];
    let cursor: string | null = null;
    for (let read = 0; read < LINK_PRICE_PAGES; read += 1) {
      const page: ApiResult<z.infer<typeof priceChoicesSchema>> = await query(
        'merchantCatalog.prices.choices',
        { billing: 'one_time', kind: 'fixed', limit: 100, ...(cursor ? { cursor } : {}) },
        priceChoicesSchema,
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
    list('merchantStores.list', storeSchema, { ...(status ? { status } : {}), ...(cursor ? { cursor } : {}) }, signal),
  createStore: (input: StoreCreateInput) => mutate('merchantStores.create', input, storeCreated),
  archiveStore: (storeId: string) => mutateRecord(PAY_MERCHANT_STORES_ARCHIVE, { storeId }),
  reopenStore: (storeId: string) => mutateRecord(PAY_MERCHANT_STORES_REOPEN, { storeId }),
  /** Where one product is sold: every store of the business, each channel on or off. */
  availability: (productId: string, signal?: AbortSignal) => queryRecord(PAY_MERCHANT_CATALOG_AVAILABILITY_GET, { productId }, signal),
  setAvailability: (input: { productId: string; storeId: string; channel: SaleChannel; sold: boolean }) =>
    mutateRecord(PAY_MERCHANT_CATALOG_AVAILABILITY_SET, input),
});
