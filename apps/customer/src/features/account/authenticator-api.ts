import type { z } from 'zod';
import {
  stepUpBegunSchema,
  stepUpDoneSchema,
  totpDisabledSchema,
  totpReplacedSchema,
  totpReplaceStartedSchema,
  totpStatusSchema,
} from '@intafaced/contracts/identity-account-room';

/** Answer shapes for the `totpManage` procedures and the step-up that gates turning off or replacing. */
export const totpStatus = totpStatusSchema;
export type TotpStatus = z.infer<typeof totpStatus>;

export const stepUpBegun = stepUpBegunSchema;
export const stepUpDone = stepUpDoneSchema;
export const disabledAnswer = totpDisabledSchema;
export const replaceStarted = totpReplaceStartedSchema;
export const replacedAnswer = totpReplacedSchema;

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
