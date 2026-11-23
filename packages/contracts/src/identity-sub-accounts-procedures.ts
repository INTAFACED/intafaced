import { z } from 'zod';
import { defineProcedure } from './procedure.js';
import { balance, blocker, feature, SUB_ACCOUNT_KINDS } from './identity-call-schemas.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-identity `subAccounts.*`, one record per call: svc-identity mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-identity', module: 'identity', transport: 'trpc' } as const;

export const IDENTITY_SUB_ACCOUNTS_CREATE = defineProcedure({
  ...base,
  name: 'identity.subAccounts.create',
  kind: 'mutation',
  path: 'subAccounts.create',
  access: { caller: 'scope', scope: 'identity:write' },
  refusals: {},
  input: z.object({
    label: z.string().min(1).max(64),
    purpose: z.string().max(200).optional(),
    kind: z.enum(SUB_ACCOUNT_KINDS).optional(),
    nickname: z.string().max(64).optional(),
  }),
  output: z.object({ id: z.string().guid() }),
  samples: [
    { verdict: 'accept', input: { label: 'USDC' } },
    { verdict: 'refuse', input: 42 },
  ],
});

/**
 * Soft-disable. Self-only via principal.userId → parent_user_id.
 * No ledger posts — balances under this id are untouched.
 */
export const IDENTITY_SUB_ACCOUNTS_REVOKE = defineProcedure({
  ...base,
  name: 'identity.subAccounts.revoke',
  kind: 'mutation',
  path: 'subAccounts.revoke',
  access: { caller: 'scope', scope: 'identity:write' },
  refusals: {},
  input: z.object({ subAccountId: z.string().guid() }),
  output: z.object({ revoked: z.boolean() }),
  samples: [
    { verdict: 'accept', input: { subAccountId: '11111111-1111-4111-8111-111111111111' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const IDENTITY_SUB_ACCOUNTS_DELETE_CHECK = defineProcedure({
  ...base,
  name: 'identity.subAccounts.deleteCheck',
  kind: 'query',
  path: 'subAccounts.deleteCheck',
  access: { caller: 'signedIn' },
  refusals: {},
  input: z.object({ subAccountId: z.string().guid() }).strict(),
  output: z.object({ blockers: z.array(blocker), balances: z.array(balance) }),
  samples: [
    { verdict: 'accept', input: { subAccountId: '11111111-1111-4111-8111-111111111111' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const IDENTITY_SUB_ACCOUNTS_DELETE = defineProcedure({
  ...base,
  name: 'identity.subAccounts.delete',
  kind: 'mutation',
  path: 'subAccounts.delete',
  access: { caller: 'signedIn' },
  refusals: {},
  input: z
    .object({ subAccountId: z.string().guid(), stepUpApprovalId: z.string().guid(), clientRequestId: z.string().min(1).max(128) })
    .strict(),
  output: z.object({ deleted: z.literal(true), changed: z.boolean() }),
  samples: [
    {
      verdict: 'accept',
      input: {
        subAccountId: '11111111-1111-4111-8111-111111111111',
        stepUpApprovalId: '11111111-1111-4111-8111-111111111111',
        clientRequestId: 'USDC',
      },
    },
    { verdict: 'refuse', input: 42 },
  ],
});

export const IDENTITY_SUB_ACCOUNTS_GET_FEATURES = defineProcedure({
  ...base,
  name: 'identity.subAccounts.getFeatures',
  kind: 'query',
  path: 'subAccounts.getFeatures',
  access: { caller: 'signedIn' },
  refusals: {},
  input: z.object({ subAccountId: z.string().guid() }).strict(),
  output: z.object({
    kind: z.enum(SUB_ACCOUNT_KINDS),
    frozen: z.boolean(),
    published: z.boolean(),
    features: z.array(z.object({ feature, offered: z.boolean(), enabled: z.boolean() })),
  }),
  samples: [
    { verdict: 'accept', input: { subAccountId: '11111111-1111-4111-8111-111111111111' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const IDENTITY_SUB_ACCOUNTS_ASSETS = defineProcedure({
  ...base,
  name: 'identity.subAccounts.assets',
  kind: 'query',
  path: 'subAccounts.assets',
  access: { caller: 'signedIn' },
  refusals: {},
  input: z.object({ subAccountId: z.string().guid() }).strict(),
  output: z.object({ balances: z.array(balance) }),
  samples: [
    { verdict: 'accept', input: { subAccountId: '11111111-1111-4111-8111-111111111111' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const IDENTITY_SUB_ACCOUNTS_SET_FEATURES = defineProcedure({
  ...base,
  name: 'identity.subAccounts.setFeatures',
  kind: 'mutation',
  path: 'subAccounts.setFeatures',
  access: { caller: 'signedIn' },
  refusals: {},
  input: z.object({ subAccountId: z.string().guid(), feature, enabled: z.boolean() }).strict(),
  output: z.object({ feature, enabled: z.boolean(), changed: z.boolean() }),
  samples: [
    { verdict: 'accept', input: { subAccountId: '11111111-1111-4111-8111-111111111111', feature: 'spot', enabled: true } },
    { verdict: 'refuse', input: 42 },
  ],
});
