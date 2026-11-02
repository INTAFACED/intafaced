import { z } from 'zod';

/**
 * Balance disclosure gate (RC-support-public-01, ACC-0189, SUP-0004; J-support-public-20 #2): the desk may not read a
 * customer's balance, fills or withdrawal destination from a request until the request holds two matched checks the
 * customer can confirm: an email equal to their registered email, and one id of a record of their own.
 *
 * Browser-safe: zod only, so the admin console can import it through `@intafaced/contracts/support-verification-checks`.
 *
 * A CHECK IS PROVED BY THE SERVICE THAT OWNS THE FACT, NEVER BY AN OPERATOR'S SAY-SO. The email is compared with the
 * registered one by svc-identity; a client order id by svc-trade; a withdrawal or deposit id by svc-pay. Until that
 * service answers, recording the check refuses `support.disclosure_unwired` naming it, and nothing is stored. The typed
 * value is never stored and never returned: svc-support keeps a sha256 digest and whether it matched.
 *
 * NO BALANCE IS READ HERE. With the gate held, each read still refuses `support.disclosure_unwired` naming its owner
 * until that owner serves a read door; the refusal before the gate says how many of the two are matched, and nothing else.
 */

/** How many matched checks, of different kinds, open the gate: the email and one record id (SUP-0004). A rule, not an owner value. */
export const SUPPORT_VERIFICATION_CHECKS_REQUIRED = 2;

/** The kinds of check the desk can record. No other kind: a security question or code word would need a stored secret. */
export const SUPPORT_VERIFICATION_CHECK_KINDS = ['email', 'client_order_id', 'withdrawal_id', 'deposit_id'] as const;
export type SupportVerificationCheckKind = (typeof SUPPORT_VERIFICATION_CHECK_KINDS)[number];

/** The record-id kinds: one of them, matched, is the second check. */
export const SUPPORT_VERIFICATION_RECORD_KINDS = ['client_order_id', 'withdrawal_id', 'deposit_id'] as const;

/** The service that answers each check. */
export const SUPPORT_VERIFICATION_CHECK_OWNER: Readonly<Record<SupportVerificationCheckKind, 'svc-identity' | 'svc-trade' | 'svc-pay'>> = {
  email: 'svc-identity',
  client_order_id: 'svc-trade',
  withdrawal_id: 'svc-pay',
  deposit_id: 'svc-pay',
};

/** What the gate guards, and the service whose read door would answer it. */
export const SUPPORT_DISCLOSURE_KINDS = ['balance', 'fills', 'destination'] as const;
export type SupportDisclosureKind = (typeof SUPPORT_DISCLOSURE_KINDS)[number];
export const SUPPORT_DISCLOSURE_OWNER: Readonly<Record<SupportDisclosureKind, 'svc-ledger' | 'svc-trade' | 'svc-pay'>> = {
  balance: 'svc-ledger',
  fills: 'svc-trade',
  destination: 'svc-pay',
};

/**
 * Typed refusals.
 * `support.verification_checks_required`: the request does not hold the two matched checks; nothing is read. The spec
 * names it `support.disclosure_checks_missing`; the journey test on main (J-support-public-20 #2) names this, and wins.
 * `support.verification_mismatch`: the owner answered, and the value is not the customer's. Stored as unmatched; the
 * refusal never says which part failed.
 * `support.disclosure_unwired`: the service that answers a check or a read serves no door for it yet, or gave no
 * verified answer. Nothing is stored and nothing is read.
 * `support.verification_attempts_unset`: the owner has not set how many checks one request may take. Never defaulted.
 * `support.verification_attempts_exhausted`: the request has taken as many check attempts as the owner allows.
 */
export const SUPPORT_VERIFICATION_ERROR_CODES = [
  'support.verification_checks_required',
  'support.verification_mismatch',
  'support.disclosure_unwired',
  'support.verification_attempts_unset',
  'support.verification_attempts_exhausted',
] as const;
export type SupportVerificationErrorCode = (typeof SUPPORT_VERIFICATION_ERROR_CODES)[number];

const ticketId = z.string().guid();

/** One check as the operator types it from what the customer says. The customer comes off the ticket, never this input. */
export const supportRecordVerificationCheckInputSchema = z.discriminatedUnion('kind', [
  z.object({ ticketId, kind: z.literal('email'), value: z.string().trim().max(254).email() }).strict(),
  z
    .object({
      ticketId,
      kind: z.literal('client_order_id'),
      value: z
        .string()
        .trim()
        .regex(/^[A-Za-z0-9._:-]{1,64}$/, 'a client order id is 1 to 64 letters, digits, dots, colons, dashes or underscores'),
    })
    .strict(),
  z.object({ ticketId, kind: z.literal('withdrawal_id'), value: z.string().trim().guid() }).strict(),
  z.object({ ticketId, kind: z.literal('deposit_id'), value: z.string().trim().guid() }).strict(),
]);
export type SupportRecordVerificationCheckInput = z.infer<typeof supportRecordVerificationCheckInputSchema>;

/** A stored check: its kind and whether it matched, never the value or its digest. */
export const supportVerificationCheckSchema = z
  .object({
    ticketId,
    kind: z.enum(SUPPORT_VERIFICATION_CHECK_KINDS),
    matched: z.boolean(),
    /** The operator who recorded it. */
    checkedBy: z.string().min(1).max(128),
    checkedAt: z.string().datetime(),
  })
  .strict();
export type SupportVerificationCheck = z.infer<typeof supportVerificationCheckSchema>;

/** A door that takes a ticket and nothing else: the customer comes off the ticket. */
export const supportTicketOnlyInputSchema = z.object({ ticketId }).strict();

/** One read behind the gate. */
export const supportDisclosureReadInputSchema = z.object({ ticketId, kind: z.enum(SUPPORT_DISCLOSURE_KINDS) }).strict();
export type SupportDisclosureReadInput = z.infer<typeof supportDisclosureReadInputSchema>;

/** The checks on one request, oldest first; how many of the two the gate needs are matched; and the attempts allowed. */
export const supportVerificationChecksSchema = z
  .object({
    required: z.literal(SUPPORT_VERIFICATION_CHECKS_REQUIRED),
    /** 0, 1 or 2: a matched email, and a matched record id of any kind. */
    matched: z.number().int().min(0).max(SUPPORT_VERIFICATION_CHECKS_REQUIRED),
    /** The owner's cap on check attempts per request; null while it is unset, and every check refuses. */
    attemptsAllowed: z.number().int().positive().nullable(),
    attemptsUsed: z.number().int().min(0),
    checks: z.array(supportVerificationCheckSchema),
  })
  .strict();
export type SupportVerificationChecks = z.infer<typeof supportVerificationChecksSchema>;

/** How many of the two the gate needs are matched among these checks: the email, and any one record id. */
export function matchedVerificationCount(checks: readonly Pick<SupportVerificationCheck, 'kind' | 'matched'>[]): number {
  const email = checks.some((c) => c.matched && c.kind === 'email');
  const record = checks.some((c) => c.matched && (SUPPORT_VERIFICATION_RECORD_KINDS as readonly string[]).includes(c.kind));
  return (email ? 1 : 0) + (record ? 1 : 0);
}
