import { z } from 'zod';
import type { ApiResult } from '../../shared/api';
import { rooms } from '../../app/navigation';
import { sessionSchema, type Session } from '../session/session';

export const authKinds = ['register', 'password', 'options', 'passkey'] as const;
export type AuthKind = (typeof authKinds)[number];
const roomPatterns = new Set(rooms.filter((room) => !['public', 'team', 'parked'].includes(room.area)).map((room) => room.path));
const recordSchema = z
  .object({
    localRef: z.string().uuid(),
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
    },
    passkey: { 'auth.invalid_credentials': 401, 'auth.account_frozen': 403, 'auth.webauthn_not_enrolled': 403 },
  };
  const status = permitted[kind]?.[answer.code];
  const reason = status === 401 ? 'unauthorized' : status === 403 ? 'forbidden' : status === 404 ? 'not_mounted' : 'error';
  return status !== undefined && status === answer.status && reason === answer.reason;
}
