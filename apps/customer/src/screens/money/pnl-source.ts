/** `tax.lotBook`: the caller's own lots and sales, built from their ledger, and their saved cost-basis choices. */
import { useCallback, useMemo } from 'react';
import { useDataEnv, useSource, type Loadable } from '../../data';
import { constantSource } from '../../data/source';
import {
  LOT_METHODS,
  basisWriteResultSchema,
  lotBookSchema,
  lotChoiceSavedSchema,
  missingBasisSchema,
  type LotBook,
  type LotMethod,
  type MissingBasis,
} from './pnl-model';
import { pnlOverTimeSchema, type PnlOverTime } from './pnl-time-model';
import { BANK_VALUE_HISTORY_UNAVAILABLE, VALUE_PRICES_DOWN, bankValueOverTimeSchema, type BankValueOverTime } from './value-time-model';

const LOT_BOOK_INTERVAL = 60_000;

/** What the link asks for: the saved choices, a preview of one method, or `null` for a method the service does not offer. */
export type LotBookAsk = LotMethod | 'saved' | null;

const bookKey = (userId: string, ask: LotMethod | 'saved') => `tax-lot-book:${userId}:${ask}`;
const missingKey = (userId: string, ask: LotMethod | 'saved') => `tax-missing-basis:${userId}:${ask}`;
/** Every over-time read asked for in this tab, so a saved choice or price reads each of them again. */
const pnlKeys = new Set<string>();
const PNL_KEYS_KEPT = 8;
const refreshPnl = (env: ReturnType<typeof useDataEnv>) => {
  for (const key of pnlKeys) env.poller.refresh(key);
};
const askInput = (ask: LotMethod | 'saved') => (ask === 'saved' ? {} : { method: ask });

/** `null`: nothing is asked (the service refuses it too), and the screen says so. */
export function useLotBook(method: LotBookAsk): Loadable<LotBook> {
  const env = useDataEnv();
  return useSource(
    useMemo(
      () =>
        method === null
          ? constantSource<LotBook>({ status: 'refused', code: 'tax.lot_method_required' })
          : env.userId
            ? env.poller.source<LotBook>(
                bookKey(env.userId, method),
                (signal) => env.api.query('tax', 'lotBook', askInput(method), lotBookSchema, { signal }),
                { intervalMs: LOT_BOOK_INTERVAL },
              )
            : constantSource<LotBook>({ status: 'refused', code: 'auth.required' }),
      [env, method],
    ),
  );
}

/** `tax.missingBasis`: the open lots and the parts of sales that have no cost, for the same method as the book. */
export function useMissingBasis(method: LotBookAsk): Loadable<MissingBasis> {
  const env = useDataEnv();
  return useSource(
    useMemo(
      () =>
        method === null
          ? constantSource<MissingBasis>({ status: 'refused', code: 'tax.lot_method_required' })
          : env.userId
            ? env.poller.source<MissingBasis>(
                missingKey(env.userId, method),
                (signal) => env.api.query('tax', 'missingBasis', askInput(method), missingBasisSchema, { signal }),
                { intervalMs: LOT_BOOK_INTERVAL },
              )
            : constantSource<MissingBasis>({ status: 'refused', code: 'auth.required' }),
      [env, method],
    ),
  );
}

/**
 * `tax.pnlOverTime`: the cumulative result over a range and its breakdown, under the saved choices. `null`: nothing to
 * ask (the room says why).
 */
export function usePnlOverTime(ask: { from: string; to?: string; utcOffsetMinutes: number } | null): Loadable<PnlOverTime> {
  const env = useDataEnv();
  const from = ask?.from;
  const to = ask?.to;
  const offset = ask?.utcOffsetMinutes;
  return useSource(
    useMemo(() => {
      if (from === undefined || offset === undefined) return constantSource<PnlOverTime>({ status: 'empty' });
      if (!env.userId) return constantSource<PnlOverTime>({ status: 'refused', code: 'auth.required' });
      const key = `tax-pnl-over-time:${env.userId}:${from}:${to ?? 'now'}:${offset}`;
      // The newest few ranges only: an older one is read again when it is opened again.
      pnlKeys.delete(key);
      pnlKeys.add(key);
      if (pnlKeys.size > PNL_KEYS_KEPT) pnlKeys.delete(pnlKeys.values().next().value!);
      const input = { from, ...(to === undefined ? {} : { to }), utcOffsetMinutes: offset };
      return env.poller.source<PnlOverTime>(key, (signal) => env.api.query('tax', 'pnlOverTime', input, pnlOverTimeSchema, { signal }), {
        intervalMs: LOT_BOOK_INTERVAL,
      });
    }, [env, from, to, offset]),
  );
}

/** The bank's own answers that it cannot read now: they arrive as a 503, which the poller would read as a broken link. */
const VALUE_DOWN = [VALUE_PRICES_DOWN, BANK_VALUE_HISTORY_UNAVAILABLE];
/** A range that ended before now cannot change but by a late posting, so it is read again rarely. */
const PAST_RANGE_INTERVAL = 15 * 60_000;

/**
 * `bank.portfolio.valueOverTime`: what the caller's main account and Spaces were worth over a range, and the
 * change-in-value bridge. `null`: nothing to ask (the room says why).
 */
export function useValueOverTime(ask: { from: string; to?: string } | null): Loadable<BankValueOverTime> {
  const env = useDataEnv();
  const from = ask?.from;
  const to = ask?.to;
  return useSource(
    useMemo(() => {
      if (from === undefined) return constantSource<BankValueOverTime>({ status: 'empty' });
      if (!env.userId) return constantSource<BankValueOverTime>({ status: 'refused', code: 'auth.required' });
      const input = { from, ...(to === undefined ? {} : { to }) };
      return env.poller.source<BankValueOverTime>(
        `bank-value-over-time:${env.userId}:${from}:${to ?? 'now'}`,
        async (signal) => {
          const result = await env.api.query('bank', 'portfolio.valueOverTime', input, bankValueOverTimeSchema, { signal });
          if (result.ok) return result;
          const down = VALUE_DOWN.find((code) => result.code === code || result.message.includes(code));
          return down ? { ok: false, reason: result.reason, code: down, status: 409 } : result;
        },
        { intervalMs: to !== undefined && Date.parse(to) <= Date.now() ? PAST_RANGE_INTERVAL : LOT_BOOK_INTERVAL },
      );
    }, [env, from, to]),
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
      for (const each of [...LOT_METHODS, 'saved' as const]) {
        env.poller.refresh(bookKey(env.userId, each));
        env.poller.refresh(missingKey(env.userId, each));
      }
      refreshPnl(env);
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

export type LotChoice =
  | { procedure: 'setLotMethod'; input: { assetId: string | null; method: LotMethod | null } }
  | { procedure: 'setDayMethod'; input: { day: string; assetId: string | null; method: LotMethod | null } }
  | { procedure: 'pickSaleLot'; input: { saleTxId: string; assetId: string; lotId: string | null } }
  | { procedure: 'setIncludeTransfers'; input: { include: boolean | null } };

/**
 * Saves one cost-basis choice, then reads the saved book and its missing list again. Settings only: nothing moves. An
 * `uncertain` answer may have been stored, so the book is read again for it too. Whether transfers count changes the book
 * under every method, so that one reads every method's book again.
 */
export function useSaveLotChoice(): (choice: LotChoice) => Promise<BasisOutcome> {
  const env = useDataEnv();
  return useCallback(
    async (choice) => {
      const result = await env.api.mutate('tax', choice.procedure, choice.input, lotChoiceSavedSchema);
      const unsure = !result.ok && result.reason === 'uncertain';
      if ((result.ok || unsure) && env.userId) {
        for (const each of choice.procedure === 'setIncludeTransfers' ? [...LOT_METHODS, 'saved' as const] : ['saved' as const]) {
          env.poller.refresh(bookKey(env.userId, each));
          env.poller.refresh(missingKey(env.userId, each));
        }
        refreshPnl(env);
      }
      return result.ok ? { ok: true } : { ok: false, code: result.code ?? result.reason, unsure };
    },
    [env],
  );
}
