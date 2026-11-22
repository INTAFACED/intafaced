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
