'use client';

import * as React from 'react';
import { type AsOf, freshnessOf, msUntilFreshnessChange } from './freshness.js';

/** Longest single wait. A timer this long just re-reads the clock and re-plans, so a sleeping tab or a drifting clock self-corrects. */
const MAX_WAIT_MS = 60_000;

export interface UseFreshnessClockOptions {
  asOf: AsOf;
  /** Epoch ms from the caller. When given, the caller owns the clock: it is returned as is and no timer runs. */
  now?: number;
  staleAfterMs: number | null | undefined;
  refused?: boolean;
  /** False when the caller has a fixed kind or nothing to judge: no timer is scheduled. */
  enabled?: boolean;
}

/**
 * The "now" for a freshness check. With `now` given it returns that. Without it, it keeps its own clock
 * and sets one timer for the moment `freshnessOf` would change its answer (live to stale), so a chip
 * turns Stale when a feed stops even though nothing else re-renders. The timer is cleared on unmount
 * and whenever an input changes. Server rendering reads the clock once and never schedules.
 */
export function useFreshnessClock({ asOf, now, staleAfterMs, refused, enabled = true }: UseFreshnessClockOptions): number {
  const [clock, setClock] = React.useState(() => Date.now());
  // New inputs: take a fresh reading in the same render, so an old clock never judges a new timestamp.
  const signature = `${String(asOf)}|${String(staleAfterMs)}|${String(refused)}`;
  const [seen, setSeen] = React.useState(signature);
  if (seen !== signature) {
    setSeen(signature);
    setClock(Date.now());
  }

  const owned = now == null;
  React.useEffect(() => {
    if (!owned || !enabled) return;
    const input = { asOf, staleAfterMs, refused };
    const t = Date.now();
    // The clock fell behind real time (long wait, sleeping tab): catch up first; this effect runs again.
    if (freshnessOf({ ...input, now: t }) !== freshnessOf({ ...input, now: clock })) {
      setClock(t);
      return;
    }
    const wait = msUntilFreshnessChange({ ...input, now: t });
    if (wait == null) return;
    const timer = setTimeout(() => setClock(Date.now()), Math.min(Math.max(wait, 1), MAX_WAIT_MS));
    return () => clearTimeout(timer);
  }, [owned, enabled, asOf, staleAfterMs, refused, clock]);

  return owned ? clock : now;
}
