import { z } from 'zod';
import { assetIdSchema } from './asset-id.js';
import { defineProcedure } from './procedure.js';
import { amountString } from './bank-earn-procedures.js';

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
