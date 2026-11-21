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

/** Every credit-preview record, for the service's sample test. */
export const BANK_CREDIT_PREVIEW_PROCEDURES = [
  BANK_CREDIT_PREVIEWS_OVERVIEW,
  BANK_CREDIT_PREVIEWS_SCHEDULE,
  BANK_CREDIT_PREVIEWS_REVOLVING,
  BANK_CREDIT_PREVIEWS_ACT,
] as const;
