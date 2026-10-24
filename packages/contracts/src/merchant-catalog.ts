import { z } from 'zod';

/**
 * The merchant's product catalogue (M-catalogue-01, J-merchant-03 steps 1 and 2): `merchantOps.catalog.*` on svc-pay.
 *
 * A product is a record only. It holds no price and moves no money; prices come with M-catalogue-02. Every product
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

export const productGetInputSchema = z.object({ productId: z.string().guid() }).strict();

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
    /** The file, base64. Its decoded size is checked against the rule. */
    dataBase64: z.string().min(1).max(12_000_000),
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
