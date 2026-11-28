import { defineProcedure } from './procedure.js';
import {
  businessReceiptsZipSchema,
  businessExpensesOverviewSchema,
  businessCardSchema,
  businessCardPurchaseSchema,
  businessCardLimitRequestSchema,
  businessExpensePolicySchema,
  businessReimbursementSchema,
} from './bank-business-cards.js';
import { accountInput, amountString, stepUpApprovalField } from './bank-call-schemas.js';
import { z } from 'zod';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-bank `businessCards.*`, one record per call, written from its router while its Rust port is in flight: every app caller calls it by its record, and the router keeps its own schemas until the port's switch. */

const base = { service: 'svc-bank', module: 'bank', transport: 'trpc' } as const;

/** Every receipt of the business in one ZIP file, base64 on the wire. */
export const BANK_BUSINESS_CARDS_RECEIPTS_ZIP = defineProcedure({
  ...base,
  name: 'bank.businessCards.receiptsZip',
  kind: 'query',
  path: 'businessCards.receiptsZip',
  access: { caller: 'scope', scope: 'bank:read', module: 'bank' },
  refusals: {},
  input: accountInput,
  output: businessReceiptsZipSchema,
  samples: [
    { verdict: 'accept', input: { accountId: '11111111-1111-4111-8111-111111111111' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const BANK_BUSINESS_CARDS_OVERVIEW = defineProcedure({
  ...base,
  name: 'bank.businessCards.overview',
  kind: 'query',
  path: 'businessCards.overview',
  access: { caller: 'scope', scope: 'bank:read', module: 'bank' },
  refusals: {},
  input: accountInput,
  output: businessExpensesOverviewSchema,
  samples: [
    { verdict: 'accept', input: { accountId: '22222222-2222-4222-8222-222222222222' } },
    { verdict: 'refuse', input: 42 },
  ],
});

/** Issues a TEST card to a member of the business with a per-purchase limit. */
export const BANK_BUSINESS_CARDS_ISSUE_CARD = defineProcedure({
  ...base,
  name: 'bank.businessCards.issueCard',
  kind: 'mutation',
  path: 'businessCards.issueCard',
  access: { caller: 'scope', scope: 'bank:write', module: 'bank' },
  refusals: {},
  input: z
    .object({
      accountId: z.string().guid(),
      cardId: z.string().guid(),
      memberUserId: z.string().min(1).max(128),
      perPurchaseLimit: amountString,
    })
    .strict(),
  output: businessCardSchema,
  samples: [
    {
      verdict: 'accept',
      input: {
        accountId: '22222222-2222-4222-8222-222222222222',
        cardId: '22222222-2222-4222-8222-222222222222',
        memberUserId: 'placeholder',
        perPurchaseLimit: '1.50',
      },
    },
    { verdict: 'refuse', input: 42 },
  ],
});

/** A purchase on the TEST card network (the `rail.card` stand-in), by the card's holder. Refused off the TEST stack. */
export const BANK_BUSINESS_CARDS_TEST_PURCHASE = defineProcedure({
  ...base,
  name: 'bank.businessCards.testPurchase',
  kind: 'mutation',
  path: 'businessCards.testPurchase',
  access: { caller: 'scope', scope: 'bank:write', module: 'bank' },
  refusals: {},
  input: z
    .object({ cardId: z.string().guid(), purchaseId: z.string().guid(), merchant: z.string().min(1).max(80), amount: amountString })
    .strict(),
  output: businessCardPurchaseSchema,
  samples: [
    {
      verdict: 'accept',
      input: {
        cardId: '22222222-2222-4222-8222-222222222222',
        purchaseId: '22222222-2222-4222-8222-222222222222',
        merchant: 'placeholder',
        amount: '1.50',
      },
    },
    { verdict: 'refuse', input: 42 },
  ],
});

export const BANK_BUSINESS_CARDS_DECIDE_LIMIT_REQUEST = defineProcedure({
  ...base,
  name: 'bank.businessCards.decideLimitRequest',
  kind: 'mutation',
  path: 'businessCards.decideLimitRequest',
  access: { caller: 'scope', scope: 'bank:write', module: 'bank' },
  refusals: {},
  input: z.object({ purchaseId: z.string().guid(), approve: z.boolean() }).strict(),
  output: businessCardLimitRequestSchema,
  samples: [
    { verdict: 'accept', input: { purchaseId: '22222222-2222-4222-8222-222222222222', approve: true } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const BANK_BUSINESS_CARDS_SET_POLICY = defineProcedure({
  ...base,
  name: 'bank.businessCards.setPolicy',
  kind: 'mutation',
  path: 'businessCards.setPolicy',
  access: { caller: 'scope', scope: 'bank:write', module: 'bank' },
  refusals: {},
  input: z.object({ accountId: z.string().guid(), receiptOver: amountString }).strict(),
  output: businessExpensePolicySchema,
  samples: [
    { verdict: 'accept', input: { accountId: '22222222-2222-4222-8222-222222222222', receiptOver: '1.50' } },
    { verdict: 'refuse', input: 42 },
  ],
});

/** An approver's yes, never the claimant's: one partner move to the member's own account, sent once. */
export const BANK_BUSINESS_CARDS_APPROVE_AND_PAY = defineProcedure({
  ...base,
  name: 'bank.businessCards.approveAndPay',
  kind: 'mutation',
  path: 'businessCards.approveAndPay',
  access: { caller: 'scope', scope: 'bank:write', module: 'bank' },
  refusals: {},
  input: z.object({ claimId: z.string().guid(), stepUpApprovalId: stepUpApprovalField }).strict(),
  output: businessReimbursementSchema,
  samples: [
    { verdict: 'accept', input: { claimId: '22222222-2222-4222-8222-222222222222' } },
    { verdict: 'refuse', input: 42 },
  ],
});
