import { z } from 'zod';
import { assetIdSchema } from './asset-id.js';

/**
 * svc-bank `businessCards.*` (J-bank-22; BK-bcard-01, BK-bexp-01, BK-bexp-02): a business gives its team cards and
 * handles their expenses.
 *
 * The business's money is the partner bank's. A card is a TEST card on the TEST card network (`rail.card` is not
 * connected; no card number, CVC or PIN exists). A purchase over the card's per-purchase limit is declined `over_limit`
 * with one request to the admins; one within it is one partner move under `bank.business.card-capture:<purchase id>`. A
 * captured purchase over the business's receipt rule with no receipt needs one, with exactly one reminder queued. A
 * reimbursement approved and paid is one partner move from the business's account to the member's own, under
 * `bank.business.reimbursement:<claim id>`. The ledger posts nothing. Amounts are decimal strings; times are ISO strings.
 *
 * Refusals the app names: `bank.business_card_field_invalid`, `bank.business_card_not_found`, `bank.receipt_invalid`,
 * `bank.business_self_approve`, `bank.business_role_forbidden`, `bank.business_request_conflict`, `bank.test_partner_off`.
 */
export const BUSINESS_CARD_PURCHASE_STATUSES = ['declined', 'capturing', 'captured'] as const;
export const BUSINESS_CARD_LIMIT_REQUEST_STATUSES = ['open', 'approved', 'declined'] as const;
export const BUSINESS_REIMBURSEMENT_STATUSES = ['submitted', 'paying', 'paid', 'declined'] as const;
export const BUSINESS_RECEIPT_TYPES = ['application/pdf', 'image/png', 'image/jpeg', 'text/plain'] as const;

/** The API path of each business card door, as svc-bank mounts it behind Edge (the Developers page lists them). */
export const BUSINESS_CARD_API_PATHS = {
  overview: 'GET /api/bank/trpc/businessCards.overview',
  issueCard: 'POST /api/bank/trpc/businessCards.issueCard',
  testPurchase: 'POST /api/bank/trpc/businessCards.testPurchase',
  decideLimitRequest: 'POST /api/bank/trpc/businessCards.decideLimitRequest',
  setPolicy: 'POST /api/bank/trpc/businessCards.setPolicy',
  attachReceipt: 'POST /api/bank/trpc/businessCards.attachReceipt',
  receiptsZip: 'GET /api/bank/trpc/businessCards.receiptsZip',
  submitClaim: 'POST /api/bank/trpc/businessCards.submitClaim',
  approveAndPay: 'POST /api/bank/trpc/businessCards.approveAndPay',
} as const;

const amount = z.string().regex(/^-?\d+(\.\d+)?$/);
const iso = z.string().datetime();

export const businessCardSchema = z
  .object({
    id: z.string(),
    accountId: z.string(),
    memberUserId: z.string(),
    memberHandle: z.string().nullable(),
    assetId: assetIdSchema,
    perPurchaseLimit: amount,
    panTail: z.string().regex(/^\d{4}$/),
    status: z.enum(['active', 'frozen']),
    test: z.literal(true),
    issuedBy: z.string(),
    createdAt: iso,
  })
  .strict();
export type BusinessCard = z.infer<typeof businessCardSchema>;

export const businessCardLimitRequestSchema = z
  .object({
    purchaseId: z.string(),
    cardId: z.string(),
    memberUserId: z.string(),
    amount,
    status: z.enum(BUSINESS_CARD_LIMIT_REQUEST_STATUSES),
    decidedBy: z.string().nullable(),
    createdAt: iso,
  })
  .strict();
export type BusinessCardLimitRequest = z.infer<typeof businessCardLimitRequestSchema>;

export const businessCardPurchaseSchema = z
  .object({
    id: z.string(),
    cardId: z.string(),
    panTail: z.string(),
    memberUserId: z.string(),
    merchant: z.string(),
    assetId: assetIdSchema,
    amount,
    status: z.enum(BUSINESS_CARD_PURCHASE_STATUSES),
    declineReason: z.string().nullable(),
    partnerKey: z.string(),
    partnerMoveId: z.string().nullable(),
    receiptOver: amount.nullable(),
    needsReceipt: z.boolean(),
    receiptId: z.string().nullable(),
    reminders: z.number().int().nonnegative(),
    limitRequest: businessCardLimitRequestSchema.nullable(),
    createdAt: iso,
    capturedAt: iso.nullable(),
  })
  .strict();
export type BusinessCardPurchase = z.infer<typeof businessCardPurchaseSchema>;

export const businessReceiptSchema = z
  .object({
    id: z.string(),
    fileName: z.string(),
    contentType: z.string(),
    size: z.number().int().positive(),
    sha256: z.string(),
    uploadedBy: z.string(),
    createdAt: iso,
  })
  .strict();

export const businessReimbursementSchema = z
  .object({
    id: z.string(),
    accountId: z.string(),
    memberUserId: z.string(),
    assetId: assetIdSchema,
    amount,
    description: z.string(),
    receipt: businessReceiptSchema,
    status: z.enum(BUSINESS_REIMBURSEMENT_STATUSES),
    approvedBy: z.string().nullable(),
    partnerKey: z.string(),
    partnerMoveId: z.string().nullable(),
    memberBefore: amount.nullable(),
    memberAfter: amount.nullable(),
    refusalCode: z.string().nullable(),
    createdAt: iso,
    paidAt: iso.nullable(),
  })
  .strict();
export type BusinessReimbursement = z.infer<typeof businessReimbursementSchema>;

export const businessExpensePolicySchema = z.object({ receiptOver: amount.nullable() }).strict();

export const businessExpensesOverviewSchema = z
  .object({
    policy: businessExpensePolicySchema,
    permissions: z.array(z.string()),
    cards: z.array(businessCardSchema),
    purchases: z.array(businessCardPurchaseSchema),
    limitRequests: z.array(businessCardLimitRequestSchema),
    claims: z.array(businessReimbursementSchema),
    myBalance: z.object({ label: z.string(), amount: amount.nullable() }).strict().nullable(),
  })
  .strict();
export type BusinessExpensesOverview = z.infer<typeof businessExpensesOverviewSchema>;

export const businessReceiptsZipSchema = z
  .object({ fileName: z.string(), count: z.number().int().nonnegative(), zipBase64: z.string() })
  .strict();
