import { z } from 'zod';

/** Answer shapes for the `totpManage` procedures and the step-up that gates turning off or replacing. */
export const totpStatus = z.object({
  enabled: z.boolean(),
  label: z.string().nullable(),
  enrolledAt: z.string().nullable(),
  recoveryCodesLeft: z.number().int().min(0),
});
export type TotpStatus = z.infer<typeof totpStatus>;

export const stepUpBegun = z.object({ challengeId: z.string().guid() }).passthrough();
export const stepUpDone = z.object({ stepUpApprovalId: z.string().min(1) }).passthrough();
export const disabledAnswer = z.object({ disabled: z.literal(true), recoveryCodeSpent: z.boolean() });
export const replaceStarted = z.object({ secret: z.string().regex(/^[A-Z2-7]{16,}$/), uri: z.string() });
export const replacedAnswer = z.object({
  replaced: z.literal(true),
  recoveryCodeSpent: z.boolean(),
  /** The new recovery codes, shown once; the old ones stopped working with the swap. */
  recoveryCodes: z.array(z.string()).min(1),
  /** Other sessions of the account that the swap ended (the lost phone among them). */
  sessionsEnded: z.number().int().min(0),
});

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
/**
 * The step-up's factor: digits are the app's code (spaces dropped), anything else is a recovery code (only replace and
 * turn-off take one). A run of digits that is not six long is a mistyped app code and is refused before it is sent, so
 * it never counts against the sign-in lockout as a wrong recovery code.
 */
export function stepUpProof(value: string): { totpCode: string } | { recoveryCode: string } | null {
  const digits = value.replace(/\s+/g, '');
  if (/^\d+$/.test(digits)) return digits.length === 6 ? { totpCode: digits } : null;
  return isProof(value) ? { recoveryCode: value.trim() } : null;
}
