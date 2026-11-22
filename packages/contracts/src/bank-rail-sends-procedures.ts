import { z } from 'zod';
import { assetIdSchema } from './asset-id.js';
import { defineProcedure, NO_INPUT } from './procedure.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-bank `railSends.*`, one record per call, written from its router while its Rust port is in flight: every app caller calls it by its record, and the router keeps its own schemas until the port's switch. */

const base = { service: 'svc-bank', module: 'bank', transport: 'trpc' } as const;

export const BANK_RAILS = ['ach', 'wire', 'instant', 'sepa', 'proxy'] as const;

/**
 * `bank.railSends.*` (BK-xfer-02 and BK-xfer-06, J-bank-04 #1 and #2): send from a space to a bank account over a bank
 * rail (`./rail-sends.ts`). Asking takes `trade:withdraw`, the step-up scope, as every money-out door does. Nothing here
 * posts: with no banking partner on the rail, the intent is kept refused with `rail.bank`.
 */
export const rail = z.enum(BANK_RAILS);

export const payee = z
  .object({
    payeeId: z.string(),
    nickname: z.string(),
    country: z.string(),
    rail,
    recipient: z.string(),
    verification: z.literal('cannot_check'),
    verificationRail: z.literal('rail.bank'),
    addedAt: z.string(),
    cooling: z.object({ state: z.enum(['unset', 'active', 'open']), endsAt: z.string().nullable() }).strict(),
    scamWarning: z.object({ state: z.enum(['unread', 'read']), readAt: z.string().nullable() }).strict(),
  })
  .strict();

export const field = z.object({ name: z.string(), required: z.boolean(), choices: z.array(z.string()).nullable() }).strict();

export const intent = z
  .object({
    requestId: z.string(),
    fromSpaceId: z.string(),
    assetId: assetIdSchema,
    amount: z.string(),
    rail,
    recipient: z.string(),
    status: z.literal('refused'),
    refusalCode: z.string(),
    createdAt: z.string(),
  })
  .strict();

/** The person read the first-time payee scam warning for a recipient (BK-safe-02, J-bank-18 #2). Once per recipient. */
export const BANK_RAIL_SENDS_READ_PAYEE_WARNING = defineProcedure({
  ...base,
  name: 'bank.railSends.readPayeeWarning',
  kind: 'mutation',
  path: 'railSends.readPayeeWarning',
  access: { caller: 'scope', scope: 'bank:write', module: 'bank' },
  refusals: {},
  input: z.object({ payeeId: z.string().guid() }).strict(),
  output: payee,
  samples: [
    { verdict: 'accept', input: { payeeId: '11111111-1111-4111-8111-111111111111' } },
    { verdict: 'refuse', input: 42 },
  ],
});

/**
 * Each rail's recipient form and who carries it (no one in this build, so each names `rail.bank`), and the countries
 * the recipient book takes with the rails each one's forms come from.
 */
export const BANK_RAIL_SENDS_REQUIREMENTS = defineProcedure({
  ...base,
  name: 'bank.railSends.requirements',
  kind: 'query',
  path: 'railSends.requirements',
  access: { caller: 'scope', scope: 'bank:read', module: 'bank' },
  refusals: {},
  input: NO_INPUT,
  output: z
    .object({
      rails: z.array(z.object({ rail, fields: z.array(field), partner: z.null(), blocker: z.literal('rail.bank') }).strict()),
      countries: z.array(z.object({ country: z.string(), rails: z.array(rail) }).strict()),
    })
    .strict(),
  samples: [{ verdict: 'accept' }],
});

/** The customer's own sends over a bank rail, newest first. */
export const BANK_RAIL_SENDS_LIST = defineProcedure({
  ...base,
  name: 'bank.railSends.list',
  kind: 'query',
  path: 'railSends.list',
  access: { caller: 'scope', scope: 'bank:read', module: 'bank' },
  refusals: {},
  input: z.object({ limit: z.number().int().min(1).max(50) }).strict(),
  output: z.array(intent),
  samples: [
    { verdict: 'accept', input: { limit: 1 } },
    { verdict: 'refuse', input: 42 },
  ],
});

/** The recipient book (BK-xfer-06): saved recipients with their name check and cooling-off, newest first. */
export const BANK_RAIL_SENDS_PAYEES = defineProcedure({
  ...base,
  name: 'bank.railSends.payees',
  kind: 'query',
  path: 'railSends.payees',
  access: { caller: 'scope', scope: 'bank:read', module: 'bank' },
  refusals: {},
  input: z.object({ limit: z.number().int().min(1).max(50) }).strict(),
  output: z.array(payee),
  samples: [
    { verdict: 'accept', input: { limit: 1 } },
    { verdict: 'refuse', input: 42 },
  ],
});

/** Invite a recipient to enter their own details by email: refused by name while no email delivery is connected. */
export const BANK_RAIL_SENDS_INVITE_PAYEE = defineProcedure({
  ...base,
  name: 'bank.railSends.invitePayee',
  kind: 'mutation',
  path: 'railSends.invitePayee',
  access: { caller: 'scope', scope: 'bank:write', module: 'bank' },
  refusals: {},
  input: z.object({ email: z.string().max(254) }).strict(),
  output: z.never(),
  samples: [
    { verdict: 'accept', input: { email: 'USDC' } },
    { verdict: 'refuse', input: 42 },
  ],
});

/** Remove a saved recipient, waiting or not. */
export const BANK_RAIL_SENDS_REMOVE_PAYEE = defineProcedure({
  ...base,
  name: 'bank.railSends.removePayee',
  kind: 'mutation',
  path: 'railSends.removePayee',
  access: { caller: 'scope', scope: 'bank:write', module: 'bank' },
  refusals: {},
  input: z.object({ payeeId: z.string().guid() }).strict(),
  output: z.object({ payeeId: z.string(), removed: z.literal(true) }).strict(),
  samples: [
    { verdict: 'accept', input: { payeeId: '11111111-1111-4111-8111-111111111111' } },
    { verdict: 'refuse', input: 42 },
  ],
});
