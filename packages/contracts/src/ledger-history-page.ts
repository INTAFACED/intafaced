import { z } from 'zod';
import { accountRefSchema, describeOwnerIdSpace, isValidOwnerId } from '@intafaced/ledger-client';
import { assetIdSchema } from './asset-id.js';
import { defineProcedure } from './procedure.js';

/**
 * svc-ledger's paged history door (`historyPage`, U5a), one record for both ends: svc-ledger mounts
 * its plain HTTP route from it (`s2s-http.ts`), and svc-tax's ledger reader calls it through it (`ledger-reads.ts`).
 * Main had two declarations: the served route (no output schema) and an unserved tRPC procedure whose output lacked
 * `withdrawalId`, which the served route sends.
 */

export const HISTORY_PAGE_DEFAULT_LIMIT = 50;
export const HISTORY_PAGE_MAX_LIMIT = 200;
export const HISTORY_RAILS = ['crypto-native', 'card-sandbox', 'bank-crypto-ledger', 'local-test'] as const;
export const HISTORY_PRODUCTS = ['convert'] as const;

export const historyPageInputSchema = z
  .object({
    ...accountRefSchema.shape,
    /** Optional here (required on a plain AccountRef): omitted = all of the owner's assets. */
    assetId: assetIdSchema.min(1).max(16).optional(),
    limit: z.number().int().min(1).max(HISTORY_PAGE_MAX_LIMIT).default(HISTORY_PAGE_DEFAULT_LIMIT),
    cursor: z.string().min(1).max(256).optional(),
  })
  .strict()
  .superRefine((ref, ctx) => {
    if (isValidOwnerId(ref.ownerType, ref.ownerId)) return;
    ctx.addIssue({
      code: 'custom',
      path: ['ownerId'],
      message: `owner_type "${ref.ownerType}" requires ${describeOwnerIdSpace(ref.ownerType)} — got "${ref.ownerId}"`,
    });
  });

export const historyPageEntrySchema = z.object({
  txId: z.string(),
  module: z.string(),
  reason: z.string(),
  direction: z.enum(['debit', 'credit']),
  /** Decimal string. Money never crosses as a `number`. */
  amount: z.string(),
  postedAt: z.string(),
  assetId: assetIdSchema,
  /** `ledger_entries.id` (bigserial) as a decimal string. */
  entryId: z.string(),
  rail: z.enum(HISTORY_RAILS).nullable(),
  product: z.enum(HISTORY_PRODUCTS).nullable(),
  orderId: z.string().min(1).max(128).nullable(),
  /** Decimal string: the fee taken from the owner's receiving line of a fill (`0` when none), else null. */
  fee: z.string().nullable(),
  withdrawalId: z.string().nullable(),
});

export const LEDGER_HISTORY_PAGE = defineProcedure({
  name: 'ledger.historyPage',
  service: 'svc-ledger',
  transport: 'http',
  method: 'POST',
  path: '/trpc/historyPage',
  /**
   * main derives this list from svc-ledger's recipe grant table (`door-callers.ts` READERS); copied here, held equal by
   * svc-ledger's `door-callers.test.ts`. Escape: the record cannot derive it without moving the grant table here.
   */
  access: {
    caller: 'service',
    callers: [
      'svc-agents',
      'svc-bank',
      'svc-identity',
      'svc-market',
      'svc-mining-pool',
      'svc-p2p',
      'svc-pay',
      'svc-token',
      'svc-trade',
      'svc-matching',
      'svc-tax',
    ],
  },
  /** Plain-HTTP refusals: status and `{ message, code }` from svc-ledger's `httpError`. */
  refusals: {
    'ledger.history_cursor_invalid': 'BAD_REQUEST',
    'ledger.unauthenticated': 'UNAUTHORIZED',
    's2s.caller_forbidden': 'FORBIDDEN',
  },
  accept: {
    'ledger.owner_id_space': {
      at: 'input',
      says: "ownerId is drawn from the space its ownerType declares (a lowercase UUID for a person's account, a slug for a platform one)",
    },
  },
  input: historyPageInputSchema,
  samples: [
    { verdict: 'accept', input: { ownerType: 'user', ownerId: '11111111-1111-4111-8111-111111111111', kind: 'available' } },
    {
      verdict: 'accept',
      input: {
        ownerType: 'user',
        ownerId: '11111111-1111-4111-8111-111111111111',
        kind: 'available',
        assetId: 'USDT',
        limit: 200,
        cursor: 'c',
      },
    },
    { verdict: 'refuse', input: { ownerType: 'user', ownerId: 'fees:trade', kind: 'available' }, by: 'ledger.owner_id_space' },
    { verdict: 'refuse', input: { ownerType: 'user', ownerId: '11111111-1111-4111-8111-111111111111', kind: 'available', limit: 201 } },
    { verdict: 'refuse', input: { ownerType: 'user', ownerId: '11111111-1111-4111-8111-111111111111', kind: 'available', before: 'x' } },
  ],
  output: z.object({ entries: z.array(historyPageEntrySchema), nextCursor: z.string().nullable() }),
});
