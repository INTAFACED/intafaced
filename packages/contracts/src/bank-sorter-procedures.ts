import { z } from 'zod';
import { defineProcedure, NO_INPUT } from './procedure.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-bank `sorter.*`, one record per call, written from its router while its Rust port is in flight: every app caller calls it by its record, and the router keeps its own schemas until the port's switch. */

const base = { service: 'svc-bank', module: 'bank', transport: 'trpc' } as const;

export const amountString = z.string().regex(/^\d+(\.\d{1,18})?$/);

export const sorterView = z.object({
  id: z.string(),
  assetId: z.string(),
  status: z.enum(['active', 'cancelled']),
  legs: z.array(z.object({ spaceId: z.string(), shareBp: z.number().int() })),
  createdAt: z.string(),
  cancelledAt: z.string().nullable(),
});

/** A live sorter on the list: each leg names its space and says whether it was archived since (its share then stays). */
export const listedView = sorterView.extend({
  legs: z.array(z.object({ spaceId: z.string(), shareBp: z.number().int(), spaceName: z.string(), archived: z.boolean() })),
});

export const runView = z.object({
  id: z.string(),
  creditTransferId: z.string(),
  creditTxId: z.string(),
  creditAmount: amountString,
  /** When the payment posted; `createdAt` is when it was sorted. */
  creditPostedAt: z.string(),
  /** Recorded and not split: under the bank's smallest sorted payment, or no terms stood. */
  skippedReason: z.enum(['below_minimum', 'terms_unset']).nullable(),
  createdAt: z.string(),
  legs: z.array(
    z.object({
      position: z.number().int(),
      spaceId: z.string(),
      amount: amountString,
      status: z.enum(['pending', 'settled', 'rejected']),
      ledgerTxId: z.string().nullable(),
      rejectionCode: z.string().nullable(),
    }),
  ),
});

/** The bank's terms for sorting, and the caller's live sorters (one per asset at most). */
export const BANK_SORTER_LIST = defineProcedure({
  ...base,
  name: 'bank.sorter.list',
  kind: 'query',
  path: 'sorter.list',
  access: { caller: 'scope', scope: 'bank:read', module: 'bank' },
  refusals: {},
  input: NO_INPUT,
  output: z.object({
    terms: z.discriminatedUnion('state', [
      z.object({ state: z.literal('set'), minCredit: amountString }),
      z.object({ state: z.literal('not_set'), code: z.literal('bank.sorter_terms_unset') }),
    ]),
    sorters: z.array(listedView),
  }),
  samples: [{ verdict: 'accept' }],
});

/** What each sorted credit came to under one of the caller's sorters, newest first. */
export const BANK_SORTER_RUNS = defineProcedure({
  ...base,
  name: 'bank.sorter.runs',
  kind: 'query',
  path: 'sorter.runs',
  access: { caller: 'scope', scope: 'bank:read', module: 'bank' },
  refusals: {},
  input: z.object({ sorterId: z.string().guid(), limit: z.number().int().min(1).max(50) }).strict(),
  output: z.array(runView),
  samples: [
    { verdict: 'accept', input: { sorterId: '11111111-1111-4111-8111-111111111111', limit: 1 } },
    { verdict: 'refuse', input: 42 },
  ],
});
