/**
 * Two facts the shared markets read does not carry, taken from the same `/markets` listing: a market that belongs
 * in its own group (FX pairs: `degrade.separateFromSpot`) and whether its trading session is open. Read here, with
 * a loose schema, so a field the service adds or drops never breaks the Markets screen: if this read fails the
 * list falls back to showing a closed market as "Paused" and every market in Spot.
 */
import { useMemo } from 'react';
import { z } from 'zod';
import { useDataEnv, useSource } from './deps';
import type { Loadable } from './deps';
import { ianaZone } from './window';
import type { Preferences } from '../../../shared/preferences';

export interface ListingStatus {
  separateFromSpot: boolean;
  sessionOpen: boolean | null;
  /** Epoch ms the session next opens, or null when it is not about to open (or not known). */
  opensAt: number | null;
}
export type ListingStatusMap = Readonly<Record<string, ListingStatus>>;

const listingStatusSchema = z
  .object({
    symbol: z.string(),
    sessionOpen: z.boolean().nullish(),
    nextSessionChange: z.object({ open: z.boolean(), timestamp: z.number() }).passthrough().nullish(),
    degrade: z.object({ separateFromSpot: z.boolean().nullish() }).passthrough().nullish(),
  })
  .passthrough();
type ListingRow = z.infer<typeof listingStatusSchema>;

export const STATUS_INTERVAL_MS = 300_000;

export function toStatusMap(rows: readonly ListingRow[]): ListingStatusMap {
  const map: Record<string, ListingStatus> = {};
  for (const row of rows) {
    const change = row.nextSessionChange;
    map[row.symbol] = {
      separateFromSpot: row.degrade?.separateFromSpot === true,
      sessionOpen: row.sessionOpen ?? null,
      opensAt: change && change.open ? change.timestamp : null,
    };
  }
  return map;
}

/** The status of every listed market, or null while it loads or if the read failed (callers then use the plain behaviour). */
export function useListingStatus(): ListingStatusMap | null {
  const env = useDataEnv();
  const source = useMemo(
    () =>
      env.poller.source<ListingStatusMap>(
        'markets-status',
        async (signal) => {
          const result = await env.api.rest('/markets', z.array(listingStatusSchema), { query: { limit: 500 }, signal });
          return result.ok ? { ok: true, data: toStatusMap(result.data) } : result;
        },
        { intervalMs: STATUS_INTERVAL_MS },
      ),
    [env],
  );
  const read: Loadable<ListingStatusMap> = useSource(source);
  return read.status === 'ready' ? read.data : null;
}

/** Rows that belong in their own group, not in the Spot list. */
export const isSeparateFromSpot = (status: ListingStatusMap | null, symbol: string) => status?.[symbol]?.separateFromSpot === true;

export type RowStatus = { kind: 'open' } | { kind: 'paused' } | { kind: 'closed'; opensAt: number | null };

/** What a row's status badge says. Only a market that is not orderable can read Closed: its session is shut. */
export function rowStatus(orderable: boolean, status: ListingStatus | undefined): RowStatus {
  if (orderable) return { kind: 'open' };
  if (status && status.sessionOpen === false) return { kind: 'closed', opensAt: status.opensAt };
  return { kind: 'paused' };
}

/** "Mon 9:30 AM" in the person's zone (named when it is not the device's own). */
export function opensLabel(at: number, zone: Preferences['timeZone']): string {
  const text = new Intl.DateTimeFormat('en-US', {
    weekday: 'short',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: ianaZone(zone),
  }).format(at);
  return zone === 'device' ? text : `${text} ${zone}`;
}
