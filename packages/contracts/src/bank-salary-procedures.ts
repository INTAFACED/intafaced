import { z } from 'zod';
import { defineProcedure } from './procedure.js';
import { salaryCreditView, profileField, ACCOUNT_DETAIL_REQUEST_STATES, detailSet } from './bank-call-schemas.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-bank `salary.*`, one record per call, written from its router while its Rust port is in flight: every app caller calls it by its record, and the router keeps its own schemas until the port's switch. */

const base = { service: 'svc-bank', module: 'bank', transport: 'trpc' } as const;

/** The person's salary credits, newest first: received, returned or reversed, each with its split. */
export const BANK_SALARY_CREDITS = defineProcedure({
  ...base,
  name: 'bank.salary.credits',
  kind: 'query',
  path: 'salary.credits',
  access: { caller: 'scope', scope: 'bank:read', module: 'bank' },
  refusals: {},
  input: z.object({ limit: z.number().int().min(1).max(100) }).strict(),
  output: z.array(salaryCreditView),
  samples: [
    { verdict: 'accept', input: { limit: 1 } },
    { verdict: 'refuse', input: 42 },
  ],
});

/** The details salary is paid to, per owner-listed currency, and the name the partner holds the account in. */
export const BANK_SALARY_DETAILS = defineProcedure({
  ...base,
  name: 'bank.salary.details',
  kind: 'query',
  path: 'salary.details',
  access: { caller: 'scope', scope: 'bank:read', module: 'bank' },
  refusals: {},
  input: z.object({ profile: profileField }).strict().optional(),
  checks: { profile_field_holds: { at: 'input.profile', says: 'Expected "personal" or "business:<account id>"' } },
  output: z.object({
    partnerBank: z.string(),
    network: z.string(),
    holderName: z.string().nullable(),
    currencies: z.array(
      z.object({
        currency: z.string(),
        state: z.enum(['unavailable', ...ACCOUNT_DETAIL_REQUEST_STATES]),
        blocker: z.literal('rail.bank').nullable(),
        sets: z.array(detailSet),
      }),
    ),
  }),
  samples: [
    { verdict: 'accept', input: {} },
    { verdict: 'refuse', input: 42 },
    { verdict: 'refuse', by: 'profile_field_holds', input: { profile: '' } },
  ],
});

/** The employer form for one currency, as fields and as the text the person downloads. */
export const BANK_SALARY_FORM = defineProcedure({
  ...base,
  name: 'bank.salary.form',
  kind: 'query',
  path: 'salary.form',
  access: { caller: 'scope', scope: 'bank:read', module: 'bank' },
  refusals: {},
  input: z.object({ currency: z.string().trim().length(3), profile: profileField }).strict(),
  checks: { profile_field_holds: { at: 'input.profile', says: 'Expected "personal" or "business:<account id>"' } },
  output: z.object({
    currency: z.string(),
    holderName: z.string(),
    partnerBank: z.string(),
    accountNumber: z.string().nullable(),
    sortCode: z.string().nullable(),
    routingNumber: z.string().nullable(),
    iban: z.string().nullable(),
    bic: z.string().nullable(),
    reference: z.string(),
    text: z.string(),
  }),
  samples: [
    { verdict: 'accept', input: { currency: 'xxx' } },
    { verdict: 'refuse', input: 42 },
    { verdict: 'refuse', by: 'profile_field_holds', input: { currency: 'xxx', profile: '' } },
  ],
});
