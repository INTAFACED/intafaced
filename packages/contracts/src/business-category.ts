import { z } from 'zod';

/**
 * Business categories (RC-merchant-08, J-merchant-02 step 7): which kinds of business INTAFACED takes, and on what
 * terms. The owner keeps one versioned table; every edit needs a second founder. A business picks its category, and
 * the class of that category decides what it may do:
 *
 *  - `standard` (OWNER 108): an ordinary verified business. Every rail the platform has (cards, crypto-native and bank
 *    transfer), no extra documents, no reserve.
 *  - `permissionless`: crypto-native payments only, no extra documents.
 *  - `restricted`: no card payments (card rails are removed; crypto-native and bank transfer still work), extra
 *    verification documents, and reserve terms. Blank reserve terms keep the business from going live (`pay.reserve_terms_unset`); nothing is invented.
 *  - `prohibited`: INTAFACED does not take this business; every payment and checkout session is refused
 *    (`pay.category_prohibited`) before any row exists.
 *
 * While the table is empty no business can choose a category and none can go live
 * (`pay.business_category_policy_unset`). A reserve term is a policy value only: holding a reserve is a later ledger
 * movement and nothing here moves money.
 */
export const BUSINESS_CATEGORY_CLASSES = ['standard', 'permissionless', 'restricted', 'prohibited'] as const;
export const businessCategoryClassSchema = z.enum(BUSINESS_CATEGORY_CLASSES);
export type BusinessCategoryClass = z.infer<typeof businessCategoryClassSchema>;

/**
 * The rails a business of each limited class may take payments on (a `standard` one is not limited). Source: the RC-merchant-08 spec (merchant recon of
 * 2026-10-20): "permissionless (crypto-native only)", and "a restricted category removes card rails from rail selection"
 * with "crypto-native still works". So a restricted business keeps every rail that is not a card rail: crypto-native and
 * the bank-transfer rail (`bank-transfer-sandbox`, the only one registered). It is a list rather than "every rail but
 * cards" so a rail added later is refused to both classes until it is named here.
 */
export const CATEGORY_CLASS_RAILS: Readonly<Record<'permissionless' | 'restricted', readonly string[]>> = {
  permissionless: ['crypto-native'],
  restricted: ['crypto-native', 'bank-transfer-sandbox'],
};

export const businessCategoryKeySchema = z.string().regex(/^[a-z][a-z0-9-]{1,62}$/, 'lowercase letters, digits and hyphens');

/** Characters as people count them (code points), the way the stored text is checked. */
const charCount = (text: string): number => [...text].length;
const words = (min: number, max: number) =>
  z
    .string()
    .trim()
    .refine((text) => charCount(text) >= min && charCount(text) <= max, `${min} to ${max} characters`);

/** A percent with at most two decimals, above 0 and at most 100. A decimal string, never a number. */
export const reservePercentSchema = z
  .string()
  .regex(/^(?:100(?:\.0{1,2})?|[0-9]{1,2}(?:\.[0-9]{1,2})?)$/, 'a percent such as 5 or 7.5')
  .refine((text) => !/^0+(?:\.0+)?$/.test(text), 'above 0');

export const reserveTermsSchema = z
  .object({
    percent: reservePercentSchema,
    /** How long each reserved part is held, in days. */
    holdDays: z.number().int().min(1).max(3650),
  })
  .strict();
export type ReserveTerms = z.infer<typeof reserveTermsSchema>;

/** What a category says, as the business reads it. */
export const businessCategoryTermsSchema = z
  .object({
    key: businessCategoryKeySchema,
    label: z.string(),
    class: businessCategoryClassSchema,
    /** Restricted only. Null on a restricted category means the owner has not set them. */
    reserve: reserveTermsSchema.nullable(),
    /** Restricted only: what more the business must send for verification. */
    extraDocuments: z.array(z.string()),
  })
  .strict();
export type BusinessCategoryTerms = z.infer<typeof businessCategoryTermsSchema>;

export const businessCategorySchema = businessCategoryTermsSchema
  .extend({
    version: z.number().int().min(1),
    updatedAt: z.string(),
    updatedBy: z.string(),
    approvedBy: z.string(),
  })
  .strict();
export type BusinessCategory = z.infer<typeof businessCategorySchema>;

export const categoryPolicyViewSchema = z
  .object({
    /** Goes up by one on every edit; 0 while the table is empty. */
    tableVersion: z.number().int().min(0),
    categories: z.array(businessCategorySchema),
  })
  .strict();
export type CategoryPolicyView = z.infer<typeof categoryPolicyViewSchema>;

const categoryChangeShape = {
  key: businessCategoryKeySchema,
  label: words(2, 120),
  class: businessCategoryClassSchema,
  reserve: reserveTermsSchema.nullable(),
  extraDocuments: z.array(words(3, 200)).max(20),
  /** The version the entry was loaded at; null adds a new category. */
  expectedVersion: z.number().int().min(1).nullable(),
  reason: words(3, 500),
};

const restrictedOnly = (change: { class: BusinessCategoryClass; reserve: unknown; extraDocuments: unknown[] }) =>
  change.class === 'restricted' || (change.reserve === null && change.extraDocuments.length === 0);
const restrictedOnlyMessage = { message: 'Reserve terms and extra documents belong to a restricted category only', path: ['class'] };

export const categoryPolicyPreviewInputSchema = z.object(categoryChangeShape).strict().refine(restrictedOnly, restrictedOnlyMessage);
export type CategoryPolicyPreviewInput = z.infer<typeof categoryPolicyPreviewInputSchema>;

export const categoryPolicySetInputSchema = z
  .object({
    ...categoryChangeShape,
    /** The second founder's approval for exactly this change (from `preview`'s hash). */
    approvalId: z.string().min(1).max(128),
    operationId: z.string().min(1).max(128),
  })
  .strict()
  .refine(restrictedOnly, restrictedOnlyMessage);
export type CategoryPolicySetInput = z.infer<typeof categoryPolicySetInputSchema>;

export const categoryPolicyPreviewSchema = z
  .object({
    /** Every edit of the table needs a second founder. */
    needsDualControl: z.literal(true),
    reasons: z.array(z.string()),
    actionType: z.string(),
    payloadHash: z.string(),
  })
  .strict();
export type CategoryPolicyPreview = z.infer<typeof categoryPolicyPreviewSchema>;

export const categoryPolicyEventSchema = z
  .object({
    seq: z.number().int().min(1),
    key: businessCategoryKeySchema,
    actorId: z.string(),
    approverId: z.string(),
    before: businessCategoryTermsSchema.nullable(),
    after: businessCategoryTermsSchema,
    reason: z.string(),
    createdAt: z.string(),
  })
  .strict();
export type CategoryPolicyEvent = z.infer<typeof categoryPolicyEventSchema>;

export const categoryPolicyHistoryInputSchema = z
  .object({ key: businessCategoryKeySchema.optional(), limit: z.number().int().min(1).max(200).default(50) })
  .strict();

export const categoryPolicyListInputSchema = z.object({}).strict().optional();

/** A business's own category, and the table it chooses from. */
export const merchantCategoryViewSchema = z
  .object({
    merchantId: z.string().guid(),
    /** An empty list means no rule is set yet: the business cannot choose and cannot go live. */
    policy: z.object({ tableVersion: z.number().int().min(0), categories: z.array(businessCategoryTermsSchema) }).strict(),
    /** The category as it reads now; null until the business chooses. */
    chosen: z
      .object({
        category: businessCategoryTermsSchema,
        /** The table version the business chose against. */
        tableVersion: z.number().int().min(1),
        chosenAt: z.string(),
      })
      .strict()
      .nullable(),
    /** True once the business is verified: then only INTAFACED operations changes the category. */
    locked: z.boolean(),
  })
  .strict();
export type MerchantCategoryView = z.infer<typeof merchantCategoryViewSchema>;

export const merchantCategoryGetInputSchema = z.object({ merchantId: z.string().guid() }).strict();

export const merchantCategoryChooseInputSchema = z
  .object({
    merchantId: z.string().guid(),
    categoryKey: businessCategoryKeySchema,
    /** The table version the business read; a table edited since is `pay.category_policy_changed`. */
    expectedTableVersion: z.number().int().min(1),
  })
  .strict();
export type MerchantCategoryChooseInput = z.infer<typeof merchantCategoryChooseInputSchema>;
