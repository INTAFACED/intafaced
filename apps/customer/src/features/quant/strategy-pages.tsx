import { useEffect, useState } from 'react';
import type { ZodType } from 'zod';
import type { ApiResult } from '../../shared/api';
import { useResource } from '../../shared/resource';
import { Button, Failure, Loading } from '../../shared/ui';
import { useApi } from '../session/session';
import { studioCopy } from './studio-copy';

/** How many saved strategies a list reads at once. A page size of these screens, not a product limit. */
export const STRATEGY_PAGE = 20;

type Failed = Extract<ApiResult<unknown>, { ok: false }>;
type Page<T> = { strategies: T[]; nextCursor: string | null };

/**
 * One list of saved strategies, a page at a time: the first read, then Show more reads the next page with the cursor
 * the service gave. Studio, the Algo dev home and the strategy list all page the same way.
 */
export function useStrategyPages<T>(procedure: 'studio.list' | 'studio.listDeleted', schema: ZodType<Page<T>>, reloadKey: string) {
  const api = useApi();
  const first = useResource(
    (signal) => api.query('quant', procedure, { limit: STRATEGY_PAGE }, schema, { signal }),
    `quant-${procedure}:${reloadKey}`,
  );
  const [later, setLater] = useState<{ rows: T[]; cursor: string | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failed | null>(null);
  useEffect(() => {
    setLater(null);
    setFailure(null);
  }, [first.resource]);
  async function more(cursor: string) {
    setBusy(true);
    setFailure(null);
    const res = await api.query('quant', procedure, { limit: STRATEGY_PAGE, cursor }, schema);
    setBusy(false);
    if (res.ok) setLater((prev) => ({ rows: [...(prev?.rows ?? []), ...res.data.strategies], cursor: res.data.nextCursor }));
    else setFailure(res);
  }
  /** Every row read so far and the cursor of the next page, once the first page has answered. */
  const rowsOf = (data: Page<T>) => ({
    rows: [...data.strategies, ...(later?.rows ?? [])],
    cursor: later ? later.cursor : data.nextCursor,
  });
  return { first, rowsOf, busy, failure, more };
}

/** Show more, its loading state and its refusal, under a list that has a next page. */
export function MorePages(props: { cursor: string | null; busy: boolean; failure: Failed | null; more: (cursor: string) => void }) {
  const { t } = studioCopy.useCopy();
  const { cursor } = props;
  return (
    <>
      {props.busy && <Loading />}
      {props.failure && <Failure result={props.failure} retry={() => cursor && props.more(cursor)} />}
      {cursor && !props.busy && (
        <Button variant="secondary" onClick={() => props.more(cursor)}>
          {t('showMore')}
        </Button>
      )}
    </>
  );
}
