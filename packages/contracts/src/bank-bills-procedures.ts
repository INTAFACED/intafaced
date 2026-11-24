import { z } from 'zod';
import { defineProcedure, NO_INPUT } from './procedure.js';
import { amountString, billView, limitField } from './bank-call-schemas.js';
import { assetIdSchema } from './asset-id.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-bank `bills.*`, one record per call, written from its router while its Rust port is in flight: every app caller calls it by its record, and the router keeps its own schemas until the port's switch. */

const base = { service: 'svc-bank', module: 'bank', transport: 'trpc' } as const;

export const BANK_BILLS_OPS_SUMMARY = defineProcedure({
  ...base,
  name: 'bank.bills.ops.summary',
  kind: 'query',
  path: 'bills.ops.summary',
  access: { caller: 'scope', scope: 'admin:read', module: 'bank' },
  refusals: {},
  input: NO_INPUT,
  output: z.object({
    asOf: z.string(),
    counts: z.object({ submitted: z.number(), accepted: z.number(), paid: z.number(), failed: z.number(), returned: z.number() }),
    volumes: z.array(z.object({ status: z.string(), assetId: assetIdSchema, count: z.number(), amount: amountString })),
    rails: z.object({
      billerDirectory: z.enum(['unset', 'live']),
      lookup: z.enum(['unset', 'live']),
      payRail: z.enum(['unset', 'live']),
      blocker: z.literal('socket.psp-partners'),
    }),
  }),
  samples: [{ verdict: 'accept' }],
});

export const BANK_BILLS_OPS_FAILED = defineProcedure({
  ...base,
  name: 'bank.bills.ops.failed',
  kind: 'query',
  path: 'bills.ops.failed',
  access: { caller: 'scope', scope: 'admin:read', module: 'bank' },
  refusals: {},
  input: z.object({ limit: limitField, cursor: z.string().min(1).max(512).optional() }).strict(),
  output: z.object({ items: z.array(billView.extend({ userId: z.string() })), nextCursor: z.string().nullable() }),
  samples: [
    { verdict: 'accept', input: {} },
    { verdict: 'refuse', input: 42 },
  ],
});

/** One biller the bill directory answers with: ours when one is connected, else the partner's that holds the person's money. */
export const billerView = z.object({ id: z.string(), name: z.string(), country: z.string(), category: z.string() });

/** One recurring bill, each run of which is one bill payment. */
export const recurringBillView = z.object({
  id: z.string(),
  billerId: z.string(),
  reference: z.string(),
  amount: amountString,
  assetId: assetIdSchema,
  fromSpaceId: z.string(),
  cadence: z.enum(['weekly', 'monthly']),
  status: z.enum(['active', 'paused', 'cancelled', 'completed']),
  startsAt: z.string(),
  endsAt: z.string().nullable(),
  nextRunAt: z.string(),
});

/** The billers whose names hold the query; refuses `bank.bills_directory_unset` while no directory answers for the person. */
export const BANK_BILLS_BILLERS_SEARCH = defineProcedure({
  ...base,
  name: 'bank.bills.billers.search',
  kind: 'query',
  path: 'bills.billers.search',
  access: { caller: 'scope', scope: 'bank:read', module: 'bank' },
  refusals: {},
  input: z.object({ query: z.string().min(1).max(64), country: z.string().optional() }).strict(),
  output: z.array(billerView),
  samples: [
    { verdict: 'accept', input: { query: 'water' } },
    { verdict: 'refuse', input: { query: '' } },
  ],
});

/** A bill paid on its dates from one of the person's spaces; refuses `bank.bills_psp_unset` while no one can pay it. */
export const BANK_BILLS_RECURRING_CREATE = defineProcedure({
  ...base,
  name: 'bank.bills.recurring.create',
  kind: 'mutation',
  path: 'bills.recurring.create',
  access: { caller: 'scope', scope: 'bank:write', module: 'bank' },
  refusals: {},
  input: z
    .object({
      idempotencyKey: z.string().min(8).max(128),
      billerId: z.string().min(1).max(64),
      reference: z.string().min(1).max(64),
      amount: amountString,
      fromSpaceId: z.string().guid(),
      cadence: z.enum(['weekly', 'monthly']),
      startsAt: z.string().datetime(),
      endsAt: z.string().datetime().optional(),
      stepUpApprovalId: z.string().optional(),
    })
    .strict(),
  output: recurringBillView,
  samples: [
    {
      verdict: 'accept',
      input: {
        idempotencyKey: 'bill-recurring:0001',
        billerId: 'test-biller-water',
        reference: 'ACC-1',
        amount: '3',
        fromSpaceId: '11111111-1111-4111-8111-111111111111',
        cadence: 'monthly',
        startsAt: '2026-12-01T00:00:00.000Z',
      },
    },
    { verdict: 'refuse', input: { idempotencyKey: 'short' } },
  ],
});

/** The person's own bill payments, newest first. */
export const BANK_BILLS_LIST = defineProcedure({
  ...base,
  name: 'bank.bills.list',
  kind: 'query',
  path: 'bills.list',
  access: { caller: 'scope', scope: 'bank:read', module: 'bank' },
  refusals: {},
  input: z
    .object({
      limit: limitField,
      status: billView.shape.status.optional(),
      cursor: z.string().min(1).max(512).optional(),
    })
    .strict(),
  output: z.object({ items: z.array(billView), nextCursor: z.string().nullable() }),
  samples: [
    { verdict: 'accept', input: { limit: 20 } },
    { verdict: 'refuse', input: 42 },
  ],
});

/** The person's recurring bills. */
export const BANK_BILLS_RECURRING_LIST = defineProcedure({
  ...base,
  name: 'bank.bills.recurring.list',
  kind: 'query',
  path: 'bills.recurring.list',
  access: { caller: 'scope', scope: 'bank:read', module: 'bank' },
  refusals: {},
  input: z.object({ limit: limitField }).strict(),
  output: z.array(recurringBillView),
  samples: [
    { verdict: 'accept', input: { limit: 20 } },
    { verdict: 'refuse', input: 42 },
  ],
});
