import { z } from 'zod';
import { payAmountStringSchema } from './merchant-control.js';

/**
 * BK-xfer-02 (contracts first): bank rails (ACH, wire, real-time, SEPA) behind one RailPort, and proxy-ID aliases.
 *
 * Every rail is `rail.bank`: no partner is contracted. A send writes its intent row and reserve first, then the rail
 * call refuses `rail.bank` and the reconciler releases the reserve. The retry key is server-built,
 * `send:<userId>:<draftSeq>`, so the same draft sent twice is one intent. Owner values, never defaulted: the cutoff
 * table (blank means no same-day promise) and the alias limit per customer (blank refuses `bank.alias_limit_unset`).
 */
const id = z.string().uuid();
const timestamp = z.string().datetime({ offset: true });
const positiveAmountString = payAmountStringSchema.refine((v) => /[1-9]/.test(v), 'amount must be greater than zero');

export const BANK_RAILS = ['ach', 'wire', 'instant', 'sepa'] as const;
export const bankRailSchema = z.enum(BANK_RAILS);
export type BankRail = z.infer<typeof bankRailSchema>;

/** The states every rail declares. `auto_cancelled` is a refused or voided send whose reserve was released. */
export const BANK_RAIL_STATES = ['pending', 'confirmed', 'auto_cancelled', 'failed', 'returned'] as const;
export const bankRailStateSchema = z.enum(BANK_RAIL_STATES);
export type BankRailState = z.infer<typeof bankRailStateSchema>;

/** The blocker every rail names until a bank partner exists. */
export const BANK_RAIL_BLOCKER = 'rail.bank' as const;

/** A rail send. `draftSeq` is the caller's draft counter; the server builds the key from it and the signed-in user. */
export const bankRailSendInputSchema = z
  .object({
    rail: bankRailSchema,
    draftSeq: z.number().int().min(0),
    fromSpaceId: id,
    amount: positiveAmountString,
    destinationId: z.string().min(1).max(200),
    reference: z.string().max(140).optional(),
  })
  .strict();
export type BankRailSendInput = z.infer<typeof bankRailSendInputSchema>;

export const bankRailIntentSchema = z
  .object({
    id,
    rail: bankRailSchema,
    state: bankRailStateSchema,
    fromSpaceId: id,
    assetId: z.string(),
    amount: z.string(),
    destinationId: z.string(),
    failureCode: z.string().nullable(),
    /** True only when the owner cutoff table names this rail and the send is before it. Blank table: always false. */
    sameDayPromise: z.boolean(),
    createdAt: timestamp,
  })
  .strict();
export type BankRailIntent = z.infer<typeof bankRailIntentSchema>;

export const BANK_ALIAS_KINDS = ['phone', 'email', 'handle'] as const;
export const bankAliasKindSchema = z.enum(BANK_ALIAS_KINDS);
export type BankAliasKind = z.infer<typeof bankAliasKindSchema>;

export const bankAliasRegisterInputSchema = z
  .object({ kind: bankAliasKindSchema, value: z.string().min(1).max(254), idempotencyKey: z.string().min(1).max(200) })
  .strict();
export const bankAliasDeactivateInputSchema = z.object({ aliasId: id }).strict();
export const bankAliasSchema = z
  .object({ id, kind: bankAliasKindSchema, value: z.string(), active: z.boolean(), createdAt: timestamp })
  .strict();
export type BankAlias = z.infer<typeof bankAliasSchema>;

export const BANK_RAIL_CODES = [
  'rail.bank',
  'bank.rail_send_conflict',
  'bank.rail_cutoffs_invalid',
  'bank.alias_taken',
  'bank.alias_invalid',
  'bank.alias_limit_unset',
  'bank.alias_limit_reached',
  'bank.alias_not_found',
] as const;
export type BankRailCode = (typeof BANK_RAIL_CODES)[number];
