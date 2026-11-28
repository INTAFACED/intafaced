import { z } from 'zod';
import { defineProcedure, NO_INPUT } from './procedure.js';
import { account } from './bank-call-schemas.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-bank `linkedAccounts.*`, one record per call, written from its router while its Rust port is in flight: every app caller calls it by its record, and the router keeps its own schemas until the port's switch. */

const base = { service: 'svc-bank', module: 'bank', transport: 'trpc' } as const;

/** Every account the customer has linked, oldest first, each with its state and why it cannot be used yet. */
export const BANK_LINKED_ACCOUNTS_LIST = defineProcedure({
  ...base,
  name: 'bank.linkedAccounts.list',
  kind: 'query',
  path: 'linkedAccounts.list',
  access: { caller: 'scope', scope: 'bank:read', module: 'bank' },
  refusals: {},
  input: NO_INPUT,
  output: z.object({ accounts: z.array(account) }).strict(),
  samples: [{ verdict: 'accept' }],
});

/** Link an account, kept `unverified`. The IBAN is the business key: linking it again returns the same account. */
export const BANK_LINKED_ACCOUNTS_LINK = defineProcedure({
  ...base,
  name: 'bank.linkedAccounts.link',
  kind: 'mutation',
  path: 'linkedAccounts.link',
  access: { caller: 'scope', scope: 'trade:withdraw', module: 'bank' },
  refusals: {},
  input: z
    .object({
      label: z.string().min(1).max(64),
      holderName: z.string().min(1).max(140),
      iban: z.string().min(15).max(64),
    })
    .strict(),
  output: z.object({ account, created: z.boolean() }).strict(),
  samples: [
    { verdict: 'accept', input: { label: 'USDC', holderName: 'USDC', iban: '11111111-1111-4111-8111-111111111111' } },
    { verdict: 'refuse', input: 42 },
  ],
});

/** Unlink, with the same step-up scope. Removing one already removed answers the same. */
export const BANK_LINKED_ACCOUNTS_REMOVE = defineProcedure({
  ...base,
  name: 'bank.linkedAccounts.remove',
  kind: 'mutation',
  path: 'linkedAccounts.remove',
  access: { caller: 'scope', scope: 'trade:withdraw', module: 'bank' },
  refusals: {},
  input: z.object({ accountId: z.string().guid() }).strict(),
  output: z.object({ accountId: z.string(), removed: z.literal(true) }).strict(),
  samples: [
    { verdict: 'accept', input: { accountId: '11111111-1111-4111-8111-111111111111' } },
    { verdict: 'refuse', input: 42 },
  ],
});
