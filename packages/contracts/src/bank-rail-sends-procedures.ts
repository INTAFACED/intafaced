import { z } from 'zod';
import { defineProcedure, NO_INPUT } from './procedure.js';
import { assetIdSchema } from './asset-id.js';

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

export const from = {
  fromSpaceId: z.string().guid(),
  amount: z
    .string()
    .trim()
    .regex(/^\d+(\.\d{1,18})?$/),
};

export const recipient = z.record(z.string().max(64), z.string().max(254)).refine((value) => Object.keys(value).length <= 8);

/** Details typed for this send, or a saved recipient. */
export const typed = { ...from, rail, recipient };

export const saved = { ...from, payeeId: z.string().guid() };

export const ask = z.union([z.object(typed).strict(), z.object(saved).strict()]);

export const payeeAsk = z.object({ nickname: z.string().max(120), country: z.string().max(8), rail, recipient }).strict();

/** Every check a send makes, keeping nothing: asked before the person spends a code on the confirmation. */
export const BANK_RAIL_SENDS_CHECK = defineProcedure({
  ...base,
  name: 'bank.railSends.check',
  kind: 'query',
  path: 'railSends.check',
  access: { caller: 'scope', scope: 'bank:read', module: 'bank' },
  refusals: {},
  input: ask,
  checks: { at_most_eight_keys: { at: 'input|0.recipient', says: 'at most eight keys' } },
  output: z.object({ assetId: assetIdSchema, amount: z.string(), available: z.string() }).strict(),
  samples: [
    {
      verdict: 'accept',
      input: {
        fromSpaceId: '22222222-2222-4222-8222-222222222222',
        amount: '1.50',
        rail: 'ach',
        recipient: { holderName: 'Ada TEST', routingNumber: '021000021', accountNumber: '000123456789', accountType: 'checking' },
      },
    },
    { verdict: 'refuse', input: 42 },
    {
      verdict: 'refuse',
      by: 'at_most_eight_keys',
      input: {
        fromSpaceId: '22222222-2222-4222-8222-222222222222',
        amount: '1.50',
        rail: 'ach',
        recipient: { k1: 'x', k2: 'x', k3: 'x', k4: 'x', k5: 'x', k6: 'x', k7: 'x', k8: 'x', k9: 'x' },
      },
    },
  ],
});

/** Every check saving makes, keeping nothing: asked before the person spends a code on the confirmation. */
export const BANK_RAIL_SENDS_CHECK_PAYEE = defineProcedure({
  ...base,
  name: 'bank.railSends.checkPayee',
  kind: 'query',
  path: 'railSends.checkPayee',
  access: { caller: 'scope', scope: 'bank:read', module: 'bank' },
  refusals: {},
  input: payeeAsk,
  checks: { at_most_eight_keys: { at: 'input.recipient', says: 'at most eight keys' } },
  output: z.object({ nickname: z.string(), country: z.string(), rail, recipient: z.string() }).strict(),
  samples: [
    {
      verdict: 'accept',
      input: {
        nickname: 'Ada TEST',
        country: 'US',
        rail: 'ach',
        recipient: { holderName: 'Ada TEST', routingNumber: '021000021', accountNumber: '000123456789', accountType: 'checking' },
      },
    },
    { verdict: 'refuse', input: 42 },
    {
      verdict: 'refuse',
      by: 'at_most_eight_keys',
      input: {
        nickname: 'Ada TEST',
        country: 'US',
        rail: 'ach',
        recipient: { k1: 'x', k2: 'x', k3: 'x', k4: 'x', k5: 'x', k6: 'x', k7: 'x', k8: 'x', k9: 'x' },
      },
    },
  ],
});

/** Save a recipient, behind the step-up scope: the same destination again is the same recipient. */
export const BANK_RAIL_SENDS_ADD_PAYEE = defineProcedure({
  ...base,
  name: 'bank.railSends.addPayee',
  kind: 'mutation',
  path: 'railSends.addPayee',
  access: { caller: 'scope', scope: 'trade:withdraw', module: 'bank' },
  refusals: {},
  input: payeeAsk,
  checks: { at_most_eight_keys: { at: 'input.recipient', says: 'at most eight keys' } },
  output: payee,
  samples: [
    {
      verdict: 'accept',
      input: {
        nickname: 'Ada TEST',
        country: 'US',
        rail: 'ach',
        recipient: { holderName: 'Ada TEST', routingNumber: '021000021', accountNumber: '000123456789', accountType: 'checking' },
      },
    },
    { verdict: 'refuse', input: 42 },
    {
      verdict: 'refuse',
      by: 'at_most_eight_keys',
      input: {
        nickname: 'Ada TEST',
        country: 'US',
        rail: 'ach',
        recipient: { k1: 'x', k2: 'x', k3: 'x', k4: 'x', k5: 'x', k6: 'x', k7: 'x', k8: 'x', k9: 'x' },
      },
    },
  ],
});
