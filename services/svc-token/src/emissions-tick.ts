/**
 * Auto-tick POLL interval.
 *
 * The epoch LENGTH is `EMISSIONS_EPOCH_MS` (default 1 day, owner-present) and
 * is enforced by the database time gate (`token.epoch_too_early`), so the tick
 * is only "ask whether the next epoch is due". `index.ts` passes a fallback
 * poll for a BLANK / missing `EMISSIONS_TICK_MS`. A non-blank value that is
 * garbage or below 1000 ms is still `token.emissions_tick_unset` — a typo is
 * never silently replaced. Called without a fallback, blank is refused too.
 */
import { TokenError } from './token-service.js';

/**
 * Read owner tick ms. Missing / blank / non-integer / below 1000 is unset —
 * never coerced to 86400000.
 */
export function readEmissionsTickMs(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;
  if (!/^[0-9]+$/.test(trimmed)) return undefined;
  const ms = Number.parseInt(trimmed, 10);
  if (!Number.isInteger(ms) || ms < 1_000) return undefined;
  return ms;
}

/**
 * Default poll when `EMISSIONS_TICK_MS` is blank: the epoch length, capped at
 * one minute. A tick equal to the epoch length is not safe — `created_at` is
 * stamped a few ms after the tick fires, so the next tick lands just inside
 * the gate and the epoch after it waits a whole extra period.
 */
export const MAX_DEFAULT_TICK_MS = 60_000;
export function defaultEmissionsTickMs(epochMs: number): number {
  return Math.min(epochMs, MAX_DEFAULT_TICK_MS);
}

export function requireEmissionsTickMsForAutoTick(autoTick: true, raw: string | undefined, fallbackMs?: number): number;
export function requireEmissionsTickMsForAutoTick(autoTick: false, raw: string | undefined, fallbackMs?: number): number | undefined;
export function requireEmissionsTickMsForAutoTick(autoTick: boolean, raw: string | undefined, fallbackMs?: number): number | undefined;
export function requireEmissionsTickMsForAutoTick(autoTick: boolean, raw: string | undefined, fallbackMs?: number): number | undefined {
  const tickMs = readEmissionsTickMs(raw);
  if (!autoTick) return tickMs;
  if (tickMs === undefined) {
    const blank = raw === undefined || raw.trim().length === 0;
    if (blank && fallbackMs !== undefined) return fallbackMs;
    throw new TokenError(
      'EMISSIONS_TICK_MS is unset or invalid — set an integer of at least 1000 ms (the epoch length itself is EMISSIONS_EPOCH_MS)',
      'token.emissions_tick_unset',
    );
  }
  return tickMs;
}
