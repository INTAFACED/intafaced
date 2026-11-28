import { z } from 'zod';
import { defineProcedure, NO_INPUT } from './procedure.js';
import { globalSendSchema } from './bank-global-procedures.js';
import { amountString, limitField, operatorHoldView, idString } from './bank-call-schemas.js';
import { assetIdSchema } from './asset-id.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-bank `global.*`, one record per call, written from its router while its Rust port is in flight: every app caller calls it by its record, and the router keeps its own schemas until the port's switch. */

const base = { service: 'svc-bank', module: 'bank', transport: 'trpc' } as const;

export const BANK_GLOBAL_OPS_PROOF = defineProcedure({
  ...base,
  name: 'bank.global.ops.proof',
  kind: 'query',
  path: 'global.ops.proof',
  access: { caller: 'scope', scope: 'admin:compliance', module: 'bank' },
  refusals: {},
  input: z.object({ sendId: z.string().guid() }).strict(),
  output: z.object({ name: z.string(), type: z.string(), contentBase64: z.string() }),
  samples: [
    { verdict: 'accept', input: { sendId: '11111111-1111-4111-8111-111111111111' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const BANK_GLOBAL_OPS_HOLDS = defineProcedure({
  ...base,
  name: 'bank.global.ops.holds',
  kind: 'query',
  path: 'global.ops.holds',
  access: { caller: 'scope', scope: 'admin:read', module: 'bank' },
  refusals: {},
  input: z.object({ limit: limitField }).strict(),
  output: z.array(operatorHoldView.extend({ send: globalSendSchema.extend({ userId: z.string() }) })),
  samples: [
    { verdict: 'accept', input: {} },
    { verdict: 'refuse', input: 42 },
  ],
});

export const BANK_GLOBAL_OPS_CONTROLS = defineProcedure({
  ...base,
  name: 'bank.global.ops.controls',
  kind: 'query',
  path: 'global.ops.controls',
  access: { caller: 'scope', scope: 'admin:read', module: 'bank' },
  refusals: {},
  input: NO_INPUT,
  output: z.object({
    payeeControls: z.object({ state: z.enum(['unset', 'published']), blockedCount: z.number() }),
    exchangeAllowance: z.object({
      state: z.enum(['unset', 'published']),
      windowDays: z.number().nullable(),
      exchangeCount: z.number(),
    }),
    proofLimits: z.object({
      state: z.enum(['unset', 'published']),
      allowedTypes: z.array(z.string()),
      maxBytes: z.number().nullable(),
    }),
  }),
  samples: [{ verdict: 'accept' }],
});

export const BANK_GLOBAL_OPS_SUMMARY = defineProcedure({
  ...base,
  name: 'bank.global.ops.summary',
  kind: 'query',
  path: 'global.ops.summary',
  access: { caller: 'scope', scope: 'admin:read', module: 'bank' },
  refusals: {},
  input: NO_INPUT,
  output: z.object({
    asOf: z.string(),
    counts: z.object({
      submitted: z.number(),
      held: z.number(),
      sent: z.number(),
      on_the_way: z.number(),
      arrived: z.number(),
      failed: z.number(),
      cancelled: z.number(),
      returned: z.number(),
      refunded: z.number(),
    }),
    volumes: z.array(z.object({ status: z.string(), assetId: assetIdSchema, count: z.number(), amount: amountString })),
    rails: z.object({
      corridors: z.enum(['unset', 'live']),
      fx: z.enum(['unset', 'live']),
      payout: z.enum(['unset', 'live']),
      bic: z.enum(['unset', 'live']),
      travelRule: z.enum(['undecided', 'recorded']),
      blocker: z.literal('socket.psp-partners'),
      standIn: z.string().nullable(),
    }),
  }),
  samples: [{ verdict: 'accept' }],
});

export const BANK_GLOBAL_OPS_FAILED = defineProcedure({
  ...base,
  name: 'bank.global.ops.failed',
  kind: 'query',
  path: 'global.ops.failed',
  access: { caller: 'scope', scope: 'admin:read', module: 'bank' },
  refusals: {},
  input: z.object({ limit: limitField }).strict(),
  output: z.array(globalSendSchema.extend({ userId: z.string() })),
  samples: [
    { verdict: 'accept', input: {} },
    { verdict: 'refuse', input: 42 },
  ],
});

export const BANK_GLOBAL_OPS_RECALLS = defineProcedure({
  ...base,
  name: 'bank.global.ops.recalls',
  kind: 'query',
  path: 'global.ops.recalls',
  access: { caller: 'scope', scope: 'admin:read', module: 'bank' },
  refusals: {},
  input: z.object({ limit: limitField }).strict(),
  output: z.array(globalSendSchema.extend({ userId: z.string() })),
  samples: [
    { verdict: 'accept', input: {} },
    { verdict: 'refuse', input: 42 },
  ],
});

export const BANK_GLOBAL_OPS_HOLD = defineProcedure({
  ...base,
  name: 'bank.global.ops.hold',
  kind: 'mutation',
  path: 'global.ops.hold',
  access: { caller: 'scope', scope: 'admin:compliance', module: 'bank' },
  refusals: { 'bank.global_not_found': 'NOT_FOUND' },
  input: z
    .object({
      sendId: z.string().guid(),
      holdKey: idString,
      reason: z.string().min(1).max(500),
      infoRequest: z.string().min(1).max(1000).optional(),
    })
    .strict(),
  output: operatorHoldView,
  samples: [
    { verdict: 'accept', input: { sendId: '22222222-2222-4222-8222-222222222222', holdKey: 'placeholder', reason: 'placeholder' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const BANK_GLOBAL_OPS_REQUEST_INFO = defineProcedure({
  ...base,
  name: 'bank.global.ops.requestInfo',
  kind: 'mutation',
  path: 'global.ops.requestInfo',
  access: { caller: 'scope', scope: 'admin:compliance', module: 'bank' },
  refusals: { 'bank.hold_not_found': 'NOT_FOUND' },
  input: z.object({ sendId: z.string().guid(), infoRequest: z.string().min(1).max(1000) }).strict(),
  output: operatorHoldView,
  samples: [
    { verdict: 'accept', input: { sendId: '22222222-2222-4222-8222-222222222222', infoRequest: 'placeholder' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const BANK_GLOBAL_OPS_RELEASE = defineProcedure({
  ...base,
  name: 'bank.global.ops.release',
  kind: 'mutation',
  path: 'global.ops.release',
  access: { caller: 'scope', scope: 'admin:compliance', module: 'bank' },
  refusals: { 'bank.hold_not_found': 'NOT_FOUND' },
  input: z.object({ sendId: z.string().guid() }).strict(),
  output: globalSendSchema,
  samples: [
    { verdict: 'accept', input: { sendId: '22222222-2222-4222-8222-222222222222' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const BANK_GLOBAL_OPS_LINK_REFERENCE = defineProcedure({
  ...base,
  name: 'bank.global.ops.linkReference',
  kind: 'mutation',
  path: 'global.ops.linkReference',
  access: { caller: 'scope', scope: 'admin:compliance', module: 'bank' },
  refusals: { 'bank.global_not_found': 'NOT_FOUND' },
  input: z.object({ sendId: z.string().guid(), reference: z.string().min(6).max(64) }).strict(),
  output: z.object({ linked: z.literal(true), send: globalSendSchema }),
  samples: [
    { verdict: 'accept', input: { sendId: '22222222-2222-4222-8222-222222222222', reference: 'placeholder' } },
    { verdict: 'refuse', input: 42 },
  ],
});
