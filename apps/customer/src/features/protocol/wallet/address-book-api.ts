import { z } from 'zod';
import {
  PROTOCOL_WALLET_SESSION_REFUSALS,
  protocolAddressBookListOutputSchema,
  protocolAddressBookRemovedOutputSchema,
  protocolContactSchema,
  protocolWalletGroupSchema,
  protocolWalletSessionChallengeOutputSchema,
  protocolWalletSessionOpenOutputSchema,
  type ProtocolAddressBook,
  type ProtocolContact,
  type ProtocolWalletGroup,
} from '@intafaced/contracts/protocol-address-book';
import type { ApiClient, ApiResult } from '../../../shared/api';
import type { SignRequest, SignResult } from './eip1193';

export type AddressBook = ProtocolAddressBook;
export type Contact = ProtocolContact;
export type WalletGroup = ProtocolWalletGroup;

/**
 * svc-protocol's wallet session and address book (D-portfolio-wallet-03). Every call is a POST: the session token goes in
 * the body, never in a URL. A wallet-session refusal is this call's own answer, never proof that the exchange sign-in
 * ended, so none of them signs the person out of their account.
 */
const keepSessionFor = PROTOCOL_WALLET_SESSION_REFUSALS;

export function createAddressBookApi(api: ApiClient) {
  const call = <T>(procedure: string, input: unknown, schema: z.ZodType<T>) =>
    api.mutate('protocol', procedure, input, schema, { keepSessionFor });
  return {
    challenge: (input: { address: string; origin: string }) =>
      call('walletSession.challenge', input, protocolWalletSessionChallengeOutputSchema),
    open: (input: { challenge: string; signature: string }) => call('walletSession.open', input, protocolWalletSessionOpenOutputSchema),
    list: (session: string) => call('addressBook.list', { session }, protocolAddressBookListOutputSchema),
    addContact: (session: string, input: { label: string; address: string }) =>
      call('addressBook.addContact', { session, ...input }, protocolContactSchema),
    removeContact: (session: string, id: string) =>
      call('addressBook.removeContact', { session, id }, protocolAddressBookRemovedOutputSchema),
    createGroup: (session: string, input: { name: string; members: string[] }) =>
      call('addressBook.createGroup', { session, ...input }, protocolWalletGroupSchema),
    group: (session: string, id: string) => call('addressBook.group', { session, id }, protocolWalletGroupSchema),
    removeGroup: (session: string, id: string) => call('addressBook.removeGroup', { session, id }, protocolAddressBookRemovedOutputSchema),
  };
}
export type AddressBookApi = ReturnType<typeof createAddressBookApi>;

/**
 * Wallet sessions in memory only, one per address, so moving between the address book and a group asks the wallet once.
 * Never in browser storage: a reload asks again.
 */
const sessions = new Map<string, { token: string; expiresAt: number }>();
/** Single flight per address: two panels asking at once share one signature request. */
const opening = new Map<string, Promise<SessionResult>>();
/** A minute of margin, so a session never expires between being read here and reaching the service. */
const MARGIN_MS = 60_000;

export type SessionResult =
  | { ok: true; token: string }
  | { ok: false; kind: 'rejected' }
  /** The wallet could not sign: on another network, timed out, switched account or answered nothing. */
  | { ok: false; kind: 'wallet'; reason: 'chain_mismatch' | 'other' }
  | { ok: false; kind: 'refused'; code: string | undefined; message: string };

export function forgetWalletSession(address: string): void {
  sessions.delete(address.toLowerCase());
}

/** Test seam: clears every remembered session. */
export function resetWalletSessions(): void {
  sessions.clear();
  opening.clear();
}

/**
 * The session for `address`: the remembered one while it lasts, else a new one. The sign-in message goes through
 * `sign`, the wallet provider's own path: the plain-words sheet first, then the wallet, only after the person continues.
 */
export function walletSession(
  api: AddressBookApi,
  wallet: { address: string; sign: (request: SignRequest) => Promise<SignResult> },
  now: () => number = Date.now,
): Promise<SessionResult> {
  const key = wallet.address.toLowerCase();
  const known = sessions.get(key);
  if (known && known.expiresAt - MARGIN_MS > now()) return Promise.resolve({ ok: true, token: known.token });
  const pending = opening.get(key);
  if (pending) return pending;
  const run = (async (): Promise<SessionResult> => {
    const refused = (result: Extract<ApiResult<unknown>, { ok: false }>): SessionResult => ({
      ok: false,
      kind: 'refused',
      code: result.code,
      message: result.message,
    });
    const challenge = await api.challenge({ address: wallet.address, origin: window.location.origin });
    if (!challenge.ok) return refused(challenge);
    const signed = await wallet.sign({ kind: 'message', message: challenge.data.message });
    if (signed.status === 'rejected') return { ok: false, kind: 'rejected' };
    if (signed.status !== 'signed')
      return {
        ok: false,
        kind: 'wallet',
        reason: signed.status === 'failed' && signed.reason === 'chain_mismatch' ? 'chain_mismatch' : 'other',
      };
    const opened = await api.open({ challenge: challenge.data.challenge, signature: signed.signature });
    if (!opened.ok) return refused(opened);
    sessions.set(key, { token: opened.data.session, expiresAt: Date.parse(opened.data.expiresAt) });
    return { ok: true, token: opened.data.session };
  })();
  opening.set(key, run);
  return run.finally(() => opening.delete(key));
}
