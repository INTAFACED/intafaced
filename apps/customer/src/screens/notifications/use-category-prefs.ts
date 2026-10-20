import { useCallback, useEffect, useState } from 'react';
import { useSession } from '../../features/session/session';
import { categoryPrefs, setCategoryPref, type CategoryChannel, type CategoryId, type CategoryPrefRow } from './notify-api';

export type CategoryLoad = { status: 'loading' } | { status: 'failed' } | { status: 'ready'; rows: CategoryPrefRow[] };

export type CategoryWrite = 'saved' | 'locked' | 'failed';

/** Replace the rows the service returned for a write; a cell the service did not return keeps what it had. */
export function mergeRows(current: readonly CategoryPrefRow[], returned: readonly CategoryPrefRow[]): CategoryPrefRow[] {
  return current.map((row) => returned.find((next) => next.category === row.category && next.channel === row.channel) ?? row);
}

/** Read the category-by-channel preferences and write one cell at a time; the service's answer replaces what is shown. */
export function useCategoryPrefs() {
  const { api, userId } = useSession();
  const [load, setLoad] = useState<CategoryLoad>({ status: 'loading' });
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    if (!userId) return;
    const controller = new AbortController();
    void categoryPrefs(api, controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      setLoad(result.ok ? { status: 'ready', rows: result.data } : { status: 'failed' });
    });
    return () => controller.abort();
  }, [api, userId, revision]);
  const reload = useCallback(() => {
    setLoad({ status: 'loading' });
    setRevision((value) => value + 1);
  }, []);
  const set = useCallback(
    async (category: CategoryId, channel: CategoryChannel, enabled: boolean): Promise<CategoryWrite> => {
      const result = await setCategoryPref(api, { category, channel, enabled });
      if (!result.ok) return 'failed';
      setLoad((current) => (current.status === 'ready' ? { status: 'ready', rows: mergeRows(current.rows, result.data.rows) } : current));
      return result.data.locked ? 'locked' : 'saved';
    },
    [api],
  );
  return { load, reload, set };
}
