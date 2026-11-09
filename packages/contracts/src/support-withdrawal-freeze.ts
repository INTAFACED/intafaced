import { z } from 'zod';
import type { ServiceName } from './service-keys.js';
import { securityLockSchema } from './identity.js';

/**
 * Support withdrawal freeze (J-support-public-20 #7, RC-support-public-06 and -07): a support agent asks, from a customer's
 * request, for that customer's withdrawals to be frozen. svc-identity records it: it sets the account's security lock
 * (`account_security_locks`, `set_by = 'support'`), which stops withdrawals and changes to withdrawal addresses, and
 * writes one audit row naming the request, the agent and the reason, in the same transaction.
 *
 * Browser-safe: zod only at run time.
 *
 * Freezing only takes power away. It holds no balance, posts no ledger entry and leaves existing holds as they are.
 * Support has no door that lifts the lock, and nothing a request's status does reaches it: only the customer's own
 * unlock, after the owner's wait, ends it. Asking again from the same request while the lock holds answers the first
 * record.
 */

/** svc-identity's signed internal door (a POST, the body bound to the signature). */
export const SUPPORT_WITHDRAWAL_FREEZE_PATH = '/internal/support/withdrawal-freeze';

/** The only service allowed to call it: svc-identity refuses any other verified caller. */
export const SUPPORT_WITHDRAWAL_FREEZE_CALLERS: readonly ServiceName[] = ['svc-support'];

export const supportWithdrawalFreezeInputSchema = z
  .object({
    /** The request's customer, taken off the request by svc-support, never from the agent's input. */
    userId: z.string().guid(),
    ticketId: z.string().guid(),
    /** The support agent, from the signed principal. */
    operatorId: z.string().guid(),
    reason: z.string().trim().min(1).max(500),
  })
  .strict();
export type SupportWithdrawalFreezeInput = z.infer<typeof supportWithdrawalFreezeInputSchema>;

export const supportWithdrawalFreezeResultSchema = z
  .object({
    recordedBy: z.literal('svc-identity'),
    /** The account's security lock as it stands after the ask. */
    lock: securityLockSchema,
    /** False when the lock already held and this request had already asked: nothing new was written. */
    changed: z.boolean(),
    /** The audit row that records this request's freeze. */
    auditId: z.string().guid(),
    recordedAt: z.string().datetime({ offset: true }),
  })
  .strict();
export type SupportWithdrawalFreezeResult = z.infer<typeof supportWithdrawalFreezeResultSchema>;
