/** `trade.journal.closedTrades`: the closed perp trades of the person's own venue account, from the journal's record. */
import { useMemo } from 'react';
import {
  TRADE_JOURNAL_CLOSED_TRADES,
  TRADE_JOURNAL_MAX_DAYS,
  TRADE_JOURNAL_MAX_TRADES,
  type TradeJournal,
} from '@intafaced/contracts/trade-journal-procedures';
import { useDataEnv, useSource, type Loadable } from '../../../data';
import { constantSource } from '../../../data/source';

const JOURNAL_INTERVAL = 30_000;
const DAY_MS = 86_400_000;

/** The journal of `owner`'s main venue account over the longest window one read takes; `null` while no wallet is connected. */
export function useTradeJournal(owner: string | null): Loadable<TradeJournal> {
  const env = useDataEnv();
  return useSource(
    useMemo(
      () =>
        owner && env.userId
          ? env.poller.source<TradeJournal>(
              `trade-journal:${env.userId}:${owner}`,
              (signal) =>
                env.api.call(
                  TRADE_JOURNAL_CLOSED_TRADES,
                  {
                    owner,
                    // A minute inside the longest window, so the clock moving between here and the service never refuses it.
                    since: new Date(Date.now() - TRADE_JOURNAL_MAX_DAYS * DAY_MS + 60_000).toISOString(),
                    limit: TRADE_JOURNAL_MAX_TRADES,
                  },
                  { signal },
                ),
              { intervalMs: JOURNAL_INTERVAL },
            )
          : constantSource<TradeJournal>({ status: 'refused', code: 'auth.required' }),
      [env, owner],
    ),
  );
}
