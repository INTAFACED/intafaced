import { useCallback, useMemo } from 'react';
import { ADDRESS_BOOK_LABEL_MAX, WALLET_GROUP_NAME_MAX } from '@intafaced/contracts/protocol-address-book';
import type { ApiResult } from '../../../shared/api';
import { useApi } from '../../session/session';
import { REGION_BLOCKED_CODE } from '../region';
import { createAddressBookApi, forgetWalletSession, walletSession, type AddressBookApi, type SessionResult } from './address-book-api';
import type { walletCopy } from './copy';
import { useWallet } from './WalletProvider';

export type BookFailure = Exclude<SessionResult, { ok: true }> | { ok: false; kind: 'no_wallet' };
export type BookOutcome<T> = { ok: true; data: T } | BookFailure;

/**
 * Runs one address book call with this wallet's session, opening one (one signature) when there is none. A session the
 * service no longer accepts is forgotten and opened again once.
 */
export function useAddressBook() {
  const wallet = useWallet();
  const transport = useApi();
  const api: AddressBookApi = useMemo(() => createAddressBookApi(transport), [transport]);
  const provider = wallet.status === 'connected' ? wallet.connected?.provider : undefined;
  const address = wallet.status === 'connected' ? wallet.address : null;

  const run = useCallback(
    async <T>(work: (api: AddressBookApi, session: string) => Promise<ApiResult<T>>): Promise<BookOutcome<T>> => {
      if (!provider || !address) return { ok: false, kind: 'no_wallet' };
      for (let attempt = 0; ; attempt++) {
        const session = await walletSession(api, { provider, address });
        if (!session.ok) return session;
        const result = await work(api, session.token);
        if (result.ok) return { ok: true, data: result.data };
        if (result.code === 'protocol.wallet_session_invalid' && attempt === 0) {
          forgetWalletSession(address);
          continue;
        }
        return { ok: false, kind: 'refused', code: result.code, message: result.message };
      }
    },
    [api, provider, address],
  );
  return { run, address };
}

type T = ReturnType<typeof walletCopy.forLocale>['t'];
const BOOK_CODES = new Set([
  'contact_address_invalid',
  'contact_duplicate',
  'contact_self',
  'address_book_full',
  'address_book_max_contacts_unset',
  'contact_not_found',
  'group_name_duplicate',
  'group_members_empty',
  'group_member_unknown',
  'wallet_groups_full',
  'wallet_groups_max_unset',
  'group_not_found',
] as const);
type BookCode = typeof BOOK_CODES extends Set<infer C> ? C : never;

/** Plain words for a failed address book call. A service's own prose is never shown; an unknown refusal says nothing changed. */
export function bookMessage(t: T, failure: BookFailure): string {
  if (failure.kind === 'no_wallet') return t('needsWallet');
  if (failure.kind === 'rejected') return t('bookRejected');
  if (failure.kind === 'wallet') return failure.reason === 'chain_mismatch' ? t('signWrongNetwork') : t('bookFailed');
  const code = failure.code;
  if (code === undefined) return t('bookFailed');
  if (code === REGION_BLOCKED_CODE) return t('permitRefused_region');
  if (code === 'protocol.wallet_session_unset') return t('bookUnset');
  if (code === 'protocol.wallet_session_origin_unlisted') return t('bookOriginUnlisted');
  if (code === 'protocol.wallet_signature_not_owner') return t('bookSignatureNotOwner');
  if (code === 'protocol.wallet_session_invalid' || code === 'protocol.wallet_challenge_invalid') return t('bookSessionEnded');
  if (code === 'protocol.contact_label_invalid') return t('bookRefused_contact_label_invalid', { max: String(ADDRESS_BOOK_LABEL_MAX) });
  if (code === 'protocol.group_name_invalid') return t('bookRefused_group_name_invalid', { max: String(WALLET_GROUP_NAME_MAX) });
  const suffix = code.startsWith('protocol.') ? code.slice('protocol.'.length) : '';
  if (BOOK_CODES.has(suffix as BookCode)) return t(`bookRefused_${suffix as BookCode}`);
  return t('bookFailed');
}
