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
import { z } from 'zod';
import { PREVIEW_LABEL, router, scopedProcedure } from '@intafaced/contracts';
import { throwPreviewRefusal } from './loan-servicing-preview.js';

export const CREDIT_PREVIEW_LABEL = PREVIEW_LABEL;
/** The sample currency every figure is written in. TEST, like the figures. */
export const CREDIT_PREVIEW_CURRENCY = 'EUR' as const;

/** Engine ids for the typed Preview refusal (`<module>.<engine>`), one per missing engine. */
export const CREDIT_PREVIEW_ENGINES = {
  overdraft: 'bank.overdraft',
  personal_loan: 'bank.personal_loan',
  business_term_loan: 'bank.business_term_loan',
  credit_bureau: 'bank.credit_bureau',
  revolving_credit: 'bank.revolving_credit',
} as const;
export type CreditPreviewProduct = keyof typeof CREDIT_PREVIEW_ENGINES;

/** The engine actions each preview page offers. Every one refuses. */
export const CREDIT_PREVIEW_ACTIONS = {
  overdraft: ['check_eligibility', 'apply', 'change_limit', 'cancel'],
  personal_loan: ['check_eligibility', 'apply'],
  business_term_loan: ['check_eligibility', 'apply'],
  credit_bureau: ['view_file'],
  revolving_credit: ['apply', 'borrow', 'repay'],
} as const satisfies Record<CreditPreviewProduct, readonly string[]>;

const decimal = z.string().regex(/^\d+(\.\d{1,18})?$/);
const sampleRow = z
  .object({ termMonths: z.number().int().positive(), monthly: decimal, totalInterest: decimal, test: z.literal(true) })
  .strict();
const shell = {
  label: z.literal(CREDIT_PREVIEW_LABEL),
  preview: z.literal(true),
  blurred: z.literal(true),
  currency: z.literal(CREDIT_PREVIEW_CURRENCY),
};

export const creditPreviewOverviewSchema = z
  .object({
    ...shell,
    overdraft: z
      .object({
        engine: z.literal(CREDIT_PREVIEW_ENGINES.overdraft),
        limits: z.array(decimal),
        rate: decimal,
        /** What a month at each sample limit, fully used, costs at the sample rate. */
        monthlyCost: z.array(z.object({ limit: decimal, cost: decimal, test: z.literal(true) }).strict()),
        repaymentWindowMonths: z.number().int().positive(),
        test: z.literal(true),
      })
      .strict(),
    personalLoan: z
      .object({
        engine: z.literal(CREDIT_PREVIEW_ENGINES.personal_loan),
        amount: decimal,
        rate: decimal,
        terms: z.array(sampleRow),
        test: z.literal(true),
      })
      .strict(),
    businessTermLoan: z
      .object({
        engine: z.literal(CREDIT_PREVIEW_ENGINES.business_term_loan),
        amount: decimal,
        flatFee: decimal,
        terms: z.array(z.object({ weeks: z.number().int().positive(), weekly: decimal, fee: decimal, test: z.literal(true) }).strict()),
        test: z.literal(true),
      })
      .strict(),
    bureau: z
      .object({
        engine: z.literal(CREDIT_PREVIEW_ENGINES.credit_bureau),
        rows: z.array(
          z.object({ item: z.enum(['account_history', 'repayment_history', 'how_it_appears']), test: z.literal(true) }).strict(),
        ),
      })
      .strict(),
  })
  .strict();
export type CreditPreviewOverview = z.infer<typeof creditPreviewOverviewSchema>;

/** A fixed TEST id the schedule preview sends to the servicing preview doors; no loan with it exists or is looked up. */
export const SAMPLE_UNSECURED_LOAN_ID = '00000000-0000-4000-8000-000000000012' as const;

export const creditPreviewScheduleSchema = z
  .object({
    ...shell,
    sampleLoanId: z.literal(SAMPLE_UNSECURED_LOAN_ID),
    amount: decimal,
    rate: decimal,
    termMonths: z.number().int().positive(),
    rows: z.array(z.object({ n: z.number().int().positive(), amount: decimal, test: z.literal(true) }).strict()),
  })
  .strict();

export const REVOLVING_SECTIONS = [
  'credit_limit',
  'statements',
  'interest_tiers',
  'repayments',
  'bureau_reporting',
  'collections',
] as const;
export const creditPreviewRevolvingSchema = z
  .object({
    ...shell,
    engine: z.literal(CREDIT_PREVIEW_ENGINES.revolving_credit),
    rows: z
      .array(
        z.object({ section: z.enum(REVOLVING_SECTIONS), item: z.string(), figure: decimal.nullable(), test: z.literal(true) }).strict(),
      )
      .min(1),
  })
  .strict();

const freezeAll = <T extends object>(rows: readonly T[]): readonly T[] => Object.freeze(rows.map((r) => Object.freeze({ ...r })));
const T = true as const;

const OVERVIEW: CreditPreviewOverview = Object.freeze({
  label: CREDIT_PREVIEW_LABEL,
  preview: T,
  blurred: T,
  currency: CREDIT_PREVIEW_CURRENCY,
  overdraft: Object.freeze({
    engine: CREDIT_PREVIEW_ENGINES.overdraft,
    limits: ['250.00', '500.00', '1000.00'],
    rate: '11.00',
    // limit × 11.00% ÷ 12, half-up to cents.
    monthlyCost: freezeAll([
      { limit: '250.00', cost: '2.29', test: T },
      { limit: '500.00', cost: '4.58', test: T },
      { limit: '1000.00', cost: '9.17', test: T },
    ]) as CreditPreviewOverview['overdraft']['monthlyCost'],
    repaymentWindowMonths: 2,
    test: T,
  }),
  personalLoan: Object.freeze({
    engine: CREDIT_PREVIEW_ENGINES.personal_loan,
    amount: '5000.00',
    rate: '6.90',
    terms: freezeAll([
      { termMonths: 12, monthly: '432.40', totalInterest: '188.80', test: T },
      { termMonths: 24, monthly: '223.64', totalInterest: '367.36', test: T },
      { termMonths: 36, monthly: '154.16', totalInterest: '549.76', test: T },
      { termMonths: 48, monthly: '119.50', totalInterest: '736.00', test: T },
      { termMonths: 60, monthly: '98.77', totalInterest: '926.20', test: T },
    ]) as CreditPreviewOverview['personalLoan']['terms'],
    test: T,
  }),
  businessTermLoan: Object.freeze({
    engine: CREDIT_PREVIEW_ENGINES.business_term_loan,
    amount: '50000.00',
    flatFee: '4.00',
    // (amount + amount × 4.00%) ÷ weeks.
    terms: freezeAll([
      { weeks: 26, weekly: '2000.00', fee: '2000.00', test: T },
      { weeks: 52, weekly: '1000.00', fee: '2000.00', test: T },
    ]) as CreditPreviewOverview['businessTermLoan']['terms'],
    test: T,
  }),
  bureau: Object.freeze({
    engine: CREDIT_PREVIEW_ENGINES.credit_bureau,
    rows: freezeAll([
      { item: 'account_history' as const, test: T },
      { item: 'repayment_history' as const, test: T },
      { item: 'how_it_appears' as const, test: T },
    ]) as CreditPreviewOverview['bureau']['rows'],
  }),
}) as CreditPreviewOverview;

const SCHEDULE = Object.freeze({
  label: CREDIT_PREVIEW_LABEL,
  preview: T,
  blurred: T,
  currency: CREDIT_PREVIEW_CURRENCY,
  sampleLoanId: SAMPLE_UNSECURED_LOAN_ID,
  amount: '5000.00',
  rate: '6.90',
  termMonths: 12,
  rows: freezeAll(Array.from({ length: 12 }, (_, i) => ({ n: i + 1, amount: '432.40', test: T }))),
});

const REVOLVING = Object.freeze({
  label: CREDIT_PREVIEW_LABEL,
  preview: T,
  blurred: T,
  currency: CREDIT_PREVIEW_CURRENCY,
  engine: CREDIT_PREVIEW_ENGINES.revolving_credit,
  rows: freezeAll([
    { section: 'credit_limit' as const, item: 'limit', figure: '2000.00', test: T },
    { section: 'credit_limit' as const, item: 'available', figure: '1650.00', test: T },
    { section: 'statements' as const, item: 'statement_balance', figure: '350.00', test: T },
    { section: 'statements' as const, item: 'minimum_due', figure: '25.00', test: T },
    { section: 'interest_tiers' as const, item: 'purchases_rate', figure: '19.90', test: T },
    { section: 'interest_tiers' as const, item: 'cash_rate', figure: '24.90', test: T },
    { section: 'repayments' as const, item: 'pay_in_full', figure: '350.00', test: T },
    { section: 'repayments' as const, item: 'pay_minimum', figure: '25.00', test: T },
    { section: 'bureau_reporting' as const, item: 'monthly_report', figure: null, test: T },
    { section: 'collections' as const, item: 'missed_payment_steps', figure: null, test: T },
  ]),
});

/** Copies so no caller can change the frozen fixtures. */
export const creditPreviewOverview = (): CreditPreviewOverview => structuredClone(OVERVIEW);
export const creditPreviewSchedule = () => structuredClone(SCHEDULE) as z.infer<typeof creditPreviewScheduleSchema>;
export const creditPreviewRevolving = () => structuredClone(REVOLVING) as z.infer<typeof creditPreviewRevolvingSchema>;

export const creditPreviewActInputSchema = z.discriminatedUnion('product', [
  z.object({ product: z.literal('overdraft'), action: z.enum(CREDIT_PREVIEW_ACTIONS.overdraft) }).strict(),
  z.object({ product: z.literal('personal_loan'), action: z.enum(CREDIT_PREVIEW_ACTIONS.personal_loan) }).strict(),
  z.object({ product: z.literal('business_term_loan'), action: z.enum(CREDIT_PREVIEW_ACTIONS.business_term_loan) }).strict(),
  z.object({ product: z.literal('credit_bureau'), action: z.enum(CREDIT_PREVIEW_ACTIONS.credit_bureau) }).strict(),
  z.object({ product: z.literal('revolving_credit'), action: z.enum(CREDIT_PREVIEW_ACTIONS.revolving_credit) }).strict(),
]);
export type CreditPreviewActInput = z.infer<typeof creditPreviewActInputSchema>;

/** Always throws the typed Preview refusal (PRECONDITION_FAILED, `error.data.preview`). Nothing is read or written. */
export function refuseCreditPreviewAct(input: CreditPreviewActInput): never {
  return throwPreviewRefusal(CREDIT_PREVIEW_ENGINES[input.product], input.action);
}

/** `bank.creditPreviews.*`: TEST reads and one refusing action door. The router takes no services, so it can touch none. */
export function createCreditPreviewsRouter() {
  const read = scopedProcedure('bank:read', { module: 'bank' });
  return router({
    overview: read.output(creditPreviewOverviewSchema).query(() => creditPreviewOverview()),
    schedule: read.output(creditPreviewScheduleSchema).query(() => creditPreviewSchedule()),
    revolving: read.output(creditPreviewRevolvingSchema).query(() => creditPreviewRevolving()),
    act: scopedProcedure('bank:write', { module: 'bank' })
      .input(creditPreviewActInputSchema)
      .output(z.never())
      .mutation(({ input }): never => refuseCreditPreviewAct(input)),
  });
}
