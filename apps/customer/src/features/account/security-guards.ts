import { z } from 'zod';
import {
  credentialBytes,
  credentialIdSchema as credentialId,
  credentialReference,
  passkeySchema as passkey,
} from '@intafaced/contracts/identity-account-room';
import type { ApiResult } from '../../shared/api';
import type { SecurityJournal, SecurityKind } from './security-journal';

export { credentialBytes, credentialId, credentialReference };
export {
  finishSecurity,
  prepareSecurity,
  readSecurity,
  saveSecurity,
  securityKey,
  securitySessionLock,
  type SecurityJournal,
  type SecurityKind,
  type SecurityRecord,
} from './security-journal';
export type Passkey = z.infer<typeof passkey>;
export function passkeysIn(limit: number) {
  return z
    .array(passkey)
    .max(limit)
    .refine(
      (rows) =>
        new Set(rows.map((row) => row.credentialId)).size === rows.length &&
        rows.every((row, i) => i === 0 || Date.parse(rows[i - 1]!.createdAt) >= Date.parse(row.createdAt)),
    );
}
/**
 * The change a "Confirm it is you" may send again after a second-factor refusal: adding or removing a passkey, or
 * starting an authenticator. Not a confirmation (its code has likely expired by then) and not signing out everywhere.
 */
export function stepUpKind(kind: SecurityKind | undefined): 'options' | 'remove' | 'setup' | null {
  return kind === 'options' || kind === 'register' ? 'options' : kind === 'remove' || kind === 'setup' ? kind : null;
}
/** Explicit AuthService branches before the relevant account change; HTTP status alone is insufficient.
 * registerOptions/setup may change preparation state, but do not enroll a credential/enable MFA.
 * Registration invalidity precedes credential UPDATE; MFA invalidity/key checks precede account UPDATE.
 * Rank/dependency failures after those writes and global sign-out have no such refusal guarantee.
 * `auth.mfa_required` 403 is the factor gate (svc-identity factor-gate.ts): it refuses a session that has not passed a
 * second factor before any read-modify-write of the account's factors.
 */
const preEffectRefusals: Readonly<Record<SecurityKind, Readonly<Record<string, number>>>> = {
  options: { 'auth.not_found': 404, 'auth.mfa_required': 403 },
  register: { 'auth.not_found': 404, 'auth.webauthn_invalid': 401, 'auth.mfa_required': 403 },
  remove: { 'auth.not_found': 404, 'auth.mfa_required': 403 },
  setup: { 'auth.totp_key_missing': 412, 'auth.not_found': 404, 'auth.mfa_already_enrolled': 409, 'auth.mfa_required': 403 },
  confirm: { 'auth.mfa_invalid': 401, 'auth.totp_key_missing': 412, 'auth.mfa_required': 403 },
  logout: {},
};
export function isPreEffectRefusal(kind: SecurityKind, answer: ApiResult<unknown>): boolean {
  if (answer.ok || !answer.code || answer.messageCopy || !answer.message.trim()) return false;
  const status = preEffectRefusals[kind][answer.code];
  if (status === undefined || answer.status !== status) return false;
  const reason = status === 401 ? 'unauthorized' : status === 403 ? 'forbidden' : status === 404 ? 'not_mounted' : 'error';
  return answer.reason === reason;
}
export type SecurityFamily = 'credentials' | 'authenticator' | 'sessions';
export function securityFamily(kind: SecurityKind): SecurityFamily {
  return kind === 'options' || kind === 'register' || kind === 'remove'
    ? 'credentials'
    : kind === 'setup' || kind === 'confirm'
      ? 'authenticator'
      : 'sessions';
}
export function familyBlocked(journal: SecurityJournal, family: SecurityFamily): boolean {
  return (
    journal.failed ||
    journal.records.some(
      (row) => row.state === 'sent' && row.kind !== 'options' && row.kind !== 'setup' && securityFamily(row.kind) === family,
    )
  );
}
