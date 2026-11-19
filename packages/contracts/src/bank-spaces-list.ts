import { z } from 'zod';
import { assetIdSchema } from './asset-id.js';
import { defineProcedure } from './procedure.js';

/**
 * `bank` `spaces.list`: the customer's spaces, each with its balance and the ledger account it is a view of. Served by
 * svc-bank (mounted from this record) and read by the customer app's Money and Pay areas through this record, never through
 * a hand copy: a held space's null `ledgerAccount` once broke Pay's copy for every customer who had one.
 */

const amount = z.string().regex(/^\d+(\.\d{1,18})?$/, 'amount must be an unsigned decimal string (max 18dp)');

/** The ledger account a space is a view of, so a client can check it against the space. */
export const spaceLedgerAccountSchema = z.object({ ownerType: z.string(), ownerId: z.string(), assetId: assetIdSchema, kind: z.string() });

export const bankSpaceSchema = z.object({
  id: z.string(),
  assetId: assetIdSchema,
  kind: z.enum(['primary', 'named']),
  name: z.string(),
  goalTarget: z.string().nullable(),
  lockedUntil: z.string().nullable(),
  /** An early unlock still waiting (BK-pots-02): when the pot opens, and when its owner asked. Null when none waits. */
  unlocksAt: z.string().nullable(),
  unlockRequestedAt: z.string().nullable(),
  /** Set when this pot pays the person's bills (BK-pots-03): whether a standing order from it tops it up from the account. */
  billsPot: z.object({ fallback: z.boolean() }).nullable(),
  /** Read from the ledger at request time, or from the partner bank when it holds this money. Not stored, not cached. */
  balance: amount,
  /**
   * The ledger account this space is a view of. Null when the partner bank holds this money: no ledger account
   * holds it, and `heldAt` says whose figure the balance is.
   */
  ledgerAccount: spaceLedgerAccountSchema.nullable(),
  /**
   * Set when the partner bank holds this money: its label (TEST on the TEST partner), the partner's own time for the
   * balance, and the displayed figure (b2 change 6): `known`, or `stale` when older than the partner's declared limit.
   * An unknown figure is never sent: the read refuses `bank.partner_balance_not_known`.
   */
  heldAt: z
    .object({
      label: z.string(),
      asOf: z.string().datetime(),
      figure: z
        .object({
          state: z.enum(['known', 'stale']),
          source: z.string(),
          amount,
          asOf: z.string().datetime(),
          staleAfterMs: z.number().int().positive(),
          reason: z.null(),
        })
        .strict(),
    })
    .nullable(),
});
export type BankSpace = z.output<typeof bankSpaceSchema>;

export const BANK_SPACES_LIST = defineProcedure({
  name: 'bank.spaces.list',
  service: 'svc-bank',
  module: 'bank',
  transport: 'trpc',
  kind: 'query',
  path: 'spaces.list',
  input: z.object({
    assetId: assetIdSchema.min(1).max(16).optional(),
    /** Page size. Optional so omit reaches `bank.spaces_list_limit_unset` instead of a Zod "Required". Blank is not 50. */
    limit: z.number().int().min(1).max(200).optional(),
  }),
  output: z.array(bankSpaceSchema),
});
