import { z } from 'zod';

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
  })
  .strict();

export const priceQuoteSchema = z
  .object({
    priceId: z.string().guid(),
    assetId: z.string(),
    amount: z.string(),
    billing: priceBillingSchema,
  })
  .strict();
export type PriceQuote = z.infer<typeof priceQuoteSchema>;
