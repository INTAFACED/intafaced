import { z } from 'zod';
import { defineProcedure } from './procedure.js';
import { amountString } from './bank-call-schemas.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-bank `loans.*`, one record per call, written from its router while its Rust port is in flight: every app caller calls it by its record, and the router keeps its own schemas until the port's switch. */

const base = { service: 'svc-bank', module: 'bank', transport: 'trpc' } as const;

/**
 * `loanId` is supplied by the client so a retried request is the same loan,
 * not a second one (§5). A timeout on this call must not leave a borrower with
 * two leveraged positions against collateral they meant to pledge once.
 */
export const BANK_LOANS_OPEN = defineProcedure({
  ...base,
  name: 'bank.loans.open',
  kind: 'mutation',
  path: 'loans.open',
  access: { caller: 'scope', scope: 'bank:write', module: 'bank' },
  refusals: {},
  input: z.object({
    loanId: z.string().guid(),
    productId: z.string().guid(),
    collateralAmount: amountString,
    principal: amountString,
    /** The rate the borrower was shown; a new loan refuses bank.loan_rate_changed when it no longer matches. */
    expectedAprBps: z.number().int().min(0).max(10_000).optional(),
  }),
  output: z.object({ loanId: z.string(), status: z.string(), ltvBps: z.number().int(), drawLedgerTxId: z.string() }),
  samples: [
    {
      verdict: 'accept',
      input: {
        loanId: '11111111-1111-4111-8111-111111111111',
        productId: '11111111-1111-4111-8111-111111111111',
        collateralAmount: '1',
        principal: '1',
      },
    },
    { verdict: 'refuse', input: 42 },
  ],
});

export const BANK_LOANS_REPAY = defineProcedure({
  ...base,
  name: 'bank.loans.repay',
  kind: 'mutation',
  path: 'loans.repay',
  access: { caller: 'scope', scope: 'bank:write', module: 'bank' },
  refusals: {},
  input: z.object({ loanId: z.string().guid(), amount: amountString, eventId: z.string().guid() }),
  output: z.object({
    ledgerTxId: z.string(),
    interestPaid: amountString,
    principalPaid: amountString,
    remainingPrincipal: amountString,
    remainingInterest: amountString,
    closed: z.boolean(),
  }),
  samples: [
    {
      verdict: 'accept',
      input: { loanId: '11111111-1111-4111-8111-111111111111', amount: '1', eventId: '11111111-1111-4111-8111-111111111111' },
    },
    { verdict: 'refuse', input: 42 },
  ],
});

/**
 * `eventId` is the client retry key (§5). Required: omit used to allocate
 * MAX+1 and post a second loanCollateralLock. Same eventId + amount is one lock.
 */
export const BANK_LOANS_ADD_COLLATERAL = defineProcedure({
  ...base,
  name: 'bank.loans.addCollateral',
  kind: 'mutation',
  path: 'loans.addCollateral',
  access: { caller: 'scope', scope: 'bank:write', module: 'bank' },
  refusals: {},
  input: z.object({ loanId: z.string().guid(), eventId: z.string().guid(), amount: amountString }),
  output: z.object({ ledgerTxId: z.string(), sequence: z.number().int() }),
  samples: [
    {
      verdict: 'accept',
      input: { loanId: '11111111-1111-4111-8111-111111111111', eventId: '11111111-1111-4111-8111-111111111111', amount: '1' },
    },
    { verdict: 'refuse', input: 42 },
  ],
});

export const BANK_LOANS_RELEASE_EXCESS = defineProcedure({
  ...base,
  name: 'bank.loans.releaseExcess',
  kind: 'mutation',
  path: 'loans.releaseExcess',
  access: { caller: 'scope', scope: 'bank:write', module: 'bank' },
  refusals: {},
  input: z.object({ loanId: z.string().guid(), eventId: z.string().guid(), amount: amountString }),
  output: z.object({ ledgerTxId: z.string(), sequence: z.number().int() }),
  samples: [
    {
      verdict: 'accept',
      input: { loanId: '11111111-1111-4111-8111-111111111111', eventId: '11111111-1111-4111-8111-111111111111', amount: '1' },
    },
    { verdict: 'refuse', input: 42 },
  ],
});

/** Release collateral on a loan that owes nothing. Refuses otherwise. */
export const BANK_LOANS_CLOSE = defineProcedure({
  ...base,
  name: 'bank.loans.close',
  kind: 'mutation',
  path: 'loans.close',
  access: { caller: 'scope', scope: 'bank:write', module: 'bank' },
  refusals: {},
  input: z.object({ loanId: z.string().guid() }),
  output: z.object({ released: amountString, ledgerTxId: z.string().nullable() }),
  samples: [
    { verdict: 'accept', input: { loanId: '11111111-1111-4111-8111-111111111111' } },
    { verdict: 'refuse', input: 42 },
  ],
});
