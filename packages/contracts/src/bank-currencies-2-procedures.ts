import { z } from 'zod';
import { defineProcedure } from './procedure.js';
import { profileField } from './bank-call-schemas.js';
import { assetIdSchema } from './asset-id.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-bank `currencies.*`, one record per call: svc-bank mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-bank', module: 'bank', transport: 'trpc' } as const;

/**
 * `bank.accounts.features`, `bank.accounts.profile` and `bank.currencies.list/add/remove` (BK-acct-01). The terms are a read
 * of the owner's publication; the currency writes are labels over ledger accounts. Nothing here writes to the ledger.
 *
 * Each call takes the profile it is made for. A profile the caller does not hold refuses `bank.profile_not_held` before
 * anything is read or written; a held business refuses the personal-account parts (`./profile.ts`).
 */
export const assetId = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9]{2,16}$/);

export const currency = z.object({ assetId: assetIdSchema, spaceId: z.string(), balance: z.string() });

/** Put a currency on the account. The same currency again is the same space. */
export const BANK_CURRENCIES_ADD = defineProcedure({
  ...base,
  name: 'bank.currencies.add',
  kind: 'mutation',
  path: 'currencies.add',
  access: { caller: 'scope', scope: 'bank:write', module: 'bank' },
  refusals: {},
  input: z.object({ assetId, profile: profileField }).strict(),
  checks: { profile_field_holds: { at: 'input.profile', says: 'Expected "personal" or "business:<account id>"' } },
  output: currency,
  samples: [
    { verdict: 'accept', input: { assetId: 'BTC' } },
    { verdict: 'refuse', input: 42 },
    { verdict: 'refuse', by: 'profile_field_holds', input: { assetId: 'BTC', profile: 'Expected' } },
  ],
});
