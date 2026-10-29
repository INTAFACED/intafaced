import { useCallback, useEffect, useRef, useState } from 'react';
import { z, type ZodType } from 'zod';
import {
  ADDRESS_WATCHES_NAMESPACE,
  addressWatchesPreferenceSchema,
  protocolWatchRequestId,
  TOKEN_WATCHLIST_NAMESPACE,
  tokenWatchlistPreferenceSchema,
  type AddressWatch,
} from '@intafaced/contracts/protocol-watch-preferences';
import { useSession } from '../../session/session';
import type { ApiResult } from '../../../shared/api';

type Namespace = typeof TOKEN_WATCHLIST_NAMESPACE | typeof ADDRESS_WATCHES_NAMESPACE;
type Failure = Extract<ApiResult<unknown>, { ok: false }>;

export type AccountList<T> =
  | { status: 'signed-out' }
  | { status: 'loading' }
  | { status: 'failed'; failure: Failure; reload: () => void }
  | { status: 'ready'; items: T[] };
export type ListWrite = { ok: true } | { ok: false; failure: Failure };

const isConflict = (result: Failure) =>
  result.status === 409 || result.code === 'CONFLICT' || result.message.includes('preferences.version_conflict');

/**
 * One of the account's Web3 lists, read and written through the identity preferences door (compare-and-set on `version`).
 * A change is a function of the stored list, so a write that meets another device's newer version reads it and applies the
 * same change once more instead of writing over it. Only the signed-in account's own list is ever read.
 */
function useAccountList<T>(
  namespace: Namespace,
  schema: ZodType<{ version: number; value: T[] | null }>,
  stored: ZodType<{ version: number; value: T[] | null }>,
) {
  const { api, userId } = useSession();
  const [list, setList] = useState<AccountList<T>>(userId ? { status: 'loading' } : { status: 'signed-out' });
  const [revision, setRevision] = useState(0);
  const version = useRef(0);

  const read = useCallback(
    async (signal?: AbortSignal) => api.query('identity', 'preferences.get', { namespace }, schema, { signal }),
    [api, namespace, schema],
  );

  useEffect(() => {
    if (!userId) {
      setList({ status: 'signed-out' });
      return;
    }
    const controller = new AbortController();
    setList({ status: 'loading' });
    void read(controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      if (result.ok) {
        version.current = result.data.version;
        setList({ status: 'ready', items: result.data.value ?? [] });
      } else setList({ status: 'failed', failure: result, reload: () => setRevision((count) => count + 1) });
    });
    return () => controller.abort();
  }, [userId, read, revision]);

  const change = useCallback(
    async (apply: (items: T[]) => T[]): Promise<ListWrite> => {
      if (!userId) return { ok: false, failure: { ok: false, reason: 'unauthorized', message: 'signed out' } };
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const current = await read();
        if (!current.ok) return { ok: false, failure: current };
        const value = apply(current.data.value ?? []);
        const ifVersion = current.data.version;
        const result = await api.mutate(
          'identity',
          'preferences.set',
          { namespace, value, ifVersion, clientRequestId: protocolWatchRequestId(userId, namespace, ifVersion, value) },
          stored,
        );
        if (result.ok) {
          version.current = result.data.version;
          setList({ status: 'ready', items: result.data.value ?? [] });
          return { ok: true };
        }
        if (!isConflict(result)) return { ok: false, failure: result };
      }
      return { ok: false, failure: { ok: false, reason: 'error', message: 'preferences.version_conflict', code: 'CONFLICT' } };
    },
    [api, userId, namespace, read, stored],
  );

  return { list, change };
}

/** The signed-in account's token watchlist (`protocol.token-watchlist`). */
const storedTokens = tokenWatchlistPreferenceSchema.extend({ outcome: z.literal('stored') });
const storedWatches = addressWatchesPreferenceSchema.extend({ outcome: z.literal('stored') });
export const useAccountTokenWatchlist = () =>
  useAccountList<string>(TOKEN_WATCHLIST_NAMESPACE, tokenWatchlistPreferenceSchema, storedTokens);
/** The signed-in account's private address watches (`protocol.address-watches`). */
export const useAccountAddressWatches = () =>
  useAccountList<AddressWatch>(ADDRESS_WATCHES_NAMESPACE, addressWatchesPreferenceSchema, storedWatches);
