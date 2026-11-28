import { z } from 'zod';
import { defineProcedure } from './procedure.js';
import { amountString } from './bank-earn-procedures.js';
import { assetIdSchema } from './asset-id.js';
import { stepUpApprovalField } from './bank-cards-procedures.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-bank `business.*`, one record per call, written from its router while its Rust port is in flight: every app caller calls it by its record, and the router keeps its own schemas until the port's switch. */

const base = { service: 'svc-bank', module: 'bank', transport: 'trpc' } as const;

/**
 * bank.business product policy — maker/checker dual control honesty.
 *
 * Threshold is per-account owner law; this door never invents a default amount.
 */
export const BUSINESS_ROLES = ['admin', 'maker', 'checker', 'signer', 'editor', 'viewer', 'security_auditor', 'non_signing_admin'] as const;

export const businessAccountOutput = z.object({
  id: z.string(),
  name: z.string(),
  assetId: assetIdSchema,
  spendThreshold: amountString,
  status: z.enum(['active', 'closed']),
  createdAt: z.string(),
});

export const BANK_BUSINESS_PENDING = defineProcedure({
  ...base,
  name: 'bank.business.pending',
  kind: 'query',
  path: 'business.pending',
  access: { caller: 'scope', scope: 'bank:read', module: 'bank' },
  refusals: {},
  input: z.object({
    accountId: z.string().guid(),
    /**
     * Page size. Optional so omit reaches `bank.business_pending_list_limit_unset`
     * instead of a Zod "Required". Blank is not 50; pass 50 explicitly.
     */
    limit: z.number().int().min(1).max(200).optional(),
  }),
  output: z.array(
    z.object({
      id: z.string(),
      accountId: z.string(),
      makerHandle: z.string().nullable(),
      makerHandleReason: z.enum(['handle_unresolved']).nullable(),
      receiverOwnerHandle: z.string().nullable(),
      receiverOwnerHandleReason: z.enum(['handle_unresolved']).nullable(),
      receiverOwnerName: z.string().nullable(),
      fromSpaceId: z.string(),
      toSpaceId: z.string(),
      assetId: assetIdSchema,
      amount: amountString,
      status: z.enum(['pending', 'approved', 'rejected', 'cancelled']),
      transferId: z.string().nullable(),
      holdLedgerTxId: z.string().nullable(),
      ledgerTxId: z.string().nullable(),
      createdAt: z.string(),
    }),
  ),
  samples: [
    { verdict: 'accept', input: { accountId: '11111111-1111-4111-8111-111111111111' } },
    { verdict: 'refuse', input: 42 },
  ],
});

/**
 * Atomic multi-recipient payroll. One ledger post. Cross-asset lines
 * refuse `bank.business_payroll_rate_unset` — rates are owner law, never invented.
 */
export const BANK_BUSINESS_MY_ROLE = defineProcedure({
  ...base,
  name: 'bank.business.myRole',
  kind: 'query',
  path: 'business.myRole',
  access: { caller: 'scope', scope: 'bank:read', module: 'bank' },
  refusals: {},
  input: z.object({ accountId: z.string().guid() }),
  output: z.object({ role: z.enum(BUSINESS_ROLES) }),
  samples: [
    { verdict: 'accept', input: { accountId: '11111111-1111-4111-8111-111111111111' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const BANK_BUSINESS_LIST = defineProcedure({
  ...base,
  name: 'bank.business.list',
  kind: 'query',
  path: 'business.list',
  access: { caller: 'scope', scope: 'bank:read', module: 'bank' },
  refusals: {},
  input: z
    .object({
      /**
       * Page size. Optional so omit reaches `bank.business_list_limit_unset`
       * instead of a Zod "Required". Blank is not 50; pass 50 explicitly.
       */
      limit: z.number().int().min(1).max(200).optional(),
    })
    .optional(),
  output: z.array(businessAccountOutput),
  samples: [
    { verdict: 'accept', input: {} },
    { verdict: 'refuse', input: 42 },
  ],
});

export const BANK_BUSINESS_RESOLVE_RECIPIENT_SPACE = defineProcedure({
  ...base,
  name: 'bank.business.resolveRecipientSpace',
  kind: 'query',
  path: 'business.resolveRecipientSpace',
  access: { caller: 'scope', scope: 'bank:read', module: 'bank' },
  refusals: {},
  input: z.object({
    accountId: z.string().guid(),
    assetId: assetIdSchema.min(1).max(16),
    handle: z.string().max(64).optional(),
    email: z.string().max(320).optional(),
  }),
  output: z.discriminatedUnion('found', [
    z.object({ found: z.literal(false) }),
    z.object({
      found: z.literal(true),
      handle: z.string(),
      assetId: assetIdSchema,
      spaceId: z.string().guid().nullable(),
    }),
  ]),
  samples: [
    { verdict: 'accept', input: { accountId: '11111111-1111-4111-8111-111111111111', assetId: 'USDC' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const BANK_BUSINESS_MEMBERS = defineProcedure({
  ...base,
  name: 'bank.business.members',
  kind: 'query',
  path: 'business.members',
  access: { caller: 'scope', scope: 'bank:read', module: 'bank' },
  refusals: {},
  input: z.object({ accountId: z.string().guid() }),
  output: z.object({
    members: z.array(
      z.object({
        accountId: z.string(),
        userId: z.string(),
        role: z.enum(BUSINESS_ROLES),
        handle: z.string(),
      }),
    ),
    pendingControls: z.array(
      z.object({
        requestId: z.string(),
        kind: z.enum(['set_threshold', 'close']),
        spendThreshold: amountString.nullable(),
        proposedByHandle: z.string(),
        createdAt: z.string(),
      }),
    ),
  }),
  samples: [
    { verdict: 'accept', input: { accountId: '11111111-1111-4111-8111-111111111111' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const BANK_BUSINESS_SET_MEMBER_ROLE = defineProcedure({
  ...base,
  name: 'bank.business.setMemberRole',
  kind: 'mutation',
  path: 'business.setMemberRole',
  access: { caller: 'scope', scope: 'bank:write', module: 'bank' },
  refusals: {},
  input: z.object({
    accountId: z.string().guid(),
    userId: z.string().min(1),
    role: z.enum(BUSINESS_ROLES),
    requestId: z.string().guid(),
    stepUpApprovalId: stepUpApprovalField,
  }),
  output: z.object({ accountId: z.string(), userId: z.string(), role: z.enum(BUSINESS_ROLES) }),
  samples: [
    {
      verdict: 'accept',
      input: {
        accountId: '11111111-1111-4111-8111-111111111111',
        userId: 'USDC',
        role: 'admin',
        requestId: '11111111-1111-4111-8111-111111111111',
      },
    },
    { verdict: 'refuse', input: 42 },
  ],
});

export const BANK_BUSINESS_REMOVE_MEMBER = defineProcedure({
  ...base,
  name: 'bank.business.removeMember',
  kind: 'mutation',
  path: 'business.removeMember',
  access: { caller: 'scope', scope: 'bank:write', module: 'bank' },
  refusals: {},
  input: z.object({
    accountId: z.string().guid(),
    userId: z.string().min(1),
    requestId: z.string().guid(),
    stepUpApprovalId: stepUpApprovalField,
  }),
  output: z.object({ accountId: z.string(), userId: z.string(), removed: z.literal(true) }),
  samples: [
    {
      verdict: 'accept',
      input: { accountId: '11111111-1111-4111-8111-111111111111', userId: 'USDC', requestId: '11111111-1111-4111-8111-111111111111' },
    },
    { verdict: 'refuse', input: 42 },
  ],
});

export const BANK_BUSINESS_ADD_MEMBER = defineProcedure({
  ...base,
  name: 'bank.business.addMember',
  kind: 'mutation',
  path: 'business.addMember',
  access: { caller: 'scope', scope: 'bank:write', module: 'bank' },
  refusals: {},
  input: z.object({
    accountId: z.string().guid(),
    userId: z.string().min(1),
    role: z.enum(BUSINESS_ROLES),
    stepUpApprovalId: stepUpApprovalField,
  }),
  output: z.object({ accountId: z.string(), userId: z.string(), role: z.enum(BUSINESS_ROLES) }),
  samples: [
    { verdict: 'accept', input: { accountId: '11111111-1111-4111-8111-111111111111', userId: 'USDC', role: 'admin' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const BANK_BUSINESS_APPROVE = defineProcedure({
  ...base,
  name: 'bank.business.approve',
  kind: 'mutation',
  path: 'business.approve',
  access: { caller: 'scope', scope: 'bank:write', module: 'bank' },
  refusals: {},
  input: z.object({ approvalId: z.string().guid(), stepUpApprovalId: stepUpApprovalField }),
  output: z.object({ transferId: z.string(), ledgerTxId: z.string() }),
  samples: [
    { verdict: 'accept', input: { approvalId: '11111111-1111-4111-8111-111111111111' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const BANK_BUSINESS_REJECT = defineProcedure({
  ...base,
  name: 'bank.business.reject',
  kind: 'mutation',
  path: 'business.reject',
  access: { caller: 'scope', scope: 'bank:write', module: 'bank' },
  refusals: {},
  input: z.object({ approvalId: z.string().guid() }),
  output: z.object({ ok: z.literal(true) }),
  samples: [
    { verdict: 'accept', input: { approvalId: '11111111-1111-4111-8111-111111111111' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const BANK_BUSINESS_CANCEL = defineProcedure({
  ...base,
  name: 'bank.business.cancel',
  kind: 'mutation',
  path: 'business.cancel',
  access: { caller: 'scope', scope: 'bank:write', module: 'bank' },
  refusals: {},
  input: z.object({ approvalId: z.string().guid() }),
  output: z.object({ ok: z.literal(true) }),
  samples: [
    { verdict: 'accept', input: { approvalId: '11111111-1111-4111-8111-111111111111' } },
    { verdict: 'refuse', input: 42 },
  ],
});
