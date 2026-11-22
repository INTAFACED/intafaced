import { z } from 'zod';
import { defineProcedure } from './procedure.js';
import { amountString } from './bank-ops-2-procedures.js';
import { signedAmountString } from './bank-call-schemas.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-bank `loans.*`, one record per call, written from its router while its Rust port is in flight: every app caller calls it by its record, and the router keeps its own schemas until the port's switch. */

const base = { service: 'svc-bank', module: 'bank', transport: 'trpc' } as const;

export const projectionRow = z
  .object({
    date: z.string(),
    basis: amountString,
    interest: amountString,
    principal: amountString,
    debt: amountString,
  })
  .strict();

/**
 * Collateral needed now for a target draw, the starting LTV and the liquidation price, from the marks `open` accepts.
 * A missing or stale mark refuses `bank.mark_missing`; the lending policy off refuses `bank.loans_disabled`.
 */
export const BANK_LOANS_QUOTE = defineProcedure({
  ...base,
  name: 'bank.loans.quote',
  kind: 'query',
  path: 'loans.quote',
  access: { caller: 'scope', scope: 'bank:read', module: 'bank' },
  refusals: {},
  input: z.object({ productId: z.string().guid(), principal: amountString }).strict(),
  output: z
    .object({
      productId: z.string(),
      debtAssetId: z.string(),
      collateralAssetId: z.string(),
      quoteAssetId: z.string(),
      principal: amountString,
      requiredCollateral: amountString,
      startingLtvBps: z.number().int(),
      maxLtvBps: z.number().int(),
      liquidationLtvBps: z.number().int(),
      liquidationPrice: amountString,
      debtPrice: amountString,
      collateralPrice: amountString,
      pricedAt: z.string(),
    })
    .strict(),
  samples: [
    { verdict: 'accept', input: { productId: '11111111-1111-4111-8111-111111111111', principal: '1' } },
    { verdict: 'refuse', input: 42 },
  ],
});

/**
 * The owner's fee table for a new loan: the origination fee, or not set (and `open` refuses `bank.loan_fee_unset`).
 * `collectable` is false when a non-zero fee is published, because no ledger leg collects it yet and `open` refuses
 * `bank.loan_fee_unwired`.
 */
export const BANK_LOANS_FEES = defineProcedure({
  ...base,
  name: 'bank.loans.fees',
  kind: 'query',
  path: 'loans.fees',
  access: { caller: 'scope', scope: 'bank:read', module: 'bank' },
  refusals: {},
  input: z.object({ productId: z.string().guid(), principal: amountString.optional() }).strict(),
  output: z
    .object({
      productId: z.string(),
      assetId: z.string(),
      origination: z.union([
        z.object({ status: z.literal('not_set') }).strict(),
        z
          .object({
            status: z.literal('published'),
            bps: z.number().int(),
            amount: amountString.nullable(),
            collectable: z.boolean(),
          })
          .strict(),
      ]),
    })
    .strict(),
  samples: [
    { verdict: 'accept', input: { productId: '11111111-1111-4111-8111-111111111111' } },
    { verdict: 'refuse', input: 42 },
  ],
});

/** The terms written on this loan at open: its rate and thresholds, never the product's current ones. Self-only. */
export const BANK_LOANS_TERMS = defineProcedure({
  ...base,
  name: 'bank.loans.terms',
  kind: 'query',
  path: 'loans.terms',
  access: { caller: 'scope', scope: 'bank:read', module: 'bank' },
  refusals: {},
  input: z.object({ loanId: z.string().guid() }).strict(),
  output: z
    .object({
      loanId: z.string(),
      productId: z.string(),
      debtAssetId: z.string(),
      collateralAssetId: z.string(),
      principal: amountString,
      openingCollateral: amountString.nullable(),
      aprBps: z.number().int(),
      marginCallLtvBps: z.number().int().nullable(),
      liquidationLtvBps: z.number().int().nullable(),
      openedAt: z.string(),
    })
    .strict(),
  samples: [
    { verdict: 'accept', input: { loanId: '11111111-1111-4111-8111-111111111111' } },
    { verdict: 'refuse', input: 42 },
  ],
});

/** Interest through today, then principal, plus the published fee. Valid until the owner's window or the day's end. Not stored. */
export const BANK_LOANS_PAYOFF_QUOTE = defineProcedure({
  ...base,
  name: 'bank.loans.payoffQuote',
  kind: 'query',
  path: 'loans.payoffQuote',
  access: { caller: 'scope', scope: 'bank:read', module: 'bank' },
  refusals: {},
  input: z.object({ loanId: z.string().guid() }).strict(),
  output: z
    .object({
      loanId: z.string(),
      principal: amountString,
      interest: amountString,
      fee: amountString,
      total: amountString,
      assetId: z.string(),
      interestThrough: z.string(),
      validUntil: z.string(),
    })
    .strict(),
  samples: [
    { verdict: 'accept', input: { loanId: '11111111-1111-4111-8111-111111111111' } },
    { verdict: 'refuse', input: 42 },
  ],
});

/** Next UTC days of interest, using the accrual rule. Labelled a projection, not a schedule. */
export const BANK_LOANS_PROJECTION = defineProcedure({
  ...base,
  name: 'bank.loans.projection',
  kind: 'query',
  path: 'loans.projection',
  access: { caller: 'scope', scope: 'bank:read', module: 'bank' },
  refusals: {},
  input: z
    .object({
      loanId: z.string().guid(),
      days: z.number().int().min(1).max(366),
      extraRepayment: amountString.optional(),
    })
    .strict(),
  output: z
    .object({
      loanId: z.string(),
      kind: z.literal('projection'),
      obligation: z.literal(false),
      aprBps: z.number().int(),
      days: z.number().int(),
      openingPrincipal: amountString,
      openingInterest: amountString,
      extraApplied: amountString.nullable(),
      rows: z.array(projectionRow),
    })
    .strict(),
  samples: [
    { verdict: 'accept', input: { loanId: '11111111-1111-4111-8111-111111111111', days: 1 } },
    { verdict: 'refuse', input: 42 },
  ],
});

/**
 * LOAN-05: the loan's interest as rows. Each accrual day as written (newest first, at most a year listed and the
 * rest counted), each approved correction with its reason, and the totals they add up to. Rows are append-only.
 */
export const BANK_LOANS_INTEREST_ROWS = defineProcedure({
  ...base,
  name: 'bank.loans.interestRows',
  kind: 'query',
  path: 'loans.interestRows',
  access: { caller: 'scope', scope: 'bank:read', module: 'bank' },
  refusals: {},
  input: z.object({ loanId: z.string().guid() }).strict(),
  output: z
    .object({
      loanId: z.string(),
      assetId: z.string(),
      days: z.array(z.object({ date: z.string(), rateBps: z.number().int(), basis: amountString, interest: amountString }).strict()),
      earlierDays: z.number().int().nonnegative(),
      corrections: z.array(z.object({ id: z.string(), at: z.string(), amount: signedAmountString, reason: z.string() }).strict()),
      accrued: amountString,
      corrected: signedAmountString,
      paid: amountString,
      owed: amountString,
    })
    .strict(),
  samples: [
    { verdict: 'accept', input: { loanId: '11111111-1111-4111-8111-111111111111' } },
    { verdict: 'refuse', input: 42 },
  ],
});

/**
 * LOAN-05: this loan's settled draw, repayments and collateral movements against the ledger's own transactions,
 * leg by leg, and its collateral pot against them. A read; a difference is reported, never repaired here.
 */
export const BANK_LOANS_LEDGER_CHECK = defineProcedure({
  ...base,
  name: 'bank.loans.ledgerCheck',
  kind: 'query',
  path: 'loans.ledgerCheck',
  access: { caller: 'scope', scope: 'bank:read', module: 'bank' },
  refusals: {},
  input: z.object({ loanId: z.string().guid() }).strict(),
  output: z
    .object({
      loanId: z.string(),
      status: z.enum(['agrees', 'differs', 'pending']),
      checked: z.number().int().nonnegative(),
      pending: z.number().int().nonnegative(),
      collateralHeld: amountString,
      collateralExpected: signedAmountString,
      mismatches: z.array(z.object({ kind: z.string(), ref: z.string(), problem: z.string() }).strict()),
      checkedAt: z.string(),
    })
    .strict(),
  samples: [
    { verdict: 'accept', input: { loanId: '11111111-1111-4111-8111-111111111111' } },
    { verdict: 'refuse', input: 42 },
  ],
});

/** Signed CSV for one loan over a period. A month still in progress is marked provisional. */
export const BANK_LOANS_STATEMENT = defineProcedure({
  ...base,
  name: 'bank.loans.statement',
  kind: 'query',
  path: 'loans.statement',
  access: { caller: 'scope', scope: 'bank:read', module: 'bank' },
  refusals: {},
  input: z
    .object({
      loanId: z.string().guid(),
      from: z.string().datetime({ offset: true }),
      to: z.string().datetime({ offset: true }),
    })
    .strict(),
  output: z
    .object({
      format: z.literal('csv'),
      filename: z.string(),
      contentType: z.literal('text/csv; charset=utf-8'),
      bodyBase64: z.string(),
      sha256: z.string(),
      signature: z.string(),
      rowCount: z.number().int().nonnegative(),
      provisional: z.boolean(),
      openingPrincipal: amountString,
      openingInterest: amountString,
      closingPrincipal: amountString,
      closingInterest: amountString,
      generatedAt: z.string(),
    })
    .strict(),
  samples: [
    {
      verdict: 'accept',
      input: { loanId: '11111111-1111-4111-8111-111111111111', from: '2026-01-01T00:00:00.000Z', to: '2026-01-01T00:00:00.000Z' },
    },
    { verdict: 'refuse', input: 42 },
  ],
});
