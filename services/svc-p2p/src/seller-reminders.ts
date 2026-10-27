/**
 * P-trade-orders-15 / J-p2p-02 #2: the buyer reminds a slow seller to check the payment and release.
 *
 * Both figures are the owner's: the wait after the order is marked paid, and again after each reminder, before the
 * next may go (`P2P_REMIND_WAIT_SECONDS`), and how many one order may send (`P2P_REMIND_MAX`). Either blank refuses
 * every reminder `p2p.config_unset`; neither has a default.
 */
import { parseActiveOrderCap } from './take-limits.js';

export interface ReminderPolicy {
  /** Whole seconds, at least 1. `null` is unset. */
  readonly waitSeconds: number | null;
  /** Whole number of reminders per order, at least 1. `null` is unset. */
  readonly max: number | null;
}

/** Blank is unset; a value that is not a whole number of at least 1 is unset too (and refuses), never a guess. */
export function parseReminderPolicy(waitSeconds: number | null | undefined, max: number | null | undefined): ReminderPolicy {
  const wait = parseActiveOrderCap(waitSeconds);
  const count = parseActiveOrderCap(max);
  return wait === null || count === null ? { waitSeconds: null, max: null } : { waitSeconds: wait, max: count };
}

/** What an order's reminders look like to its two parties. */
export interface ReminderState {
  /** Reminders sent on this order so far. */
  readonly count: number;
  /** When the last one went, or null before the first. */
  readonly lastAt: Date | null;
  /**
   * When the buyer may send the next one: null when none can go (the order is not waiting on the seller, the count is
   * spent, or the owner's figures are unset).
   */
  readonly nextAt: Date | null;
  /** The owner's count, or null when unset. */
  readonly max: number | null;
}

/** The earliest moment the next reminder may go: the owner's wait after the order was marked paid, or after the last one. */
export function nextReminderAt(policy: ReminderPolicy, fiatSentAt: Date, lastAt: Date | null): Date | null {
  if (policy.waitSeconds === null) return null;
  return new Date((lastAt ?? fiatSentAt).getTime() + policy.waitSeconds * 1000);
}
