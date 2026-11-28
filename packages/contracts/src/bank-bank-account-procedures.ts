import { z } from 'zod';
import { defineProcedure } from './procedure.js';
import { profileField } from './bank-call-schemas.js';
import { assetIdSchema } from './asset-id.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-bank `bankAccount.*`, one record per call: svc-bank mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-bank', module: 'bank', transport: 'trpc' } as const;

export const iso = z.string().datetime();

export const infoRequestOut = z
  .object({
    id: z.string(),
    title: z.string(),
    detail: z.string(),
    openedAt: iso,
    dueAt: iso,
    status: z.enum(['open', 'under_review']),
    answeredAt: iso.nullable(),
    file: z.object({ name: z.string(), type: z.string(), size: z.number().int(), sha256: z.string() }).strict().nullable(),
    label: z.string(),
  })
  .strict();

export const reviewOut = z
  .object({
    id: z.string(),
    title: z.string(),
    dueAt: iso,
    missedEffect: z.string(),
    status: z.enum(['open', 'answered']),
    answeredAt: iso.nullable(),
    label: z.string(),
  })
  .strict();

export const businessId = z.string().regex(/^[A-Za-z0-9:_-]{8,64}$/);

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

/** The profile in view, as every bank call carries it (J-bank-01 #7); none is Personal. */
export const forProfile = z.object({ profile: profileField }).strict().optional();

export const dataRequestOut = z
  .object({
    id: z.string(),
    kind: z.enum(['access', 'portability']),
    requestedAt: iso,
    status: z.literal('received'),
    partnerRef: z.string(),
    label: z.string(),
  })
  .strict();

/** Answers one open request with one file, which goes to the partner; the request moves to under review once (#2). */
export const BANK_BANK_ACCOUNT_ANSWER_REQUEST = defineProcedure({
  ...base,
  name: 'bank.bankAccount.answerRequest',
  kind: 'mutation',
  path: 'bankAccount.answerRequest',
  access: { caller: 'scope', scope: 'bank:write', module: 'bank' },
  refusals: {},
  input: z
    .object({
      requestId: z.string().min(1).max(128),
      name: z.string().trim().min(1).max(200),
      type: z.string().trim().min(1).max(100),
      // The size cap is the owner's; this bound only stops a body far past any cap from being decoded.
      contentBase64: z.string().min(4).max(28_000_000),
      profile: profileField,
    })
    .strict(),
  checks: { profile_field_holds: { at: 'input.profile', says: 'Expected "personal" or "business:<account id>"' } },
  output: infoRequestOut,
  samples: [
    { verdict: 'accept', input: { requestId: 'placeholder', name: 'placeholder', type: 'placeholder', contentBase64: 'placeholder' } },
    { verdict: 'refuse', input: 42 },
    {
      verdict: 'refuse',
      by: 'profile_field_holds',
      input: { requestId: 'placeholder', name: 'placeholder', type: 'placeholder', contentBase64: 'placeholder', profile: 'Expected' },
    },
  ],
});

export const BANK_BANK_ACCOUNT_ANSWER_REVIEW = defineProcedure({
  ...base,
  name: 'bank.bankAccount.answerReview',
  kind: 'mutation',
  path: 'bankAccount.answerReview',
  access: { caller: 'scope', scope: 'bank:write', module: 'bank' },
  refusals: {},
  input: z
    .object({
      reviewId: z.string().min(1).max(128),
      stillAccurate: z.boolean(),
      note: z.string().trim().max(500).nullable(),
      profile: profileField,
    })
    .strict(),
  checks: { profile_field_holds: { at: 'input.profile', says: 'Expected "personal" or "business:<account id>"' } },
  output: reviewOut,
  samples: [
    { verdict: 'accept', input: { reviewId: 'placeholder', stillAccurate: true, note: 'placeholder' } },
    { verdict: 'refuse', input: 42 },
    {
      verdict: 'refuse',
      by: 'profile_field_holds',
      input: { reviewId: 'placeholder', stillAccurate: true, note: 'placeholder', profile: 'Expected' },
    },
  ],
});

/** Asks the partner to close the account, once per `closureId`; a balance needs a destination; a legal hold refuses (#5). */
export const BANK_BANK_ACCOUNT_REQUEST_CLOSURE = defineProcedure({
  ...base,
  name: 'bank.bankAccount.requestClosure',
  kind: 'mutation',
  path: 'bankAccount.requestClosure',
  access: { caller: 'scope', scope: 'bank:write', module: 'bank' },
  refusals: {},
  input: z
    .object({
      closureId: businessId,
      profile: profileField,
      destination: z
        .object({
          name: z.string().trim().min(1).max(140),
          accountRef: z
            .string()
            .trim()
            .regex(/^[A-Za-z0-9 ]{6,40}$/),
        })
        .strict()
        .nullable(),
    })
    .strict(),
  checks: { profile_field_holds: { at: 'input.profile', says: 'Expected "personal" or "business:<account id>"' } },
  output: closureOut,
  samples: [
    { verdict: 'accept', input: { closureId: 'placeholder', destination: { name: 'placeholder', accountRef: 'placeholder' } } },
    { verdict: 'refuse', input: 42 },
    {
      verdict: 'refuse',
      by: 'profile_field_holds',
      input: { closureId: 'placeholder', destination: { name: 'placeholder', accountRef: 'placeholder' }, profile: 'Expected' },
    },
  ],
});

/** Reopens a closed account within the owner's window (#6). */
export const BANK_BANK_ACCOUNT_REOPEN = defineProcedure({
  ...base,
  name: 'bank.bankAccount.reopen',
  kind: 'mutation',
  path: 'bankAccount.reopen',
  access: { caller: 'scope', scope: 'bank:write', module: 'bank' },
  refusals: {},
  input: forProfile,
  checks: { profile_field_holds: { at: 'input.profile', says: 'Expected "personal" or "business:<account id>"' } },
  output: closureOut,
  samples: [
    { verdict: 'accept', input: {} },
    { verdict: 'refuse', input: 42 },
    { verdict: 'refuse', by: 'profile_field_holds', input: { profile: 'Expected' } },
  ],
});

export const BANK_BANK_ACCOUNT_REQUEST_DATA = defineProcedure({
  ...base,
  name: 'bank.bankAccount.requestData',
  kind: 'mutation',
  path: 'bankAccount.requestData',
  access: { caller: 'scope', scope: 'bank:write', module: 'bank' },
  refusals: {},
  input: z.object({ requestId: businessId, kind: z.enum(['access', 'portability']), profile: profileField }).strict(),
  checks: { profile_field_holds: { at: 'input.profile', says: 'Expected "personal" or "business:<account id>"' } },
  output: dataRequestOut,
  samples: [
    { verdict: 'accept', input: { requestId: 'placeholder', kind: 'access' } },
    { verdict: 'refuse', input: 42 },
    { verdict: 'refuse', by: 'profile_field_holds', input: { requestId: 'placeholder', kind: 'access', profile: 'Expected' } },
  ],
});
