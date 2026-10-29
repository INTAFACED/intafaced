// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import type { ApiClient } from '../../../shared/api';
import { matchWeb3Route, walletGroupPath } from '../routes';
import { createAddressBookApi, forgetWalletSession, resetWalletSessions, walletSession } from './address-book-api';
import { walletCopy } from './copy';
import type { SignRequest, SignResult } from './eip1193';
import { bookMessage } from './useAddressBook';

const ADDR = '0x1111111111111111111111111111111111111111';
const { t } = walletCopy.forLocale('en');

type Sent = { procedure: string; input: unknown; keepSessionFor?: readonly string[] };
function fakeApi(answers: Record<string, (input: unknown) => unknown>) {
  const sent: Sent[] = [];
  const client = {
    mutate: async (_module: string, procedure: string, input: unknown, _schema: unknown, opts: { keepSessionFor?: readonly string[] }) => {
      sent.push({ procedure, input, keepSessionFor: opts.keepSessionFor });
      const answer = answers[procedure];
      if (!answer) throw new Error(`unexpected ${procedure}`);
      return answer(input);
    },
  } as unknown as ApiClient;
  return { api: createAddressBookApi(client), sent };
}
/** The wallet provider's `sign`: in the app it shows the plain-words sheet, then asks the wallet. */
function fakeWallet(answer: () => Promise<SignResult> = async () => ({ status: 'signed', signature: '0xsigned' })) {
  const asked: SignRequest[] = [];
  const sign = async (request: SignRequest) => {
    asked.push(request);
    return answer();
  };
  return { sign, asked };
}
const later = new Date(Date.now() + 3_600_000).toISOString();
const ok = { 'walletSession.challenge': () => ({ ok: true, data: { message: 'm', challenge: 'c', expiresAt: later } }) };

afterEach(() => resetWalletSessions());

describe('wallet session for the address book', () => {
  it('asks the wallet once and reuses the session in memory; two panels asking at once share one signature', async () => {
    const { api, sent } = fakeApi({
      ...ok,
      'walletSession.open': () => ({ ok: true, data: { session: 's1', address: ADDR, expiresAt: later } }),
    });
    const { sign, asked } = fakeWallet();
    const [a, b] = await Promise.all([walletSession(api, { sign, address: ADDR }), walletSession(api, { sign, address: ADDR })]);
    expect(a).toEqual({ ok: true, token: 's1' });
    expect(b).toEqual({ ok: true, token: 's1' });
    expect(asked).toHaveLength(1);
    expect(asked[0]).toEqual({ kind: 'message', message: 'm' });
    expect(sent.map((s) => s.procedure)).toEqual(['walletSession.challenge', 'walletSession.open']);
    // The page's own origin goes with the challenge; a wallet-session refusal never signs the person out.
    expect(sent[0]!.input).toEqual({ address: ADDR, origin: window.location.origin });
    expect(sent[0]!.keepSessionFor).toContain('protocol.wallet_session_invalid');
    forgetWalletSession(ADDR);
    await walletSession(api, { sign, address: ADDR });
    expect(asked).toHaveLength(2);
  });

  it('a session about to expire is opened again', async () => {
    const soon = new Date(Date.now() + 30_000).toISOString();
    const { api } = fakeApi({ ...ok, 'walletSession.open': () => ({ ok: true, data: { session: 's', address: ADDR, expiresAt: soon } }) });
    const { sign, asked } = fakeWallet();
    await walletSession(api, { sign, address: ADDR });
    await walletSession(api, { sign, address: ADDR });
    expect(asked).toHaveLength(2);
  });

  it('a cancelled signature, a refused challenge and a refused signature open nothing and are not remembered', async () => {
    const { api: a1, sent: s1 } = fakeApi({ ...ok });
    const rejected = await walletSession(a1, {
      sign: fakeWallet(async () => ({ status: 'rejected' })).sign,
      address: ADDR,
    });
    expect(rejected).toEqual({ ok: false, kind: 'rejected' });
    expect(s1.map((s) => s.procedure)).toEqual(['walletSession.challenge']);

    const { api: a2 } = fakeApi({
      'walletSession.challenge': () => ({ ok: false, reason: 'error', message: 'x', code: 'protocol.wallet_session_unset' }),
    });
    expect(await walletSession(a2, { sign: fakeWallet().sign, address: ADDR })).toMatchObject({
      ok: false,
      kind: 'refused',
      code: 'protocol.wallet_session_unset',
    });

    const { api: a3 } = fakeApi({
      ...ok,
      'walletSession.open': () => ({ ok: false, reason: 'forbidden', message: 'x', code: 'protocol.wallet_signature_not_owner' }),
    });
    const { sign, asked } = fakeWallet();
    expect(await walletSession(a3, { sign, address: ADDR })).toMatchObject({ code: 'protocol.wallet_signature_not_owner' });
    await walletSession(a3, { sign, address: ADDR });
    expect(asked).toHaveLength(2);
  });
});

describe('address book words and routes', () => {
  it('names every refusal in plain words and never shows the service’s prose', () => {
    const refused = (code: string | undefined, message = 'protocol.x: service prose') =>
      bookMessage(t, { ok: false, kind: 'refused', code, message });
    expect(bookMessage(t, { ok: false, kind: 'rejected' })).toBe(t('bookRejected'));
    expect(bookMessage(t, { ok: false, kind: 'no_wallet' })).toBe(t('needsWallet'));
    expect(refused('protocol.wallet_session_unset')).toBe(t('bookUnset'));
    expect(refused('protocol.wallet_session_invalid')).toBe(t('bookSessionEnded'));
    expect(refused('protocol.contact_duplicate')).toBe(t('bookRefused_contact_duplicate'));
    expect(refused('protocol.address_book_max_contacts_unset')).toBe(t('bookRefused_address_book_max_contacts_unset'));
    expect(refused('protocol.contact_label_invalid')).toMatch(/1 to 64 characters/);
    expect(refused('protocol.something_new')).toBe(t('bookFailed'));
    expect(refused('edge.geo_blocked')).toBe(t('permitRefused_region'));
    // A wallet-side failure has its own words; a refusal with no code shows no prose of anyone's.
    expect(bookMessage(t, { ok: false, kind: 'wallet', reason: 'chain_mismatch' })).toBe(t('signWrongNetwork'));
    expect(bookMessage(t, { ok: false, kind: 'wallet', reason: 'other' })).toBe(t('bookFailed'));
    expect(refused(undefined, 'raw transport text')).toBe(t('bookFailed'));
  });

  it('opens the address book at its own path and a group under it', () => {
    expect(matchWeb3Route('/wallet/address-book')?.route.wallet).toBe('addressBook');
    const id = '00000000-0000-4000-8000-000000000001';
    expect(walletGroupPath(id)).toBe(`/wallet/groups/${id}`);
    const found = matchWeb3Route(walletGroupPath(id));
    expect(found?.route.walletGroup).toBe(true);
    expect(found?.params).toEqual({ groupId: id });
  });
});
