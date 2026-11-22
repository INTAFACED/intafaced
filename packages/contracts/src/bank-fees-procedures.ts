import { z } from 'zod';
import { assetIdSchema } from './asset-id.js';
import { defineProcedure, NO_INPUT } from './procedure.js';
import { amountString } from './bank-earn-procedures.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-bank `fees.*`, one record per call, written from its router while its Rust port is in flight: every app caller calls it by its record, and the router keeps its own schemas until the port's switch. */

const base = { service: 'svc-bank', module: 'bank', transport: 'trpc' } as const;

export const BANK_FEES_PARTNER = defineProcedure({
  ...base,
  name: 'bank.fees.partner',
  kind: 'query',
  path: 'fees.partner',
  access: { caller: 'scope', scope: 'bank:read', module: 'bank' },
  refusals: {},
  input: z.object({ assetId: assetIdSchema.min(1).max(16) }),
  output: z.discriminatedUnion('held', [
    z.object({ held: z.literal(false) }),
    z.object({
      held: z.literal(true),
      label: z.string(),
      assetId: assetIdSchema,
      dailyLimit: z.string().nullable(),
      usedToday: z.string().nullable(),
      remainingToday: z.string().nullable(),
      sendFee: z.string().nullable(),
      asOf: z.string().nullable(),
    }),
  ]),
  samples: [
    { verdict: 'accept', input: { assetId: 'USDC' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const BANK_FEES_SCHEDULE_GET = defineProcedure({
  ...base,
  name: 'bank.fees.schedule.get',
  kind: 'query',
  path: 'fees.schedule.get',
  access: { caller: 'scope', scope: 'bank:read', module: 'bank' },
  refusals: {},
  input: NO_INPUT,
  output: z.object({
    published: z.boolean(),
    entries: z.array(
      z.object({
        assetId: assetIdSchema,
        fee: amountString,
        free: z.boolean(),
        feeBlocker: z.literal('bank.personal_transfer_fee_unwired').nullable(),
        publishedAt: z.string(),
      }),
    ),
  }),
  samples: [{ verdict: 'accept' }],
});

export const BANK_FEES_ACCOUNT = defineProcedure({
  ...base,
  name: 'bank.fees.account',
  kind: 'query',
  path: 'fees.account',
  access: { caller: 'scope', scope: 'bank:read', module: 'bank' },
  refusals: {},
  input: NO_INPUT,
  output: z.object({
    set: z.boolean(),
    lines: z.array(z.object({ id: z.string(), label: z.string(), fee: z.string(), assetId: assetIdSchema })),
  }),
  samples: [{ verdict: 'accept' }],
});
