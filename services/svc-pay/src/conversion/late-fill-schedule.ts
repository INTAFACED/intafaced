/**
 * Technical bounds for the late-fill sweep and the orphan-hold sweep.
 *
 * None of these are quote TTLs, fees, or business horizons. They exist so a
 * replica cannot call the venue forever, and so two replicas cannot call it
 * for the same tick.
 *
 * Horizon: a resolve-absent row is rechecked only until 7 days after
 * `placing_at` (or `created_at` when the claim instant is missing). The venue
 * search window stays `placing_at` minus 1 minute through plus 10 minutes.
 * After the horizon the row is marked `late_fill_check_final_at` and the
 * sweep does not call the venue for it again, including a founder force.
 * A fill that shows up later is not auto-detected.
 *
 * Backoff: after each successful check the next check waits at most 1 minute,
 * then 5, then 15, then 60. The wait is half the cap plus a deterministic
 * jitter from the row id, so it never exceeds the cap and two replicas agree.
 * A venue error does not move the schedule.
 *
 * Tick cap: one pass calls the venue for at most this many rows. The pass
 * holds a session advisory lock, so a larger page would sit on that lock and
 * starve quote and execute lookups. The next tick continues.
 */

export const CONVERSION_LATE_FILL_HORIZON_MS = 7 * 24 * 60 * 60 * 1000;

/** Caps, in order, after the 1st, 2nd, 3rd, and later successful checks. */
export const CONVERSION_LATE_FILL_BACKOFF_CAPS_MS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000] as const;

/** Timer period. Equal to the shortest backoff cap, not a second business interval. */
export const CONVERSION_LATE_FILL_TICK_MS = CONVERSION_LATE_FILL_BACKOFF_CAPS_MS[0];

/** Venue calls one locked tick may make. Technical budget, not a quota. */
export const CONVERSION_LATE_FILL_VENUE_CALLS_PER_TICK = 8;

/** Orphan-hold timer. The founder trigger stays; both take the same try-lock. */
export const CONVERSION_HOLD_SWEEP_MS = 5 * 60 * 1000;

/** Session try-lock for one late-fill tick. Pair, so it does not collide with the hold sweep. */
export const LATE_FILL_SWEEP_LOCK_A = 7416;
export const LATE_FILL_SWEEP_LOCK_B = 8601;

/** Session try-lock for one orphan-hold pass. */
export const HOLD_SWEEP_LOCK_A = 7416;
export const HOLD_SWEEP_LOCK_B = 8602;

function hashUnit(text: string): number {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % 10_000;
}

/**
 * Delay before the next check after `checksCompleted` successful checks.
 * Inclusive of half the cap, exclusive of one past the cap.
 */
export function lateFillBackoffMs(rowId: string, checksCompleted: number): number {
  const step = Math.min(Math.max(checksCompleted, 1), CONVERSION_LATE_FILL_BACKOFF_CAPS_MS.length);
  const cap = CONVERSION_LATE_FILL_BACKOFF_CAPS_MS[step - 1]!;
  const half = Math.floor(cap / 2);
  return half + Math.floor((half * hashUnit(`${rowId}:${checksCompleted}`)) / 10_000);
}
