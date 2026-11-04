import type { ApiResult } from './deps';
import { payCopy } from './copy';

/** How the person answers the fresh confirmation: a code from their authenticator app, or a passkey. */
export type StepUpHow = 'code' | 'passkey';

/**
 * The bank's answers that mean "confirm it's you (again)" (ADR 2026-10-14-money-out-step-up): the rule asks for a fresh
 * confirmation, or the one given was already spent or ran out. Nothing was sent, and the same review can carry on.
 * `bank.step_up_mismatch` is not one: the same review would bind the same fields again, so it is a final refusal.
 */
export function stepUpAgain(code: string | undefined): boolean {
  return code === 'bank.step_up_required' || code === 'bank.step_up_used';
}

/** Why a confirmation did not go through, in plain words. Nothing was sent in any of these cases. */
export function stepUpProblem(result: Extract<ApiResult<unknown>, { ok: false }>): string {
  switch (result.code) {
    case 'auth.mfa_invalid':
      return payCopy.t('Code refused');
    case 'auth.mfa_not_enrolled':
      return payCopy.t('No second factor');
    case 'stepUp.no_passkey':
    case 'auth.webauthn_not_enrolled':
      return payCopy.t('No passkey');
    case 'auth.webauthn_invalid':
      return payCopy.t('Passkey failed');
  }
  if (result.status === 429) return payCopy.t('Too many tries');
  if (result.status === 403) return payCopy.t('Cannot confirm here');
  return payCopy.t('Confirm failed');
}
