/** `tax.lotBook`: the caller's own lots and sales, built from their ledger. And their saved cost-basis choices. */
import { useCallback, useMemo } from 'react';
import { useDataEnv, useSource, type Loadable } from '../../data';
import { constantSource } from '../../data/source';
import { lotBookSchema, lotChoiceSavedSchema, type LotBook, type LotMethod } from './pnl-model';

const LOT_BOOK_INTERVAL = 60_000;

/** What the link asks for: the saved choices, a preview of one method, or `null` for a method the service does not offer. */
export type LotBookAsk = LotMethod | 'saved' | null;

const keyOf = (userId: string, ask: LotMethod | 'saved') => `tax-lot-book:${userId}:${ask}`;

/** `null`: nothing is asked (the service refuses it too), and the screen says so. */
export function useLotBook(ask: LotBookAsk): Loadable<LotBook> {
  const env = useDataEnv();
  return useSource(
    useMemo(
      () =>
        ask === null
          ? constantSource<LotBook>({ status: 'refused', code: 'tax.lot_method_required' })
          : env.userId
            ? env.poller.source<LotBook>(
                keyOf(env.userId, ask),
                (signal) => env.api.query('tax', 'lotBook', ask === 'saved' ? {} : { method: ask }, lotBookSchema, { signal }),
                { intervalMs: LOT_BOOK_INTERVAL },
              )
            : constantSource<LotBook>({ status: 'refused', code: 'auth.required' }),
      [env, ask],
    ),
  );
}

export type LotChoice =
  | { procedure: 'setLotMethod'; input: { assetId: string | null; method: LotMethod | null } }
  | { procedure: 'setDayMethod'; input: { day: string; assetId: string | null; method: LotMethod | null } }
  | { procedure: 'pickSaleLot'; input: { saleTxId: string; assetId: string; lotId: string | null } };

/** Saves one cost-basis choice, then reads the saved book again. Settings only: nothing moves. */
export function useSaveLotChoice(): (choice: LotChoice) => Promise<{ ok: true } | { ok: false; code: string }> {
  const env = useDataEnv();
  return useCallback(
    async (choice) => {
      const result = await env.api.mutate('tax', choice.procedure, choice.input, lotChoiceSavedSchema);
      if (!result.ok) return { ok: false, code: result.code ?? result.reason };
      if (env.userId) env.poller.refresh(keyOf(env.userId, 'saved'));
      return { ok: true };
    },
    [env],
  );
}
