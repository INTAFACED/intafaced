import { z } from 'zod';
import { defineProcedure } from './procedure.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-bank `cashOut.*`, one record per call, written from its router while its Rust port is in flight: every app caller calls it by its record, and the router keeps its own schemas until the port's switch. */

const base = { service: 'svc-bank', module: 'bank', transport: 'trpc' } as const;

export const CASH_OUT_STATUSES = ['refused', 'processing', 'completed', 'failed', 'cancelled', 'returned'] as const;

export const request = z
  .object({
    requestId: z.string(),
    assetId: z.string(),
    amount: z.string(),
    linkedAccountId: z.string(),
    rail: z.literal('rail.bank'),
    status: z.enum(CASH_OUT_STATUSES),
    refusalCode: z.string().nullable(),
    fee: z.string().nullable(),
    receiveAmount: z.string().nullable(),
    receiveCurrency: z.string().nullable(),
    payoutRef: z.string().nullable(),
    ledgerTxId: z.string().nullable(),
    heldAt: z.string().nullable(),
    partnerMoveId: z.string().nullable(),
    failureCode: z.string().nullable(),
    returnedAmount: z.string().nullable(),
    remainsPaidOut: z.string().nullable(),
    createdAt: z.string(),
    completedAt: z.string().nullable(),
    failedAt: z.string().nullable(),
    cancelledAt: z.string().nullable(),
    returnedAt: z.string().nullable(),
  })
  .strict();

/**
 * `bank.cashOut.quote/start/requests` (BK-ord-01, J-bank-03): cash out to one of the customer's linked bank accounts
 * (`./cash-out.ts`). Asking takes `trade:withdraw`, the step-up scope, as every money-out door does. Only a request the
 * banking partner can take is held; the partner's answers come through its signed job doors, never through this router.
 */
export const amount = z
  .string()
  .trim()
  .regex(/^\d+(\.\d{1,18})?$/);

export const ask = { assetId: z.string().trim().min(1).max(16), amount, linkedAccountId: z.string().guid() };

export const LINKED_ACCOUNT_STATES = ['unverified', 'verified'] as const;

/** Why an account cannot be used, in the order they are checked. */
export const LINKED_ACCOUNT_BLOCKERS = [
  'bank.linked_account_unverified',
  'bank.offramp_cooling_unset',
  'bank.offramp_cooling_active',
] as const;

export const account = z
  .object({
    accountId: z.string().guid(),
    label: z.string(),
    holderName: z.string(),
    ibanMasked: z.string(),
    country: z.string(),
    state: z.enum(LINKED_ACCOUNT_STATES),
    usable: z.boolean(),
    blocker: z.enum(LINKED_ACCOUNT_BLOCKERS).nullable(),
    verificationRail: z.literal('rail.bank').nullable(),
    linkedAt: z.string(),
    coolingOffEndsAt: z.string().nullable(),
  })
  .strict();

/** The customer's own cash-out requests, newest first. */
export const BANK_CASH_OUT_REQUESTS = defineProcedure({
  ...base,
  name: 'bank.cashOut.requests',
  kind: 'query',
  path: 'cashOut.requests',
  access: { caller: 'scope', scope: 'bank:read', module: 'bank' },
  refusals: {},
  input: z.object({ limit: z.number().int().min(1).max(50) }).strict(),
  output: z.array(request),
  samples: [
    { verdict: 'accept', input: { limit: 1 } },
    { verdict: 'refuse', input: 42 },
  ],
});

/** The signed receipt of a cash-out that was paid out: its text, SHA-256, signature, and the ledger
 * transaction or (partner-held) the partner's move that paid it. */
export const BANK_CASH_OUT_RECEIPT = defineProcedure({
  ...base,
  name: 'bank.cashOut.receipt',
  kind: 'query',
  path: 'cashOut.receipt',
  access: { caller: 'scope', scope: 'bank:read', module: 'bank' },
  refusals: {},
  input: z.object({ requestId: z.string().guid() }).strict(),
  output: z
    .object({
      fileName: z.string(),
      text: z.string(),
      ledgerTxId: z.string().nullable(),
      partnerMoveId: z.string().nullable(),
      sha256: z.string(),
      signature: z.string(),
    })
    .strict(),
  samples: [
    { verdict: 'accept', input: { requestId: '11111111-1111-4111-8111-111111111111' } },
    { verdict: 'refuse', input: 42 },
  ],
});

/** The entry checks, the account and what stands in the way, or the partner's fee and what arrives. None is invented. */
export const BANK_CASH_OUT_QUOTE = defineProcedure({
  ...base,
  name: 'bank.cashOut.quote',
  kind: 'query',
  path: 'cashOut.quote',
  access: { caller: 'scope', scope: 'bank:read', module: 'bank' },
  refusals: {},
  input: z.object(ask).strict(),
  output: z
    .object({
      assetId: z.string(),
      amount: z.string(),
      available: z.string(),
      heldAt: z.string().nullable(),
      account,
      rail: z.literal('rail.bank'),
      fee: z.string().nullable(),
      receiveAmount: z.string().nullable(),
      receiveCurrency: z.string().nullable(),
      blocker: z.string().nullable(),
      standIn: z.string().nullable(),
    })
    .strict(),
  samples: [
    { verdict: 'accept', input: { assetId: 'USDC', amount: '1', linkedAccountId: '11111111-1111-4111-8111-111111111111' } },
    { verdict: 'refuse', input: 42 },
  ],
});

/** Ask to cash out, behind the step-up scope. The request id is the business key of one ask. */
export const BANK_CASH_OUT_START = defineProcedure({
  ...base,
  name: 'bank.cashOut.start',
  kind: 'mutation',
  path: 'cashOut.start',
  access: { caller: 'scope', scope: 'trade:withdraw', module: 'bank' },
  refusals: {},
  input: z.object({ requestId: z.string().guid(), ...ask }).strict(),
  output: request,
  samples: [
    {
      verdict: 'accept',
      input: {
        requestId: '11111111-1111-4111-8111-111111111111',
        assetId: 'USDC',
        amount: '1',
        linkedAccountId: '11111111-1111-4111-8111-111111111111',
      },
    },
    { verdict: 'refuse', input: 42 },
  ],
});
