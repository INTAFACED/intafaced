import { z } from 'zod';
import { payAmountStringSchema, payAssetCodeSchema, payMerchantIdSchema, payTimestampSchema } from './merchant-control.js';
import { payListCursorSchema, payListSearchSchema, payPageSchema } from './pay-merchant-reads.js';

/**
 * Payment link create and re-read.
 *
 * The token is the public checkout credential. Create returns it, and a later
 * read by a caller who can see the link returns it again, with the checkout
 * path. A link minted before the credential was stored has a null token and a
 * null checkoutUrl. Nothing here invents a host, a fee, or a lifetime.
 *
 * `idempotencyKey` is optional. Blank and oversized keys are refused in the
 * service as `pay.idempotency_required`, not by this schema, so the refusal
 * stays that pay code.
 */

const pageLimitSchema = z.number().int().min(1).max(200).optional();

export const payCreateLinkInputSchema = z
  .object({
    merchantId: payMerchantIdSchema,
    label: z.string().min(1).max(120),
    profileId: z.string().guid().nullish(),
    amount: payAmountStringSchema.optional(),
    currency: payAssetCodeSchema.optional(),
    /** Omit for the service default. A link with no expiry cannot be created. */
    expiresAt: payTimestampSchema.optional(),
    /** Completed payments this link may take. Omit for unbounded. */
    maxUses: z.number().int().min(1).max(1_000_000).optional(),
    idempotencyKey: z.string().optional(),
  })
  .strict();
export type PayCreateLinkInput = z.infer<typeof payCreateLinkInputSchema>;

export const payCreateLinkOutputSchema = z
  .object({
    id: z.string().guid(),
    token: z.string().min(8).max(200),
    prefix: z.string().min(1).max(64),
    label: z.string(),
    /** Always a date. The service defaults and caps it; it is never null. */
    expiresAt: payTimestampSchema,
    maxUses: z.number().int().nullable(),
    checkoutUrl: z.string().min(1).max(2048),
  })
  .strict();
export type PayCreateLinkOutput = z.infer<typeof payCreateLinkOutputSchema>;

export const payLinkListInputSchema = z
  .object({
    merchantId: payMerchantIdSchema,
    /**
     * Page size. Optional so omit reaches `pay.payment_link_list_limit_unset`
     * instead of a parser "Required". Blank is not 50; pass 50 explicitly.
     */
    limit: pageLimitSchema,
    cursor: payListCursorSchema.optional(),
    search: payListSearchSchema.optional(),
    assetId: z.string().trim().min(1).max(16).optional(),
    from: payTimestampSchema.optional(),
    to: payTimestampSchema.optional(),
    active: z.boolean().optional(),
  })
  .strict();

export const payLinkListItemSchema = z
  .object({
    id: z.string().guid(),
    prefix: z.string().min(1).max(64),
    label: z.string(),
    amount: payAmountStringSchema.nullable(),
    currency: z.string().nullable(),
    active: z.boolean(),
    expiresAt: z.string().nullable(),
    maxUses: z.number().int().nullable(),
    uses: z.number().int(),
    createdAt: z.string(),
    /** Null when this link was minted before the credential was stored. */
    token: z.string().min(8).max(200).nullable(),
    /** Null when `token` is null. A path, not an invented host. */
    checkoutUrl: z.string().min(1).max(2048).nullable(),
  })
  .strict();
export type PayLinkListItem = z.infer<typeof payLinkListItemSchema>;

export const payLinkListPageSchema = payPageSchema(payLinkListItemSchema);

export const payGetLinkInputSchema = z
  .object({
    merchantId: payMerchantIdSchema,
    linkId: z.string().guid(),
  })
  .strict();
export type PayGetLinkInput = z.infer<typeof payGetLinkInputSchema>;
