import type { Preferences } from '../../../shared/preferences';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * When the "24h" figures of these tickers only cover part of a day (a market younger than 24 hours), the time they start
 * at: the latest start among them, so "since 19:29" is true of every row. Null when every window is a full day, and the
 * columns then say "24h". One rule for the markets list, Home Pro and the desk's list, so the same figure never carries
 * two labels (critic M2).
 */
export function sharedWindowStart(tickers: Iterable<{ windowStart: number | null } | undefined>, nowMs: number): number | null {
  let latest: number | null = null;
  for (const ticker of tickers) {
    const start = ticker?.windowStart ?? null;
    if (start === null || start <= nowMs - DAY_MS) continue;
    if (latest === null || start > latest) latest = start;
  }
  return latest;
}

/** "19:29" in the person's zone (named when it is not the device's own, as the desk ticker does). */
export function sinceLabel(at: number, zone: Preferences['timeZone']): string {
  const name = zone === 'UTC' ? 'UTC' : zone === 'UTC+8' ? 'Etc/GMT-8' : undefined;
  const text = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: name }).format(at);
  return zone === 'device' ? text : `${text} ${zone}`;
}
