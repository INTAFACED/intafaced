import { z } from 'zod';
import { defineProcedure, NO_INPUT } from './procedure.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-bank `rules.*`, one record per call, written from its router while its Rust port is in flight: every app caller calls it by its record, and the router keeps its own schemas until the port's switch. */

const base = { service: 'svc-bank', module: 'bank', transport: 'trpc' } as const;

/** The lead times a person can choose, in hours: one, two, three or seven days before a run. */
export const REMINDER_LEAD_HOURS = [24, 48, 72, 168] as const;

export const leadHours = z.literal(REMINDER_LEAD_HOURS);

export const reminderView = z.object({
  ruleKey: z.string(),
  leadHours: leadHours.nullable(),
  revision: z.number().int(),
  updatedAt: z.string(),
});

/**
 * `bank.rules.*` (BK-acct-10, J-bank-06 #6): the person's payment reminder rule and the rules that would move money by
 * themselves. Reading is `bank:read`; saving the reminder rule and asking for a money rule are `bank:write`. A money rule
 * refuses `bank.rule_terms_unset` until the owner publishes its terms, and nothing is stored.
 */
export const amountString = z.string().regex(/^\d+(\.\d{1,18})?$/);

/** No owner terms for rules that move money by themselves, so none can be created. */
export const RULE_TERMS_UNSET = 'bank.rule_terms_unset';

/** Save the reminder rule: a lead time from the offered choices, or `null` for off, at the revision read (0 for none). */
export const BANK_RULES_SET_REMINDER = defineProcedure({
  ...base,
  name: 'bank.rules.setReminder',
  kind: 'mutation',
  path: 'rules.setReminder',
  access: { caller: 'scope', scope: 'bank:write', module: 'bank' },
  refusals: {},
  input: z
    .object({
      leadHours: leadHours.nullable(),
      expectedRevision: z.number().int().min(0),
      clientRequestId: z.string().min(1).max(128),
    })
    .strict(),
  output: reminderView,
  samples: [
    { verdict: 'accept', input: { leadHours: 24, expectedRevision: 0, clientRequestId: 'USDC' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const BANK_RULES_GET = defineProcedure({
  ...base,
  name: 'bank.rules.get',
  kind: 'query',
  path: 'rules.get',
  access: { caller: 'scope', scope: 'bank:read', module: 'bank' },
  refusals: {},
  input: NO_INPUT,
  output: z.object({
    reminder: reminderView.nullable(),
    leadChoices: z.array(z.number().int()),
    moneyRules: z.object({ state: z.literal('not_set'), code: z.literal(RULE_TERMS_UNSET) }),
  }),
  samples: [{ verdict: 'accept' }],
});
