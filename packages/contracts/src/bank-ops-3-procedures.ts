import { z } from 'zod';
import { defineProcedure } from './procedure.js';
import { actionApprovalFields, amountString, signedAmountString } from './bank-call-schemas.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-bank `ops.*`, one record per call: svc-bank mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-bank', module: 'bank', transport: 'trpc' } as const;

export const BANK_OPS_ACCRUE_INTEREST = defineProcedure({
  ...base,
  name: 'bank.ops.accrueInterest',
  kind: 'mutation',
  path: 'ops.accrueInterest',
  access: { caller: 'service', callers: ['svc-bank'], forbidden: 'ops job is callable only as svc-bank' },
  refusals: {},
  input: z.object({ poolId: z.string().guid().optional(), at: z.string().datetime({ offset: true }).optional() }),
  output: z.object({
    results: z.array(
      z.object({
        poolId: z.string(),
        date: z.string(),
        paid: amountString,
        recipients: z.number().int(),
        alreadyAccrued: z.boolean(),
      }),
    ),
    /** Pools that threw (e.g. underfunded); day not consumed for those pools. */
    failures: z.array(
      z.object({
        poolId: z.string(),
        reason: z.string(),
        code: z.string().optional(),
      }),
    ),
  }),
  samples: [
    { verdict: 'accept', input: {} },
    { verdict: 'refuse', input: 42 },
  ],
});

/** Give up on a pending loan and give the borrower their collateral back. */
export const BANK_OPS_ABANDON_PENDING_LOAN = defineProcedure({
  ...base,
  name: 'bank.ops.abandonPendingLoan',
  kind: 'mutation',
  path: 'ops.abandonPendingLoan',
  access: { caller: 'scope', scope: 'admin:treasury' },
  refusals: {},
  input: z.object({ loanId: z.string().guid(), ...actionApprovalFields }),
  output: z.object({
    released: amountString,
    ledgerTxId: z.string().nullable(),
    /** True when the draw had in fact booked: the loan was completed to active and no collateral moved. */
    adopted: z.boolean(),
    drawLedgerTxId: z.string().nullable(),
    confirmOperatorId: z.string(),
  }),
  samples: [
    { verdict: 'accept', input: { loanId: '22222222-2222-4222-8222-222222222222' } },
    { verdict: 'refuse', input: 42 },
  ],
});

/**
 * The reserve identity, as a query rather than an investigation:
 * `balance(loanReserve) + Σ outstanding principal` against what was funded.
 */
export const BANK_OPS_RECONCILE_LOAN_RESERVE = defineProcedure({
  ...base,
  name: 'bank.ops.reconcileLoanReserve',
  kind: 'query',
  path: 'ops.reconcileLoanReserve',
  access: { caller: 'scope', scope: 'admin:treasury' },
  refusals: {},
  input: z.object({ debtAssetId: z.string().min(1).max(16) }),
  output: z.object({
    reserveBalance: amountString,
    outstandingPrincipal: amountString,
    badDebt: amountString,
    funded: amountString,
    /** funded − badDebt − reserve − outstanding: a signed residual, negative when the reserve holds more than was recorded as funded. */
    drift: signedAmountString,
    /** False until funded is journal-independent; do not treat drift 0 as green. */
    independent: z.boolean(),
    insuranceCapacity: amountString,
  }),
  samples: [
    { verdict: 'accept', input: { debtAssetId: 'placeholder' } },
    { verdict: 'refuse', input: 42 },
  ],
});
