import { z } from 'zod';
import { defineProcedure } from './procedure.js';
import { amount, assetId, country, ONRAMP_METHODS, rail } from './bank-call-schemas.js';
import { assetIdSchema } from './asset-id.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-bank `addMoney.*`, one record per call: svc-bank mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-bank', module: 'bank', transport: 'trpc' } as const;

export const onramp = z.object({
  onrampId: z.string(),
  quoteId: z.string(),
  method: z.enum(ONRAMP_METHODS),
  /** What the person receives, in `assetId`: the quote's receive amount. */
  assetId: assetIdSchema,
  amount: z.string(),
  payAmount: z.string(),
  fee: z.string(),
  payCurrency: z.string(),
  status: z.literal('pending_payment'),
  partnerRail: z.string(),
  hostedUrl: z.string().nullable(),
  bankInstructions: z.object({ reference: z.string(), accountName: z.string(), accountRef: z.string() }).nullable(),
});

export const request = z.object({
  requestId: z.string(),
  assetId: assetIdSchema,
  amount: z.string(),
  method: z.enum(ONRAMP_METHODS),
  country: z.string(),
  rail,
  status: z.enum(['opening', 'refused', 'opened', 'pending', 'credited', 'returned', 'delivered']),
  refusalCode: z.string().nullable(),
  onramp: onramp.nullable(),
  createdAt: z.string(),
  openedAt: z.string().nullable(),
  pendingAt: z.string().nullable(),
  creditedAt: z.string().nullable(),
  creditedAmount: z.string().nullable(),
  creditedBy: z.enum(['ledger', 'partner']).nullable(),
  returnedAt: z.string().nullable(),
  walletAddress: z.string().nullable(),
  deliveredAt: z.string().nullable(),
  deliveryTx: z.string().nullable(),
});

/** Ask for money to be added. The request id is the business key: the same id and terms is the same request. */
export const BANK_ADD_MONEY_START = defineProcedure({
  ...base,
  name: 'bank.addMoney.start',
  kind: 'mutation',
  path: 'addMoney.start',
  access: { caller: 'scope', scope: 'bank:write', module: 'bank' },
  refusals: {},
  input: z
    .object({
      requestId: z.string().guid(),
      assetId,
      amount,
      method: z.enum(ONRAMP_METHODS),
      country,
      quoteId: z.string().guid().optional(),
      /** Buy to wallet (J-dex-protocol-05 #4): the person's own wallet the partner delivers to, not a balance here. */
      walletAddress: z
        .string()
        .trim()
        .regex(/^0x[0-9a-fA-F]{40}$/)
        .optional(),
      /** That wallet's EIP-191 signature over the request's own message (`walletDeliveryMessage`), proving it is theirs. */
      walletSignature: z
        .string()
        .trim()
        .regex(/^0x[0-9a-fA-F]{130}$/)
        .optional(),
    })
    .strict(),
  checks: { amount_holds: { at: 'input.amount', says: 'The amount must be above zero' } },
  output: request,
  samples: [
    {
      verdict: 'accept',
      input: { requestId: '22222222-2222-4222-8222-222222222222', assetId: 'placeholder', amount: '1.50', method: 'card', country: 'DE' },
    },
    { verdict: 'refuse', input: 42 },
    {
      verdict: 'refuse',
      by: 'amount_holds',
      input: { requestId: '22222222-2222-4222-8222-222222222222', assetId: 'placeholder', amount: '0', method: 'card', country: 'DE' },
    },
  ],
});
