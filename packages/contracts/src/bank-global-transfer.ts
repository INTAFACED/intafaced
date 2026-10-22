import { z } from 'zod';
import { payAmountStringSchema } from './merchant-control.js';

/**
 * BK-xfer-03: international transfer contracts, owned by svc-bank.
 * Who pays the SWIFT charges (SHA shares them, OUR means the sender pays all of them), the rate-lock
 * policy, and the refusal codes. A firm bank-side FX rate is HELD until LG-fx-bank-grant-01. Until
 * then that path returns the typed refusal `bank.fx_firm_rate_held` and never quotes a rate.
 */
const timestamp = z.string().datetime({ offset: true });

export const bankChargeBearerSchema = z.enum(['SHA', 'OUR']);
export type BankChargeBearer = z.infer<typeof bankChargeBearerSchema>;

/** Owner-set OUR flat fee for one corridor currency. If no row exists, OUR refuses with `bank.our_fee_unset`. */
export const bankOurFeeRowSchema = z
  .object({ currency: z.string().regex(/^[A-Z]{3}$/), fee: payAmountStringSchema, feeAsset: z.string().min(1).max(16) })
  .strict();
export type BankOurFeeRow = z.infer<typeof bankOurFeeRowSchema>;

/** Owner rate-lock policy. Every field is required, and a blank policy refuses with `bank.rate_lock_unset`. */
export const bankRateLockPolicySchema = z
  .object({
    windowSeconds: z.number().int().positive().max(86_400),
    misuseExpiredLocksBeforeRemoval: z.number().int().positive().max(1000),
    floatingRateAllowed: z.boolean(),
  })
  .strict();
export type BankRateLockPolicy = z.infer<typeof bankRateLockPolicySchema>;

export const BANK_GLOBAL_TRANSFER_CODES = [
  'bank.our_fee_unset',
  'bank.rate_lock_unset',
  'bank.rate_lock_removed',
  'bank.recipient_incomplete',
  'bank.global_quote_expired',
  'bank.fx_firm_rate_held',
] as const;
export const bankGlobalTransferCodeSchema = z.enum(BANK_GLOBAL_TRANSFER_CODES);
export type BankGlobalTransferCode = z.infer<typeof bankGlobalTransferCodeSchema>;

/** Typed refusals. `recipient_incomplete` lists the missing corridor fields. FX held names its blocker. */
export const bankGlobalTransferRefusalSchema = z.discriminatedUnion('code', [
  z.object({ code: z.literal('bank.our_fee_unset'), currency: z.string() }).strict(),
  z.object({ code: z.literal('bank.rate_lock_unset') }).strict(),
  z.object({ code: z.literal('bank.rate_lock_removed') }).strict(),
  z.object({ code: z.literal('bank.recipient_incomplete'), missingFields: z.array(z.string().min(1).max(64)).min(1) }).strict(),
  z.object({ code: z.literal('bank.global_quote_expired'), validUntil: timestamp }).strict(),
  z.object({ code: z.literal('bank.fx_firm_rate_held'), blocker: z.literal('LG-fx-bank-grant-01') }).strict(),
]);
export type BankGlobalTransferRefusal = z.infer<typeof bankGlobalTransferRefusalSchema>;

/** Server-built send key, `global:<userId>:<draftSeq>`. */
export function bankGlobalSendKey(userId: string, draftSeq: number): string {
  if (!userId || /[:\s]/.test(userId)) throw new Error('bankGlobalSendKey: bad userId');
  if (!Number.isSafeInteger(draftSeq) || draftSeq < 1) throw new Error('bankGlobalSendKey: bad draftSeq');
  return `global:${userId}:${draftSeq}`;
}
