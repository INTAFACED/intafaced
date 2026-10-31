import { z } from 'zod';
import type { ServiceName } from './service-keys.js';

/**
 * Support record ownership (J-support-public-20 #1, RC-support-public-01): svc-support asks svc-pay whether a withdrawal or
 * a deposit belongs to a ticket's customer, so the desk can link the record to the ticket, or count it as a check the
 * customer can confirm, without reading svc-pay's tables.
 *
 * Browser-safe: zod only at run time.
 *
 * THE ANSWER IS ONE BOOLEAN. A missing id, another customer's id and an id of the other kind all answer `owned: false`,
 * the same way: no amount, no status, no owner and no error code tells them apart, so the door cannot be used to learn
 * whether an id exists or whose it is. Only svc-support may call it, as a service, never under a customer's scope.
 */

/** The tRPC path on svc-pay's root router. */
export const SUPPORT_RECORD_OWNERSHIP_PROCEDURES = {
  owns: 'supportRecordOwnership.owns',
} as const;

/** The only service allowed to call it. Passed to `serviceProcedureFor`; enforced under either S2S mode. */
export const SUPPORT_RECORD_OWNERSHIP_CALLERS: readonly ServiceName[] = ['svc-support'];

/** The svc-pay records support can ask about. */
export const SUPPORT_OWNED_RECORD_KINDS = ['withdrawal', 'deposit'] as const;
export type SupportOwnedRecordKind = (typeof SUPPORT_OWNED_RECORD_KINDS)[number];

export const supportRecordOwnershipInputSchema = z
  .object({
    kind: z.enum(SUPPORT_OWNED_RECORD_KINDS),
    /** svc-pay's own record id. */
    recordId: z.string().guid(),
    /** The ticket's customer, taken off the ticket by svc-support, never from an operator's input. */
    userId: z.string().min(1).max(128),
  })
  .strict();
export type SupportRecordOwnershipInput = z.infer<typeof supportRecordOwnershipInputSchema>;

export const supportRecordOwnershipResultSchema = z.object({ owned: z.boolean() }).strict();
export type SupportRecordOwnershipResult = z.infer<typeof supportRecordOwnershipResultSchema>;
