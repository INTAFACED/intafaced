/**
 * "As of" and lag wording. Every metric on these pages says when it was
 * projected; a figure whose freshness is unknown is never painted as live.
 */

export interface Freshness {
  readonly asOf: string | null;
  readonly lagSeconds: number | null;
}

/** Display threshold for the stale banner. A UI label only; no money rule depends on it. */
export const STALE_AFTER_SECONDS = 300;

/** "2026-10-15 10:02:03 UTC", or "unknown". Pure: UTC, no locale. */
export function formatUtc(iso: string | null): string {
  if (iso === null) return 'unknown';
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return 'unknown';
  return `${new Date(ms).toISOString().slice(0, 19).replace('T', ' ')} UTC`;
}

export function formatLag(seconds: number | null): string {
  if (seconds === null) return 'lag unknown';
  if (seconds < 60) return `lag ${seconds} s`;
  if (seconds < 3600) return `lag ${Math.floor(seconds / 60)} min ${seconds % 60} s`;
  return `lag ${Math.floor(seconds / 3600)} h ${Math.floor((seconds % 3600) / 60)} min`;
}

export type FreshnessState = 'live' | 'stale' | 'unknown';

export interface FreshnessView {
  readonly state: FreshnessState;
  readonly asOf: string;
  readonly lag: string;
  readonly sentence: string;
}

export function describeFreshness(freshness: Freshness): FreshnessView {
  const asOf = formatUtc(freshness.asOf);
  const lag = formatLag(freshness.lagSeconds);
  const unknown = freshness.asOf === null || freshness.lagSeconds === null;
  const state: FreshnessState = unknown ? 'unknown' : freshness.lagSeconds! > STALE_AFTER_SECONDS ? 'stale' : 'live';
  const sentence =
    state === 'unknown'
      ? `As of ${asOf}, ${lag}. How fresh this is has not been measured, so it is not shown as live.`
      : state === 'stale'
        ? `As of ${asOf}, ${lag}. This is older than ${STALE_AFTER_SECONDS / 60} minutes.`
        : `As of ${asOf}, ${lag}.`;
  return { state, asOf, lag, sentence };
}

/** Oldest known freshness across several reads, so a page never claims to be fresher than its stalest number. */
export function stalestFreshness(list: readonly Freshness[]): Freshness {
  if (list.length === 0) return { asOf: null, lagSeconds: null };
  if (list.some((f) => f.asOf === null || f.lagSeconds === null)) return { asOf: null, lagSeconds: null };
  const oldest = list.reduce((a, b) => (Date.parse(a.asOf!) <= Date.parse(b.asOf!) ? a : b));
  const lag = Math.max(...list.map((f) => f.lagSeconds!));
  return { asOf: oldest.asOf, lagSeconds: lag };
}
