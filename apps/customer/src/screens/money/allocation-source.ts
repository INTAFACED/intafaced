/**
 * The bank's `bank.portfolio.allocation`: the priced holdings grouped by class (cash, dollar coins, other crypto,
 * commodities, earn, and unclassified for an asset the bank's catalogue does not list) and by where they sit (spendable or
 * locked). Same prices as the total, so the groups add up to it. An older bank without
 * the call, or one that cannot answer, leaves only the by-coin view; the screen says so and never fills the groups itself.
 */
import { useMemo } from 'react';
import { z } from 'zod';
import { useDataEnv, useSource, type Loadable } from '../../data';
import { dec } from '../../data/decimal';
import type { DataEnv } from '../../data/queries';
import { constantSource } from '../../data/source';
import type { Fetcher } from '../../data/poll';

export const allocationSchema = z.object({
  totalValueUsd: z.string(),
  classes: z.array(
    z.object({
      class: z.enum(['fiat', 'stablecoin', 'crypto', 'commodity', 'earn', 'unclassified']),
      valueUsd: z.string(),
      share: z.string(),
      assets: z.array(z.object({ asset: z.string(), valueUsd: z.string(), share: z.string() })),
    }),
  ),
  /** Set when the bank could not work out the classes (its asset list could not be read); `classes` is then empty. */
  classesRefused: z.string().nullable(),
  types: z.array(z.object({ type: z.enum(['available', 'locked']), valueUsd: z.string(), share: z.string() })),
  unpriced: z.array(z.object({ asset: z.string(), amount: z.string(), reason: z.string() })),
  asOf: z.number(),
});

export type ServerAllocation = z.infer<typeof allocationSchema>;

export type AllocationGrouping = 'class' | 'type';

export interface GroupSlice {
  key: string;
  /** Key into the money copy ('Dollar coins', ...), not display text. */
  labelKey: 'Cash' | 'Dollar coins' | 'Other crypto' | 'Commodities' | 'Earn' | 'Unclassified' | 'Spendable' | 'Locked';
  /** Ratio string ("0.5912"). */
  share: string;
  /** The coins in a class, biggest first; empty for a type. */
  assets: string[];
}

const CLASS_LABEL = {
  fiat: 'Cash',
  stablecoin: 'Dollar coins',
  crypto: 'Other crypto',
  commodity: 'Commodities',
  earn: 'Earn',
  unclassified: 'Unclassified',
} as const;
const TYPE_LABEL = { available: 'Spendable', locked: 'Locked' } as const;

/**
 * Slices of the counted total for one grouping, biggest first. A group of nothing is left out. One share that does not parse
 * makes the whole grouping unusable (null): an unknown figure is never shown as a zero.
 */
export function groupSlices(answer: ServerAllocation, by: AllocationGrouping): GroupSlice[] | null {
  const rows =
    by === 'class'
      ? answer.classes.map((row) => ({
          key: row.class,
          labelKey: CLASS_LABEL[row.class],
          share: row.share,
          assets: row.assets.map((member) => member.asset),
        }))
      : answer.types.map((row) => ({ key: row.type, labelKey: TYPE_LABEL[row.type], share: row.share, assets: [] as string[] }));
  if (rows.some((row) => dec(row.share) === null)) return null;
  return rows
    .filter((row) => dec(row.share)! > 0n)
    .sort((a, b) => (dec(a.share)! === dec(b.share)! ? a.key.localeCompare(b.key) : dec(a.share)! > dec(b.share)! ? -1 : 1));
}

export function allocationFetcher(env: DataEnv): Fetcher<ServerAllocation> {
  return (signal) => env.api.query('bank', 'portfolio.allocation', undefined, allocationSchema, { signal });
}

const ALLOCATION_INTERVAL = 30_000;

/** The grouped allocation. Not read until `enabled` (the person asked for a grouping). */
export function useAllocation(enabled: boolean): Loadable<ServerAllocation> {
  const env = useDataEnv();
  return useSource(
    useMemo(
      () =>
        env.userId && enabled
          ? env.poller.source<ServerAllocation>(`bank-allocation:${env.userId}`, allocationFetcher(env), {
              intervalMs: ALLOCATION_INTERVAL,
            })
          : constantSource<ServerAllocation>({ status: 'refused', code: 'auth.required' }),
      [env, enabled],
    ),
  );
}
