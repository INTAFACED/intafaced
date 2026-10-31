import { z } from 'zod';
import type { ApiResult } from '../../shared/api';
import { isSignInDestination, rooms } from '../../app/navigation';
import { sessionSchema, type Session } from '../session/session';

export const authKinds = ['register', 'password', 'options', 'passkey', 'secondStep', 'wallet'] as const;
export type AuthKind = (typeof authKinds)[number];
const roomPatterns = new Set(rooms.filter(isSignInDestination).map((room) => room.path));
const recordSchema = z
  .object({
    localRef: z.string().guid(),
    kind: z.enum(authKinds),
    createdAt: z
      .string()
      .datetime()
      .refine((value) => Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value),
    target: z.string().refine((value) => value === 'invite' || roomPatterns.has(value)),
  })
  .strict();
const journalSchema = z.array(recordSchema).superRefine((records, ctx) => {
  if (new Set(records.map((record) => record.localRef)).size !== records.length)
    ctx.addIssue({ code: 'custom', message: 'Duplicate local reference' });
});
export type AuthRecord = z.infer<typeof recordSchema>;
export const publicAuthKey = 'intafaced.customer.public-auth.v1';
export const publicAuthLock = 'customer-public-auth';
export function readAuth(): { records: AuthRecord[]; failed: boolean } {
  try {
    const raw = localStorage.getItem(publicAuthKey);
    if (raw === null) return { records: [], failed: false };
    const parsed = journalSchema.safeParse(JSON.parse(raw));
    return parsed.success ? { records: parsed.data, failed: false } : { records: [], failed: true };
  } catch {
    return { records: [], failed: true };
  }
}
export function saveAuth(record: AuthRecord): boolean {
  const current = readAuth();
  if (current.failed || !recordSchema.safeParse(record).success) return false;
  try {
    const next = [...current.records, record];
    localStorage.setItem(publicAuthKey, JSON.stringify(next));
    return JSON.stringify(readAuth().records) === JSON.stringify(next);
  } catch {
    return false;
  }
}
export function finishAuth(record: AuthRecord): boolean {
  const current = readAuth();
  if (current.failed) return false;
  const found = current.records.find((row) => row.localRef === record.localRef);
  if (!found || JSON.stringify(found) !== JSON.stringify(record)) return false;
  try {
    const next = current.records.filter((row) => row.localRef !== record.localRef);
    if (next.length) localStorage.setItem(publicAuthKey, JSON.stringify(next));
    else localStorage.removeItem(publicAuthKey);
    const read = readAuth();
    return !read.failed && JSON.stringify(read.records) === JSON.stringify(next);
  } catch {
    return false;
  }
}
export function validAuthSession(value: Session): boolean {
  if (!sessionSchema.safeParse(value).success) return false;
  const time = Date.parse(value.expiresAt);
  return Number.isFinite(time) && time > Date.now() && value.accessToken.trim().length > 0;
}
/** Codes below occur before account/session issuance in these exact procedures.
 * A refused passkey verification can consume its challenge: no assertion is kept or reused.
 * Unclassified/generic4xx and post-effect failures remain original unknowns. */
export function knownAuthRefusal(kind: AuthKind, answer: ApiResult<unknown>): boolean {
  if (answer.ok) return false;
  if (answer.reason === 'aborted' && ['beforeDispatch', 'accountChanged'].includes(answer.messageCopy?.key ?? '')) return true;
  if (answer.messageCopy || !answer.message.trim() || !answer.code) return false;
  const permitted: Partial<Record<AuthKind, Record<string, number>>> = {
    register: { 'auth.handle_taken': 409, 'auth.email_taken': 409 },
    password: {
      'auth.invalid_credentials': 401,
      'auth.account_frozen': 403,
      'auth.mfa_required': 401,
      'auth.mfa_invalid': 401,
      'auth.not_found': 404,
      // The per-account pause after too many wrong passwords (svc-identity attempt-lockout): nothing was signed in.
      'auth.too_many_attempts': 429,
      // Every factor passed on a browser the account has not trusted yet: nothing was signed in; approval comes next.
      'auth.device_authorisation_required': 403,
      // The self-hosted sign-in challenge (I-signin-sessions-30): asked for, failed, or not set by the owner.
      'auth.challenge_required': 403,
      'auth.challenge_invalid': 403,
      'auth.challenge_expired': 403,
      'auth.challenge_used': 403,
      'identity.challenge_unconfigured': 412,
    },
    passkey: { 'auth.invalid_credentials': 401, 'auth.account_frozen': 403, 'auth.webauthn_not_enrolled': 403 },
    // A wallet's signature (I-account-lifecycle-07): an unlinked wallet, a spent challenge or a refused signature signs nothing in.
    wallet: {
      'auth.invalid_credentials': 401,
      'auth.account_frozen': 403,
      'auth.mfa_required': 401,
      'auth.mfa_invalid': 401,
      'auth.too_many_attempts': 429,
      'auth.device_authorisation_required': 403,
      'identity.wallet_challenge_invalid': 400,
      'identity.wallet_signature_invalid': 400,
      'identity.wallet_kind_unsupported': 400,
    },
    // The passkey after the password (I-signin-sessions-10): a refused or timed-out step signs nothing in.
    secondStep: {
      'auth.webauthn_invalid': 401,
      'auth.second_step_expired': 401,
      'auth.account_frozen': 403,
      'auth.too_many_attempts': 429,
      'auth.device_authorisation_required': 403,
    },
  };
  const status = permitted[kind]?.[answer.code];
  const reason = status === 401 ? 'unauthorized' : status === 403 ? 'forbidden' : status === 404 ? 'not_mounted' : 'error';
  return status !== undefined && status === answer.status && reason === answer.reason;
}
