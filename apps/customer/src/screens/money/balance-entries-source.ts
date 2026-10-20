import { useCallback, useEffect, useRef, useState } from 'react';
import { useSession } from '../../features/session/session';
import { classifyFailure } from '../../data/poll';
import { BALANCE_ENTRIES_PAGE, balanceEntriesSchema, type BalanceEntriesPage, type BalanceEntryRow } from './balance-entries-model';

const MISMATCH = 'portfolio.entries_do_not_sum';

/** The bank's sentence naming the gap, without the trailing code. Null if it does not look like one: nothing is made up. */
export function gapSentence(message: string): string | null {
  const text = message.replace(/\s*\(portfolio\.entries_do_not_sum\)\s*$/, '').trim();
  return /^The entries add up to .+ a gap of \S+$/.test(text) ? text : null;
}

export type BalanceEntriesState =
  | { status: 'loading' }
  | { status: 'refused'; code: string; /** The bank's own sentence when it carries the gap, else null. */ detail: string | null }
  | { status: 'error'; retry: () => void }
  | {
      status: 'ready';
      rows: BalanceEntryRow[];
      check: BalanceEntriesPage['sumCheck'];
      hasMore: boolean;
      loadingMore: boolean;
      moreFailed: boolean;
      loadMore: () => void;
    };

/**
 * `bank.portfolio.balanceEntries` for one coin, newest first, one more page each time `loadMore` is called. The bank checks the
 * whole history against the live balance on every page, so a page that arrives has passed the check; one that does not is a
 * refusal and no list. Never polls: a list that moves under the reader's finger helps nobody.
 */
export function useBalanceEntries(assetId: string, accountId: string | null): BalanceEntriesState {
  const { api, userId } = useSession();
  const [state, setState] = useState<BalanceEntriesState>({ status: 'loading' });
  const cursor = useRef<string | null>(null);
  const busy = useRef(false);
  const alive = useRef(0);
  const loadMoreRef = useRef<() => void>(() => undefined);
  const startRef = useRef<() => void>(() => undefined);

  const load = useCallback(
    async (next: string | null, token: number) => {
      const result = await api.query(
        'bank',
        'portfolio.balanceEntries',
        { assetId, limit: BALANCE_ENTRIES_PAGE, ...(accountId ? { accountId } : {}), ...(next ? { cursor: next } : {}) },
        balanceEntriesSchema,
      );
      if (token !== alive.current) return;
      busy.current = false;
      if (result.ok) {
        cursor.current = result.data.nextCursor;
        setState((prev) => {
          const seen = new Set(
            prev.status === 'ready' && next ? prev.rows.map((r) => `${r.accountId}:${r.txId}:${r.entryId ?? r.direction + r.amount}`) : [],
          );
          const fresh = result.data.entries.filter((r) => !seen.has(`${r.accountId}:${r.txId}:${r.entryId ?? r.direction + r.amount}`));
          return {
            status: 'ready',
            rows: prev.status === 'ready' && next ? [...prev.rows, ...fresh] : fresh,
            check: result.data.sumCheck,
            hasMore: result.data.nextCursor !== null,
            loadingMore: false,
            moreFailed: false,
            loadMore: () => loadMoreRef.current(),
          };
        });
        return;
      }
      if (next) {
        setState((prev) => (prev.status === 'ready' ? { ...prev, loadingMore: false, moreFailed: true } : prev));
        return;
      }
      const failure = classifyFailure(result);
      setState(
        failure.kind === 'refused'
          ? { status: 'refused', code: failure.code, detail: failure.code === MISMATCH ? gapSentence(result.message) : null }
          : { status: 'error', retry: () => startRef.current() },
      );
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [api, assetId, accountId],
  );

  const loadMore = useCallback(() => {
    if (busy.current || cursor.current === null) return;
    busy.current = true;
    setState((prev) => (prev.status === 'ready' ? { ...prev, loadingMore: true, moreFailed: false } : prev));
    void load(cursor.current, alive.current);
  }, [load]);
  loadMoreRef.current = loadMore;

  const start = useCallback(() => {
    alive.current += 1;
    cursor.current = null;
    busy.current = true;
    setState({ status: 'loading' });
    void load(null, alive.current);
  }, [load]);
  startRef.current = start;

  useEffect(() => {
    start();
    return () => {
      alive.current += 1;
    };
  }, [start, userId]);

  return state;
}
