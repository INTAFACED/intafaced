import { z } from 'zod';

/**
 * svc-bank `businessBooks.*` (J-bank-23; BK-bexp-03, BK-bexp-04, BK-bexp-05): a business keeps its books in order.
 *
 * Every line is one line of the partner bank's own record for the business's account, named by the partner's reference.
 * Connecting accounting software needs `vendor.accounting`, switched off in this build: asking keeps a record and connects
 * nothing, and the bank feed by file is the CSV statement. A rule "payee contains <text> sets <category>" is tried before
 * it is saved and codes matching lines from then on; a person codes one line or many. A statement in CSV, MT940, CAMT.053
 * or QIF is checked against the partner's own statement first (closing balance and line count). The partner's history
 * window bounds the period; a period reaching back past its strong customer authentication age needs
 * `bank.step_up.businessBooks.exportStatement`. Amounts are decimal strings; times are ISO strings. The ledger posts nothing.
 *
 * Refusals the app names: `vendor.accounting` (on the record), `bank.business_books_field_invalid`,
 * `bank.business_line_not_found`, `bank.statement_range`, `bank.statement_history_window`, `bank.statement_mismatch`,
 * `bank.partner_statement_unavailable`, `bank.step_up_required`, `bank.business_role_forbidden`.
 */
export const BUSINESS_BOOK_FORMATS = ['csv', 'mt940', 'camt053', 'qif'] as const;
export type BusinessBookFormat = (typeof BUSINESS_BOOK_FORMATS)[number];

const signed = z.string().regex(/^-?\d+(\.\d{1,18})?$/);
const iso = z.string().datetime();

export const businessAccountingConnectionSchema = z.object({
  status: z.literal('switched_off'),
  needs: z.literal('vendor.accounting'),
  requestedBy: z.string(),
  requestedAt: iso,
  attempts: z.number().int().positive(),
});

export const businessCodingRuleSchema = z.object({
  id: z.string().guid(),
  payeeContains: z.string(),
  category: z.string(),
  glCode: z.string().nullable(),
  createdAt: iso,
});

export const businessBookLineSchema = z.object({
  id: z.string(),
  bookedAt: iso,
  amount: signed,
  payee: z.string(),
  partnerKey: z.string(),
  category: z.string().nullable(),
  glCode: z.string().nullable(),
  codedBy: z.enum(['rule', 'person']).nullable(),
  ruleId: z.string().nullable(),
});

export const businessBooksOverviewSchema = z.object({
  account: z.object({ id: z.string().guid(), name: z.string(), assetId: z.string() }),
  permissions: z.array(z.string()),
  connection: businessAccountingConnectionSchema.nullable(),
  rules: z.array(businessCodingRuleSchema),
  partnerLabel: z.string().nullable(),
  historyRules: z.object({ label: z.string(), historyDays: z.number().int(), scaAfterDays: z.number().int() }).nullable(),
});

export const businessBookStatementSchema = z.object({
  format: z.enum(BUSINESS_BOOK_FORMATS),
  fileName: z.string(),
  contentType: z.string(),
  bodyBase64: z.string(),
  sha256: z.string(),
  opening: signed,
  closing: signed,
  lineCount: z.number().int().nonnegative(),
  partner: z.object({ label: z.string(), closing: signed, lines: z.number().int().nonnegative(), asOf: iso }),
});

export type BusinessBookLine = z.infer<typeof businessBookLineSchema>;
export type BusinessCodingRule = z.infer<typeof businessCodingRuleSchema>;
export type BusinessBooksOverview = z.infer<typeof businessBooksOverviewSchema>;
export type BusinessBookStatement = z.infer<typeof businessBookStatementSchema>;
