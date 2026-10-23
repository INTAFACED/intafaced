/** `tax.lotBook`: the caller's own open lots and sales, built from their trade fills. Read-only. */
import { useMemo } from 'react';
import { useDataEnv, useSource, type Loadable } from '../../data';
import { constantSource } from '../../data/source';
import { lotBookSchema, type LotBook, type LotMethod } from './pnl-model';

const LOT_BOOK_INTERVAL = 60_000;

/** `null` is a method the service does not offer: nothing is asked (the service refuses it too), and the screen says so. */
export function useLotBook(method: LotMethod | null): Loadable<LotBook> {
  const env = useDataEnv();
  return useSource(
    useMemo(
      () =>
        method === null
          ? constantSource<LotBook>({ status: 'refused', code: 'tax.lot_method_required' })
          : env.userId
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
