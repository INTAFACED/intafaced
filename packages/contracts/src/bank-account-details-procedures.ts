import { z } from 'zod';
import { defineProcedure } from './procedure.js';
import { currencyDetails, profileField } from './bank-call-schemas.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-bank `accountDetails.*`, one record per call: svc-bank mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-bank', module: 'bank', transport: 'trpc' } as const;

export const BANK_ACCOUNT_DETAILS_LIST = defineProcedure({
  ...base,
  name: 'bank.accountDetails.list',
  kind: 'query',
  path: 'accountDetails.list',
  access: { caller: 'scope', scope: 'bank:read', module: 'bank' },
  refusals: {},
  input: z.object({ profile: profileField }).strict().optional(),
  checks: { profile_field_holds: { at: 'input.profile', says: 'Expected "personal" or "business:<account id>"' } },
  output: z.object({ currencies: z.array(currencyDetails) }),
  samples: [
    { verdict: 'accept', input: {} },
    { verdict: 'refuse', input: 42 },
    { verdict: 'refuse', by: 'profile_field_holds', input: { profile: '' } },
  ],
});
