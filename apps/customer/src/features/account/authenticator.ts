import { z } from 'zod';

/** Answer shapes for the `totpManage` procedures and the step-up that gates turning off or replacing. */
export const totpStatus = z.object({
  enabled: z.boolean(),
  label: z.string().nullable(),
  enrolledAt: z.string().nullable(),
  recoveryCodesLeft: z.number().int().min(0),
});
export type TotpStatus = z.infer<typeof totpStatus>;

export const stepUpBegun = z.object({ challengeId: z.string().uuid() }).passthrough();
export const stepUpDone = z.object({ stepUpApprovalId: z.string().min(1) }).passthrough();
export const disabledAnswer = z.object({ disabled: z.literal(true), recoveryCodeSpent: z.boolean() });
export const replaceStarted = z.object({ secret: z.string().regex(/^[A-Z2-7]{16,}$/), uri: z.string() });
export const replacedAnswer = z.object({ replaced: z.literal(true), recoveryCodeSpent: z.boolean() });

export type StepUpScope = 'identity.step_up.totp_disable' | 'identity.step_up.totp_replace';
export const STEP_UP_PURPOSE: Record<StepUpScope, string> = {
  'identity.step_up.totp_disable': 'account.totp.disable',
  'identity.step_up.totp_replace': 'account.totp.replace',
};

/** The body of `stepUp.begin`: the door's only field is the request id, which is also its target. */
export function stepUpBeginInput(scope: StepUpScope, clientRequestId: string) {
  return { scope, purpose: STEP_UP_PURPOSE[scope], target: clientRequestId, fields: { clientRequestId } };
}

export const isSixDigits = (value: string): boolean => /^\d{6}$/.test(value.trim());
/** A TOTP code or a recovery code; the service decides which. */
export const isProof = (value: string): boolean => value.trim().length >= 6 && value.trim().length <= 64;
