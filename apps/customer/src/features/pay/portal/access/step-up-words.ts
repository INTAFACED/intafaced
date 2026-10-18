import type { ApiResult } from '../../../../shared/api';
import { refusalText, registerRefusals } from '../refusal';
import { stepUpCopy } from './step-up-copy';

// The service's own codes, so a refusal that reaches any page reads in words. (`auth.*` codes carry no `pay.` prefix.)
registerRefusals({
  'auth.step_up_required': () => stepUpCopy.t('suRequired'),
  'auth.step_up_expired': () => stepUpCopy.t('suExpired'),
  'pay.role_not_allowed': () => stepUpCopy.t('suRoleAny'),
});

type Failed = Extract<ApiResult<unknown>, { ok: false }>;
/** A money-call refusal for "no confirmation held / declined", shaped like a service refusal so the shared dialog prints it. */
export const stepUpRequired = (): Failed => ({ ok: false, reason: 'error', code: 'portal.local', message: stepUpCopy.t('suRequired') });
export const stepUpExpired = (): Failed => ({ ok: false, reason: 'error', code: 'portal.local', message: stepUpCopy.t('suExpired') });
export const stepUpWords = {
  required: <T>() => stepUpRequired() as ApiResult<T>,
  expired: <T>() => stepUpExpired() as ApiResult<T>,
};

/** Why the service would not confirm it's this person, in plain words. A code never reaches the screen. */
export function stepUpRefusalText(result: Failed): string {
  const code = result.code ?? '';
  const t = stepUpCopy.t;
  switch (code) {
    case 'auth.step_up_required':
      return t('suRequired');
    case 'auth.step_up_expired':
      return t('suExpired');
    case 'auth.mfa_invalid':
      return t('suCodeBad');
    case 'auth.mfa_not_enrolled':
      return t('suNoAuthenticator');
    case 'auth.webauthn_not_enrolled':
      return t('suNoPasskey');
    case 'auth.webauthn_invalid':
      return t('suPasskeyBad');
    case 'portal.passkey_stopped':
      return t('suPasskeyStopped');
    case 'portal.passkey_unavailable':
      return t('suPasskeyUnavailable');
    case 'portal.passkey_failed':
    case 'portal.passkey_unreadable':
      return t('suPasskeyFailed');
    case 'pay.role_not_allowed':
      // The service names the permission it checked: "refunds.create" or "payout.send".
      return /refund/i.test(result.message) ? t('suRoleRefund') : /payout/i.test(result.message) ? t('suRolePayout') : t('suRoleAny');
    default:
  }
  if (/api keys? and sub-accounts/i.test(result.message)) return t('suKeys');
  if (result.reason === 'unauthorized' || result.reason === 'forbidden') return t('suFailed');
  return refusalText(result);
}
