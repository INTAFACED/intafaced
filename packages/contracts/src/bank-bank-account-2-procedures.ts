import { z } from 'zod';
import { defineProcedure } from './procedure.js';
import { forProfile, iso, unset } from './bank-bank-account-procedures.js';
import { assetIdSchema } from './asset-id.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-bank `bankAccount.*`, one record per call: svc-bank mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-bank', module: 'bank', transport: 'trpc' } as const;

export const closureOut = z
  .object({
    id: z.string(),
    state: z.enum(['pending', 'closed', 'reopened']),
    requestedAt: iso,
    balances: z.array(z.object({ assetId: assetIdSchema, spaceId: z.string().nullable(), amount: z.string() }).strict()),
    destination: z.object({ name: z.string(), accountRef: z.string() }).strict().nullable(),
    payoutMoveIds: z.array(z.string()),
    paidOutAt: iso.nullable(),
    closedAt: iso.nullable(),
    reopenedAt: iso.nullable(),
    label: z.string(),
  })
  .strict();

/** Whether the account is open, closing (restricted) or closed, every closure newest first, and the reopen window (#5, #6). */
export const BANK_BANK_ACCOUNT_CLOSURE = defineProcedure({
  ...base,
  name: 'bank.bankAccount.closure',
  kind: 'query',
  path: 'bankAccount.closure',
  access: { caller: 'scope', scope: 'bank:read', module: 'bank' },
  refusals: {},
  input: forProfile,
  checks: { profile_field_holds: { at: 'input.profile', says: 'Expected "personal" or "business:<account id>"' } },
  output: z
    .object({
      state: z.enum(['open', 'pending', 'closed']),
      closures: z.array(closureOut),
      reopenWindow: z.union([
        z.object({ state: z.literal('published'), days: z.number().int(), until: iso.nullable() }).strict(),
        unset('bank.reopen_window_unset'),
      ]),
    })
    .strict(),
  samples: [
    { verdict: 'accept', input: {} },
    { verdict: 'refuse', input: 42 },
    { verdict: 'refuse', by: 'profile_field_holds', input: { profile: 'Expected' } },
  ],
});
