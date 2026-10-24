import { useMemo } from 'react';
import { bankHoldingsChangeSchema, type BankHoldingsChange } from '@intafaced/contracts/bank-value-history';
import { useDataEnv, useSource, type Loadable } from '../../data';
import { constantSource } from '../../data/source';
import { BANK_VALUE_HISTORY_UNAVAILABLE, VALUE_PRICES_DOWN } from './value-time-model';

/**
 * `bank.portfolio.holdingsChange` (J-portfolio-06 #3): what rose and fell in amount over a range, per coin, from the same
 * replay as the value over time. The range runs from `from` to now.
 */
export type { BankHoldingsChange };

/** The ranges offered: hours back from now. */
export const CHANGE_RANGES = [
  { key: '24h', hours: 24 },
  { key: '7d', hours: 24 * 7 },
  { key: '30d', hours: 24 * 30 },
] as const;
export type ChangeRangeKey = (typeof CHANGE_RANGES)[number]['key'];

const CHANGE_INTERVAL = 60_000;
const DOWN = [VALUE_PRICES_DOWN, BANK_VALUE_HISTORY_UNAVAILABLE];

export function useHoldingsChange(from: string): Loadable<BankHoldingsChange> {
  const env = useDataEnv();
  return useSource(
    useMemo(() => {
      if (!env.userId) return constantSource<BankHoldingsChange>({ status: 'refused', code: 'auth.required' });
      return env.poller.source<BankHoldingsChange>(
        `bank-holdings-change:${env.userId}:${from}`,
        async (signal) => {
          const result = await env.api.query('bank', 'portfolio.holdingsChange', { from }, bankHoldingsChangeSchema, { signal });
          if (result.ok) return result;
          // Prices or history the bank cannot read now arrive as a 503: a typed refusal, not a broken connection.
          const down = DOWN.find((code) => result.code === code || result.message.includes(code));
          return down ? { ok: false, reason: result.reason, code: down, status: 409 } : result;
        },
        { intervalMs: CHANGE_INTERVAL },
      );
    }, [env, from]),
  );
}
