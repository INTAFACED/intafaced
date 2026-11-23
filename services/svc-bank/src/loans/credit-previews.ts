/**
 * Credit previews (J-bank-12): the overdraft, the unsecured personal loan, the business term loan and credit bureau
 * reporting (BK-loan-08), a sample unsecured-loan schedule for the servicing preview (BK-loan-09), and revolving card
 * credit (BK-cops-09, customer half).
 *
 * None of these engines exists and each needs a licence we do not hold. Under IA-SPEC 3.3 each page sits at its final
 * route, is labelled "Preview · sample data" and blurs its engine panels; every figure here is a fixed TEST fixture served
 * from the back end (never a constant in front-end code), and every engine action answers with the typed Preview refusal
 * from `@intafaced/contracts`. The refusal is decided before anything is read: no record is stored, nothing reaches the
 * ledger, and no account or posting freeze is read.
 *
 * The figures are not our values and not an offer: they are sample numbers so the pages can be played with. Amounts are
 * decimal strings; rates are decimal percent strings. The monthly payments are the standard annuity payment on the sample
 * amount at the sample rate, rounded half-up to cents, worked out once and fixed here.
 */
import {
  CREDIT_PREVIEW_CURRENCY,
  CREDIT_PREVIEW_ENGINES,
  CREDIT_PREVIEW_LABEL,
  SAMPLE_UNSECURED_LOAN_ID,
  type CreditPreviewActInput,
  type CreditPreviewOverview,
  type CreditPreviewRevolving,
  type CreditPreviewSchedule,
  BANK_CREDIT_PREVIEWS_ACT,
  BANK_CREDIT_PREVIEWS_OVERVIEW,
  BANK_CREDIT_PREVIEWS_REVOLVING,
  BANK_CREDIT_PREVIEWS_SCHEDULE,
} from '@intafaced/contracts/bank-credit-preview-procedures';
import { router } from '@intafaced/contracts/trpc';
import { mountRecord } from '@intafaced/contracts/procedure-mount';
import { previewRefusalOnly, throwPreviewRefusal } from './loan-servicing-preview.js';
const T = true as const;

const OVERVIEW: CreditPreviewOverview = {
  label: CREDIT_PREVIEW_LABEL,
  preview: T,
  blurred: T,
  currency: CREDIT_PREVIEW_CURRENCY,
  overdraft: {
    engine: CREDIT_PREVIEW_ENGINES.overdraft,
    limits: ['250.00', '500.00', '1000.00'],
    rate: '11.00',
    // limit × 11.00% ÷ 12, half-up to cents.
    monthlyCost: [
      { limit: '250.00', cost: '2.29', test: T },
      { limit: '500.00', cost: '4.58', test: T },
      { limit: '1000.00', cost: '9.17', test: T },
    ],
    repaymentWindowMonths: 2,
    test: T,
  },
  personalLoan: {
    engine: CREDIT_PREVIEW_ENGINES.personal_loan,
    amount: '5000.00',
    rate: '6.90',
    terms: [
      { termMonths: 12, monthly: '432.40', totalInterest: '188.80', test: T },
      { termMonths: 24, monthly: '223.64', totalInterest: '367.36', test: T },
      { termMonths: 36, monthly: '154.16', totalInterest: '549.76', test: T },
      { termMonths: 48, monthly: '119.50', totalInterest: '736.00', test: T },
      { termMonths: 60, monthly: '98.77', totalInterest: '926.20', test: T },
    ],
    test: T,
  },
  businessTermLoan: {
    engine: CREDIT_PREVIEW_ENGINES.business_term_loan,
    amount: '50000.00',
    flatFee: '4.00',
    // (amount + amount × 4.00%) ÷ weeks.
    terms: [
      { weeks: 26, weekly: '2000.00', fee: '2000.00', test: T },
      { weeks: 52, weekly: '1000.00', fee: '2000.00', test: T },
    ],
    test: T,
  },
  bureau: {
    engine: CREDIT_PREVIEW_ENGINES.credit_bureau,
    rows: [
      { item: 'account_history', test: T },
      { item: 'repayment_history', test: T },
      { item: 'how_it_appears', test: T },
    ],
  },
};

const SCHEDULE: CreditPreviewSchedule = {
  label: CREDIT_PREVIEW_LABEL,
  preview: T,
  blurred: T,
  currency: CREDIT_PREVIEW_CURRENCY,
  sampleLoanId: SAMPLE_UNSECURED_LOAN_ID,
  amount: '5000.00',
  rate: '6.90',
  termMonths: 12,
  rows: Array.from({ length: 12 }, (_, i) => ({ n: i + 1, amount: '432.40', test: T })),
};

const REVOLVING: CreditPreviewRevolving = {
  label: CREDIT_PREVIEW_LABEL,
  preview: T,
  blurred: T,
  currency: CREDIT_PREVIEW_CURRENCY,
  engine: CREDIT_PREVIEW_ENGINES.revolving_credit,
  rows: [
    { section: 'credit_limit', item: 'limit', figure: '2000.00', test: T },
    { section: 'credit_limit', item: 'available', figure: '1650.00', test: T },
    { section: 'statements', item: 'statement_balance', figure: '350.00', test: T },
    { section: 'statements', item: 'minimum_due', figure: '25.00', test: T },
    { section: 'interest_tiers', item: 'purchases_rate', figure: '19.90', test: T },
    { section: 'interest_tiers', item: 'cash_rate', figure: '24.90', test: T },
    { section: 'repayments', item: 'pay_in_full', figure: '350.00', test: T },
    { section: 'repayments', item: 'pay_minimum', figure: '25.00', test: T },
    { section: 'bureau_reporting', item: 'monthly_report', figure: null, test: T },
    { section: 'collections', item: 'missed_payment_steps', figure: null, test: T },
  ],
};

/** Copies, so no caller can change the fixtures. */
const creditPreviewOverview = (): CreditPreviewOverview => structuredClone(OVERVIEW);
const creditPreviewSchedule = (): CreditPreviewSchedule => structuredClone(SCHEDULE);
const creditPreviewRevolving = (): CreditPreviewRevolving => structuredClone(REVOLVING);

/** Always throws the typed Preview refusal (PRECONDITION_FAILED, `error.data.preview`). Nothing is read or written. */
function refuseCreditPreviewAct(input: CreditPreviewActInput): never {
  return throwPreviewRefusal(CREDIT_PREVIEW_ENGINES[input.product], input.action);
}

/** `bank.creditPreviews.*`: TEST reads and one refusing action door. The router takes no services, so it can touch none. */

/** `bank.creditPreviews.*`, mounted from its records: TEST reads and one refusing action door. It takes no services, so it can touch none. */
export function createCreditPreviewsRouter() {
  return router({
    overview: mountRecord(BANK_CREDIT_PREVIEWS_OVERVIEW, () => creditPreviewOverview(), previewRefusalOnly),
    schedule: mountRecord(BANK_CREDIT_PREVIEWS_SCHEDULE, () => creditPreviewSchedule(), previewRefusalOnly),
    revolving: mountRecord(BANK_CREDIT_PREVIEWS_REVOLVING, () => creditPreviewRevolving(), previewRefusalOnly),
    act: mountRecord(BANK_CREDIT_PREVIEWS_ACT, ({ input }) => refuseCreditPreviewAct(input), previewRefusalOnly),
  });
}
