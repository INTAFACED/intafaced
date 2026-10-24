import { z } from 'zod';
import type { ServiceName } from './service-keys.js';

/**
 * Approver eligibility: may this person approve for a business team? Asked by svc-pay and answered by svc-bank, which owns
 * the team and its roles (W-security-accounts-04). It is the first PR of the two-PR order for multi-approval withdrawals
 * (W-withdraw-11): svc-bank serves it, svc-pay asks it, and svc-pay never reads the team tables.
 *
 * ONE QUESTION, NO WRITE. The answer says whether the named member's role holds the `approve` capability on the named team
 * account. It does not say who started the request or whether the same person already approved: svc-pay owns the request and
 * checks those itself. The role table is svc-bank's (`BUSINESS_ROLE_CAPABILITIES`); a role name is never copied here.
 *
 * The call carries no state change, but it is a POST to a tRPC mutation, the same shape as `operationAdmission.decide`, because
 * the signed body is what the caller proves.
 *
 * A caller that cannot get an answer (no URL, no secret, a timeout, a malformed reply) gets `unavailable` and must refuse the
 * approval: an unreachable team is never read as "eligible".
 */

/** The tRPC path on svc-bank's root router. */
export const BANK_APPROVER_ELIGIBILITY_PROCEDURE = 'business.approverEligibility' as const;

/** The only service allowed to call it. Passed to `serviceProcedureFor`; the list is enforced under either S2S mode. */
export const BANK_APPROVER_ELIGIBILITY_CALLERS: readonly ServiceName[] = ['svc-pay'];

export const bankApproverEligibilityInputSchema = z
  .object({
    /** The business team account whose roles decide. */
    accountId: z.string().guid(),
    /** The person asking to approve. Bank user ids are opaque text. */
    userId: z.string().min(1).max(128),
  })
  .strict();
export type BankApproverEligibilityInput = z.infer<typeof bankApproverEligibilityInputSchema>;

/**
 * The answer. `eligible` is the only state that lets an approval count. Every other state names why not, so the approver sees
 * a reason and the request is left as it was:
 * - `no_such_account`: the team account does not exist.
 * - `account_closed`: the team account is closed.
 * - `not_a_member`: the person is not on the team.
 * - `role_cannot_approve`: the person's role lacks the `approve` capability (`role` says which role they hold).
 */
export const bankApproverEligibilitySchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('eligible'), role: z.string().min(1).max(64) }).strict(),
  z.object({ state: z.literal('role_cannot_approve'), role: z.string().min(1).max(64) }).strict(),
  z.object({ state: z.literal('not_a_member') }).strict(),
  z.object({ state: z.literal('account_closed') }).strict(),
  z.object({ state: z.literal('no_such_account') }).strict(),
]);
export type BankApproverEligibility = z.infer<typeof bankApproverEligibilitySchema>;

/** What a caller sees when no answer came back. Never an approval. */
export type BankApproverEligibilityResult =
  BankApproverEligibility | { readonly state: 'unavailable'; readonly code: 'bank.approver_eligibility_unavailable' };

/** The port svc-pay depends on. The HTTP client implements it; tests inject a fake. */
export interface BankApproverEligibilityPort {
  check(input: BankApproverEligibilityInput): Promise<BankApproverEligibilityResult>;
}
