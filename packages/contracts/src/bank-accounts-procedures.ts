import { defineProcedure } from './procedure.js';
import { accountTermsOutput, forProfile, profileOutput } from './bank-call-schemas.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-bank `accounts.*`, one record per call: svc-bank mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-bank', module: 'bank', transport: 'trpc' } as const;

/**
 * The published base-tier terms. Blank refuses `bank.account_terms_unset`; there are no built-in terms. A plan that
 * publishes an overdraft carries `bank.overdraft_switched_off`: no overdraft engine exists in this build.
 */
export const BANK_ACCOUNTS_FEATURES = defineProcedure({
  ...base,
  name: 'bank.accounts.features',
  kind: 'query',
  path: 'accounts.features',
  access: { caller: 'scope', scope: 'bank:read', module: 'bank' },
  refusals: {},
  input: forProfile.optional(),
  checks: { profile_field_holds: { at: 'input.profile', says: 'Expected "personal" or "business:<account id>"' } },
  output: accountTermsOutput,
  samples: [
    { verdict: 'accept', input: {} },
    { verdict: 'refuse', input: 42 },
    { verdict: 'refuse', by: 'profile_field_holds', input: { profile: '' } },
  ],
});

/** The profile the app is showing, proved held: Personal, or a business with its name and the caller's role in it. */
export const BANK_ACCOUNTS_PROFILE = defineProcedure({
  ...base,
  name: 'bank.accounts.profile',
  kind: 'query',
  path: 'accounts.profile',
  access: { caller: 'scope', scope: 'bank:read', module: 'bank' },
  refusals: {},
  input: forProfile,
  checks: { profile_field_holds: { at: 'input.profile', says: 'Expected "personal" or "business:<account id>"' } },
  output: profileOutput,
  samples: [
    { verdict: 'accept', input: {} },
    { verdict: 'refuse', input: 42 },
    { verdict: 'refuse', by: 'profile_field_holds', input: { profile: '' } },
  ],
});
