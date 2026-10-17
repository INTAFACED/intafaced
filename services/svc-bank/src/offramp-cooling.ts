import { BankError } from './errors.js';

/** Owner-set offramp cooling window. Blank refuses; never default 24. */
export const BANK_OFFRAMP_COOLING_HOURS_ENV = 'BANK_OFFRAMP_COOLING_HOURS';

/**
 * Require an owner-set cooling window in hours.
 *
 * Unset / blank / non-integer / negative → `bank.offramp_cooling_unset`.
 * Zero is a real owner choice (no wait). Dest-elapsed is a later check:
 * `assertOfframpDestCoolingElapsed` after the dest row is loaded — never
 * invent elapsed when the dest is missing.
 */
export function requireOfframpCoolingHours(raw: string | undefined): number {
  const trimmed = raw?.trim() ?? '';
  if (trimmed === '') {
    throw new BankError(
      `${BANK_OFFRAMP_COOLING_HOURS_ENV} is unset — offramp refuses rather than inventing cooling hours`,
      'bank.offramp_cooling_unset',
    );
  }
  if (!/^[0-9]+$/.test(trimmed)) {
    throw new BankError(
      `${BANK_OFFRAMP_COOLING_HOURS_ENV} must be a non-negative integer hour count, got '${trimmed}'`,
      'bank.offramp_cooling_unset',
    );
  }
  return Number.parseInt(trimmed, 10);
}

const MS_PER_HOUR = 60 * 60 * 1000;

/**
 * List view of the owner window. Unset, blank, or not an integer is null —
 * the list still returns the destination and names `bank.offramp_cooling_unset`
 * instead of inventing 24 hours. Sending money still uses `requireOfframpCoolingHours`.
 */
export function readOfframpCoolingHours(raw: string | undefined): number | null {
  const trimmed = raw?.trim() ?? '';
  if (!/^[0-9]+$/.test(trimmed)) return null;
  return Number.parseInt(trimmed, 10);
}

/** When the cooling window ends. Zero hours ends at `updatedAt` (no wait). */
export function coolingOffEndsAt(hours: number, updatedAt: Date): Date {
  return new Date(updatedAt.getTime() + hours * MS_PER_HOUR);
}

/**
 * Dest last-changed must be at least `hours` old. Zero hours is no wait.
 * Inside the window → `bank.offramp_cooling_active`. Caller must already
 * have a dest row; missing dest is `bank.withdraw_destination_missing`.
 */
export function assertOfframpDestCoolingElapsed(hours: number, destUpdatedAt: Date, now: Date = new Date()): void {
  if (hours === 0) return;
  const elapsedMs = now.getTime() - destUpdatedAt.getTime();
  const windowMs = hours * MS_PER_HOUR;
  if (!Number.isFinite(elapsedMs) || elapsedMs < windowMs) {
    throw new BankError(`Withdraw destination last changed within the owner cooling window (${hours}h)`, 'bank.offramp_cooling_active');
  }
}
