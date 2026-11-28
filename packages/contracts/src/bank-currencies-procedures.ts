import { z } from 'zod';
import { defineProcedure } from './procedure.js';
import { currency, forProfile, profileField } from './bank-call-schemas.js';
import { assetId } from './bank-currencies-2-procedures.js';
import { assetIdSchema } from './asset-id.js';

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

/** Take a currency off the account. Refuses `bank.currency_in_use` while it holds anything. */
export const BANK_CURRENCIES_REMOVE = defineProcedure({
  ...base,
  name: 'bank.currencies.remove',
  kind: 'mutation',
  path: 'currencies.remove',
  access: { caller: 'scope', scope: 'bank:write', module: 'bank' },
  refusals: {},
  input: z.object({ assetId, profile: profileField }).strict(),
  checks: { profile_field_holds: { at: 'input.profile', says: 'Expected "personal" or "business:<account id>"' } },
  output: z.object({ assetId: assetIdSchema, removed: z.literal(true) }),
  samples: [
    { verdict: 'accept', input: { assetId: 'BTC' } },
    { verdict: 'refuse', input: 42 },
    { verdict: 'refuse', by: 'profile_field_holds', input: { assetId: 'BTC', profile: 'Expected' } },
  ],
});
