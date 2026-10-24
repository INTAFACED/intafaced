import { z } from 'zod';
import { isTimeZone } from './ops-console-preferences.js';

/**
 * A business's stores and where its products are sold (M-adv-org-access-05, M-adv-payments-core-21; J-merchant-03 step
 * 6): `merchantStores.*` and `merchantCatalog.availability.*` on svc-pay.
 *
 * A store is a place of sale with a name (unique in the business), an optional address and an IANA time zone. Every
 * store sells through the same three channels. A store is archived, never deleted. A product is sold in every store
 * and channel until the business turns one off; a price check for that store and channel then refuses
 * (`pay.product_not_sold_here`). A sale with no store named (a subscription, a link) is not limited by it. Nothing here moves money. Reads are for every team role; changes are for the roles
 * that manage products, from an interactive session.
 */
export const SALE_CHANNELS = ['online', 'in_person', 'invoice'] as const;
export const saleChannelSchema = z.enum(SALE_CHANNELS);
export type SaleChannel = z.infer<typeof saleChannelSchema>;

const text = (max: number) => z.string().trim().min(1).max(max);

/** An IANA time zone this runtime knows, such as `Europe/Berlin` (no bare offset), kept in its canonical spelling. */
export const storeTimezoneSchema = z
  .string()
  .trim()
  .refine(isTimeZone, { message: 'an IANA time zone, such as Europe/Berlin' })
  .transform((zone) => new Intl.DateTimeFormat('en-GB', { timeZone: zone }).resolvedOptions().timeZone);

export const storeSchema = z
  .object({
    id: z.string().guid(),
    name: z.string(),
    address: z.string().nullable(),
    timezone: z.string(),
    status: z.enum(['active', 'archived']),
    version: z.number().int(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .strict();
export type MerchantStore = z.infer<typeof storeSchema>;

export const storeListInputSchema = z
  .object({
    status: z.enum(['active', 'archived']).optional(),
    limit: z.number().int().min(1).max(100).optional(),
    cursor: z.string().min(1).max(200).optional(),
  })
  .strict();

export const storeListSchema = z.object({ items: z.array(storeSchema), nextCursor: z.string().nullable() }).strict();

export const storeCreateInputSchema = z
  .object({
    /** The client's key for this one create, so a retry after a lost answer makes one store. */
    requestId: z.string().guid(),
    name: text(80),
    address: text(300).optional(),
    timezone: storeTimezoneSchema,
  })
  .strict();
export type StoreCreateInput = z.infer<typeof storeCreateInputSchema>;

export const storeIdInputSchema = z.object({ storeId: z.string().guid() }).strict();

/** Where one product is sold: each store of the business (archived ones too), with each channel on or off. */
export const productAvailabilitySchema = z
  .object({
    productId: z.string().guid(),
    stores: z.array(
      z
        .object({
          storeId: z.string().guid(),
          name: z.string(),
          status: z.enum(['active', 'archived']),
          channels: z.object({ online: z.boolean(), in_person: z.boolean(), invoice: z.boolean() }).strict(),
        })
        .strict(),
    ),
  })
  .strict();
export type ProductAvailability = z.infer<typeof productAvailabilitySchema>;

export const productAvailabilitySetInputSchema = z
  .object({
    productId: z.string().guid(),
    storeId: z.string().guid(),
    channel: saleChannelSchema,
    /** Sold there (true) or not (false). Setting what is already set changes nothing. */
    sold: z.boolean(),
  })
  .strict();
