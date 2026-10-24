import { useMemo } from 'react';
import { bankHoldingsChangeSchema, type BankHoldingsChange } from '@intafaced/contracts/bank-value-history';
import { useDataEnv, useSource, type Loadable } from '../../data';
import { constantSource } from '../../data/source';
import { VALUE_DOWN } from './pnl-source';

/**
 * `bank.portfolio.holdingsChange` (J-portfolio-06 #3): what rose and fell in amount over a range, per coin, from the same
 * replay as the value over time. The range runs from `hours` ago to now.
 */
export type { BankHoldingsChange };

/** The ranges offered: hours back from now, and the copy key of each. */
export const CHANGE_RANGES = [
  { key: '24h', hours: 24, label: 'Change 24h' },
  { key: '7d', hours: 24 * 7, label: 'Change 7d' },
  { key: '30d', hours: 24 * 30, label: 'Change 30d' },
] as const;
export type ChangeRangeKey = (typeof CHANGE_RANGES)[number]['key'];

const CHANGE_INTERVAL = 60_000;

/** The range `hours` back from now, read again on every poll so "7 days ago" stays 7 days while the page is open. */
export function useHoldingsChange(hours: number): Loadable<BankHoldingsChange> {
  const env = useDataEnv();
  return useSource(
    useMemo(() => {
      if (!env.userId) return constantSource<BankHoldingsChange>({ status: 'refused', code: 'auth.required' });
      return env.poller.source<BankHoldingsChange>(
        `bank-holdings-change:${env.userId}:${hours}h`,
        async (signal) => {
          const from = new Date(Date.now() - hours * 3_600_000).toISOString();
          const result = await env.api.query('bank', 'portfolio.holdingsChange', { from }, bankHoldingsChangeSchema, { signal });
          if (result.ok) return result;
          const down = VALUE_DOWN.find((code) => result.code === code || result.message.includes(code));
          return down ? { ok: false, reason: result.reason, code: down, status: 409 } : result;
        },
        { intervalMs: CHANGE_INTERVAL },
      );
    }, [env, hours]),
  );
}
