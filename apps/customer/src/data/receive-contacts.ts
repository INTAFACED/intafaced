// hand-declared-ok: svc-identity's receiveContacts answers have no schema in packages/contracts.
/**
 * The caller's own ways to receive (PP-send-request-03, J-pay-03 #6): extra email addresses and phone numbers people
 * can pay them by, each proved with the code sent to it. svc-identity `receiveContacts.list`, `add`, `verify` and
 * `remove`, and `users.searchPayees` for a sender who types an email or a phone.
 *
 * A blank owner setting is `identity.receive_contact_unset`, and a sender that is off is
 * `identity.receive_contact_mail_off` or `identity.receive_contact_sms_off`: the screen names each, never a guess.
 */
import { z } from 'zod';
import type { ApiClient } from '../shared/api';
import { resolveHandleSchema, type ResolveOutcome } from './identity';

export const receiveContactListSchema = z.object({
  contacts: z.array(z.object({ id: z.string().guid(), channel: z.enum(['email', 'phone']), target: z.string(), verified: z.boolean() })),
  max: z.number().int().positive().nullable(),
});
export type ReceiveContactList = z.infer<typeof receiveContactListSchema>;
export type ReceiveContact = ReceiveContactList['contacts'][number];
export type ReceiveChannel = ReceiveContact['channel'];

export const RECEIVE_CONTACT_CODES = [
  'identity.receive_contact_invalid',
  'identity.receive_contact_unset',
  'identity.receive_contact_cap_reached',
  'identity.receive_contact_mail_off',
  'identity.receive_contact_sms_off',
  'identity.receive_contact_wait',
  'identity.receive_contact_send_failed',
  'identity.contact_code_invalid',
  'identity.security_locked',
  'identity.delegated_refused',
  'identity.session_not_live',
  'auth.account_frozen',
  'auth.not_found',
] as const;
export type ReceiveContactCode = (typeof RECEIVE_CONTACT_CODES)[number];

export type ReceiveContactOutcome =
  { kind: 'ok'; list: ReceiveContactList } | { kind: 'refused'; code: ReceiveContactCode } | { kind: 'failed' };

const known = (code: string | undefined): code is ReceiveContactCode => (RECEIVE_CONTACT_CODES as readonly string[]).includes(code ?? '');

export async function fetchReceiveContacts(api: ApiClient, signal?: AbortSignal): Promise<ReceiveContactOutcome> {
  const result = await api.query('identity', 'receiveContacts.list', undefined, receiveContactListSchema, { signal });
  if (result.ok) return { kind: 'ok', list: result.data };
  return known(result.code) ? { kind: 'refused', code: result.code } : { kind: 'failed' };
}

async function change(api: ApiClient, procedure: string, input: unknown): Promise<ReceiveContactOutcome> {
  const result = await api.mutate('identity', procedure, input, receiveContactListSchema);
  if (result.ok) return { kind: 'ok', list: result.data };
  return known(result.code) ? { kind: 'refused', code: result.code } : { kind: 'failed' };
}

export const addReceiveContact = (api: ApiClient, input: { channel: ReceiveChannel; target: string }) =>
  change(api, 'receiveContacts.add', input);
export const verifyReceiveContact = (api: ApiClient, input: { id: string; code: string }) => change(api, 'receiveContacts.verify', input);
export const removeReceiveContact = (api: ApiClient, input: { id: string }) => change(api, 'receiveContacts.remove', input);

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE = /^\+[1-9][0-9]{7,14}$/;

/** What a person typed where a handle goes: an email address, an E.164 phone, or neither (a handle). */
export function contactKind(raw: string): ReceiveChannel | null {
  const value = raw.trim();
  if (EMAIL.test(value)) return 'email';
  if (PHONE.test(value)) return 'phone';
  return null;
}

/** Find the person an exact email or phone pays (`users.searchPayees`). The same answers as a handle lookup. */
export async function resolveContact(api: ApiClient, raw: string, signal?: AbortSignal): Promise<ResolveOutcome> {
  const kind = contactKind(raw);
  if (kind === null) return { kind: 'notFound' };
  const value = raw.trim();
  const result = await api.query(
    'identity',
    'users.searchPayees',
    kind === 'email' ? { email: value } : { phone: value },
    resolveHandleSchema,
    {
      signal,
    },
  );
  if (result.ok)
    return result.data.found
      ? { kind: 'found', userId: result.data.userId, handle: result.data.handle, self: result.data.self }
      : { kind: 'notFound' };
  if (result.status === 429) return { kind: 'rateLimited' };
  return { kind: 'failed' };
}
