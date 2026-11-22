import { z } from 'zod';
import { assetIdSchema } from './asset-id.js';
import { defineProcedure, NO_INPUT } from './procedure.js';
import { amountString } from './bank-earn-procedures.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-bank `loans.*`, one record per call, written from its router while its Rust port is in flight: every app caller calls it by its record, and the router keeps its own schemas until the port's switch. */

const base = { service: 'svc-bank', module: 'bank', transport: 'trpc' } as const;

/** One eligibility condition: met, not met (with the code `open` would refuse), or not set by the owner. */
export const reason = z
  .object({
    key: z.enum(['lending_policy', 'product_open', 'assets_open', 'origination_fee', 'jurisdiction_rules']),
    state: z.enum(['met', 'unmet', 'not_set']),
    code: z.string().nullable(),
  })
  .strict();

export const BANK_LOANS_PRODUCTS = defineProcedure({
  ...base,
  name: 'bank.loans.products',
  kind: 'query',
  path: 'loans.products',
  access: { caller: 'scope', scope: 'bank:read', module: 'bank' },
  refusals: {},
  input: z.object({
    assetId: assetIdSchema.min(1).max(16).optional(),
    /**
     * Page size. Optional so omit reaches `bank.loan_products_list_limit_unset`
     * instead of a Zod "Required". Blank is not 50; pass 50 explicitly.
     */
    limit: z.number().int().min(1).max(200).optional(),
  }),
  output: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      debtAssetId: z.string(),
      collateralAssetId: z.string(),
      quoteAssetId: z.string(),
      aprBps: z.number().int(),
      maxLtvBps: z.number().int(),
      marginCallLtvBps: z.number().int(),
      liquidationLtvBps: z.number().int(),
      /** Home's margin warning level, the owner's (BANK_MARGIN_WARNING_LTV_BPS); null while it is blank. */
      marginWarningLtvBps: z.number().int().nullable(),
      minPrincipal: amountString,
    }),
  ),
  samples: [
    { verdict: 'accept', input: {} },
    { verdict: 'refuse', input: 42 },
  ],
});

/** Why a new loan on this product would or would not open now, condition by condition. */
export const BANK_LOANS_ELIGIBILITY = defineProcedure({
  ...base,
  name: 'bank.loans.eligibility',
  kind: 'query',
  path: 'loans.eligibility',
  access: { caller: 'scope', scope: 'bank:read', module: 'bank' },
  refusals: {},
  input: z.object({ productId: z.string().guid() }).strict(),
  output: z.object({ productId: z.string(), eligible: z.boolean(), reasons: z.array(reason) }).strict(),
  samples: [
    { verdict: 'accept', input: { productId: '11111111-1111-4111-8111-111111111111' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const BANK_LOANS_LIST = defineProcedure({
  ...base,
  name: 'bank.loans.list',
  kind: 'query',
  path: 'loans.list',
  access: { caller: 'scope', scope: 'bank:read', module: 'bank' },
  refusals: {},
  input: z
    .object({
      /**
       * Page size. Optional so omit reaches `bank.loans_list_limit_unset`
       * instead of a Zod "Required". Blank is not 50; pass 50 explicitly.
       */
      limit: z.number().int().min(1).max(200).optional(),
    })
    .optional(),
  output: z.array(
    z.object({
      id: z.string(),
      productId: z.string(),
      debtAssetId: z.string(),
      collateralAssetId: z.string(),
      principal: amountString,
      outstandingPrincipal: amountString,
      outstandingInterest: amountString,
      collateral: amountString,
      aprBps: z.number().int(),
      status: z.string(),
      marginCalledAt: z.string().nullable(),
    }),
  ),
  samples: [
    { verdict: 'accept', input: {} },
    { verdict: 'refuse', input: 42 },
  ],
});

/**
 * Redeem-excess read (BK-loan-05): the most collateral `releaseExcess` would
 * release now under the product's max LTV. Self-only. Posts nothing.
 */
export const BANK_LOANS_RELEASABLE = defineProcedure({
  ...base,
  name: 'bank.loans.releasable',
  kind: 'query',
  path: 'loans.releasable',
  access: { caller: 'scope', scope: 'bank:read', module: 'bank' },
  refusals: {},
  input: z.object({ loanId: z.string().guid() }),
  output: z.object({
    loanId: z.string(),
    held: amountString,
    releasable: amountString,
    maxLtvBps: z.number().int(),
    ltvBps: z.number().int(),
  }),
  samples: [
    { verdict: 'accept', input: { loanId: '11111111-1111-4111-8111-111111111111' } },
    { verdict: 'refuse', input: 42 },
  ],
});

/**
 * The borrower's own risk view.
 *
 * Read-only and portfolio-wide, so someone can see a margin call coming
 * rather than learning about it from the liquidation. It marks; it never acts.
 */
export const BANK_LOANS_HEALTH = defineProcedure({
  ...base,
  name: 'bank.loans.health',
  kind: 'query',
  path: 'loans.health',
  access: { caller: 'scope', scope: 'bank:read', module: 'bank' },
  refusals: {},
  input: NO_INPUT,
  output: z.object({
    debtValue: amountString,
    collateralValue: amountString,
    portfolioLtvBps: z.number().int(),
    loans: z.array(
      z.object({
        loanId: z.string(),
        debtValue: amountString,
        collateralValue: amountString,
        ltvBps: z.number().int(),
      }),
    ),
  }),
  samples: [{ verdict: 'accept' }],
});
