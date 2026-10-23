import type { ApiResult } from './api';

/**
 * Password rules and refusals shared by "forgot password" and "change password".
 * The identity service enforces every rule here (services/svc-identity/src/auth/passwords.ts `assertPasswordShape`);
 * the browser only mirrors them so a mistake is caught before a round trip. Nothing here stores or logs a password or code.
 */
export const MIN_PASSWORD_LENGTH = 12;
export const MAX_PASSWORD_BYTES = 72;
/** The service refuses longer input outright (zod `.max(200)`). */
export const MAX_INPUT_LENGTH = 200;

export type PasswordIssue = 'tooShort' | 'tooLong' | 'repeated' | 'mismatch';

/** What the browser can tell before sending. `null` means nothing is wrong that the service would not also refuse. */
export function passwordIssue(password: string, confirm: string): PasswordIssue | null {
  if (password.length < MIN_PASSWORD_LENGTH) return 'tooShort';
  if (new TextEncoder().encode(password).length > MAX_PASSWORD_BYTES) return 'tooLong';
  // No `u` flag: this must match the server's regex exactly (UTF-16 units, so six identical emoji pass on both).
  if (/^(.)\1+$/.test(password)) return 'repeated';
  if (password !== confirm) return 'mismatch';
  return null;
}

export type PasswordProblem =
  /** Password reset is switched off on the server (`auth.reset_unwired`). Never shown as a success. */
  | 'resetOff'
  /** The identity service is not mounted behind the gateway. */
  | 'notConnected'
  | 'badCode'
  | 'policy'
  | 'unchanged'
  | 'wrongCurrent'
  | 'rateLimited'
  | 'secondStep'
  | 'inviteNeeded'
  | 'inactive'
  /** The owner's security lock holds (`identity.security_locked`): no password change or reset until it ends. */
  | 'securityLocked'
  | 'signedOut'
  | 'invalidInput'
  /** The request left but no answer was confirmed: the password may or may not have changed. */
  | 'unconfirmed'
  /** Only the request-a-code step uses this: asking for a code never changes a password. */
  | 'requestUnconfirmed'
  | 'unreachable'
  | 'other';

type Refusal = Extract<ApiResult<unknown>, { ok: false }>;

/** Every AuthError code the three password procedures can answer with, and what the customer is told. */
export function passwordProblem(result: Refusal): PasswordProblem {
  switch (result.code) {
    case 'auth.reset_unwired':
      return 'resetOff';
    case 'auth.reset_proof_invalid':
      return 'badCode';
    case 'auth.password_policy':
      return 'policy';
    case 'auth.password_unchanged':
      return 'unchanged';
    case 'auth.invalid_credentials':
      return 'wrongCurrent';
    case 'auth.too_many_attempts':
      return 'rateLimited';
    case 'auth.mfa_required':
      return 'secondStep';
    case 'auth.privileged_enrolment_requires_invite':
      return 'inviteNeeded';
    case 'auth.account_frozen':
      return 'inactive';
    case 'identity.security_locked':
      return 'securityLocked';
    case 'auth.session_invalid':
    case 'auth.session_denied':
    case 'auth.session_revoked':
      return 'signedOut';
  }
  if (result.status === 429) return 'rateLimited';
  switch (result.reason) {
    case 'unauthorized':
      return 'signedOut';
    case 'not_mounted':
    case 'not_supported':
      return 'notConnected';
    case 'uncertain':
      return 'unconfirmed';
    case 'unreachable':
      return 'unreachable';
  }
  if (result.status === 400 && (!result.code || result.code === 'BAD_REQUEST')) return 'invalidInput';
  return 'other';
}

/**
 * One request at a time. `run` starts the task unless one is already in flight, in which case it returns `undefined`
 * without calling it. State updates are asynchronous, so a double click is stopped here, not by a disabled button alone.
 */
export function singleFlight() {
  let busy = false;
  return {
    get busy() {
      return busy;
    },
    async run<T>(task: () => Promise<T>): Promise<T | undefined> {
      if (busy) return undefined;
      busy = true;
      try {
        return await task();
      } finally {
        busy = false;
      }
    },
  };
}
