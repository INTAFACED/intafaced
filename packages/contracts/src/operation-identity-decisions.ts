import { z } from 'zod';
import { currentAuthorityInputSchema, operationAdmissionInputSchema } from './account-controls.js';

const id = z.string().uuid();
const version = z.string().regex(/^(0|[1-9][0-9]*)$/);
const timestamp = z.string().datetime({ offset: true });
const payfacProof = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('root_relation'), actorMerchantId: id, subjectMerchantId: id }).strict(),
  z
    .object({
      kind: z.literal('explicit_grant'),
      actorMerchantId: id,
      subjectMerchantId: id,
      grantEventId: id,
      grantSequence: z.string().regex(/^[1-9][0-9]*$/),
    })
    .strict(),
]);

/** Server-derived authority, never accepted as a public request's permission. */
export const identityOperationAuthoritySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('credential'), subject: currentAuthorityInputSchema }).strict(),
  // New children recheck the parent's original durable credential. A parent
  // grant identifies a delegation; it never skips current identity checks.
  z.object({ kind: z.literal('delegation'), parentGrantId: id }).strict(),
  // Hosted checkout and provider events have no merchant browser session. The
  // owning payment service proves the merchant policy before requesting this.
  z.object({ kind: z.literal('merchant_policy'), merchantId: id }).strict(),
  // svc-pay proves current tree ownership/grant under its own cutoff guard.
  // Identity independently checks both the child owner and original actor.
  z
    .object({
      kind: z.literal('payfac_credential'),
      subject: currentAuthorityInputSchema,
      area: z.enum(['payment', 'settlement.payout']),
      proof: payfacProof,
    })
    .strict(),
]);

export const identityOperationIntentSchema = operationAdmissionInputSchema
  .extend({ authority: identityOperationAuthoritySchema })
  .strict()
  .superRefine((input, ctx) => {
    const authority = input.authority;
    if (
      authority.kind === 'payfac_credential' &&
      (input.operation.service !== 'svc-pay' ||
        input.operation.merchantId !== authority.proof.subjectMerchantId ||
        authority.proof.actorMerchantId === authority.proof.subjectMerchantId ||
        authority.area !== (input.operation.kind === 'payout' ? 'settlement.payout' : 'payment'))
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['authority'],
        message: 'PayFac proof must match the payment operation and distinct actor merchant',
      });
    }
    if (authority.kind === 'credential' && authority.subject.userId !== input.operation.userId) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['authority'], message: 'Credential must belong to the operation owner' });
    }
    if (
      authority.kind === 'delegation' &&
      (input.operation.service !== 'svc-trade' || !['algo.child', 'copy.mirror'].includes(input.operation.kind))
    ) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['authority'], message: 'Delegation is limited to fresh trading children' });
    }
    if (
      authority.kind === 'merchant_policy' &&
      (input.operation.service !== 'svc-pay' || input.operation.merchantId !== authority.merchantId)
    ) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['authority'], message: 'Merchant policy must match the payment owner' });
    }
  });
export type IdentityOperationIntent = z.infer<typeof identityOperationIntentSchema>;

/** Per-owner signed service transport must bind the exact body and service name. */
export const identityOperationDecisionInputSchema = z
  .object({ mode: z.enum(['grant', 'resolve_or_cancel']), intent: identityOperationIntentSchema })
  .strict();
export type IdentityOperationDecisionInput = z.infer<typeof identityOperationDecisionInputSchema>;

const decisionFields = { intent: identityOperationIntentSchema, decidedAt: timestamp };
export const identityOperationGrantSchema = z
  .object({ ...decisionFields, status: z.literal('granted'), grantId: id, identityVersion: version })
  .strict();
export type IdentityOperationGrant = z.infer<typeof identityOperationGrantSchema>;

export const identityOperationDecisionSchema = z.discriminatedUnion('status', [
  identityOperationGrantSchema,
  z
    .object({
      ...decisionFields,
      status: z.literal('cancelled'),
      code: z.enum(['admission.cancelled', 'auth.account_frozen', 'auth.credential_denied', 'auth.sub_account_denied']),
    })
    .strict(),
  z.object({ status: z.literal('conflict'), code: z.literal('operation.conflict') }).strict(),
  z.object({ status: z.literal('unavailable'), code: z.literal('authority.unavailable') }).strict(),
]);
export type IdentityOperationDecision = z.infer<typeof identityOperationDecisionSchema>;

/**
 * Identity decides once under the same guard as identity freeze, and retains
 * both grants and cancellation tombstones. A retry only resolves that decision.
 * This is one half of admission, not an owner receipt or a completed operation.
 *
 * Before calling grant, the owner commits an immutable prepared intent and its
 * request marker. It holds its restriction guard during grant/finalization.
 * Before committing a local restriction, it resolves or cancels EVERY pending
 * marked intent under that guard. Network failure refuses the restriction; it
 * must not discard pending decisions or let late grants pass the restriction.
 * Previously granted intents recover against their recorded original payload.
 */
export interface IdentityOperationDecisionPort {
  decide(input: IdentityOperationDecisionInput): Promise<IdentityOperationDecision>;
}
