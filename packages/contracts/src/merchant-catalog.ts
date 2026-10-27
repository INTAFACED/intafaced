import { z } from 'zod';
import { saleChannelSchema } from './merchant-stores.js';

/**
 * The merchant's product catalogue (M-catalogue-01, J-merchant-03 steps 1 and 2): `merchantCatalog.*` on svc-pay.
 *
 * A product is a record only and moves no money; its prices are below (M-catalogue-02). Every product
 * belongs to one business and one mode (`live` today; test-mode rows come with the test and live copy of
 * M-adv-payments-core-21). Its id is the business's own choice, or one svc-pay makes, and is unique in that business
 * and mode. Reads are for every team role; adding a product is for the owner, an admin or a developer, from an
 * interactive session.
 *
 * A product image is checked against the owner's published rule (`productImageRulesSchema`): while the owner has set
 * no size, every upload refuses `pay.product_image_rules_unset` and a product can still be made without one.
 */
export const PRODUCT_TYPES = ['physical', 'digital', 'service', 'event'] as const;
export const productTypeSchema = z.enum(PRODUCT_TYPES);
export type ProductType = z.infer<typeof productTypeSchema>;

export const CATALOG_MODES = ['live', 'test'] as const;
export const catalogModeSchema = z.enum(CATALOG_MODES);

/** A chosen product id: 3 to 64 lowercase letters, digits, `-` or `_`, starting with a letter or digit. */
export const productKeySchema = z
  .string()
  .trim()
  .regex(/^[a-z0-9][a-z0-9_-]{2,63}$/, '3 to 64 lowercase letters, digits, - or _');

/**
 * What a card statement may carry: 5 to 22 characters, at least one letter, none of `< > \ ' " *` (the card
 * networks' rule for a statement descriptor). Crypto payments show none; it is kept for receipts and card rails.
 */
export const statementDescriptorSchema = z
  .string()
  .trim()
  .min(5)
  .max(22)
  .regex(/[A-Za-z]/, 'at least one letter')
  .regex(/^[^<>\\'"*]*$/, 'none of < > \\ \' " *');

const text = (max: number) => z.string().trim().min(1).max(max);
const iso = z.string().datetime({ offset: true });

/** An event's own facts: when it starts and where. Only a product of type `event` carries them, and it must. */
export const productEventSchema = z
  .object({
    startsAt: iso,
    location: text(200),
  })
  .strict();

export const productSchema = z
  .object({
    id: z.string().guid(),
    productKey: z.string(),
    mode: catalogModeSchema,
    name: z.string(),
    type: productTypeSchema,
    unitLabel: z.string().nullable(),
    statementDescriptor: z.string().nullable(),
    event: productEventSchema.nullable(),
    imageId: z.string().guid().nullable(),
    /** The product in the other catalogue this one was copied from; null for one made here. */
    copiedFrom: z.string().guid().nullable(),
    status: z.enum(['active', 'archived']),
    version: z.number().int().min(1),
    createdAt: z.string(),
    createdBy: z.string(),
    updatedAt: z.string(),
  })
  .strict();
export type MerchantProduct = z.infer<typeof productSchema>;

export const productListInputSchema = z
  .object({
    /** Which catalogue: live (left out) or test. */
    mode: catalogModeSchema.optional(),
    status: z.enum(['active', 'archived']).optional(),
    limit: z.number().int().min(1).max(100).optional(),
    cursor: z.string().min(1).max(200).optional(),
  })
  .strict();

export const productListSchema = z
  .object({
    items: z.array(productSchema),
    nextCursor: z.string().nullable(),
  })
  .strict();

export const productCreateInputSchema = z
  .object({
    /** The client's key for this one create, so a retry after a lost answer makes one product. */
    requestId: z.string().guid(),
    /** Which catalogue the product joins: live (left out) or test. */
    mode: catalogModeSchema.optional(),
    /** The business's own id for the product. Left out: svc-pay makes one. */
    productKey: productKeySchema.optional(),
    name: text(250),
    type: productTypeSchema,
    unitLabel: text(40).optional(),
    statementDescriptor: statementDescriptorSchema.optional(),
    event: productEventSchema.optional(),
    imageId: z.string().guid().optional(),
  })
  .strict();
export type ProductCreateInput = z.infer<typeof productCreateInputSchema>;

/** Any address segment: an id that names no product of this business (a typed product ID included) is not found. */
export const productGetInputSchema = z.object({ productId: z.string().min(1).max(200) }).strict();

/** The image types a product image may be. The bytes are checked, not only the name the browser gives them. */
export const PRODUCT_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;
export const productImageTypeSchema = z.enum(PRODUCT_IMAGE_TYPES);

/** The owner's rule for product images. `maxBytes` null: no size is published and every upload refuses. */
export const productImageRulesSchema = z
  .object({
    maxBytes: z.number().int().positive().nullable(),
    types: z.array(productImageTypeSchema),
  })
  .strict();
export type ProductImageRules = z.infer<typeof productImageRulesSchema>;

export const productImageUploadInputSchema = z
  .object({
    requestId: z.string().guid(),
    contentType: z.string().trim().min(1).max(100),
    /** The file, base64. Its decoded size is checked against the rule, which is at most 700 000 bytes (933 336 characters)
     * because one request carries at most 1 MiB. */
    dataBase64: z.string().min(1).max(933_336),
  })
  .strict();

export const productImageSchema = z
  .object({
    imageId: z.string().guid(),
    contentType: productImageTypeSchema,
    byteSize: z.number().int().positive(),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();

export const productImageFileSchema = productImageSchema.extend({ dataBase64: z.string() }).strict();

export const productImageGetInputSchema = z.object({ imageId: z.string().guid() }).strict();

/**
 * Prices on a product (M-catalogue-02, J-merchant-03 step 3): `merchantCatalog.prices.*` on svc-pay.
 *
 * A price is a fixed amount of one asset, charged once or every month, or a customer-chosen amount between the
 * business's own minimum and maximum (one-time only; both bounds are required, so a blank one refuses). Amounts are
 * decimal strings, never numbers. The first price of a product is its default until another is set as default. A price
 * is never edited; replacing one is a new price (M-adv-payments-core-20). `quote` answers what a price charges for an
 * amount a customer enters, refusing one outside the bounds.
 */
export const PRICE_BILLINGS = ['one_time', 'monthly'] as const;
export const priceBillingSchema = z.enum(PRICE_BILLINGS);
export type PriceBilling = z.infer<typeof priceBillingSchema>;

export const PRICE_KINDS = ['fixed', 'customer_chosen'] as const;
export const priceKindSchema = z.enum(PRICE_KINDS);

/** A positive decimal amount as typed: digits, an optional point and up to 18 places, no sign or exponent. */
export const priceAmountSchema = z
  .string()
  .trim()
  .regex(/^(?:0|[1-9][0-9]{0,19})(?:\.[0-9]{1,18})?$/, 'a decimal amount, for example 20 or 19.99');

/** An asset code as the ledger's asset registry writes it: 1 to 16 upper-case letters or digits. */
export const priceAssetSchema = z
  .string()
  .trim()
  .regex(/^[A-Z0-9]{1,16}$/, '1 to 16 upper-case letters or digits');

export const priceSchema = z
  .object({
    id: z.string().guid(),
    productId: z.string().guid(),
    billing: priceBillingSchema,
    kind: priceKindSchema,
    assetId: z.string(),
    amount: z.string().nullable(),
    minAmount: z.string().nullable(),
    maxAmount: z.string().nullable(),
    isDefault: z.boolean(),
    status: z.enum(['active', 'archived']),
    /** The price this one replaced, when it was made by Replace price. */
    replacesId: z.string().guid().nullable(),
    createdAt: z.string(),
    createdBy: z.string(),
  })
  .strict();
export type MerchantPrice = z.infer<typeof priceSchema>;

export const priceListInputSchema = z
  .object({
    productId: z.string().min(1).max(200),
    limit: z.number().int().min(1).max(100).optional(),
    cursor: z.string().min(1).max(200).optional(),
  })
  .strict();

export const priceListSchema = z
  .object({
    items: z.array(priceSchema),
    nextCursor: z.string().nullable(),
  })
  .strict();

export const priceCreateInputSchema = z
  .object({
    /** The client's key for this one create, so a retry after a lost answer makes one price. */
    requestId: z.string().guid(),
    productId: z.string().guid(),
    billing: priceBillingSchema,
    kind: priceKindSchema,
    assetId: priceAssetSchema,
    /** A fixed price's amount. */
    amount: priceAmountSchema.optional(),
    /** A customer-chosen price's bounds, both required. */
    minAmount: priceAmountSchema.optional(),
    maxAmount: priceAmountSchema.optional(),
  })
  .strict();
export type PriceCreateInput = z.infer<typeof priceCreateInputSchema>;

export const priceSetDefaultInputSchema = z.object({ productId: z.string().guid(), priceId: z.string().guid() }).strict();

export const priceQuoteInputSchema = z
  .object({
    priceId: z.string().guid(),
    /** The amount a customer entered, for a customer-chosen price. A fixed price takes none. */
    amount: priceAmountSchema.optional(),
    /**
     * Where the sale is, as a store and channel together: a product its business does not sell there is refused
     * (`pay.product_not_sold_here`). Left out: the price as it stands, anywhere.
     */
    storeId: z.string().guid().optional(),
    channel: saleChannelSchema.optional(),
  })
  .strict()
  .refine((v) => (v.storeId === undefined) === (v.channel === undefined), {
    message: 'a store and a channel go together',
    path: ['channel'],
  });

export const priceQuoteSchema = z
  .object({
    priceId: z.string().guid(),
    assetId: z.string(),
    amount: z.string(),
    billing: priceBillingSchema,
  })
  .strict();
export type PriceQuote = z.infer<typeof priceQuoteSchema>;

/** A product's id, for archiving, unarchiving or deleting it. */
export const productIdInputSchema = z.object({ productId: z.string().guid() }).strict();

export const productDeletedSchema = z.object({ productId: z.string().guid(), deleted: z.literal(true) }).strict();

/**
 * Replace a price: a new price with these details, made in the same step that archives the one it replaces
 * (M-adv-payments-core-20). Anything already using the old price stays on it.
 */
export const priceReplaceInputSchema = z.object({ ...priceCreateInputSchema.shape, priceId: z.string().guid() }).strict();
export type PriceReplaceInput = z.infer<typeof priceReplaceInputSchema>;

export const priceReplaceSchema = z
  .object({
    price: priceSchema,
    /** The old price, now archived. */
    replaced: priceSchema,
    replayed: z.boolean(),
  })
  .strict();

export const priceIdInputSchema = z.object({ priceId: z.string().guid() }).strict();

/** What uses a price, so Replace price can say it before anything is changed. */
export const priceUsageSchema = z
  .object({
    priceId: z.string().guid(),
    /** Subscriptions started on this price that have not ended (active or paused). */
    openSubscriptions: z.number().int().nonnegative(),
  })
  .strict();

/** A price with the product it belongs to, so a document that names a price can still read both once they are archived. */
export const pricedProductSchema = z
  .object({
    price: priceSchema,
    product: z
      .object({
        id: z.string().guid(),
        productKey: z.string(),
        name: z.string(),
        status: z.enum(['active', 'archived']),
      })
      .strict(),
  })
  .strict();
export type PricedProduct = z.infer<typeof pricedProductSchema>;

/** The prices a picker offers: active prices of active products only, newest price first. */
export const priceChoicesInputSchema = z
  .object({
    billing: priceBillingSchema.optional(),
    kind: priceKindSchema.optional(),
    assetId: priceAssetSchema.optional(),
    /** A fixed price's amount, compared as a number ("5" is "5.00"). */
    amount: priceAmountSchema.optional(),
    limit: z.number().int().min(1).max(100).optional(),
    cursor: z.string().min(1).max(200).optional(),
  })
  .strict();

export const priceChoicesSchema = z
  .object({
    items: z.array(pricedProductSchema),
    nextCursor: z.string().nullable(),
  })
  .strict();

/**
 * A file of products (J-merchant-03 step 5, M-catalogue-01, M-adv-payments-core-21): CSV, one header line then one
 * product a line. `name` and `type` are required columns; the others may be left out or left blank. A dry run checks
 * every line and writes nothing; a commit writes every product in one step, and only when no line has a problem. The
 * file is its own key: the same file again, byte for byte, answers with what it made and makes nothing.
 */
export const PRODUCT_IMPORT_COLUMNS = [
  'name',
  'type',
  'product_id',
  'unit_label',
  'statement_descriptor',
  'event_starts_at',
  'event_location',
] as const;
export const productImportColumnSchema = z.enum(PRODUCT_IMPORT_COLUMNS);
export type ProductImportColumn = z.infer<typeof productImportColumnSchema>;

/** At most this many products a file. A longer file is refused whole (`pay.product_import_too_many_rows`). */
export const PRODUCT_IMPORT_MAX_ROWS = 500;
/** At most this many characters a file, so one request stays under the 1 MiB body limit even when every character is
 * one JSON writes as six bytes (`\u0001`). */
export const PRODUCT_IMPORT_MAX_CHARS = 150_000;
/** At most this many problems are listed; `problemCount` counts them all. */
export const PRODUCT_IMPORT_MAX_PROBLEMS = 100;

export const PRODUCT_IMPORT_PROBLEMS = [
  /** A header names a column the file format does not have. */
  'column_unknown',
  /** A header names one column twice. */
  'column_repeated',
  /** The header lacks `name` or `type`. */
  'column_missing',
  /** A line has more or fewer cells than the header. */
  'row_width',
  /** A quoted cell is never closed. */
  'quote_unclosed',
  'value_required',
  'value_invalid',
  'value_too_long',
  /** The product id is already one of this business's products. */
  'id_taken',
  /** Two lines of the file choose the same product id. */
  'id_repeated',
  /** An event needs both a start time and a location. */
  'event_details_required',
  /** Only an event carries a start time or a location. */
  'event_details_not_event',
] as const;
export const productImportProblemKindSchema = z.enum(PRODUCT_IMPORT_PROBLEMS);

export const productImportInputSchema = z
  .object({
    /** The file's text, as read. */
    csv: z.string().min(1).max(PRODUCT_IMPORT_MAX_CHARS),
    /** false: a dry run, which writes nothing. */
    commit: z.boolean(),
    /** Which catalogue the file's products join: live (left out) or test. */
    mode: catalogModeSchema.optional(),
  })
  .strict();

export const productImportProblemSchema = z
  .object({
    /** The file's line the problem is on; the header is line 1. A quoted cell may span lines: its row's first line. */
    line: z.number().int().min(1),
    /** The column the problem is in; null for a problem with the whole line. */
    column: z.string().nullable(),
    problem: productImportProblemKindSchema,
  })
  .strict();
export type ProductImportProblem = z.infer<typeof productImportProblemSchema>;

export const productImportSchema = z
  .object({
    /** The file's SHA-256, its key. */
    fileSha256: z.string().regex(/^[0-9a-f]{64}$/),
    /** Product lines in the file. */
    rows: z.number().int().nonnegative(),
    /** The first problems, in line order; none when the file can be imported. */
    problems: z.array(productImportProblemSchema).max(PRODUCT_IMPORT_MAX_PROBLEMS),
    problemCount: z.number().int().nonnegative(),
    /** The file's products are in the catalogue, from this request or an earlier one. */
    imported: z.boolean(),
    /** An earlier request imported this file; nothing was made now. */
    replayed: z.boolean(),
    importedAt: z.string().nullable(),
    /** The products the file made, in file order; a product deleted since is left out. Empty until imported. */
    products: z.array(productSchema),
  })
  .strict();
export type ProductImport = z.infer<typeof productImportSchema>;

/**
 * Copying the catalogue between test and live (J-merchant-03 step 6, M-adv-payments-core-21). Every active product of
 * one catalogue that has no copy in the other is copied with its active prices, keyed by (source product, target
 * catalogue): a second copy makes nothing new. A product whose id the other catalogue already uses for a product of its
 * own is skipped, and so is an archived one.
 */
export const catalogCopyInputSchema = z
  .object({ from: catalogModeSchema, to: catalogModeSchema })
  .strict()
  .refine((v) => v.from !== v.to, { message: 'from and to must differ', path: ['to'] });

/**
 * At most this many products are copied in one step, and one step reads at most `CATALOG_COPY_MAX_READ` products of
 * the source catalogue (those skipped included); more of either is refused whole (`pay.catalog_copy_too_large`).
 */
export const CATALOG_COPY_MAX_PRODUCTS = 500;
export const CATALOG_COPY_MAX_READ = 5000;

export const CATALOG_COPY_SKIPS = [
  /** The other catalogue already holds this product's copy. */
  'copied_before',
  /** A product of the other catalogue already has this product id. */
  'id_taken',
  /** The product is archived. */
  'archived',
] as const;

export const catalogCopySchema = z
  .object({
    from: catalogModeSchema,
    to: catalogModeSchema,
    created: z.array(
      z
        .object({
          sourceId: z.string().guid(),
          productId: z.string().guid(),
          productKey: z.string(),
          name: z.string(),
          /** Active prices copied with it. */
          prices: z.number().int().nonnegative(),
        })
        .strict(),
    ),
    skipped: z.array(
      z
        .object({
          sourceId: z.string().guid(),
          productKey: z.string(),
          name: z.string(),
          reason: z.enum(CATALOG_COPY_SKIPS),
          /** The product in the other catalogue that is the copy, or that holds the id; null for an archived one. */
          productId: z.string().guid().nullable(),
        })
        .strict(),
    ),
  })
  .strict();
export type CatalogCopy = z.infer<typeof catalogCopySchema>;
