/** `tax.lotBook`: the caller's own open lots and sales, built from their trade fills. Read-only. */
import { useMemo } from 'react';
import { useDataEnv, useSource, type Loadable } from '../../data';
import { constantSource } from '../../data/source';
import { lotBookSchema, type LotBook, type LotMethod } from './pnl-model';

const LOT_BOOK_INTERVAL = 60_000;

export function useLotBook(method: LotMethod): Loadable<LotBook> {
  const env = useDataEnv();
  return useSource(
    useMemo(
      () =>
        env.userId
          ? env.poller.source<LotBook>(
              `tax-lot-book:${env.userId}:${method}`,
              (signal) => env.api.query('tax', 'lotBook', { method }, lotBookSchema, { signal }),
              { intervalMs: LOT_BOOK_INTERVAL },
            )
          : constantSource<LotBook>({ status: 'refused', code: 'auth.required' }),
      [env, method],
    ),
  );
}
