/** `tax.lotBook`: the caller's own open lots and sales, built from their trade fills. Read-only. */
import { useMemo } from 'react';
import { useDataEnv, useSource, type Loadable } from '../../data';
import { constantSource } from '../../data/source';
import {
  LOT_METHODS,
  basisWriteResultSchema,
  lotBookSchema,
  missingBasisSchema,
  type LotBook,
  type LotMethod,
  type MissingBasis,
} from './pnl-model';

const LOT_BOOK_INTERVAL = 60_000;

const bookKey = (userId: string, method: LotMethod) => `tax-lot-book:${userId}:${method}`;
const missingKey = (userId: string, method: LotMethod) => `tax-missing-basis:${userId}:${method}`;

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
                bookKey(env.userId, method),
                (signal) => env.api.query('tax', 'lotBook', { method }, lotBookSchema, { signal }),
                { intervalMs: LOT_BOOK_INTERVAL },
              )
            : constantSource<LotBook>({ status: 'refused', code: 'auth.required' }),
      [env, method],
    ),
  );
}

/** `tax.missingBasis`: the open lots and the parts of sales that have no cost, for the same method as the book. */
export function useMissingBasis(method: LotMethod | null): Loadable<MissingBasis> {
  const env = useDataEnv();
  return useSource(
    useMemo(
      () =>
        method === null
          ? constantSource<MissingBasis>({ status: 'refused', code: 'tax.lot_method_required' })
          : env.userId
            ? env.poller.source<MissingBasis>(
                missingKey(env.userId, method),
                (signal) => env.api.query('tax', 'missingBasis', { method }, missingBasisSchema, { signal }),
                { intervalMs: LOT_BOOK_INTERVAL },
              )
            : constantSource<MissingBasis>({ status: 'refused', code: 'auth.required' }),
      [env, method],
    ),
  );
}

/** `unsure`: the write may have been stored (a timeout or a server error after sending); the book is read again either way. */
export type BasisOutcome = { ok: true } | { ok: false; code: string; unsure: boolean };

/**
 * A price the customer enters for one of their lots with no cost (`tax.basisOverride.set`), or its removal
 * (`tax.basisOverride.remove`). Neither touches a balance. After either, the book and the missing list are read again.
 */
export function useBasisOverride(): {
  set: (input: { lotId: string; pricePerUnit: string; date: string; sourceNote: string }) => Promise<BasisOutcome>;
  remove: (lotId: string) => Promise<BasisOutcome>;
} {
  const env = useDataEnv();
  return useMemo(() => {
    // A price changes the book under every method, so every method's book and missing list is read again.
    const reread = () => {
      if (!env.userId) return;
      for (const each of LOT_METHODS) {
        env.poller.refresh(bookKey(env.userId, each));
        env.poller.refresh(missingKey(env.userId, each));
      }
    };
    const done = (result: { ok: true } | { ok: false; code?: string; reason: string }): BasisOutcome => {
      if (!result.ok) {
        const unsure = result.reason === 'uncertain';
        if (unsure) reread();
        return { ok: false, code: result.code ?? result.reason, unsure };
      }
      reread();
      return { ok: true };
    };
    return {
      set: async (input) => done(await env.api.mutate('tax', 'basisOverride.set', input, basisWriteResultSchema)),
      remove: async (lotId) => done(await env.api.mutate('tax', 'basisOverride.remove', { lotId }, basisWriteResultSchema)),
    };
  }, [env]);
}
