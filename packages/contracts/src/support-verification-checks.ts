import { z } from 'zod';

/**
 * Balance disclosure gate (RC-support-public-01, J-support-public-20 #2): the desk may not read a customer's balance or
 * withdrawal destination from a request until two checks the customer can confirm are recorded on that request.
 *
 * Browser-safe: zod only, so the admin console can import it through `@intafaced/contracts/support-verification-checks`.
 *
 * A CHECK IS PROVED BY THE SERVICE THAT OWNS THE FACT, NEVER BY AN OPERATOR'S SAY-SO. The one kind today is `owned_record`:
 * an order, withdrawal or deposit id the customer quotes, which counts only once its owning service says it is the ticket
 * customer's (svc-pay for a withdrawal or a deposit, `support-record-ownership.ts`; svc-trade for an order). Until that
 * service answers, recording the check refuses naming it, and no check is written. Two checks are two different records.
 *
 * NO BALANCE IS READ HERE. With the checks recorded, `customerBalance` and `customerWithdrawalDestination` still refuse
 * (`support.balance_read_unwired`, `support.withdrawal_destination_read_unwired`): the desk has no read of either. The
 * refusal before the checks says how many are recorded and how many are needed, and nothing else.
 */

/** How many checks a request needs before a balance or destination may be read. A rule of the gate, not an owner value. */
export const SUPPORT_VERIFICATION_CHECKS_REQUIRED = 2;

/** The kinds of check the desk can record. */
export const SUPPORT_VERIFICATION_CHECK_KINDS = ['owned_record'] as const;
export type SupportVerificationCheckKind = (typeof SUPPORT_VERIFICATION_CHECK_KINDS)[number];

/** The records an `owned_record` check can quote, and the service that answers for each. */
export const SUPPORT_CHECK_RECORD_KINDS = ['order', 'withdrawal', 'deposit'] as const;
export type SupportCheckRecordKind = (typeof SUPPORT_CHECK_RECORD_KINDS)[number];
export const SUPPORT_CHECK_RECORD_OWNER: Readonly<Record<SupportCheckRecordKind, 'svc-trade' | 'svc-pay'>> = {
  order: 'svc-trade',
  withdrawal: 'svc-pay',
  deposit: 'svc-pay',
};

/**
 * Typed refusals.
 * `support.verification_checks_required`: fewer than two checks are recorded on the request; nothing is read.
 * `support.verification_check_not_owned`: the owning service answered, and the record is not the ticket customer's (or does
 * not exist). No check is written.
 * `support.verification_check_owner_unwired`: the owning service gives the desk no ownership answer yet. No check is written.
 * `support.verification_check_owner_unreachable`: the owning service gave no verified answer. No check is written.
 * `support.balance_read_unwired` / `support.withdrawal_destination_read_unwired`: the checks are recorded, and the desk has
 * no read of a balance or a withdrawal destination. Nothing is read.
 */
export const SUPPORT_VERIFICATION_ERROR_CODES = [
  'support.verification_checks_required',
  'support.verification_check_not_owned',
  'support.verification_check_owner_unwired',
  'support.verification_check_owner_unreachable',
  'support.balance_read_unwired',
  'support.withdrawal_destination_read_unwired',
] as const;
export type SupportVerificationErrorCode = (typeof SUPPORT_VERIFICATION_ERROR_CODES)[number];

export const supportRecordVerificationCheckInputSchema = z
  .object({
    ticketId: z.string().guid(),
    kind: z.literal('owned_record'),
    recordKind: z.enum(SUPPORT_CHECK_RECORD_KINDS),
    /** The owning service's record id, as the customer quoted it. */
    recordId: z.string().guid(),
  })
  .strict();
export type SupportRecordVerificationCheckInput = z.infer<typeof supportRecordVerificationCheckInputSchema>;

export const supportVerificationCheckSchema = z
  .object({
    ticketId: z.string().guid(),
    kind: z.enum(SUPPORT_VERIFICATION_CHECK_KINDS),
    recordKind: z.enum(SUPPORT_CHECK_RECORD_KINDS),
    recordId: z.string().guid(),
    /** The operator who recorded it. */
    recordedBy: z.string().min(1).max(128),
    recordedAt: z.string().datetime(),
  })
  .strict();
export type SupportVerificationCheck = z.infer<typeof supportVerificationCheckSchema>;

/** Every disclosure door takes a ticket and nothing else: the customer comes off the ticket. */
export const supportTicketOnlyInputSchema = z.object({ ticketId: z.string().guid() }).strict();

/** The checks on one request, oldest first, and how many the gate needs. */
export const supportVerificationChecksSchema = z
  .object({
    required: z.literal(SUPPORT_VERIFICATION_CHECKS_REQUIRED),
    checks: z.array(supportVerificationCheckSchema),
  })
  .strict();
export type SupportVerificationChecks = z.infer<typeof supportVerificationChecksSchema>;
