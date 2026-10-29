import { useCallback, useEffect, useRef, useState } from 'react';
import { z, type ZodType } from 'zod';
import {
  ADDRESS_WATCHES_NAMESPACE,
  addressWatchesPreferenceSchema,
  protocolWatchRequestId,
  PROTOCOL_WATCH_MAX,
  TOKEN_WATCHLIST_NAMESPACE,
  tokenWatchlistPreferenceSchema,
  type AddressWatch,
} from '@intafaced/contracts/protocol-watch-preferences';
import { useSession } from '../../session/session';
import type { ApiResult } from '../../../shared/api';
import { CONFLICT, rebaseAndWrite, type RecordIo } from '../../watchlists/rebase';

type Namespace = typeof TOKEN_WATCHLIST_NAMESPACE | typeof ADDRESS_WATCHES_NAMESPACE;
type Failure = Extract<ApiResult<unknown>, { ok: false }>;

export type AccountList<T> =
  | { status: 'signed-out' }
  | { status: 'loading' }
  | { status: 'failed'; failure: Failure; reload: () => void }
  | { status: 'ready'; items: T[] };
/**
 * How a change ended: stored; refused before sending because the list would pass its guard; not stored (the account said no,
 * or the newer record could not be read); or unknown, when the reply was lost after sending, so the list was read again and
 * shows what the account now holds.
 */
export type ListWrite = 'saved' | 'full' | 'not-saved' | 'unknown';

const isConflict = (result: Failure) => result.status === 409 || result.code === 'CONFLICT' || result.message.includes(CONFLICT);
/** The request went out and no answer came back: the write may or may not have landed. */
const isUncertain = (result: Failure) => result.reason === 'uncertain' || result.reason === 'unreachable';
const UNKNOWN = 'reply.unknown';

/**
 * One of the account's Web3 lists, read and written through the identity preferences door with compare-and-set on `version`
 * (the same write path as the account's watchlists, `rebaseAndWrite`): a change runs on the list as read, and on a conflict
 * on the newer list once more. Only the signed-in account's own list is ever read.
 */
function useAccountList<T>(
  namespace: Namespace,
  schema: ZodType<{ version: number; value: T[] | null }>,
  stored: ZodType<{ version: number; value: T[] | null }>,
) {
  const { api, userId } = useSession();
  const [list, setList] = useState<AccountList<T>>(userId ? { status: 'loading' } : { status: 'signed-out' });
  const [revision, setRevision] = useState(0);
  const record = useRef<{ version: number; value: T[] } | null>(null);

  const read = useCallback(
    async (signal?: AbortSignal) => api.query('identity', 'preferences.get', { namespace }, schema, { signal }),
    [api, namespace, schema],
  );
  const adopt = useCallback((version: number, value: T[] | null) => {
    record.current = { version, value: value ?? [] };
    setList({ status: 'ready', items: value ?? [] });
  }, []);

  useEffect(() => {
    record.current = null;
    if (!userId) {
      setList({ status: 'signed-out' });
      return;
    }
    const controller = new AbortController();
    setList({ status: 'loading' });
    void read(controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      if (result.ok) adopt(result.data.version, result.data.value);
      else setList({ status: 'failed', failure: result, reload: () => setRevision((count) => count + 1) });
    });
    return () => controller.abort();
  }, [userId, read, adopt, revision]);

  const change = useCallback(
    async (update: (items: T[]) => T[]): Promise<ListWrite> => {
      const start = record.current;
      if (!userId || !start) return 'not-saved';
      if (update(start.value).length > PROTOCOL_WATCH_MAX) return 'full';
      const io: RecordIo<T[]> = {
        read: async () => {
          const result = await read();
          return result.ok ? { version: result.data.version, value: result.data.value } : null;
        },
        write: async (value, ifVersion) => {
          const result = await api.mutate(
            'identity',
            'preferences.set',
            { namespace, value, ifVersion, clientRequestId: protocolWatchRequestId(userId, namespace, ifVersion, value) },
            stored,
          );
          if (result.ok) return { ok: true, version: result.data.version, value: result.data.value };
          return { ok: false, code: isConflict(result) ? CONFLICT : isUncertain(result) ? UNKNOWN : (result.code ?? result.message) };
        },
      };
      const written = await rebaseAndWrite(start, io, update, []);
      if (written.record) adopt(written.record.version, written.record.value);
      if (written.outcome.ok) return 'saved';
      if (written.outcome.code === UNKNOWN) {
        const latest = await io.read();
        if (latest) adopt(latest.version, latest.value);
        return 'unknown';
      }
      return 'not-saved';
    },
    [api, userId, namespace, read, stored, adopt],
  );

  return { list, change };
}

const storedTokens = tokenWatchlistPreferenceSchema.extend({ outcome: z.literal('stored') });
const storedWatches = addressWatchesPreferenceSchema.extend({ outcome: z.literal('stored') });
/** The signed-in account's token watchlist (`protocol.token-watchlist`). */
export const useAccountTokenWatchlist = () =>
  useAccountList<string>(TOKEN_WATCHLIST_NAMESPACE, tokenWatchlistPreferenceSchema, storedTokens);
/** The signed-in account's private address watches (`protocol.address-watches`). */
export const useAccountAddressWatches = () =>
  useAccountList<AddressWatch>(ADDRESS_WATCHES_NAMESPACE, addressWatchesPreferenceSchema, storedWatches);
