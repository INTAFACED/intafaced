import { z } from 'zod';
import type { ServiceName } from './service-keys.js';

/**
 * Where a person's crypto withdrawals went, the svc-bank to svc-pay seam (J-portfolio-03 #2). svc-pay owns its withdrawals and
 * their destinations; the ledger names each withdrawal line's own `withdrawalId`; svc-bank asks svc-pay for the addresses of
 * the person's own withdrawals by those ids, over one signed internal POST, and reads no table of svc-pay's.
 *
 * NOTHING IS INVENTED. Only a crypto destination of that person's own withdrawal is answered; an id that is not theirs, not
 * a withdrawal or not to a crypto address is simply absent. A caller that cannot get an answer gets `null`, which the bank
 * turns into a refusal when the person filters by address (a filter that silently missed a line would hide money).
 */

export const PAY_WITHDRAWAL_ADDRESSES_PATH = '/internal/withdrawals/addresses' as const;

/** The only service allowed to call it. */
export const PAY_WITHDRAWAL_ADDRESSES_CALLERS: readonly ServiceName[] = ['svc-bank'];

/** The most withdrawal ids one ask may carry (one activity page reads at most this many lines). */
export const PAY_WITHDRAWAL_ADDRESSES_MAX = 500;

export const payWithdrawalAddressesInputSchema = z
  .object({
    userId: z.string().min(1).max(128),
    withdrawalIds: z.array(z.string().uuid()).min(1).max(PAY_WITHDRAWAL_ADDRESSES_MAX),
  })
  .strict();
export type PayWithdrawalAddressesInput = z.infer<typeof payWithdrawalAddressesInputSchema>;

export const payWithdrawalAddressesReplySchema = z
  .object({
    addresses: z
      .array(z.object({ withdrawalId: z.string().uuid(), address: z.string().min(1).max(256) }).strict())
      .max(PAY_WITHDRAWAL_ADDRESSES_MAX),
  })
  .strict();
export type PayWithdrawalAddressesReply = z.infer<typeof payWithdrawalAddressesReplySchema>;

/** svc-bank's port: withdrawal id to address, or `null` when svc-pay could not be asked. */
export interface PayWithdrawalAddressesPort {
  addressesFor(userId: string, withdrawalIds: readonly string[]): Promise<ReadonlyMap<string, string> | null>;
}
