import { z } from 'zod';

/**
 * svc-bank `businessPayouts.*` (J-bank-21; BK-bpay-01, BK-bpay-02, RC-bank-05): a business pays its team and contractors
 * in bulk.
 *
 * The business's money is the partner bank's. A bulk run is one instruction to the partner for every valid line, under
 * `bank.business.bulk-pay:<run id>`, sent once; a contractor batch is one instruction to the partner's payout rail under
 * `bank.business.contractor-batch:<batch id>`, or with no rail kept refused with `rail.bank`. Recurring crypto payroll is
 * signed by the business's own wallet, one run a month under `bank.business.crypto-payroll:<payroll id>:<YYYY-MM>`:
 * INTAFACED holds no key and no vault. The ledger posts nothing. Amounts are decimal strings; times are ISO strings.
 *
 * Refusals the app names: `bank.bulk_file_invalid`, `bank.bulk_run_unfunded` (the partner balance does not cover the
 * run: nothing was sent), `bank.bulk_run_empty`, `bank.business_self_approve`, `bank.business_approvers_short`,
 * `bank.business_request_conflict` (a run id reused on another file), `bank.contractor_invoice_not_open`,
 * `bank.payroll_wallet_missing`, `bank.payroll_signature_invalid`.
 */
export const BUSINESS_BULK_RUN_STATUSES = ['draft', 'awaiting_approval', 'sending', 'sent', 'declined'] as const;
export const BUSINESS_BULK_LINE_CODES = [
  'columns_invalid',
  'name_missing',
  'iban_invalid',
  'amount_invalid',
  'asset_mismatch',
  'duplicate_line',
] as const;
export const BUSINESS_CONTRACTOR_BATCH_STATUSES = ['awaiting_approval', 'sending', 'sent', 'declined', 'refused'] as const;
export const BUSINESS_INVOICE_STATUSES = ['open', 'in_batch', 'paid'] as const;
export const BUSINESS_PAYROLL_RUN_STATUSES = ['awaiting_signature', 'signed'] as const;

const amount = z.string().regex(/^-?\d+(\.\d+)?$/);
const iso = z.string().datetime();
const approval = z.object({ userId: z.string(), approvedAt: iso }).strict();

export const businessBulkRunSchema = z
  .object({
    id: z.string(),
    accountId: z.string(),
    assetId: z.string(),
    fileSha256: z.string(),
    status: z.enum(BUSINESS_BULK_RUN_STATUSES),
    /** The valid lines' total: what the one partner instruction carries. */
    total: amount,
    lines: z.array(
      z.object({ line: z.number().int(), name: z.string(), iban: z.string(), amount, reference: z.string().nullable() }).strict(),
    ),
    /** The validation report: every line that sends nothing, with its code. */
    issues: z.array(
      z.object({ line: z.number().int(), code: z.enum(BUSINESS_BULK_LINE_CODES), detail: z.string(), raw: z.string() }).strict(),
    ),
    /** The business's threshold when the run was confirmed; at or above it an approver is needed. Null before. */
    threshold: amount.nullable(),
    approvalsNeeded: z.number().int(),
    confirmedBy: z.string().nullable(),
    approvals: z.array(approval),
    partnerKey: z.string(),
    partnerMoveId: z.string().nullable(),
    /** How many recipients the partner's one instruction carried; null before it is sent. */
    partnerPayees: z.number().int().nullable(),
    partnerReason: z.string().nullable(),
    partnerReasonText: z.string().nullable(),
    createdAt: iso,
    sentAt: iso.nullable(),
  })
  .strict();

export const businessContractorInvoiceSchema = z
  .object({
    id: z.string(),
    contractorId: z.string(),
    number: z.string(),
    assetId: z.string(),
    amount,
    dueDate: z.string().nullable(),
    status: z.enum(BUSINESS_INVOICE_STATUSES),
    createdAt: iso,
  })
  .strict();

export const businessContractorSchema = z
  .object({
    id: z.string(),
    accountId: z.string(),
    name: z.string(),
    email: z.string().nullable(),
    /** The payout IBAN's last four characters; the full IBAN is never sent back. */
    ibanLast4: z.string().nullable(),
    walletAddress: z.string().nullable(),
    onboarded: z.enum(['business', 'self']),
    invoices: z.array(businessContractorInvoiceSchema),
    createdAt: iso,
  })
  .strict();

export const businessContractorBatchSchema = z
  .object({
    id: z.string(),
    accountId: z.string(),
    assetId: z.string(),
    total: amount,
    status: z.enum(BUSINESS_CONTRACTOR_BATCH_STATUSES),
    approvalsNeeded: z.number().int(),
    ruleId: z.string().nullable(),
    createdBy: z.string(),
    approvals: z.array(approval),
    lines: z.array(z.object({ invoiceId: z.string(), contractorName: z.string(), number: z.string(), amount }).strict()),
    partnerKey: z.string(),
    partnerMoveId: z.string().nullable(),
    /** How many recipients the partner's one instruction carried; null before it is sent. */
    partnerPayees: z.number().int().nullable(),
    /** `rail.bank` when no partner payout rail carries it; the partner's code when it declined. */
    refusalCode: z.string().nullable(),
    partnerReasonText: z.string().nullable(),
    createdAt: iso,
    sentAt: iso.nullable(),
  })
  .strict();

export const businessContractorInviteSchema = z.object({ inviteId: z.string(), token: z.string() }).strict();
export const businessContractorInviteInfoSchema = z.object({ businessName: z.string(), open: z.boolean() }).strict();
export const businessContractorJoinedSchema = z.object({ contractorId: z.string(), businessName: z.string() }).strict();

export const businessPayrollWalletSchema = z.object({ address: z.string(), connectedAt: iso }).strict();
export const businessPayrollWalletOfferSchema = z.object({ offerId: z.string(), message: z.string() }).strict();

export const businessPayrollRunSchema = z
  .object({
    id: z.string(),
    payrollId: z.string(),
    period: z.string(),
    runKey: z.string(),
    /** The business's own wallet the run is signed by. */
    walletAddress: z.string(),
    /** The exact text the wallet signs. */
    message: z.string(),
    total: amount,
    status: z.enum(BUSINESS_PAYROLL_RUN_STATUSES),
    signature: z.string().nullable(),
    signedAt: iso.nullable(),
    payslips: z.array(
      z.object({ contractorId: z.string(), name: z.string(), walletAddress: z.string(), assetId: z.string(), amount }).strict(),
    ),
    createdAt: iso,
  })
  .strict();

export const businessCryptoPayrollSchema = z
  .object({
    id: z.string(),
    accountId: z.string(),
    name: z.string(),
    assetId: z.string(),
    dayOfMonth: z.number().int(),
    members: z.array(z.object({ contractorId: z.string(), name: z.string(), walletAddress: z.string().nullable(), amount }).strict()),
    runs: z.array(businessPayrollRunSchema),
    createdAt: iso,
  })
  .strict();

export type BusinessBulkRun = z.infer<typeof businessBulkRunSchema>;
export type BusinessContractor = z.infer<typeof businessContractorSchema>;
export type BusinessContractorBatch = z.infer<typeof businessContractorBatchSchema>;
export type BusinessCryptoPayroll = z.infer<typeof businessCryptoPayrollSchema>;
export type BusinessPayrollRun = z.infer<typeof businessPayrollRunSchema>;
