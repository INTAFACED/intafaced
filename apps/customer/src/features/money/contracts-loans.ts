/** Loans: products, quotes, terms, projections, statements and the ledger check. */
import { z } from 'zod';
import { decimalSchema as money, signedDecimalSchema } from '../../shared/money';

export const productSchema = z.object({
  id: z.string(),
  name: z.string(),
  debtAssetId: z.string(),
  collateralAssetId: z.string(),
  quoteAssetId: z.string(),
  aprBps: z.number().int(),
  maxLtvBps: z.number().int(),
  marginCallLtvBps: z.number().int(),
  liquidationLtvBps: z.number().int(),
  minPrincipal: money,
});
export const loanSchema = z.object({
  id: z.string(),
  productId: z.string(),
  debtAssetId: z.string(),
  collateralAssetId: z.string(),
  principal: money,
  outstandingPrincipal: money,
  outstandingInterest: money,
  collateral: money,
  aprBps: z.number().int(),
  status: z.string(),
  marginCalledAt: z.string().nullable(),
});
/** `bank.loans.quote` (J-bank-09 #2): the smallest pledge `open` accepts for a principal, from the marks `open` uses. */
export const loanQuoteSchema = z.object({
  productId: z.string(),
  debtAssetId: z.string(),
  collateralAssetId: z.string(),
  quoteAssetId: z.string(),
  principal: money,
  requiredCollateral: money,
  startingLtvBps: z.number().int(),
  maxLtvBps: z.number().int(),
  liquidationLtvBps: z.number().int(),
  liquidationPrice: money,
  debtPrice: money,
  collateralPrice: money,
  pricedAt: z.string(),
});
export type LoanQuote = z.infer<typeof loanQuoteSchema>;
export const LOAN_ELIGIBILITY_KEYS = ['lending_policy', 'product_open', 'assets_open', 'origination_fee', 'jurisdiction_rules'] as const;
/** `bank.loans.eligibility` (J-bank-09 #3): each condition met, unmet with the code `open` would refuse, or not set. */
export const loanEligibilitySchema = z.object({
  productId: z.string(),
  eligible: z.boolean(),
  reasons: z.array(
    z.object({ key: z.enum(LOAN_ELIGIBILITY_KEYS), state: z.enum(['met', 'unmet', 'not_set']), code: z.string().nullable() }),
  ),
});
export type LoanEligibility = z.infer<typeof loanEligibilitySchema>;
/** `bank.loans.fees` (J-bank-09 #3): the origination fee, not set (no fee line) or published. */
export const loanFeesSchema = z.object({
  productId: z.string(),
  assetId: z.string(),
  origination: z.discriminatedUnion('status', [
    z.object({ status: z.literal('not_set') }),
    z.object({ status: z.literal('published'), bps: z.number().int(), amount: money.nullable(), collectable: z.boolean() }),
  ]),
});
export type LoanFees = z.infer<typeof loanFeesSchema>;
/** `bank.loans.terms` (J-bank-09 #5): what was written on the loan at open, never the product's current terms. */
export const loanTermsSchema = z.object({
  loanId: z.string(),
  productId: z.string(),
  debtAssetId: z.string(),
  collateralAssetId: z.string(),
  principal: money,
  openingCollateral: money.nullable(),
  aprBps: z.number().int(),
  marginCallLtvBps: z.number().int().nullable(),
  liquidationLtvBps: z.number().int().nullable(),
  openedAt: z.string(),
});
export type LoanTerms = z.infer<typeof loanTermsSchema>;
/** `bank.loans.projection` (BK-loan-06): the accrual rule run forward by the bank. A projection, never a schedule. */
export const loanProjectionSchema = z.object({
  loanId: z.string(),
  kind: z.literal('projection'),
  obligation: z.literal(false),
  aprBps: z.number().int(),
  days: z.number().int(),
  openingPrincipal: money,
  openingInterest: money,
  extraApplied: money.nullable(),
  rows: z.array(z.object({ date: z.string(), basis: money, interest: money, principal: money, debt: money })),
});
export type LoanProjection = z.infer<typeof loanProjectionSchema>;
/** `bank.loans.payoffQuote` (BK-loan-06): what clears the loan now, re-priced on every read and never stored. */
export const payoffQuoteSchema = z.object({
  loanId: z.string(),
  principal: money,
  interest: money,
  fee: money,
  total: money,
  assetId: z.string(),
  interestThrough: z.string(),
  validUntil: z.string(),
});
export type PayoffQuote = z.infer<typeof payoffQuoteSchema>;

export const loanStatementSchema = z.object({
  format: z.literal('csv'),
  filename: z.string(),
  contentType: z.string(),
  bodyBase64: z.string(),
  sha256: z.string(),
  signature: z.string(),
  rowCount: z.number().int().nonnegative(),
  provisional: z.boolean(),
  openingPrincipal: money,
  openingInterest: money,
  closingPrincipal: money,
  closingInterest: money,
  generatedAt: z.string(),
});
export type LoanStatement = z.infer<typeof loanStatementSchema>;
/** `bank.loans.interestRows` (LOAN-05): each accrual day as written, each approved correction with its reason, and their totals. */
export const loanInterestRowsSchema = z.object({
  loanId: z.string(),
  assetId: z.string(),
  days: z.array(z.object({ date: z.string(), rateBps: z.number().int(), basis: money, interest: money })),
  earlierDays: z.number().int().nonnegative(),
  corrections: z.array(z.object({ id: z.string(), at: z.string(), amount: signedDecimalSchema, reason: z.string() })),
  accrued: money,
  corrected: signedDecimalSchema,
  paid: money,
  owed: money,
});
export type LoanInterestRows = z.infer<typeof loanInterestRowsSchema>;
/** `bank.loans.ledgerCheck` (LOAN-05): this loan's settled rows against the ledger's own transactions, leg by leg. */
export const loanLedgerCheckSchema = z.object({
  loanId: z.string(),
  status: z.enum(['agrees', 'differs', 'pending']),
  checked: z.number().int().nonnegative(),
  pending: z.number().int().nonnegative(),
  collateralHeld: money,
  collateralExpected: signedDecimalSchema,
  mismatches: z.array(z.object({ kind: z.string(), ref: z.string(), problem: z.string() })),
  checkedAt: z.string(),
});
export type LoanLedgerCheck = z.infer<typeof loanLedgerCheckSchema>;

/** This area's reads of svc-bank `bank.*`, composed into `bankReads` in contracts.ts. */
export const loansReads = {
  'loans.products': z.array(productSchema),
  'loans.list': z.array(loanSchema),
  'loans.projection': loanProjectionSchema,
  'loans.payoffQuote': payoffQuoteSchema,
  'loans.interestRows': loanInterestRowsSchema,
  'loans.ledgerCheck': loanLedgerCheckSchema,
  'loans.quote': loanQuoteSchema,
  'loans.eligibility': loanEligibilitySchema,
  'loans.fees': loanFeesSchema,
  'loans.terms': loanTermsSchema,
  /** `bank.loans.releasable` (BK-loan-05): the most collateral `releaseExcess` would release now, under the product's max LTV. */
  'loans.releasable': z.object({
    loanId: z.string(),
    held: money,
    releasable: money,
    maxLtvBps: z.number().int(),
    ltvBps: z.number().int(),
  }),
  'loans.health': z.object({
    debtValue: money,
    collateralValue: money,
    portfolioLtvBps: z.number().int().nonnegative().safe(),
    loans: z.array(z.object({ loanId: z.string(), debtValue: money, collateralValue: money, ltvBps: z.number().int() })),
  }),
} as const;

/** This area's writes to svc-bank `bank.*`, composed into `bankWrites` in contracts.ts. */
export const loansWrites = {
  'loans.open': z.object({ loanId: z.string(), status: z.string(), ltvBps: z.number().int(), drawLedgerTxId: z.string() }),
  'loans.addCollateral': z.object({ ledgerTxId: z.string(), sequence: z.number().int() }),
  'loans.releaseExcess': z.object({ ledgerTxId: z.string(), sequence: z.number().int() }),
  'loans.repay': z.object({
    ledgerTxId: z.string(),
    interestPaid: money,
    principalPaid: money,
    remainingPrincipal: money,
    remainingInterest: money,
    closed: z.boolean(),
  }),
  'loans.close': z.object({ released: money, ledgerTxId: z.string().nullable() }),
} as const;
