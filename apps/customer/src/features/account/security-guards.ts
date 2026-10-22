import { z } from 'zod';
import type { ApiResult } from '../../shared/api';

const uuid = z.string().uuid();
export const securityInstant = z
  .string()
  .datetime({ offset: true })
  .refine((value) => {
    const date = /^([0-9]{4})-([0-9]{2})-([0-9]{2})/.exec(value);
    if (!date || !Number.isFinite(Date.parse(value))) return false;
    const calendar = new Date(Date.UTC(Number(date[1]), Number(date[2]) - 1, Number(date[3])));
    return (
      calendar.getUTCFullYear() === Number(date[1]) &&
      calendar.getUTCMonth() === Number(date[2]) - 1 &&
      calendar.getUTCDate() === Number(date[3])
    );
  });
export function credentialBytes(value: string): ArrayBuffer {
  return Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0)).buffer;
}
export function credentialReference(value: ArrayBuffer): string {
  const bytes = new Uint8Array(value);
  let text = '';
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}
export const credentialId = z
  .string()
  .min(1)
  .max(8192)
  .refine((value) => {
    if (!/^[A-Za-z0-9_-]+$/.test(value)) return false;
    try {
      return credentialReference(credentialBytes(value)) === value;
    } catch {
      return false;
    }
  });
export const passkey = z.object({ credentialId, createdAt: securityInstant, transports: z.array(z.string()).optional() });
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
export const securityKind = z.enum(['options', 'register', 'remove', 'setup', 'confirm', 'logout']);
export type SecurityKind = z.infer<typeof securityKind>;
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
export const securityRecord = z
  .object({
    requestId: uuid,
    owner: uuid,
    createdAt: securityInstant,
    kind: securityKind,
    state: z.enum(['sent', 'prepared']),
    credential: credentialId.optional(),
    setupRequest: uuid.optional(),
  })
  .strict()
  .refine(
    (record) =>
      (record.state !== 'prepared' || record.kind === 'setup') &&
      (record.kind === 'register' || record.kind === 'remove') === (record.credential !== undefined) &&
      (record.kind === 'confirm') === (record.setupRequest !== undefined),
  );
export type SecurityRecord = z.infer<typeof securityRecord>;
export type SecurityJournal = { records: SecurityRecord[]; failed: boolean };
export const securityKey = (owner: string) => 'intafaced.customer.security.v1:' + owner;
export const securitySessionLock = (owner: string) => 'customer-session-revoke:' + owner;
const recordsSchema = z
  .array(securityRecord)
  .max(50)
  .refine((records) => new Set(records.map((record) => record.requestId)).size === records.length);
export function readSecurity(owner: string): SecurityJournal {
  try {
    const text = localStorage.getItem(securityKey(owner));
    if (text === null) return { records: [], failed: false };
    const result = recordsSchema.safeParse(JSON.parse(text));
    return result.success && result.data.every((record) => record.owner === owner)
      ? { records: result.data, failed: false }
      : { records: [], failed: true };
  } catch {
    return { records: [], failed: true };
  }
}
function writeRecords(owner: string, records: SecurityRecord[]): boolean {
  const parsed = recordsSchema.safeParse(records);
  if (!parsed.success) return false;
  const canonical = parsed.data;
  try {
    if (canonical.length === 0) localStorage.removeItem(securityKey(owner));
    else localStorage.setItem(securityKey(owner), JSON.stringify(canonical));
    const actual = readSecurity(owner);
    return !actual.failed && JSON.stringify(actual.records) === JSON.stringify(canonical);
  } catch {
    return false;
  }
}
/** Called under the owner Web Lock. Only nonsecret original references are serialized. */
export function saveSecurity(record: SecurityRecord): boolean {
  const current = readSecurity(record.owner);
  if (current.failed || current.records.some((row) => row.requestId === record.requestId)) return false;
  return writeRecords(record.owner, [...current.records, record]);
}
export function finishSecurity(original: SecurityRecord): boolean {
  const current = readSecurity(original.owner);
  const found = current.records.find((row) => row.requestId === original.requestId);
  if (current.failed || !found || !sameRecord(found, original)) return false;
  return writeRecords(
    original.owner,
    current.records.filter((row) => row.requestId !== original.requestId),
  );
}
/** A known setup replaces only known prepared setups; uncertain preparations remain original records. */
export function prepareSecurity(original: SecurityRecord): boolean {
  const current = readSecurity(original.owner);
  const found = current.records.find((row) => row.requestId === original.requestId);
  if (current.failed || original.kind !== 'setup' || !found || !sameRecord(found, original)) return false;
  return writeRecords(original.owner, [
    ...current.records.filter((row) => row.requestId !== original.requestId && row.state !== 'prepared'),
    { ...original, state: 'prepared' },
  ]);
}
function sameRecord(a: SecurityRecord, b: SecurityRecord) {
  return (
    a.requestId === b.requestId &&
    a.owner === b.owner &&
    a.createdAt === b.createdAt &&
    a.kind === b.kind &&
    a.state === b.state &&
    a.credential === b.credential &&
    a.setupRequest === b.setupRequest
  );
}
export function familyBlocked(journal: SecurityJournal, family: SecurityFamily): boolean {
  return (
    journal.failed ||
    journal.records.some(
      (row) => row.state === 'sent' && row.kind !== 'options' && row.kind !== 'setup' && securityFamily(row.kind) === family,
    )
  );
}
export const setupResponse = z
  .object({
    secret: z.string().regex(/^[A-Z2-7]{16,}$/),
    uri: z.string(),
    recoveryCodes: z.array(z.string().regex(/^[A-F0-9]{5}-[A-F0-9]{5}$/)).length(10),
  })
  .refine((value) => {
    try {
      const uri = new URL(value.uri);
      return (
        uri.protocol === 'otpauth:' &&
        uri.hostname === 'totp' &&
        uri.searchParams.get('secret') === value.secret &&
        uri.searchParams.get('issuer') === 'INTAFACED' &&
        uri.searchParams.get('algorithm') === 'SHA1' &&
        uri.searchParams.get('digits') === '6' &&
        uri.searchParams.get('period') === '30' &&
        new Set(value.recoveryCodes).size === value.recoveryCodes.length
      );
    } catch {
      return false;
    }
  });
