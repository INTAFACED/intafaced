import { z } from 'zod';
import { defineProcedure, NO_INPUT } from './procedure.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-bank `holds.*`, one record per call, written from its router while its Rust port is in flight: every app caller calls it by its record, and the router keeps its own schemas until the port's switch. */

const base = { service: 'svc-bank', module: 'bank', transport: 'trpc' } as const;

export const ruleView = z.object({
  strangers: z.enum(['pay_in', 'hold']),
  /** Whole days a held payment waits for an answer; null while the owner has published none. */
  holdDays: z.number().int().min(1).max(365).nullable(),
});

export const amountString = z.string().regex(/^\d+(\.\d{1,18})?$/);

export const holdView = z.object({
  transferId: z.string(),
  state: z.enum(['placing', 'held', 'releasing', 'released', 'returning', 'returned', 'lapsed']),
  reasonClass: z.literal('stranger'),
  amount: amountString,
  assetId: z.string(),
  fromHandle: z.string().nullable(),
  note: z.string().nullable(),
  createdAt: z.string(),
  releaseAt: z.string(),
  decidedAt: z.string().nullable(),
});

export const transferIdInput = z.object({ transferId: z.string().min(8).max(64) }).strict();

/** The caller's rule for payments from people not in their contacts, and the owner's release period. */
export const BANK_HOLDS_RULE = defineProcedure({
  ...base,
  name: 'bank.holds.rule',
  kind: 'query',
  path: 'holds.rule',
  access: { caller: 'scope', scope: 'bank:read', module: 'bank' },
  refusals: {},
  input: NO_INPUT,
  output: ruleView,
  samples: [{ verdict: 'accept' }],
});

/** Set the rule. "hold" while no release period is published refuses `bank.stranger_hold_period_unset`. */
export const BANK_HOLDS_SET_RULE = defineProcedure({
  ...base,
  name: 'bank.holds.setRule',
  kind: 'mutation',
  path: 'holds.setRule',
  access: { caller: 'scope', scope: 'bank:write', module: 'bank' },
  refusals: {},
  input: z.object({ strangers: z.enum(['pay_in', 'hold']) }).strict(),
  output: ruleView,
  samples: [
    { verdict: 'accept', input: { strangers: 'pay_in' } },
    { verdict: 'refuse', input: 42 },
  ],
});

/** The caller's payments waiting for an answer, newest first. */
export const BANK_HOLDS_WAITING = defineProcedure({
  ...base,
  name: 'bank.holds.waiting',
  kind: 'query',
  path: 'holds.waiting',
  access: { caller: 'scope', scope: 'bank:read', module: 'bank' },
  refusals: {},
  input: NO_INPUT,
  output: z.array(holdView),
  samples: [{ verdict: 'accept' }],
});

/** Accept: the whole held payment goes into the caller's balance, once. */
export const BANK_HOLDS_ACCEPT = defineProcedure({
  ...base,
  name: 'bank.holds.accept',
  kind: 'mutation',
  path: 'holds.accept',
  access: { caller: 'scope', scope: 'bank:write', module: 'bank' },
  refusals: {},
  input: transferIdInput,
  output: holdView,
  samples: [
    { verdict: 'accept', input: { transferId: 'ethereum' } },
    { verdict: 'refuse', input: 42 },
  ],
});

/** Deny: the whole held payment goes back to the person who sent it, once. */
export const BANK_HOLDS_DENY = defineProcedure({
  ...base,
  name: 'bank.holds.deny',
  kind: 'mutation',
  path: 'holds.deny',
  access: { caller: 'scope', scope: 'bank:write', module: 'bank' },
  refusals: {},
  input: transferIdInput,
  output: holdView,
  samples: [
    { verdict: 'accept', input: { transferId: 'ethereum' } },
    { verdict: 'refuse', input: 42 },
  ],
});
