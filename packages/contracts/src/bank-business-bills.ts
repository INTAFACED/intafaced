import { z } from 'zod';
import { businessTeamRuleSchema } from './bank-business-team.js';

/**
 * svc-bank `businessBills.*` (J-bank-20; BK-bill-01 to BK-bill-03): a business pays its suppliers' bills.
 *
 * The business's money is the partner bank's: paying a bill is one instruction to the partner under
 * `bank.business.bill-pay:<bill id>:<attempt>`, sent once; a category or split is the business's own record beside that
 * one payment; a payment the partner returns is given back once under `bank.business.bill-return:<payment id>`. The
 * ledger posts nothing. Amounts are decimal strings; times are ISO strings; dates are `YYYY-MM-DD`. A limit or figure not
 * set is null ("not set"), never zero.
 *
 * Refusals the app names: `bank.bill_duplicate_uncleared` (a possible duplicate is not paid until cleared),
 * `bank.bill_limit_unset` (a blank Bill Pay limit refuses every payment), `bank.bill_limit_exceeded`,
 * `bank.split_total_mismatch` (the lines must add up to the bill), `bank.bill_payment_sent` (sent: no cancel here),
 * `bank.business_self_approve`, `bank.business_already_approved`, `bank.business_approvers_short`.
 */
export const BUSINESS_BILL_STATUSES = ['inbox', 'awaiting_approval', 'approved', 'scheduled', 'paying', 'paid'] as const;
export const BUSINESS_BILL_PAYMENT_STATUSES = ['scheduled', 'sending', 'sent', 'cancelled', 'declined', 'returned'] as const;
export const BUSINESS_BILL_RETURN_REASONS = ['account_closed', 'account_not_found', 'name_mismatch', 'refused_by_payee_bank'] as const;

const amount = z.string().regex(/^-?\d+(\.\d+)?$/);
const iso = z.string().datetime();
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const businessBillExtractionSchema = z
  .object({
    reader: z.string(),
    /** Always shown with what was read: the reader is a preview, and the person checks every field. */
    label: z.string(),
    vendor: z.string().nullable(),
    reference: z.string().nullable(),
    amount: amount.nullable(),
    dueDate: day.nullable(),
  })
  .strict();

const summary = {
  id: z.string(),
  vendor: z.string().nullable(),
  reference: z.string().nullable(),
  amount: amount.nullable(),
  dueDate: day.nullable(),
  createdAt: iso,
};

export const businessBillSummarySchema = z.object(summary).strict();

export const businessBillPaymentSchema = z
  .object({
    id: z.string(),
    billId: z.string(),
    attempt: z.number().int(),
    madeByHandle: z.string(),
    assetId: z.string(),
    amount,
    /** The day a scheduled payment is sent; null for one paid at once. */
    scheduledFor: day.nullable(),
    status: z.enum(BUSINESS_BILL_PAYMENT_STATUSES),
    /** The business key of this attempt's one partner instruction. */
    partnerKey: z.string(),
    partnerMoveId: z.string().nullable(),
    /** The partner's own code and words for a decline or a return. */
    partnerReason: z.string().nullable(),
    partnerReasonText: z.string().nullable(),
    returnKey: z.string(),
    returnMoveId: z.string().nullable(),
    /** Our record beside the partner's one payment: categories adding up to it. Empty when it was not categorised. */
    splits: z.array(z.object({ category: z.string(), amount }).strict()),
    createdAt: iso,
    sentAt: iso.nullable(),
    cancelledAt: iso.nullable(),
    answeredAt: iso.nullable(),
  })
  .strict();

export const businessBillSchema = z
  .object({
    ...summary,
    accountId: z.string(),
    assetId: z.string(),
    fileName: z.string(),
    contentType: z.string(),
    fileSize: z.number().int(),
    fileSha256: z.string(),
    createdByHandle: z.string(),
    extracted: businessBillExtractionSchema.nullable(),
    status: z.enum(BUSINESS_BILL_STATUSES),
    round: z.number().int(),
    approvalsNeeded: z.number().int(),
    /** Approved at once: from a pre-approved vendor, at or under its cap. */
    preapproved: z.boolean(),
    rule: businessTeamRuleSchema.nullable(),
    submittedByHandle: z.string().nullable(),
    approvals: z.array(z.object({ userId: z.string(), handle: z.string(), approvedAt: iso }).strict()),
    duplicateOf: businessBillSummarySchema.nullable(),
    duplicateCleared: z.boolean(),
    /** Why the bill came back to the inbox, as the partner said. */
    back: z.object({ reason: z.string(), text: z.string() }).strict().nullable(),
    payments: z.array(businessBillPaymentSchema),
  })
  .strict();

export const businessBillLimitsSchema = z
  .object({ perPayment: amount.nullable(), daily: amount.nullable(), monthly: amount.nullable() })
  .strict();

export const businessBillVendorSchema = z.object({ name: z.string(), cap: amount, createdAt: iso }).strict();

export const businessBillSettingsSchema = z
  .object({
    assetId: z.string(),
    /** The bill reader, or null while none is set: every field is then typed by hand. */
    reader: z.object({ id: z.string(), label: z.string() }).strict().nullable(),
    vendors: z.array(businessBillVendorSchema),
    limits: businessBillLimitsSchema,
  })
  .strict();

export type BusinessBill = z.infer<typeof businessBillSchema>;
export type BusinessBillPayment = z.infer<typeof businessBillPaymentSchema>;
export type BusinessBillSettings = z.infer<typeof businessBillSettingsSchema>;
