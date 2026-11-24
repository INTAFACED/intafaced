import { z } from 'zod';
import { defineProcedure } from './procedure.js';
import { currency, forProfile } from './bank-call-schemas.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-bank `currencies.*`, one record per call: svc-bank mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-bank', module: 'bank', transport: 'trpc' } as const;

export const BANK_CURRENCIES_LIST = defineProcedure({
  ...base,
  name: 'bank.currencies.list',
  kind: 'query',
  path: 'currencies.list',
  access: { caller: 'scope', scope: 'bank:read', module: 'bank' },
  refusals: {},
  input: forProfile.optional(),
  checks: { profile_field_holds: { at: 'input.profile', says: 'Expected "personal" or "business:<account id>"' } },
  output: z.object({
    currencies: z.array(currency),
    addable: z.array(z.string()).nullable(),
    addableBlocker: z.literal('bank.account_currencies_unset').nullable(),
  }),
  samples: [
    { verdict: 'accept', input: {} },
    { verdict: 'refuse', input: 42 },
    { verdict: 'refuse', by: 'profile_field_holds', input: { profile: '' } },
  ],
});
