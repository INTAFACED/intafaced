import { z } from 'zod';
import { PREVIEW_LABEL, PREVIEW_REFUSAL_CODE } from './preview-refusal.js';
import { defineProcedure, NO_INPUT } from './procedure.js';

/**
 * svc-bank `creditPreviews.*` (J-bank-12): the overdraft, personal and business term loan, credit bureau, unsecured loan
 * schedule and revolving credit previews, one record per call. No engine exists: every read is a fixed TEST fixture the bank
 * serves, labelled "Preview · sample data", and every engine action answers the typed Preview refusal
 * (`preview.engine_not_built`, HTTP 412). Nothing is stored and nothing reaches the ledger. svc-bank mounts each from here
 * (`loans/credit-previews.ts`) and the customer app calls each by its record (`features/money/credit-previews`).
 */

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
export type CreditPreviewSchedule = z.infer<typeof creditPreviewScheduleSchema>;

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
export type CreditPreviewRevolving = z.infer<typeof creditPreviewRevolvingSchema>;

export const creditPreviewActInputSchema = z.discriminatedUnion('product', [
  z.object({ product: z.literal('overdraft'), action: z.enum(CREDIT_PREVIEW_ACTIONS.overdraft) }).strict(),
  z.object({ product: z.literal('personal_loan'), action: z.enum(CREDIT_PREVIEW_ACTIONS.personal_loan) }).strict(),
  z.object({ product: z.literal('business_term_loan'), action: z.enum(CREDIT_PREVIEW_ACTIONS.business_term_loan) }).strict(),
  z.object({ product: z.literal('credit_bureau'), action: z.enum(CREDIT_PREVIEW_ACTIONS.credit_bureau) }).strict(),
  z.object({ product: z.literal('revolving_credit'), action: z.enum(CREDIT_PREVIEW_ACTIONS.revolving_credit) }).strict(),
]);
export type CreditPreviewActInput = z.infer<typeof creditPreviewActInputSchema>;

// ---- The older preview doors the credit-preview rooms also call (BK-loan-09, BK-loan-10, BK-cops-09) ---------------

/** The owner's missed-payment policy: blank reads `not_set`, never a default. */
export const loanMissedPaymentPolicySchema = z.union([
  z.object({ status: z.literal('not_set') }).strict(),
  z
    .object({
      status: z.literal('set'),
      graceDays: z.number().int().nonnegative(),
      catchUpDays: z.number().int().nonnegative(),
      lateFee: decimal,
    })
    .strict(),
]);
export type LoanMissedPaymentPolicyView = z.infer<typeof loanMissedPaymentPolicySchema>;

export const CREDIT_CARD_TABS = ['application', 'limit', 'repayment', 'usage_rules', 'statements'] as const;
export const CREDIT_CARD_VARIANTS = ['credit_card', 'charge_card'] as const;

export const creditCardPreviewSchema = z.object({
  label: z.literal(PREVIEW_LABEL),
  engine: z.string(),
  preview: z.literal(true),
  blurred: z.literal(true),
  tabs: z.array(z.enum(CREDIT_CARD_TABS)),
  rows: z.array(z.object({ tab: z.enum(CREDIT_CARD_TABS), item: z.string(), test: z.literal(true) })),
});
export type CreditCardPreviewView = z.infer<typeof creditCardPreviewSchema>;

export const FRAUD_RISK_BANDS = ['very_likely', 'neutral', 'very_unlikely'] as const;
export const FRAUD_SIGNALS = ['card_testing', 'merchant_dispute_risk', 'compromised_card'] as const;
export const FRAUD_BLOCK_STANCES = ['maximise_approval_rate', 'balanced', 'maximise_risk_prevention'] as const;

export const fraudPreviewSchema = z.object({
  label: z.literal(PREVIEW_LABEL),
  engine: z.string(),
  preview: z.literal(true),
  blurred: z.literal(true),
  stances: z.array(z.enum(FRAUD_BLOCK_STANCES)),
  automaticBlocking: z.literal('unavailable'),
  rows: z.array(
    z.object({
      testAuthorisationRef: z.string().startsWith('TEST-'),
      test: z.literal(true),
      band: z.enum(FRAUD_RISK_BANDS),
      signals: z.array(z.enum(FRAUD_SIGNALS)),
    }),
  ),
});
export type FraudPreviewView = z.infer<typeof fraudPreviewSchema>;

const base = { service: 'svc-bank', module: 'bank', transport: 'trpc' } as const;
const READ = { caller: 'scope', scope: 'bank:read', module: 'bank' } as const;
const WRITE = { caller: 'scope', scope: 'bank:write', module: 'bank' } as const;

export const BANK_CREDIT_PREVIEWS_OVERVIEW = defineProcedure({
  ...base,
  name: 'bank.creditPreviews.overview',
  kind: 'query',
  path: 'creditPreviews.overview',
  access: READ,
  refusals: {},
  input: NO_INPUT,
  output: creditPreviewOverviewSchema,
  samples: [{ verdict: 'accept' }],
});

export const BANK_CREDIT_PREVIEWS_SCHEDULE = defineProcedure({
  ...base,
  name: 'bank.creditPreviews.schedule',
  kind: 'query',
  path: 'creditPreviews.schedule',
  access: READ,
  refusals: {},
  input: NO_INPUT,
  output: creditPreviewScheduleSchema,
  samples: [{ verdict: 'accept' }],
});

export const BANK_CREDIT_PREVIEWS_REVOLVING = defineProcedure({
  ...base,
  name: 'bank.creditPreviews.revolving',
  kind: 'query',
  path: 'creditPreviews.revolving',
  access: READ,
  refusals: {},
  input: NO_INPUT,
  output: creditPreviewRevolvingSchema,
  samples: [{ verdict: 'accept' }],
});

/** Every engine action: always the typed Preview refusal, so it never answers. */
export const BANK_CREDIT_PREVIEWS_ACT = defineProcedure({
  ...base,
  name: 'bank.creditPreviews.act',
  kind: 'mutation',
  path: 'creditPreviews.act',
  access: WRITE,
  refusals: { [PREVIEW_REFUSAL_CODE]: 'PRECONDITION_FAILED' },
  input: creditPreviewActInputSchema,
  output: z.never(),
  samples: [
    { verdict: 'accept', input: { product: 'overdraft', action: 'apply' } },
    { verdict: 'accept', input: { product: 'revolving_credit', action: 'borrow' } },
    { verdict: 'refuse', input: { product: 'overdraft', action: 'borrow' } },
    { verdict: 'refuse', input: { product: 'mortgage', action: 'apply' } },
  ],
});

const PREVIEW_REFUSED = { [PREVIEW_REFUSAL_CODE]: 'PRECONDITION_FAILED' } as const;
const SAMPLE_LOAN = '00000000-0000-4000-8000-000000000012';

export const BANK_LOANS_MISSED_PAYMENT_POLICY = defineProcedure({
  ...base,
  name: 'bank.loans.missedPaymentPolicy',
  kind: 'query',
  path: 'loans.missedPaymentPolicy',
  access: READ,
  refusals: {},
  input: NO_INPUT,
  output: loanMissedPaymentPolicySchema,
  samples: [{ verdict: 'accept' }],
});

/** Preview: change an unsecured loan's repayment date. Always the typed Preview refusal. */
export const BANK_LOANS_CHANGE_REPAYMENT_DATE = defineProcedure({
  ...base,
  name: 'bank.loans.changeRepaymentDate',
  kind: 'mutation',
  path: 'loans.changeRepaymentDate',
  access: WRITE,
  refusals: PREVIEW_REFUSED,
  input: z.object({ loanId: z.string().guid(), date: z.string().date() }).strict(),
  output: z.never(),
  samples: [
    { verdict: 'accept', input: { loanId: SAMPLE_LOAN, date: '2027-01-15' } },
    { verdict: 'refuse', input: { loanId: SAMPLE_LOAN, date: '15/01/2027' } },
    { verdict: 'refuse', input: { loanId: 'not-a-loan', date: '2027-01-15' } },
  ],
});

export const BANK_CREDIT_CARD_PREVIEW = defineProcedure({
  ...base,
  name: 'bank.creditCard.preview',
  kind: 'query',
  path: 'creditCard.preview',
  access: READ,
  refusals: {},
  input: NO_INPUT,
  output: creditCardPreviewSchema,
  samples: [{ verdict: 'accept' }],
});

/** Preview: apply for a credit or charge card. Always the typed Preview refusal. */
export const BANK_CREDIT_CARD_APPLICATION = defineProcedure({
  ...base,
  name: 'bank.creditCard.application',
  kind: 'mutation',
  path: 'creditCard.application',
  access: WRITE,
  refusals: PREVIEW_REFUSED,
  input: z.object({ variant: z.enum(CREDIT_CARD_VARIANTS) }).strict(),
  output: z.never(),
  samples: [
    { verdict: 'accept', input: { variant: 'charge_card' } },
    { verdict: 'refuse', input: { variant: 'store_card' } },
  ],
});

/** The console's card fraud risk preview: TEST rows only, for any operator session (`admin:read`). */
export const BANK_OPS_FRAUD_PREVIEW = defineProcedure({
  ...base,
  name: 'bank.ops.fraudPreview',
  kind: 'query',
  path: 'ops.fraudPreview',
  access: { caller: 'scope', scope: 'admin:read' },
  refusals: {},
  input: NO_INPUT,
  output: fraudPreviewSchema,
  samples: [{ verdict: 'accept' }],
});

/** Every record here, for the service's sample test. */
export const BANK_CREDIT_PREVIEW_PROCEDURES = [
  BANK_CREDIT_PREVIEWS_OVERVIEW,
  BANK_CREDIT_PREVIEWS_SCHEDULE,
  BANK_CREDIT_PREVIEWS_REVOLVING,
  BANK_CREDIT_PREVIEWS_ACT,
  BANK_LOANS_MISSED_PAYMENT_POLICY,
  BANK_LOANS_CHANGE_REPAYMENT_DATE,
  BANK_CREDIT_CARD_PREVIEW,
  BANK_CREDIT_CARD_APPLICATION,
  BANK_OPS_FRAUD_PREVIEW,
] as const;
