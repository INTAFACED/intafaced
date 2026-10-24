import { z } from 'zod';
import type { ServiceName } from './service-keys.js';

/**
 * Internal withdrawal settlement (W-withdraw-14, J-wallet-07 #3-#5): a withdrawal whose address belongs to another account
 * on the platform settles inside the book, with no rail and no network fee. svc-pay owns the withdrawal and decides that the
 * address is a platform address (its own deposit address table). svc-bank owns `bankTransfer` (granted to svc-bank only), so
 * svc-pay asks svc-bank to move the value from the sender's main account to the receiver's, as one person-to-person send. It
 * is the first PR of the two-PR order: svc-bank serves it, svc-pay asks it.
 *
 * ONE SEND PER WITHDRAWAL. `transferId` is the business key svc-pay derives from its withdrawal (`withdraw:<withdrawal id>`,
 * and the withdrawal row is unique per person and client reference), so a retry after a lost answer is the same send and posts
 * once. svc-bank keeps its own reservation row for it, so the receiver's transfer history names the sender.
 *
 * THREE ANSWERS, AND ONLY ONE IS A REFUSAL. `posted` carries the ledger transaction. `refused` means svc-bank proved nothing
 * was posted under the key (a named refusal before or by the ledger), so svc-pay may close the withdrawal as failed. Anything
 * else, a timeout, a 5xx, a reply that does not parse, is `unknown`: the send may still land, and svc-pay keeps the withdrawal
 * open and asks again with the same key.
 */

/** The tRPC path on svc-bank's root router. */
export const BANK_INTERNAL_WITHDRAWAL_PROCEDURE = 'transfers.settleWithdrawal' as const;

/** The only service allowed to call it. Passed to `serviceProcedureFor`; the list is enforced under either S2S mode. */
export const BANK_INTERNAL_WITHDRAWAL_CALLERS: readonly ServiceName[] = ['svc-pay'];

/** The key svc-pay derives from its withdrawal row. One withdrawal, one send. */
export const internalWithdrawalTransferId = (withdrawalId: string): string => `withdraw:${withdrawalId}`;

const decimal = z
  .string()
  .regex(/^\d+(\.\d{1,18})?$/, 'amounts are positive decimal strings with at most 18 decimal places')
  .refine((v) => /[1-9]/.test(v), 'must be greater than zero');

export const bankInternalWithdrawalInputSchema = z
  .object({
    /** `withdraw:<withdrawal uuid>`. */
    transferId: z.string().regex(/^withdraw:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/),
    /** The person whose withdrawal it is: the money leaves their main account. */
    fromUserId: z.string().min(1).max(128),
    /** The owner of the platform address it was sent to. */
    toUserId: z.string().min(1).max(128),
    assetId: z.string().regex(/^[A-Za-z0-9]{1,16}$/),
    amount: decimal,
  })
  .strict()
  .refine((input) => input.fromUserId !== input.toUserId, { message: 'an internal withdrawal names two people', path: ['toUserId'] });
export type BankInternalWithdrawalInput = z.infer<typeof bankInternalWithdrawalInputSchema>;

export const bankInternalWithdrawalSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('posted'), transferId: z.string().min(1), ledgerTxId: z.string().min(1) }).strict(),
  /** svc-bank's typed refusal code, for example `bank.recipient_cannot_receive` or `ledger.insufficient_funds`. */
  z.object({ state: z.literal('refused'), code: z.string().min(1).max(128) }).strict(),
]);
export type BankInternalWithdrawal = z.infer<typeof bankInternalWithdrawalSchema>;

/** What a caller sees when no answer came back. Never a refusal: the send may have posted. */
export type BankInternalWithdrawalResult =
  BankInternalWithdrawal | { readonly state: 'unknown'; readonly code: 'bank.internal_withdrawal_unknown' };

/** The port svc-pay depends on. The HTTP client implements it; tests inject a fake. */
export interface BankInternalWithdrawalPort {
  settle(input: BankInternalWithdrawalInput): Promise<BankInternalWithdrawalResult>;
}
