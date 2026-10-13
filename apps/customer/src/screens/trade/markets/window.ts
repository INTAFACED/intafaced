import type { Preferences } from '../../../shared/preferences';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * When this ticker's "24h" figures cover only part of a day (a market younger than 24 hours), the epoch ms they start
 * at; else null. The column headers always say "24h" (true for every older market); a young market's own row carries
 * a "since 19:29" mark, so one new listing never relabels the figures of the rest (review M2).
 */
export function partialWindowStart(ticker: { windowStart: number | null } | undefined, nowMs: number): number | null {
  const start = ticker?.windowStart ?? null;
  return start !== null && start > nowMs - DAY_MS ? start : null;
}

/** "19:29" in the person's zone (named when it is not the device's own, as the desk ticker does). */
export function sinceLabel(at: number, zone: Preferences['timeZone']): string {
  const name = zone === 'UTC' ? 'UTC' : zone === 'UTC+8' ? 'Etc/GMT-8' : undefined;
  const text = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: name }).format(at);
  return zone === 'device' ? text : `${text} ${zone}`;
}
